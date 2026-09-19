/**
 * Rebuilds `dist` when the sources are newer, using explicit paths and the running interpreter.
 *
 * This exists because the launcher used to call `npm run build`, which put "open the app" at the
 * mercy of the operator's PATH: npm has to make `node_modules/.bin` resolvable for the script it
 * runs, and on this machine that injection did not produce a usable Windows path — the window
 * refused to open with `'tsc' 不是内部或外部命令` while `node_modules/.bin/tsc.cmd` was sitting
 * right there. A build-system error in the middle of launching a window is the worst possible
 * place for it: the operator cannot tell whether their project is broken or their environment is.
 *
 * So the two steps are run directly, by `process.execPath` (which `desktop.cmd` points at the
 * bundled runtime in `runtime/`, falling back to PATH) and by absolute path. No npm, no shell,
 * no PATH, no `.bin` shims.
 *
 * It lives in its own module so the behaviour is testable without opening a window: the probe
 * runs it with a deliberately stripped PATH and asserts it still rebuilds.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function newestMtime(target, ignore = []) {
  let newest = 0;
  const walk = (entry) => {
    if (ignore.some((skip) => entry.includes(skip))) return;
    let stat;
    try { stat = fs.statSync(entry); } catch { return; }
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(entry)) walk(path.join(entry, child));
    } else if (stat.mtimeMs > newest) newest = stat.mtimeMs;
  };
  walk(target);
  return newest;
}

/** True when any source, or the tsconfig, is newer than the newest build artefact. */
export function buildIsStale(root) {
  const sourceRoots = ['apps', 'packages', 'scripts', 'tests'].map((name) => path.join(root, name));
  const sourceMtime = Math.max(...sourceRoots.map((dir) => newestMtime(dir)));
  const buildMtime = newestMtime(path.join(root, 'dist'));
  const tsconfigMtime = newestMtime(path.join(root, 'tsconfig.json'));
  return sourceMtime > buildMtime || tsconfigMtime > buildMtime;
}

/**
 * Runs the same two steps as `npm run build`, in order.
 *
 * Returns `{ rebuilt, error, missing }` rather than exiting: the caller decides how to report it,
 * and a probe can assert on the outcome. `error` carries the step's own exit status so the
 * message can say which half failed.
 */
export function ensureBuild(root, { force = false, quiet = false } = {}) {
  const stale = force || buildIsStale(root);
  if (!stale) return { rebuilt: false, stale: false };
  if (!quiet) {
    console.log('The build is older than the sources; rebuilding before the window opens…');
    console.log('');
  }
  const steps = [
    ['TypeScript compiler', path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), ['-p', 'tsconfig.json']],
    ['desktop build step', path.join(root, 'scripts', 'build-desktop.mjs'), []],
  ];
  for (const [label, entry, args] of steps) {
    if (!fs.existsSync(entry)) {
      return { rebuilt: false, stale: true, missing: path.relative(root, entry), label };
    }
    const step = spawnSync(process.execPath, [entry, ...args], { cwd: root, stdio: quiet ? 'pipe' : 'inherit' });
    if (step.error || step.status !== 0) {
      return { rebuilt: false, stale: true, label, error: step.error ? step.error.message : `exit ${step.status}` };
    }
  }
  return { rebuilt: true, stale: true };
}
