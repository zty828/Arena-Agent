/**
 * Locates the Electron binary that lives inside `node_modules/electron`.
 *
 * Why this is its own module: three scripts need the same answer, and this is the single most
 * common way "double-click desktop.cmd" goes wrong on a machine that is not the one it was
 * developed on. The three ways it can fail need three *different* fixes, and the original
 * message — "run node node_modules/electron/install.js" — was only correct for one of them.
 *
 * The case that actually bit us: the project's `node_modules` used to be a symlink into an
 * isolated runtime directory outside the repository, so moving or copying the folder left a
 * dependency tree that simply was not there. `dist/` was still newer than the sources, so the
 * staleness check found nothing to rebuild, and the run ended on the Electron message telling
 * the operator to re-run a script inside a directory that did not exist. Naming the real
 * problem is the whole point of this module.
 */
import fs from 'node:fs';
import path from 'node:path';

const HINTS = {
  'no-node-modules': [
    'Dependencies are missing: this folder has no node_modules directory.',
    'It is a source checkout, or a copy that did not carry the dependencies with it.',
    '',
    'Either use the self-contained release bundle, which ships node_modules/ and runtime/,',
    'or install the dependencies in this folder:',
    '',
    '    npm install',
  ],
  'no-electron-package': [
    'The Electron package is missing from node_modules.',
    '',
    'Run the dependency install in this folder to restore it:',
    '',
    '    npm install',
  ],
  'no-binary': [
    'The Electron package is present but its platform binary was never downloaded.',
    '',
    'That happens when dependencies were installed with --ignore-scripts, or when a copy',
    'dropped node_modules/electron/dist. Restore just that file with:',
    '',
    '    node node_modules/electron/install.js',
  ],
};

/**
 * Resolves the Electron executable.
 *
 * Returns `{ path, problem }` — exactly one of them is set. `problem` is a key into HINTS so the
 * caller can print the matching fix, and a probe can assert on the classification rather than on
 * the wording of a message.
 */
export function resolveElectronBinary(root) {
  const modulesRoot = path.join(root, 'node_modules');
  const packageRoot = path.join(modulesRoot, 'electron');
  if (!fs.existsSync(modulesRoot)) return { path: null, problem: 'no-node-modules' };
  if (!fs.existsSync(packageRoot)) return { path: null, problem: 'no-electron-package' };
  // `path.txt` is written by electron's install script and names the platform binary. The
  // documented name is the fallback, so a layout change degrades instead of breaking.
  let entry = 'electron.exe';
  try {
    const declared = fs.readFileSync(path.join(packageRoot, 'path.txt'), 'utf8').trim();
    if (declared) entry = declared;
  } catch { /* not installed by the download step; the fallback name is the best guess left */ }
  const candidate = path.join(packageRoot, 'dist', entry);
  if (!fs.existsSync(candidate)) return { path: null, problem: 'no-binary', candidate };
  return { path: candidate, problem: null };
}

/** Prints the problem and the fix that matches it. The caller decides whether to exit. */
export function explainElectronProblem(root, resolution) {
  const lines = HINTS[resolution.problem] ?? ['The Electron binary could not be located.'];
  for (const line of lines) console.error(line);
  if (resolution.candidate) {
    console.error('');
    console.error(`Missing file: ${path.relative(root, resolution.candidate)}`);
  }
}
