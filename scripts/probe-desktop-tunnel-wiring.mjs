/**
 * Does the desktop window's own tunnel wiring resolve at runtime?
 *
 * The reported failure was `Cannot find module 'dist/scripts/tunnel-cloudflared.mjs'` thrown from
 * `dist/apps/desktop/src/main.js` — the window's Connect handler. The path was a relative
 * specifier, correct from the source tree but resolving to a non-existent directory once compiled.
 *
 * This loads the BUILT main module's own resolution the same way the window does, and asserts the
 * writer is reachable and callable from the compiled location. It does not open the tunnel, so it
 * is offline and safe to run on every pass.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (ok, message) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`);
};

// The exact arithmetic the compiled main process uses: moduleDir is dist/apps/desktop/src.
const moduleDir = path.join(root, 'dist', 'apps', 'desktop', 'src');
const repoRoot = path.resolve(moduleDir, '..', '..', '..', '..');
check(fs.existsSync(path.join(moduleDir, 'main.js')), 'the built desktop main process exists');
check(repoRoot === root, `the compiled layout resolves repoRoot back to the project root`);

// What the OLD relative specifier resolved to from the compiled location. This is the path that
// appeared in the operator's error message, and it must not exist.
const oldResolution = path.resolve(moduleDir, '..', '..', '..', 'scripts', 'tunnel-cloudflared.mjs');
check(
  !fs.existsSync(oldResolution),
  `the old relative specifier still resolves to nothing (${path.relative(root, oldResolution)})`,
);

// What the current code resolves to. It must exist AND load with a callable writer.
const writer = path.join(repoRoot, 'scripts', 'tunnel-cloudflared.mjs');
check(fs.existsSync(writer), `the writer resolves from repoRoot (${path.relative(root, writer)})`);

let mod;
let loadError;
try { mod = await import(pathToFileURL(writer).href); } catch (error) { loadError = error; }
check(loadError === undefined, `the writer imports cleanly${loadError ? `: ${loadError.message}` : ''}`);
check(typeof mod?.startCloudflareTunnel === 'function', 'and exports a callable startCloudflareTunnel');

// A missing writer must be reported as data, not thrown out of the IPC handler — the handler
// checks existence first precisely because an uncontrolled import error reached the operator as
// an opaque "Error occurred in handler" message last time.
const mainSource = fs.readFileSync(path.join(moduleDir, 'main.js'), 'utf8');
check(
  /existsSync\(\s*tunnelWriterPath\s*\)/.test(mainSource),
  'the handler checks the writer exists before importing it, so a missing file is reported as data',
);

// Re-pairing on a live tunnel. The remote's grant is short-lived by design, so continuing a
// session means minting a new code — and that must not require tearing the tunnel down. Both
// halves of the wiring are asserted because a button that reaches no handler is indistinguishable
// from a working one until someone presses it, which is exactly how the earlier
// "arena:connect" regression survived every test.
const preloadSource = fs.readFileSync(path.join(moduleDir, 'preload.cjs'), 'utf8');
check(/arenaReissuePairing:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('arena:reissue-pairing'\)/.test(preloadSource),
  'the preload forwards a re-pairing request to the main process');
check(/ipcMain\.handle\('arena:reissue-pairing'/.test(mainSource),
  'the main process registers the re-pairing handler the preload calls');
const reissueBody = /async function reissuePairing[\s\S]*?\n}/.exec(mainSource)?.[0] ?? '';
check(/createPairing\(/.test(reissueBody) && /buildArenaPrompt\(/.test(reissueBody),
  're-pairing mints a code and rebuilds the prompt for the same tunnel');
check(/grantTtlMs:\s*pairing\.grant_ttl_ms/.test(reissueBody),
  'the re-issued prompt states the new grant lifetime, like the first one does');
// The window mints session-scoped credentials: 0 means "no wall-clock expiry", and the bound is
// the daemon session itself (epoch rotation). A fixed hour here stopped long tasks mid-flight for
// no reason the operator could see.
check(/const GRANT_TTL_MS = 0;/.test(mainSource),
  'the window mints a session-scoped grant rather than a fixed hour');
check(/activePairing\s*=\s*\{/.test(reissueBody),
  'the window keeps the new code so a later re-copy does not hand out the old one');

// --- the launcher must be able to build without the operator's PATH -----------------------
//
// The window refused to open on this machine with `'tsc' is not recognized as an internal or
// external command` even though `node_modules/.bin/tsc.cmd` existed: the launcher shelled out to
// `npm run build`, and the PATH npm handed the script contained no entry that resolves to that
// shim. That is a build-system error in the middle of "open the app", which is the worst place
// for one — the operator cannot tell whether their project is broken or their environment is.
//
// The behavioural half below is the point: it strips PATH down to the system directory (no node,
// no npm, no `.bin`) and runs the real build step. A static "does not mention npm" check alone
// would pass on a launcher that had switched to some other PATH-dependent mechanism.
const ensureBuildSource = fs.readFileSync(path.join(repoRoot, 'scripts', 'ensure-build.mjs'), 'utf8');
const desktopSource = fs.readFileSync(path.join(repoRoot, 'scripts', 'desktop.mjs'), 'utf8');
// The launcher may still *mention* npm in the message it prints when a dependency is missing; what
// it must not do is invoke it. Matching the word alone would fail on that helpful sentence.
check(!/['"]npm(\.cmd)?['"]/.test(desktopSource), 'the launcher does not invoke npm for its build');
check(/process\.execPath/.test(ensureBuildSource), 'the build runs under the interpreter that is already running');
for (const entry of [path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), path.join(repoRoot, 'scripts', 'build-desktop.mjs')]) {
  check(fs.existsSync(entry), `the build entry exists: ${path.relative(repoRoot, entry)}`);
}
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
// `node` is the interpreter npm already had to find to run the script at all, so it is the one
// bare name that is safe to start with. Anything else (`tsc`, `electron`, …) is resolved through
// node_modules/.bin, which is exactly the resolution that failed.
check(/^node\s/.test(packageJson.scripts.build),
  `the build script starts with node rather than a .bin-resolved binary (${packageJson.scripts.build})`);

if (process.platform === 'win32') {
  const { ensureBuild } = await import(pathToFileURL(path.join(repoRoot, 'scripts', 'ensure-build.mjs')).href);
  const savedPath = process.env.PATH;
  const savedPathext = process.env.PATHEXT;
  try {
    process.env.PATH = 'C:\\Windows\\system32';
    process.env.PATHEXT = '.EXE;.CMD;.BAT';
    const outcome = ensureBuild(repoRoot, { force: true, quiet: true });
    check(outcome.rebuilt === true,
      `with PATH stripped to the system directory the rebuild still succeeds (${JSON.stringify(outcome)})`);
  } finally {
    process.env.PATH = savedPath;
    process.env.PATHEXT = savedPathext;
  }
}

console.log('');
console.log(failures === 0 ? "the window's tunnel writer resolves from the compiled location" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
