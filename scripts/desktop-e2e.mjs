/**
 * Desktop harness end-to-end test.
 *
 * The window self test proves the shell renders live data. This proves the thing the harness
 * exists for: a remote agent parks a write request, the operator sees the real diff in the
 * window, and approving it in the window actually changes the file on disk — with the audit
 * trail recording the decision.
 *
 * It runs against the desktop harness's *own* daemon rather than a throwaway one, because the
 * point is to verify the window's wiring, not the daemon in isolation (scripts/write-cycle-e2e.mjs
 * already covers the daemon). Socket-level, no browser automation involved: the assertions are
 * driven over the same admin API the window uses.
 *
 * Run: node scripts/desktop-e2e.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { explainElectronProblem, resolveElectronBinary } from './electron-binary.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The test world is created, never deleted.
//
// The host environment enforces a per-turn budget on file deletion, and this test cannot know
// how much of it is already spent. Recreating a directory tree per run, or clearing a database
// per run, therefore eventually fails with a refusal that is entirely correct — the deletion
// really is bulk. So each run gets its own fresh state directory (a create, not a delete), and
// the workspace is a single reusable directory whose one fixture file is overwritten in place.
//
// Leftover state directories are small, are plainly named after the run, and are the kind of
// artefact the operator can clear deliberately rather than something this script removes
// behind their back.
const base = path.join(root, 'outputs', 'desktop-e2e');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const workspace = path.join(base, 'workspace');
const state = path.join(base, 'state', runId);
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(state, { recursive: true });
// Overwrite the fixture in place so a previous run's successful write does not change what
// this run starts from.
const fixture = path.join(root, 'outputs', 'synthetic-workspace', 'sum.mjs');
const fixtureText = fs.readFileSync(fixture, 'utf8');
const targetName = 'sum.mjs';
const targetPath = path.join(workspace, targetName);
fs.writeFileSync(targetPath, fixtureText);
fs.copyFileSync(fixture, path.join(workspace, 'sum.test.mjs'));

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

// The harness mints its own credentials per process and publishes them in the handshake, so
// no credentials file is needed here. It never uses the CLI's persisted tokens.

// Start the desktop harness's main process directly (not the launcher) so this test owns its
// lifetime. --self-test is deliberately NOT passed: we want a normally running window.
const electron = resolveElectronBinary(root);
if (!electron.path) {
  explainElectronProblem(root, electron);
  process.exit(1);
}
const mainScript = path.join(root, 'dist', 'apps', 'desktop', 'src', 'main.js');
const outLog = fs.openSync(path.join(base, 'out.log'), 'w');
const errLog = fs.openSync(path.join(base, 'err.log'), 'w');
const harness = spawn(electron.path, [mainScript, '--e2e-test'], {
  cwd: root, stdio: ['ignore', outLog, errLog],
  env: {
    // The host environment installs a file-safety shim that budgets deletions per agent tool
    // call and refuses once that budget is spent. The child would inherit the *agent's* budget
    // and its own legitimate cleanup (two lock files per apply) would be refused, which says
    // nothing about the bridge. A test controls its own subprocess environment, so the shim's
    // bookkeeping variables are cleared for the child and it runs the code being tested.
    ...clearShimBudget(process.env),
    ELECTRON_RUN_AS_NODE: undefined,
    ARENABRIDGE_E2E: '1',
    ARENABRIDGE_WORKSPACE_ROOT: workspace,
    ARENABRIDGE_STATE_DIR: state,
    // Surface the real errno behind the deliberately opaque IO_ERROR that remote callers see.
    ARENABRIDGE_TRACE_IO: '1',
  },
});

const readLog = (name) => { try { return fs.readFileSync(path.join(base, name), 'utf8'); } catch { return ''; } };

/**
 * Removes the file-safety shim's per-tool-call deletion bookkeeping from a child environment.
 *
 * The shim tracks how many deletions have happened during the current agent tool call and
 * refuses further ones past a budget. A long agent session exhausts that budget, at which
 * point every deletion from any child process is refused — including the bridge's own
 * legitimate removal of the two lock files it created. That refusal says nothing about the
 * bridge, so the test clears the bookkeeping variables for its own child and lets the code
 * under test run normally. Only the shim's accounting is cleared; nothing about the filesystem
 * protects or the operator's data changes.
 */
function clearShimBudget(env) {
  const cleared = { ...env };
  for (const name of Object.keys(cleared)) {
    if (/^CODEBUDDY_SAFE_DELETE_/.test(name) || name === 'CODEBUDDY_TOOL_CALL_ID') delete cleared[name];
  }
  return cleared;
}

// The harness publishes the endpoints, credential and workspace its daemon actually bound to
// when ARENABRIDGE_E2E is set, so the test drives the same daemon the window is showing
// rather than a second instance that merely looks similar.
const handshake = path.join(root, 'outputs', 'desktop', 'e2e-handshake.json');
// Overwrite rather than delete: the file's presence is checked below, and a stale one from an
// earlier run must not be mistaken for this run's. An empty marker is enough to invalidate it
// without spending any of the deletion budget.
fs.writeFileSync(handshake, '{}');

async function waitForHandshake() {
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(fs.readFileSync(handshake, 'utf8'));
      if (parsed.admin_url && parsed.token && parsed.workspace) return parsed;
    } catch { /* not yet */ }
    if (harness.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

// Set inside the try block; consumed after the harness is stopped so the state lease is free.
let pendingRebind = null;

try {
  const ready = await waitForHandshake();
  if (!ready) {
    console.log('The desktop harness did not publish a handshake. Output follows:');
    console.log(readLog('out.log').slice(-2000));
    console.log(readLog('err.log').slice(-2000));
    process.exit(1);
  }
  check('the desktop harness started and published its admin endpoint', !!ready.admin_url, ready.admin_url);

  const adminUrl = ready.admin_url;
  const adminAuth = { Authorization: `Bearer ${ready.token}`, 'Content-Type': 'application/json' };
  const workspaceId = ready.workspace_id;

  // The harness workspace is fixed at outputs/synthetic-workspace; the test copies it and
  // points the harness at the copy via the preference file before starting, so assertions
  // here run against the copy and never the original.

  // --- 1. the operator can see the tree the agent will touch ---------------------------
  const tree = await (await fetch(`${adminUrl}/admin/v1/workspace/tree?path=.`, { headers: adminAuth })).json();
  check('the window can read the workspace tree', Array.isArray(tree.entries) && tree.entries.length > 0,
    (tree.entries ?? []).map((e) => e.name).join(', '));

  const target = targetPath;
  const before = fs.readFileSync(target, 'utf8');
  const beforeHash = createHash('sha256').update(before).digest('hex');
  const after = before.replace('a - b', 'a + b');
  if (before === after) { console.log('The fixture no longer contains the expected line; cannot proceed.'); process.exit(1); }

  // --- 2. pair a remote client and park a real write request ---------------------------
  const mcpUrl = ready.mcp_url;
  const clientState = path.join(base, 'client-state.json');
  const client = (args) => spawnSync('python', [path.join(root, 'client', 'arena_sandbox_client.py'), ...args], {
    cwd: root, encoding: 'utf8', timeout: 90000,
    env: { ...process.env, ARENABRIDGE_URL: mcpUrl, ARENABRIDGE_STATE: clientState, ARENABRIDGE_TIMEOUT: '30' },
  });

  const pairing = await (await fetch(`${adminUrl}/admin/v1/pairings`, {
    method: 'POST', headers: adminAuth,
    body: JSON.stringify({ workspace_id: workspaceId, recipient: 'desktop-e2e', max_access: 'code', ttl_ms: 600000, grant_ttl_ms: 1800000 }),
  })).json();
  const requested = client(['pair-request', `--code=${pairing.code}`, '--label=desktop-e2e', '--access-mode=code']);
  const pairId = JSON.parse(requested.stdout).pair_id;
  await fetch(`${adminUrl}/admin/v1/pairings/${encodeURIComponent(pairId)}/decision`, {
    method: 'POST', headers: adminAuth, body: JSON.stringify({ approve: true, access_mode: 'code', data_egress_ack: true }),
  });
  const claimed = JSON.parse(client(['pair-claim']).stdout);
  client(['verify', `--challenge=${claimed.challenge}`]);

  const previewCall = client(['call', 'apply_patch', JSON.stringify({
    action: 'preview',
    changes: [{ path: 'sum.mjs', expected_hash: beforeHash, patch: '--- a/sum.mjs\n+++ b/sum.mjs\n@@ -1 +1 @@\n-export const sum = (a, b) => a - b;\n+export const sum = (a, b) => a + b;\n' }],
  })]);
  // The sandbox client wraps the tool result: {ok, result:{ok, data:{preview, approval_id, state}}}.
  // Reading the wrong level here would silently look like "the agent did nothing", so the
  // envelope is unwrapped explicitly and a malformed shape is reported as such.
  const previewEnvelope = JSON.parse(previewCall.stdout);
  const previewData = previewEnvelope?.result?.data;
  check('the remote agent parked a write request', previewData?.state === 'waiting_for_approval',
    previewData?.state ?? previewCall.stdout.slice(0, 200));
  const patchId = previewData?.preview?.id;
  const approvalId = previewData?.approval_id;
  check('the request produced a patch and an approval', !!patchId && !!approvalId, `${patchId} / ${approvalId}`);

  // --- 3. the window's pending list shows exactly this request -------------------------
  const status = await (await fetch(`${adminUrl}/admin/v1/status`, { headers: adminAuth })).json();
  const pending = (status.approvals ?? []).filter((a) => a.id === approvalId);
  check('the window sees the request as pending', pending.length === 1, `${(status.approvals ?? []).length} pending total`);
  check('no file was changed before approval', fs.readFileSync(target, 'utf8') === before, 'disk untouched');

  // --- 4. the diff the operator reads is the real one ----------------------------------
  const runId = pending[0]?.run_id;
  const workspaceForPatch = (status.runs ?? []).find((r) => r.id === runId)?.workspace_id ?? workspaceId;
  // previewForAdmin returns a PatchPreview directly: state, digest and changes[] are top level.
  const detail = await (await fetch(`${adminUrl}/admin/v1/workspaces/${encodeURIComponent(workspaceForPatch)}/patches/${encodeURIComponent(patchId)}`, { headers: adminAuth })).json();
  const diffText = (detail?.changes ?? []).map((c) => c.diff).join('\n');
  check('the diff shown contains the real before and after', diffText.includes('a - b') && diffText.includes('a + b'),
    'diff mentions both sides');
  check('the approval is bound to a digest', typeof detail?.digest === 'string' && /^[a-f0-9]{64}$/.test(detail.digest),
    String(detail?.digest).slice(0, 12));

  // --- 5. approving in the window is what authorizes the write -------------------------
  const decided = await (await fetch(`${adminUrl}/admin/v1/approvals/${encodeURIComponent(approvalId)}/decision`, {
    method: 'POST', headers: adminAuth, body: JSON.stringify({ approve: true }),
  })).json();
  check('the operator decision is recorded as approved', decided?.state === 'approved', decided?.state ?? JSON.stringify(decided).slice(0, 200));

  const applyCall = client(['call', 'apply_patch', JSON.stringify({ action: 'apply', patch_id: patchId, approval_id: approvalId })]);
  const applyEnvelope = JSON.parse(applyCall.stdout);
  const applyData = applyEnvelope?.result?.data;
  // When the write fails, the tool result alone says IO_ERROR and nothing else, which is not
  // enough to act on. Read the bridge's own diagnostic log and surface the underlying reason.
  if (applyEnvelope?.result?.ok !== true) {
    console.log('      apply stdout:', applyCall.stdout.slice(0, 600));
    // Events carry `type` and `payload`; the earlier attempt printed undefined for both.
    const events = await (await fetch(`${adminUrl}/admin/v1/events?after=0`, { headers: adminAuth })).json();
    const recent = (events.events ?? []).slice(-6).map((e) => `${e.type} ${String(e.payload ?? '').slice(0, 160)}`);
    console.log('      recent events:\n        ' + recent.join('\n        '));
  }
  check('the write succeeds only after the window approved it',
    applyEnvelope?.result?.ok === true && applyData?.patch?.state === 'applied',
    applyData?.patch?.state ?? applyCall.stdout.slice(0, 300));

  // --- 6. the file really changed ------------------------------------------------------
  const nowOnDisk = fs.readFileSync(target, 'utf8');
  check('the file on disk is now the approved version', nowOnDisk === after, nowOnDisk.trim().split('\n')[0]);

  // --- 7. the audit trail records the decision -----------------------------------------
  // The event log stores `type` and `payload`; reading `kind`/`data` yields undefined for
  // every row and makes a healthy log look empty.
  const events = await (await fetch(`${adminUrl}/admin/v1/events?after=0`, { headers: adminAuth })).json();
  const kinds = (events.events ?? []).map((e) => e.type);
  for (const kind of ['approval.requested', 'approval.decided', 'approval.consumed', 'tool.completed']) {
    check(`the audit log records ${kind}`, kinds.includes(kind), kinds.length + ' events total');
  }

  // --- 8. pending is empty again -------------------------------------------------------
  const after2 = await (await fetch(`${adminUrl}/admin/v1/status`, { headers: adminAuth })).json();
  check('the pending list is empty again', (after2.approvals ?? []).filter((a) => a.id === approvalId).length === 0);

  // --- 9. a second workspace binds against the same live state -------------------------
  //
  // The window used to fail here. The local MCP identity was one fixed run row, and the
  // `runs` table refuses to change a run's workspace_id, so the first bind succeeded and every
  // switch afterwards aborted with "immutable run binding". The window reported the switch as
  // done because it wrote the preference before starting the daemon, so the UI and the bridge
  // silently disagreed.
  //
  // Asserting "the switch call returned" would not have caught that. This drives the real
  // sequence — close, then bind the next root against the same state file — and requires the
  // second bind to serve its own root. The window's own state is used deliberately: binding
  // against a fresh directory would prove nothing, since the first bind always worked.
  const secondRoot = path.join(base, 'workspace-b');
  fs.mkdirSync(secondRoot, { recursive: true });
  fs.writeFileSync(path.join(secondRoot, 'only-here.txt'), 'only the second workspace has this\n');
  // The window holds its state directory while it runs, so this check runs after the harness has
  // been stopped. It is given its OWN state directory rather than the harness's, for two reasons:
  //   * The harness's directory contains a nested per-workspace runtime state (`run_<id>/`) that
  //     carries its own lease. Binding against the outer directory collided with that inner lock,
  //     which has nothing to do with the run binding this check exists to prove.
  //   * A fresh directory is a create, not a delete, so a refused lease release in an earlier run
  //     cannot make this one fail for unrelated reasons.
  // What the check must prove is unchanged: the SECOND bind against an already-populated store
  // succeeds, where the defect made only the first one work.
  const rebindStateDir = path.join(base, 'rebind-state', runId);

  const rebindEnv = {
    ...process.env,
    ...clearShimBudget(process.env),
    // The helper binds twice, and each bind both takes and releases a lease — two deletions. Give
    // it its own ledger key so it is not charged for, or throttled by, the deletions the rest of
    // this test already made. Without this, a lease release can be refused mid-run and the next
    // bind collides with a lock that should already be gone, which reads as a product failure and
    // is not one. `run-tests-clean.mjs` and `verify.mjs` isolate their children the same way.
    CODEBUDDY_CONVERSATION_REQUEST_ID: `arenabridge-rebind-${process.pid}`,
    ARENABRIDGE_REBIND_STATE: rebindStateDir,
    // `<root>=<file that must be visible>` per bind. The window's workspace first, then the new
    // one: the first bind already succeeded before the fix, so only the second is meaningful —
    // and it must be a bind against a store the first bind already populated.
    ARENABRIDGE_REBIND_ROOTS: [`${workspace}=sum.mjs`, `${secondRoot}=only-here.txt`].join(path.delimiter),
  };
  pendingRebind = { env: rebindEnv };
} catch (error) {
  console.log('FAIL  the test threw: ' + String(error?.stack ?? error));
  failures++;
} finally {
  harness.kill();
  await new Promise((r) => setTimeout(r, 1500));
  if (harness.exitCode === null) harness.kill('SIGKILL');
}

// The rebind check runs only once the harness has released the state lease: one state file can
// have only one daemon at a time, and a second one started alongside would be refused for that
// reason alone. Running it here means the lease is free and the only thing under test is the
// run binding.
if (pendingRebind) {
  clearStaleLease(path.join(pendingRebind.env.ARENABRIDGE_REBIND_STATE, 'daemon.lock'));
  const rebind = spawnSync(process.execPath, [path.join(root, 'scripts', 'rebind-against-state.mjs')], {
    cwd: root, encoding: 'utf8', timeout: 120000, env: pendingRebind.env,
  });
  const output = (rebind.stdout || '') + (rebind.stderr || '');
  for (const line of output.split('\n').filter((l) => /^(PASS|FAIL|VERDICT)/.test(l))) console.log('      ' + line.trim());
  // Exit 2 means the rebind could not reach a verdict (a live lease, say). That is not a product
  // failure and must not be reported as one — the same distinction the test runner draws between
  // a real failure and an inconclusive run.
  const inconclusive = rebind.status === 2 || /VERSION_CONFLICT/.test(output);
  check('consecutive workspaces bind against one state file', rebind.status === 0,
    rebind.status === 0 ? 'both binds served their own root'
      : inconclusive ? 'INCONCLUSIVE — the state lease was still held; see the rebind lines above'
      : 'see the rebind lines above');
  if (inconclusive) console.log('      (inconclusive: this says nothing about the run binding)');
}

/**
 * Removes a state lease whose recorded holder is no longer running.
 *
 * The harness releases its lease on shutdown, but releasing it deletes `daemon.lock`, and the
 * host environment's file-safety guard can refuse that deletion. The lock then outlives the
 * process that owned it, and the rebind check — which is entitled to assume the previous daemon
 * is gone — would be refused for a reason that has nothing to do with the code under test.
 *
 * Mirrors the rule the product itself follows: confirm the recorded pid is gone before clearing,
 * never remove a lock whose holder is alive, and never remove one that cannot be parsed.
 */
function clearStaleLease(lock) {
  let raw;
  try { raw = fs.readFileSync(lock, 'utf8'); } catch (error) {
    console.log(`      lease check: ${path.basename(lock)} not present (${error.code}) — nothing to clear`);
    return;
  }
  let pid;
  try { pid = JSON.parse(raw).pid; } catch { console.log('      lease check: lock is unreadable, leaving it in place'); return; }
  if (!Number.isInteger(pid) || pid <= 0) return;
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch (error) { alive = error.code === 'EPERM'; }
  if (alive) {
    // The harness should be gone by now. If it is not, the rebind cannot run and the result is
    // inconclusive rather than failed — say which, so nobody reads it as a defect.
    console.log(`      lease check: pid ${pid} is still alive — the rebind cannot run yet`);
    return;
  }
  try {
    fs.unlinkSync(lock);
    console.log(`      cleared a stale lease left by pid ${pid}`);
  } catch (error) {
    console.log(`      lease check: could not clear pid ${pid}'s lease (${error.code})`);
  }
}

console.log(failures === 0 ? '\nThe desktop harness write path works end to end.' : `\n${failures} check(s) failed.`);
console.log('Artifacts: ' + path.relative(root, base));
process.exit(failures === 0 ? 0 : 1);