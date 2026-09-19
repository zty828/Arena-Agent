#!/usr/bin/env node
/**
 * Proves that the local MCP identity can be bound to more than one workspace.
 *
 * Originally the identity was materialised as a singleton: one principal, one run
 * (`run_local_mcp`), one grant, all with fixed ids. The `runs` table carries a trigger
 * forbidding any update that changes execution_owner / workspace_id / mode /
 * principal_id. So:
 *
 *   bind workspace A  -> run_local_mcp inserted with workspace_id = A
 *   bind workspace B  -> store.put('runs', run) UPDATEs that row to workspace B
 *                     -> trigger aborts: "immutable run binding"
 *
 * The first bind worked and every later workspace switch failed. The fix derives the run
 * and grant ids from the workspace id, so each bind is a fresh INSERT and the trigger is
 * never asked to allow a rebind of an existing execution binding.
 *
 * The trigger itself is deliberately kept: an execution binding must never be silently
 * rebound. That is why the ids moved rather than the trigger.
 *
 * This runs against a throwaway state directory and never touches the desktop harness's
 * real state. Exit code 0 means every bind succeeded.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, '..');
const distUrl = (...parts) => pathToFileURL(path.join(repoRoot, 'dist', ...parts)).href;

const { Store } = await import(distUrl('packages', 'storage', 'src', 'index.js'));
const { PolicyEngine } = await import(distUrl('packages', 'policy-engine', 'src', 'index.js'));
const { newSecret } = await import(distUrl('packages', 'contracts', 'src', 'index.js'));

const base = path.join(repoRoot, '.test-data', `probe-rebind-${Date.now()}`);
await fs.mkdir(base, { recursive: true });
const stateDir = path.join(base, 'state');
await fs.mkdir(stateDir, { recursive: true });

const say = (line) => process.stdout.write(`${line}\n`);
say(`state dir: ${stateDir}\n`);

const A = path.join(base, 'workspace-a');
const B = path.join(base, 'workspace-b');
const C = path.join(base, 'workspace-c');
for (const dir of [A, B, C]) await fs.mkdir(dir, { recursive: true });

const store = new Store(path.join(stateDir, 'state.sqlite'));

// One engine per "daemon start", exactly as the desktop harness does: each
// workspace switch restarts the daemon, which generates fresh credentials and a
// fresh epoch. A new epoch means ensureLocalMcpGrant() recreates its records.
let epochCounter = 0;
function bind(label, workspaceId) {
  epochCounter += 1;
  const engine = new PolicyEngine(store, { adminToken: newSecret(), clientToken: newSecret(), mcpToken: newSecret() }, epochCounter);
  try {
    engine.ensureLocalMcpGrant(workspaceId);
    const run = store.get('runs', engine.localMcpContext(workspaceId).grant.run_id);
    const grant = store.get('grants', `grant_local_mcp:${workspaceId}`);
    // Binding is not enough on its own: the context the loopback client would act as must
    // resolve to a grant whose workspace matches, otherwise the switch is cosmetic.
    const context = engine.localMcpContext(workspaceId);
    const bound = run?.workspace_id === workspaceId && grant?.workspace_id === workspaceId
      && context.grant.workspace_id === workspaceId && context.grant.run_id === run?.id;
    say(`${bound ? 'PASS' : 'FAIL'}  ${label} ${bound ? 'bound' : 'bound but inconsistent'}  — run=${run?.id} run.workspace_id=${run?.workspace_id} grant.workspace_id=${grant?.workspace_id}`);
    return { ok: bound };
  } catch (error) {
    say(`FAIL  ${label} refused  — ${error.code ?? error.name}: ${error.message}${error.errstr ? ` (${error.errstr})` : ''}`);
    return { ok: false };
  }
}

const first = bind('first bind  (workspace A)', 'ws_a');
const second = bind('second bind (workspace B)', 'ws_b');
const third = bind('third bind  (workspace C)', 'ws_c');
// Rebinding the SAME workspace on a new epoch must still work: a restart rotates credentials
// and the local identity has to be refreshed, not refused for already existing.
const fourth = bind('rebind      (workspace A)', 'ws_a');

say('');
say('--- what is actually stored afterwards ---');
for (const workspaceId of ['ws_a', 'ws_b', 'ws_c']) {
  const run = store.get('runs', `run_local_mcp:${workspaceId}`);
  const grant = store.get('grants', `grant_local_mcp:${workspaceId}`);
  say(`  ws=${workspaceId}  run: workspace_id=${run?.workspace_id ?? '<none>'} state=${run?.state ?? '-'}  grant: workspace_id=${grant?.workspace_id ?? '<none>'} epoch=${grant?.epoch ?? '-'}`);
}
say('');
say('--- each row must still be pinned to exactly one workspace ---');
const runs = store.all('runs').filter((row) => row.id.startsWith('run_local_mcp'));
const distinct = new Set(runs.map((row) => `${row.id}=${row.workspace_id}`));
say(`  local mcp runs stored: ${runs.length} (${[...distinct].join(', ')})`);

const allOk = first.ok && second.ok && third.ok && fourth.ok;
say('');
say(`  first=${first.ok} second=${second.ok} third=${third.ok} rebind=${fourth.ok}`);
if (allOk) {
  say('VERDICT: fixed — every workspace binds to its own run/grant, so switching the desktop');
  say('         working directory no longer collides with the immutable run binding.');
} else {
  say('VERDICT: not fixed — at least one bind was refused or left inconsistent; inspect above.');
}
process.exit(allOk ? 0 : 1);
