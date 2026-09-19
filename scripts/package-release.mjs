#!/usr/bin/env node
/**
 * Builds the self-contained Windows release bundle.
 *
 * Why this exists: `node_modules/` and `runtime/` are deliberately not tracked by git, which
 * keeps the repository small — but it also means a clone is not runnable on its own, and the
 * failure it produces is confusing (see scripts/electron-binary.mjs). This script produces the
 * other half of that trade: one zip that contains the source *and* every byte needed to run it,
 * so a recipient can extract it anywhere, with no network and no installed Node, and double-click
 * desktop.cmd.
 *
 * The bundle is staged as a real folder first and then archived, because the folder is itself a
 * useful artefact (copy it to a USB stick, run it in place) and because every required file can
 * be asserted before anything is zipped.
 *
 * Usage:
 *   node scripts/package-release.mjs [--out <directory>] [--keep-folder]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureBuild } from './ensure-build.mjs';
import { ensureCloudflaredBinary } from './tunnel-cloudflared.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const BUNDLE_NAME = `${manifest.name}-${manifest.version}-win-x64`;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const outputDirectory = path.resolve(option('--out', path.join(root, 'outputs', 'release')));
const archivePath = path.join(outputDirectory, `${BUNDLE_NAME}.zip`);
const folderPath = path.join(outputDirectory, BUNDLE_NAME);

/**
 * Top-level entries that never ship.
 *
 * Everything not listed is included, which is the safer default: a new source directory shows up
 * in the bundle without anyone remembering to add it here. The exclusions are all either local
 * state, local tooling, or the run-artefact area — whose one tracked member is added back below.
 */
const NEVER_SHIP = new Set([
  '.git', '.github', '.gitignore',
  '.workbuddy-ai', '.test-data', '.arena-bridge', '.arenabridge-sandbox.json',
  'outputs',
  // Installed skills are operator data, and a skill is a set of instructions an agent then
  // follows. Shipping them would put the maintainer's own skills inside a public release bundle;
  // whoever downloads it can add their own into the bundle's skills/ directory afterwards.
  'skills',
]);
/** The single run-artefact that IS shipped: the fixture the test suite asserts against. */
const ALWAYS_SHIP = [path.join('outputs', 'synthetic-workspace')];

function fail(...lines) {
  console.error('');
  for (const line of lines) console.error(line);
  process.exit(1);
}

/** Node 22 must be the interpreter that is running, or the bundled runtime is the wrong one. */
function stageNodeRuntime() {
  const target = path.join(root, 'runtime', 'node.exe');
  if (fs.existsSync(target) && fs.statSync(target).size > 40_000_000) {
    console.log(`runtime/node.exe already present (${mb(fs.statSync(target).size)})`);
    return target;
  }
  if (!process.versions.node.startsWith('22.')) {
    fail(
      `runtime/node.exe is missing and this script is running on Node ${process.versions.node}.`,
      'The bundle pins Node 22, so it cannot be staged from a different major.',
      '',
      'Either restore runtime/node.exe from the release bundle, or run this script with Node 22.',
    );
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(process.execPath, target);
  console.log(`staged runtime/node.exe from ${process.execPath} (${mb(fs.statSync(target).size)})`);
  return target;
}

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

/** Windows ships bsdtar, which writes a real zip when the target name ends in .zip. */
function tarExecutable() {
  const systemTar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  if (fs.existsSync(systemTar)) return systemTar;
  const probe = spawnSync('tar', ['--version'], { encoding: 'utf8' });
  if (probe.status === 0) return 'tar';
  return null;
}

// --- preconditions -------------------------------------------------------------------------

if (!fs.existsSync(path.join(root, 'node_modules'))) {
  fail(
    'node_modules is missing, so there is nothing to bundle.',
    '',
    'Install the dependencies in this folder first:',
    '',
    '    npm install',
  );
}

const tar = tarExecutable();
if (!tar) {
  fail(
    'No tar executable was found, and it is what writes the zip.',
    'On Windows 10 1803 and later it ships as %SystemRoot%\\System32\\tar.exe.',
  );
}

// --- make the bundle current and complete --------------------------------------------------

const built = ensureBuild(root, { force: true });
if (built.missing || built.error) {
  fail(`The build did not complete: ${built.missing ?? built.error}`);
}
console.log('build is current');

stageNodeRuntime();
const cloudflared = await ensureCloudflaredBinary();
console.log(`runtime/cloudflared.exe ready (${mb(cloudflared.size)}${cloudflared.downloaded ? ', downloaded now' : ''})`);

// --- stage the folder ----------------------------------------------------------------------

// The staging folder has to start empty: copying over a leftover tree would leave files from an
// older build inside the bundle, which is the kind of defect nobody notices until a recipient
// runs stale code. If it cannot be cleared, stop and say so rather than stage over it.
if (fs.existsSync(folderPath)) {
  try {
    fs.rmSync(folderPath, { recursive: true, force: true });
  } catch (error) {
    fail(
      'A staging folder from an earlier run is still there and could not be removed.',
      '',
      `    ${path.relative(root, folderPath)}`,
      '',
      error instanceof Error ? `(${error.message.split('\n')[0]})` : '',
      'Delete it and run this again. Some environments cap how much a single command may',
      'delete, which is enough to refuse a folder this size while leaving the archive fine.',
    );
  }
}
fs.mkdirSync(folderPath, { recursive: true });

const entries = fs.readdirSync(root).filter((name) => !NEVER_SHIP.has(name));
const copied = [...entries, ...ALWAYS_SHIP];
let staged = 0;
for (const name of copied) {
  const from = path.join(root, name);
  if (!fs.existsSync(from)) {
    fail(`Expected to ship ${name}, but it does not exist.`);
  }
  fs.cpSync(from, path.join(folderPath, name), { recursive: true, preserveTimestamps: true });
  staged++;
}
console.log(`staged ${staged} top-level entries into ${path.relative(root, folderPath)}`);

/**
 * Make `dist/` the newest thing in the bundle.
 *
 * The launcher rebuilds whenever a source looks newer than the build, which is right when a
 * developer has just edited a file and wrong here: staging rewrites mtimes, and `scripts/` is
 * copied after `dist/`, so a freshly extracted bundle would decide every source is newer and
 * rebuild before the first window opens. The build was just forced to be current, so stamping
 * dist last states the truth — and an edit made after extraction is still newer, so the
 * rebuild still triggers when it should.
 */
const stamp = new Date();
const stampTree = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) stampTree(target);
    else if (entry.isFile()) fs.utimesSync(target, stamp, stamp);
  }
};
stampTree(path.join(folderPath, 'dist'));

/**
 * Writes THIRD_PARTY_NOTICES.md into the bundle.
 *
 * Generated rather than checked in: a hand-maintained licence list goes stale the first time a
 * dependency is bumped, and a wrong licence list is worse than none. It matters more here than
 * in a typical repository, because this bundle redistributes three large binaries — Electron, a
 * Node runtime and cloudflared — whose licences have to travel with them.
 */
function writeThirdPartyNotices(target) {
  const components = new Map();
  const visit = (directory, depth) => {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(directory, entry.name);
      if (entry.name.startsWith('@')) { visit(full, depth + 1); continue; }
      const manifestPath = path.join(full, 'package.json');
      if (fs.existsSync(manifestPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          if (pkg.name && !components.has(pkg.name)) {
            components.set(pkg.name, {
              version: pkg.version ?? '',
              license: typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? 'see package'),
            });
          }
        } catch { /* an unreadable manifest simply does not appear in the list */ }
      }
      visit(full, depth + 1);
    }
  };
  visit(path.join(root, 'node_modules'), 0);
  // Not npm packages, but redistributed all the same, so they belong in the same list.
  components.set('Node.js', { version: process.versions.node, license: 'MIT' });
  components.set('cloudflared', { version: 'reported by runtime/cloudflared.exe --version', license: 'Apache-2.0' });

  const table = [...components.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, info]) => `| ${name} | ${info.version} | ${info.license} |`);
  const lines = [
    '# Third-party notices',
    '',
    'This bundle redistributes the components below. Each keeps its own licence, and the full',
    'text of each one travels with the package that ships it, under `node_modules/<name>/`.',
    '',
    'Electron additionally carries its own `LICENSE` and `LICENSES.chromium.html` inside',
    '`node_modules/electron/dist/`; those cover Chromium and the other third-party code linked',
    'into the runtime.',
    '',
    '| Component | Version | Licence |',
    '| --- | --- | --- |',
    ...table,
    '',
    `Generated by scripts/package-release.mjs on ${new Date().toISOString()}.`,
    '',
  ];
  fs.writeFileSync(path.join(target, 'THIRD_PARTY_NOTICES.md'), lines.join('\n'), 'utf8');
  return components.size;
}
console.log(`wrote THIRD_PARTY_NOTICES.md covering ${writeThirdPartyNotices(folderPath)} components`);

// --- assert the staged folder is actually runnable before zipping --------------------------

const REQUIRED = [
  'desktop.cmd',
  path.join('scripts', 'desktop.mjs'),
  path.join('scripts', 'ensure-build.mjs'),
  path.join('scripts', 'electron-binary.mjs'),
  path.join('scripts', 'tunnel-cloudflared.mjs'),
  path.join('scripts', 'build-desktop.mjs'),
  path.join('runtime', 'node.exe'),
  path.join('runtime', 'cloudflared.exe'),
  path.join('node_modules', 'electron', 'dist', 'electron.exe'),
  path.join('node_modules', 'typescript', 'bin', 'tsc'),
  path.join('node_modules', '@modelcontextprotocol', 'server', 'package.json'),
  path.join('dist', 'apps', 'desktop', 'src', 'main.js'),
  path.join('dist', 'apps', 'desktop', 'src', 'preload.cjs'),
  path.join('dist', 'apps', 'desktop', 'src', 'renderer', 'index.html'),
  path.join('outputs', 'synthetic-workspace', 'sum.mjs'),
];
const missing = REQUIRED.filter((rel) => !fs.existsSync(path.join(folderPath, rel)));
if (missing.length) {
  fail(
    `The staged bundle is not runnable: ${missing.length} required file(s) are missing.`,
    ...missing.map((rel) => `  - ${rel}`),
  );
}
console.log(`verified ${REQUIRED.length} required files are present`);

// --- archive --------------------------------------------------------------------------------

fs.rmSync(archivePath, { force: true });
const zipped = spawnSync(tar, ['-a', '-c', '-f', archivePath, '-C', outputDirectory, BUNDLE_NAME], {
  stdio: 'inherit',
});
if (zipped.status !== 0) fail(`tar exited ${zipped.status}; no archive was produced.`);

// Read the archive back rather than trusting the writer: an archive that silently dropped the
// binary would look fine until someone tried to run it on a machine with no network.
const listed = spawnSync(tar, ['-tf', archivePath], { encoding: 'utf8' });
if (listed.status !== 0) fail(`tar could not read back the archive it just wrote (exit ${listed.status}).`);
const inside = new Set(
  (listed.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\\/g, '/').replace(/\/+$/, ''))
    // Every entry is prefixed with the bundle folder name, so extracting yields one directory
    // instead of scattering the tree into whatever folder the user happened to be in. The
    // verification below talks about paths *within* the bundle, so the prefix is stripped here.
    .map((line) => (line.startsWith(`${BUNDLE_NAME}/`) ? line.slice(BUNDLE_NAME.length + 1) : line))
    .filter(Boolean),
);
if (inside.size === 0) fail('The archive read back as empty.');
const absent = REQUIRED.filter((rel) => !inside.has(rel.replace(/\\/g, '/')));
if (absent.length) {
  fail('The archive does not contain everything it should:', ...absent.map((rel) => `  - ${rel}`));
}
const forbidden = [...inside].filter(
  (rel) => rel.startsWith('.arena-bridge/') || rel.startsWith('.test-data/') || /\.sqlite(-shm|-wal)?$/.test(rel),
);
if (forbidden.length) {
  fail('The archive contains local state that must never be published:', ...forbidden.slice(0, 10).map((rel) => `  - ${rel}`));
}

if (!flag('--keep-folder')) {
  // Best effort, and deliberately not fatal. The archive has already been produced and verified
  // by this point, so a refusal to delete the staging copy says nothing about the bundle — and
  // some environments cap how much a single command may delete, which turns tidying up after a
  // successful build into a spurious failure. Report it and leave the path so it can be removed
  // by hand.
  try {
    fs.rmSync(folderPath, { recursive: true, force: true });
  } catch (error) {
    console.warn('');
    console.warn('Note: the staging folder could not be removed automatically.');
    console.warn(`      ${path.relative(root, folderPath)}`);
    console.warn(`      ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    console.warn('      The archive is complete and verified; delete that folder whenever convenient.');
  }
}

console.log('');
console.log(`archive : ${path.relative(root, archivePath)} (${mb(fs.statSync(archivePath).size)})`);
console.log(`entries : ${inside.size} (paths relative to ${BUNDLE_NAME}/)`);
console.log('The bundle is self-contained: extract it anywhere and double-click desktop.cmd.');
