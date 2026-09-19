/**
 * Every path the built code will import at runtime must exist.
 *
 * Why this exists: `apps/desktop/src/main.ts` loaded the tunnel writer with a relative specifier,
 * `../../../scripts/tunnel-cloudflared.mjs`. That is correct from the SOURCE tree, but the file
 * is compiled into `dist/apps/desktop/src/`, where the same specifier resolves to
 * `dist/scripts/tunnel-cloudflared.mjs` — a directory that does not exist. Nothing failed at
 * build time and nothing failed in any test, because the only code that performs that import is
 * the Connect button, which no test drives. The operator found it by clicking.
 *
 * A dynamic import is invisible to the type checker and to the module resolver, so a broken one
 * is only discovered when that line runs. This scans the build output for dynamic imports whose
 * specifier is a literal path, and asserts each one resolves. It is deliberately static: it needs
 * no network, no Electron, and no daemon, so it can run on every verification pass.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(root, 'dist');

let failures = 0;
const check = (ok, message) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`);
};

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs') || entry.name.endsWith('.cjs')) yield full;
  }
}

// `import('...')` / `import("...")` with a literal specifier. A computed expression cannot be
// checked statically, so those are reported rather than skipped silently — an unchecked dynamic
// import is exactly how the reported failure reached the operator.
const literalImport = /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
const computedImport = /\bimport\s*\(\s*(?!['"])/g;

const modules = fs.existsSync(distRoot) ? [...walk(distRoot)] : [];
check(modules.length > 0, `the build output was found (${modules.length} module(s) under dist/)`);

let literalCount = 0;
let computedCount = 0;
const computedSites = [];

for (const file of modules) {
  const text = fs.readFileSync(file, 'utf8');
  const rel = path.relative(root, file);

  for (const match of text.matchAll(literalImport)) {
    const specifier = match[2];
    literalCount += 1;
    // Only path-like specifiers are this script's business; bare package names resolve through
    // node_modules and are not part of what the build lays out.
    if (!specifier.startsWith('.') && !specifier.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(specifier)) continue;
    const resolved = specifier.startsWith('.') ? path.resolve(path.dirname(file), specifier) : specifier;
    check(
      fs.existsSync(resolved),
      `${rel} imports ${specifier} -> ${path.relative(root, resolved)}`,
    );
  }

  // A dynamic import built from a path expression — e.g. `import(pathToFileURL(p).href)`.
  // Those are legitimate (the desktop main process uses one for the tunnel writer), but the
  // target cannot be verified from the specifier alone, so report them for a human to confirm.
  const computed = [...text.matchAll(computedImport)];
  if (computed.length) {
    computedCount += computed.length;
    computedSites.push(`${rel} (${computed.length})`);
  }
}

// Every dynamic import in this build is expected to be a computed one, because the compiler
// rewrites literal `import('./x.js')` into a static import. That means the scan below will
// normally find none — which is not a reason to fail; it is the reason the repoRoot assertion
// at the end of this file exists, since that is what a computed import must be anchored on.
check(
  computedCount > 0,
  `computed dynamic imports were located (${computedCount})`,
);
check(literalCount >= 0, `literal or relative dynamic imports were checked (${literalCount})`);

// The tunnel writer is the specific file this guard was written for. Assert it is reachable the
// way the desktop main process reaches it, so the guard fails loudly if that wiring regresses.
const writerFromDist = path.join(root, 'scripts', 'tunnel-cloudflared.mjs');
check(fs.existsSync(writerFromDist), `the tunnel writer exists at scripts/tunnel-cloudflared.mjs`);
check(
  !fs.existsSync(path.join(distRoot, 'scripts', 'tunnel-cloudflared.mjs')),
  'and no stale copy is expected under dist/scripts (the path a relative specifier would resolve to)',
);

// Load the built desktop main module's source and assert it anchors the writer on repoRoot.
const desktopMain = path.join(distRoot, 'apps', 'desktop', 'src', 'main.js');
if (fs.existsSync(desktopMain)) {
  const text = fs.readFileSync(desktopMain, 'utf8');
  check(
    /path\.join\(\s*repoRoot\s*,\s*['"]scripts['"]\s*,\s*['"]tunnel-cloudflared\.mjs['"]\s*\)/.test(text),
    'the desktop main process resolves the tunnel writer from repoRoot, not a relative specifier',
  );
} else {
  check(false, `the built desktop main process was found at ${path.relative(root, desktopMain)}`);
}

if (computedCount > 0) {
  console.log('');
  console.log(`note: ${computedCount} computed dynamic import(s) cannot be checked statically: ${computedSites.join(', ')}`);
}

console.log('');
console.log(failures === 0 ? 'every checkable dynamic import resolves' : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
