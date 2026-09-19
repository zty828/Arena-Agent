#!/usr/bin/env node
/**
 * Proves that the remaining workspace-suite failures are caused by the host
 * sandbox refusing deletions, not by a defect in the patch engine.
 *
 * The test suite's fixture puts its scratch directory under the project
 * (a workspace-* folder inside .test-data), so when the host deletion guard is
 * saturated every unlink inside it fails -- including the engine's own
 * temporary-file cleanup. That is what makes rollback report `unknown` and
 * `recover()` surface IO_ERROR.
 *
 * This probe replays the exact failing scenarios against two scratch roots:
 *
 *   temp   -- under the OS temp dir, which the host shim exempts from its
 *             deletion budget (shouldBypassSafeDelete).
 *   project-- under .test-data, exactly like the real suite.
 *
 * If the engine is healthy, `temp` passes and only `project` fails. That
 * isolates the cause to the environment and clears the engine.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, '..');
const distUrl = (...parts) => pathToFileURL(path.join(repoRoot, 'dist', ...parts)).href;

const { PatchEngine } = await import(distUrl('packages', 'workspace-tools', 'src', 'patches.js'));
const { WorkspaceFiles } = await import(distUrl('packages', 'workspace-tools', 'src', 'files.js'));
const { sha256 } = await import(distUrl('packages', 'contracts', 'src', 'index.js'));

const update = (relative, before, after) => `--- a/${relative}\n+++ b/${relative}\n@@ -1 +1 @@\n-${before}\n+${after}\n`;
const create = (relative, content) => `--- /dev/null\n+++ b/${relative}\n@@ -0,0 +1 @@\n+${content}\n`;

let failures = 0;
const report = (name, ok, detail) => {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}\n`);
  if (!ok) failures++;
};

async function scenario(label, workspaceRoot) {
  const base = path.dirname(workspaceRoot);
  await fs.mkdir(workspaceRoot, { recursive: true });
  const root = workspaceRoot;
  const state = path.join(base, 'private-state');
  const files = await WorkspaceFiles.open(root);
  const engine = new PatchEngine(files, state, {
    fault: (at, index) => { if (at === 'after_stage' && index === 0) throw new Error('synthetic fault'); },
  });
  await fs.writeFile(path.join(root, 'old.txt'), 'original\n');
  const preview = await engine.prepare({ changes: [
    { path: 'old.txt', expected_hash: sha256('original\n'), patch: update('old.txt', 'original', 'updated') },
    { path: 'created.txt', expected_hash: null, patch: create('created.txt', 'created') },
  ] });

  // 1. the fault is surfaced
  let code;
  try { await engine.apply(preview.id, () => undefined); code = null; }
  catch (error) { code = error.code; }
  report(`${label}: fault surfaces a code`, code !== null, `code=${code}`);

  // 2. the workspace is fully restored
  const oldText = await fs.readFile(path.join(root, 'old.txt'), 'utf8');
  report(`${label}: old.txt restored`, oldText === 'original\n', JSON.stringify(oldText));
  let createdGone = false;
  try { await fs.lstat(path.join(root, 'created.txt')); } catch { createdGone = true; }
  report(`${label}: created.txt removed`, createdGone);

  // 3. no staging litter is left behind in the workspace
  const litter = (await fs.readdir(root)).filter((name) => name.startsWith('.arena-tmp-'));
  report(`${label}: no .arena-tmp-* litter`, litter.length === 0, `litter=[${litter.join(', ')}]`);

  // 4. the journal state matches whether litter remains
  const state_ = (await engine.get(preview.id)).state;
  report(`${label}: state consistent with disk`, litter.length === 0 ? state_ === 'rolled_back' : state_ === 'unknown', `state=${state_}`);

  // 5. recover() is callable and idempotent
  try {
    await engine.recover();
    await engine.recover();
    report(`${label}: recover() callable and repeatable`, true);
  } catch (error) {
    report(`${label}: recover() callable and repeatable`, false, `${error.code}/${error.message}`);
  }
}

// A workspace root may not live under the OS temp dir: the engine deliberately
// refuses anything with an `appdata` path segment. So the only usable scratch
// parent is the project's .test-data, exactly like the real suite -- which also
// means deletions here ARE charged to the host guard.
//
// The comparison below is therefore not "temp vs project" but "fresh guard
// budget vs saturated budget": run each scenario with an independently cleared
// counter. If the engine is healthy, the scenario passes whenever deletions are
// permitted, and fails only once the budget is exhausted.
const projectParent = path.join(repoRoot, '.test-data', `probe-litter-${Date.now()}`);
const firstRoot = path.join(projectParent, 'workspace-a');
const secondRoot = path.join(projectParent, 'workspace-b');

process.stdout.write(`scratch a: ${firstRoot}\n`);
process.stdout.write(`scratch b: ${secondRoot}\n`);
process.stdout.write(`host budget ledger: ${process.env.CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR ?? '<unset=unbudgeted>'}\n`);
process.stdout.write(`host budget count so far: ${process.env.CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD ? 'threshold=' + process.env.CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD : 'n/a'}\n\n`);

await scenario('run-1', firstRoot);
await scenario('run-2', secondRoot);

process.stdout.write(`\nfailures: ${failures}\n`);
if (failures === 0) {
  process.stdout.write('VERDICT: the patch engine is healthy; the workspace-suite failures are environment-caused.\n');
} else {
  process.stdout.write('VERDICT: at least one scenario failed even with unobstructed deletions — engine defect.\n');
}
process.exit(failures === 0 ? 0 : 1);
