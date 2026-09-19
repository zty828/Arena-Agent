/**
 * Launches the ArenaBridge desktop harness.
 *
 * The window is a real Electron application, not a browser tab, because the operator needs it
 * to live alongside Arena as a peer window rather than as something to alt-tab away from. The
 * daemon runs inside that process, so quitting the window stops the bridge; there is no
 * orphaned background service and no port or bearer token to copy by hand.
 *
 * This script's only jobs are: make sure dist is current, locate the Electron binary, and spawn
 * it. All application logic lives in apps/desktop/src/main.ts.
 *
 * Everything it resolves is anchored to this file's own directory, never to the current working
 * directory or to the operator's PATH, so the folder keeps working after it is moved or copied.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureBuild } from './ensure-build.mjs';
import { explainElectronProblem, resolveElectronBinary } from './electron-binary.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const main = path.join(root, 'dist', 'apps', 'desktop', 'src', 'main.js');
const preload = path.join(root, 'dist', 'apps', 'desktop', 'src', 'preload.cjs');
const renderer = path.join(root, 'dist', 'apps', 'desktop', 'src', 'renderer', 'index.html');

/**
 * Refuse an older Node, warn about a newer one.
 *
 * The release bundle ships its own runtime, so this only ever fires for a source checkout. A
 * major below the validated floor is refused because the failure would otherwise surface as an
 * unrelated crash deep inside the daemon; a major above it is allowed through with a warning,
 * because nothing here depends on 22-only behaviour and refusing to start would be the worse
 * outcome of the two.
 */
const VALIDATED_MAJOR = 22;
const runningMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);
if (Number.isFinite(runningMajor) && runningMajor < VALIDATED_MAJOR) {
  console.error(`ArenaBridge needs Node ${VALIDATED_MAJOR} or newer; this is Node ${process.versions.node}.`);
  console.error('');
  console.error('The self-contained release bundle ships a working runtime and does not use the Node');
  console.error('on your PATH. From a source checkout, install Node 22 and try again.');
  process.exit(1);
}
if (Number.isFinite(runningMajor) && runningMajor > VALIDATED_MAJOR) {
  console.warn(`Note: this build is validated on Node ${VALIDATED_MAJOR}; running on Node ${process.versions.node}.`);
  console.warn('');
}

for (const [label, target] of [['main process', main], ['preload bridge', preload], ['window page', renderer]]) {
  if (!fs.existsSync(target)) {
    console.error(`The ${label} has not been built: ${path.relative(root, target)} is missing.`);
    console.error('Run the build first (see README).');
    process.exit(1);
  }
}

/**
 * Rebuild when the sources are newer than the build.
 *
 * Without this the window silently runs whatever was compiled last, so an edit appears to have
 * no effect and a bug that was already fixed still reproduces. That is exactly what happened:
 * a fix was in the source, `desktop.cmd` launched a stale `dist`, and the old failure came back
 * with an old line number. Checking the timestamps is cheap (a few hundred stat calls) compared
 * with the cost of debugging a build that was never loaded.
 *
 * The rebuild itself lives in `ensure-build.mjs` because it must not depend on the operator's
 * PATH — see that file for what went wrong when it shelled out to the package-manager build, and
 * for the probe that keeps it honest without opening a window.
 */
const built = ensureBuild(root);
if (built.missing) {
  // A build step that is missing *inside node_modules* is a dependency problem, not a build
  // problem, and saying so saves the operator from reinstalling the wrong thing.
  if (built.missing.replace(/\\/g, '/').startsWith('node_modules/')) {
    console.error('Dependencies are missing: the build step cannot run without them.');
    console.error('');
    console.error(`Missing: ${built.missing}`);
    console.error('');
    console.error('Either use the self-contained release bundle, or install the dependencies here:');
    console.error('');
    console.error('    npm install');
  } else {
    console.error(`The ${built.label} is missing: ${built.missing}`);
    console.error('Reinstall the dependencies in this folder and try again.');
  }
  process.exit(1);
}
if (built.error) {
  console.error('');
  console.error(`The rebuild failed in the ${built.label} step (${built.error}).`);
  console.error('Fix the build before opening the window, so the window cannot run stale code.');
  process.exit(1);
}
if (built.rebuilt) {
  for (const [label, target] of [['main process', main], ['preload bridge', preload], ['window page', renderer]]) {
    if (!fs.existsSync(target)) {
      console.error(`The rebuild did not produce the ${label}: ${path.relative(root, target)} is missing.`);
      process.exit(1);
    }
  }
  console.log('');
}

// Resolved by a shared module so the window launcher, the self test and the end-to-end test all
// report a missing Electron the same way, and so each of the three causes gets its own fix.
const electron = resolveElectronBinary(root);
if (!electron.path) {
  explainElectronProblem(root, electron);
  process.exit(1);
}

console.log('Starting the ArenaBridge desktop harness…');
console.log('Closing the window stops the local bridge.');
console.log('');

const extra = process.argv.slice(2);
const child = spawn(electron.path, [main, ...extra], {
  cwd: root,
  stdio: 'inherit',
  // Electron must own its own environment; ELECTRON_RUN_AS_NODE would make it behave as
  // plain Node and the window would never appear.
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, ELECTRON_NO_ATTACH_CONSOLE: undefined },
});

child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (error) => {
  console.error('Could not start the desktop harness:', error.message);
  process.exit(1);
});
