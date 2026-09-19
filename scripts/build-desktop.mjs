/**
 * Copies the desktop harness's non-TypeScript assets into dist/.
 *
 * `tsc` only emits .js, so the preload bridge (.cjs, deliberately CommonJS because
 * contextBridge preloads are loaded by Electron's CommonJS loader regardless of the
 * package's "type": "module") and the renderer's html/css/js would never reach dist on
 * their own. Electron loads the window from dist, so a stale or missing copy here shows
 * up as a blank window rather than a build error — this step makes that failure loud.
 *
 * Run via `npm run build`, which chains tsc then this.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'apps', 'desktop', 'src');
const target = path.join(root, 'dist', 'apps', 'desktop', 'src');

if (!fs.existsSync(source)) {
  console.error('build-desktop: apps/desktop/src is missing; nothing to copy.');
  process.exit(1);
}

const assets = ['preload.cjs'];
const rendererSource = path.join(source, 'renderer');
const rendererTarget = path.join(target, 'renderer');

fs.mkdirSync(rendererTarget, { recursive: true });
for (const name of assets) {
  const from = path.join(source, name);
  if (!fs.existsSync(from)) {
    console.error(`build-desktop: expected asset ${name} was not found.`);
    process.exit(1);
  }
  fs.copyFileSync(from, path.join(target, name));
}

let copied = 0;
for (const name of fs.readdirSync(rendererSource)) {
  const from = path.join(rendererSource, name);
  if (!fs.statSync(from).isFile()) continue;
  fs.copyFileSync(from, path.join(rendererTarget, name));
  copied++;
}
if (copied === 0) {
  console.error('build-desktop: renderer/ contained no files; the window would be blank.');
  process.exit(1);
}

// Verify the two files Electron actually resolves, so a silent mis-copy cannot pass.
for (const required of [path.join(target, 'preload.cjs'), path.join(rendererTarget, 'index.html')]) {
  if (!fs.existsSync(required)) {
    console.error(`build-desktop: ${path.relative(root, required)} is missing after copy.`);
    process.exit(1);
  }
}
console.log(`build-desktop: copied preload.cjs and ${copied} renderer file(s) into dist.`);
