/**
 * Drives the desktop window self-test against a fixed workspace.
 *
 * `desktop.cmd --self-test` renders the operator's *saved* workspace, which is whatever they
 * last chose. That is right for debugging their setup and wrong as a regression check: the
 * checks assert that a text file renders, and a directory holding only images (Pictures, for
 * instance) has no text file to render. The window is not at fault, but the run looks like a
 * failure — and a check that depends on the directory contents proves nothing about the code.
 *
 * So this points the window at the synthetic fixture through ARENABRIDGE_WORKSPACE_ROOT. That
 * variable is read by initialWorkspace() and deliberately does NOT write the operator's
 * preference file, so running this cannot change which directory their next launch opens.
 *
 * The window prints its checks to stdout and exits non-zero when any check fails, so the exit
 * code is the verdict and is propagated as-is.
 *
 * Run: npm run desktop:selftest
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { explainElectronProblem, resolveElectronBinary } from './electron-binary.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, 'outputs', 'synthetic-workspace');
if (!fs.existsSync(fixture)) {
  console.error(`The synthetic fixture is missing: ${path.relative(root, fixture)}`);
  console.error('This workspace is what the self test asserts against; recreate it before running.');
  process.exit(1);
}

const electron = resolveElectronBinary(root);
if (!electron.path) {
  explainElectronProblem(root, electron);
  process.exit(1);
}

// The self test writes probe files into this fixture to prove the file tree tracks the disk. They
// are deleted by the window, but if a run is killed mid-check one survives — and this fixture is
// shared, so `tests/daemon-gateway.test.js` D02 (which asserts the directory contains exactly
// sum.mjs and sum.test.mjs) then fails for a reason that has nothing to do with the daemon.
//
// Rather than relying on the window cleaning up, refuse to start with stale probes present and
// sweep them here on the way out. Both, because "the suite that asserts the contents" must not be
// the thing that discovers a leftover.
const PROBE_RE = /^selftest-refresh-[A-Za-z0-9-]+\.txt$/;
const staleProbes = () => fs.readdirSync(fixture).filter((name) => PROBE_RE.test(name));
const sweepProbes = () => {
  for (const name of staleProbes()) {
    try { fs.rmSync(path.join(fixture, name), { force: true }); } catch { /* reported by the check below */ }
  }
  return staleProbes();
};
const preexisting = staleProbes();
if (preexisting.length) {
  console.error(`Sweeping ${preexisting.length} leftover self-test probe file(s) from the fixture: ${preexisting.join(', ')}`);
  const remaining = sweepProbes();
  if (remaining.length) {
    console.error(`Could not remove: ${remaining.join(', ')}`);
    process.exit(1);
  }
}

console.log(`Window self test against ${path.relative(root, fixture)}`);
console.log('');

const mainScript = path.join(root, 'dist', 'apps', 'desktop', 'src', 'main.js');
const child = spawn(electron.path, [mainScript, '--self-test'], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: undefined,
    ELECTRON_NO_ATTACH_CONSOLE: undefined,
    ARENABRIDGE_WORKSPACE_ROOT: fixture,
    // A separate state directory so this shares neither the database nor the lease with a
    // desktop window the operator may have open right now. The fixture path is stable across
    // runs, so this state is reused rather than accumulating a directory per run.
    ARENABRIDGE_STATE_DIR: path.join(root, 'outputs', 'desktop', 'selftest-state'),
  },
});

child.on('exit', (code) => {
  // A probe file that outlives the run is a fixture leak, not a cosmetic detail: report it as a
  // failure even when every check passed, because the next suite to look at this directory will.
  const left = sweepProbes();
  if (left.length) {
    console.error(`FAIL  the self test left probe file(s) behind in the fixture: ${left.join(', ')}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
child.on('error', (error) => {
  console.error('Could not start the desktop harness:', error.message);
  process.exit(1);
});
