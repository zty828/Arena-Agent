#!/usr/bin/env node
/**
 * Exercises the write path end to end, which has never been run from a remote agent.
 *
 * The existing suites only prove the negative ("a read-only grant cannot preview a
 * patch"). This drives the positive path with a `code` grant:
 *
 *   pair(code) -> local approval -> claim -> challenge -> tools
 *     -> apply_patch(preview)  => real diff + patch_id, file untouched on disk
 *     -> local approval        => approval_id
 *     -> apply_patch(apply)    => file changed on disk
 *     -> replay the same approval must fail (single use)
 *
 * It works on a throwaway copy of the synthetic workspace so the shared fixture is
 * never modified.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const credentials = JSON.parse(fs.readFileSync(path.join(root, '.arena-bridge', 'local-credentials.json'), 'utf8'));

const results = [];
const check = (name, passed, detail) => { results.push({ name, passed: !!passed, detail }); };

/**
 * The tool payload from a `call` invocation's printed JSON.
 *
 * `do_call` prints the tool's own fields under `data` and does not echo the whole
 * `{ok, data, metadata}` envelope a second time (that doubled every response, including a
 * 37KB diff). The `result` fallback is kept so this still reads output from an older client.
 */
const callData = (run) => run?.data?.data ?? run?.data?.result?.data;


const stamp = Date.now();
const state = path.join(root, 'outputs', 'write-cycle', `s-${stamp}`);
// The workspace must NOT live inside the state directory: the patch journal validates
// that the two roots do not overlap, and nesting them makes every write a PATH_DENIED.
const workspace = path.join(root, 'outputs', 'write-cycle-workspace', `ws-${stamp}`);
fs.mkdirSync(state, { recursive: true });
fs.mkdirSync(workspace, { recursive: true });
for (const name of fs.readdirSync(path.join(root, 'outputs', 'synthetic-workspace'))) {
  fs.copyFileSync(path.join(root, 'outputs', 'synthetic-workspace', name), path.join(workspace, name));
}
const target = path.join(workspace, 'sum.mjs');
const before = fs.readFileSync(target, 'utf8');
check('the working copy starts from the known fixture', before.includes('a - b'), before.trim());

const config = {
  schema_version: 1,
  state_directory: state,
  ports: { api: 0, mcp: 0, mcp_remote: 0, admin: 0 },
  workspaces: [{ root: workspace, display_name: 'Write cycle workspace' }],
  response_mode: 'json',
  security_profile: 'local_trusted_development',
  arena_enabled: false,
  gateway: { type: 'disabled' },
};
const configPath = path.join(state, 'config.json');
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

const daemon = spawn(process.execPath, [path.join(root, 'dist', 'apps', 'daemon', 'src', 'cli.js'), 'serve', '--config', configPath], {
  cwd: root,
  stdio: ['ignore', fs.openSync(path.join(state, 'out.log'), 'w'), fs.openSync(path.join(state, 'err.log'), 'w')],
  env: {
    ...process.env,
    ARENABRIDGE_ADMIN_TOKEN: credentials.admin_token,
    ARENABRIDGE_API_TOKEN: credentials.api_token,
    ARENABRIDGE_MCP_TOKEN: credentials.mcp_token,
  },
});

const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
const clientState = path.join(state, 'client-state.json');
const clientScript = path.join(root, 'client', 'arena_sandbox_client.py');
let mcpUrl = '';
const runClient = (args) => {
  const result = spawnSync('python', [clientScript, ...args], {
    cwd: root, encoding: 'utf8', timeout: 90000,
    env: { ...process.env, ARENABRIDGE_URL: mcpUrl, ARENABRIDGE_STATE: clientState, ARENABRIDGE_TIMEOUT: '30' },
  });
  let data; try { data = result.stdout ? JSON.parse(result.stdout) : undefined; } catch { data = undefined; }
  return { status: result.status, stderr: result.stderr ?? '', data };
};

try {
  const deadline = Date.now() + 25000;
  let ready;
  while (Date.now() < deadline) {
    try {
      const text = fs.readFileSync(path.join(state, 'out.log'), 'utf8');
      const line = text.split('\n').find((entry) => entry.includes('daemon.ready'));
      if (line) { ready = JSON.parse(line); break; }
    } catch { /* not yet */ }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (!ready) throw new Error('bridge not ready: ' + fs.readFileSync(path.join(state, 'err.log'), 'utf8').slice(-300));
  const admin = ready.urls.admin;
  mcpUrl = ready.urls.mcp;
  const workspaceId = ready.workspaces[0].id;

  // Pair with code scope, which is what unlocks apply_patch.
  const pairing = await (await fetch(`${admin}/admin/v1/pairings`, {
    method: 'POST', headers: auth(credentials.admin_token),
    body: JSON.stringify({ workspace_id: workspaceId, recipient: 'Write cycle test', max_access: 'code', ttl_ms: 600000, grant_ttl_ms: 1800000 }),
  })).json();
  const requested = runClient(['pair-request', `--code=${pairing.code}`, '--label=write-cycle', '--access-mode=code']);
  check('the remote agent requested code access', requested.status === 0 && requested.data?.ok === true, requested.data ?? requested.stderr.slice(0, 200));

  await fetch(`${admin}/admin/v1/pairings/${encodeURIComponent(requested.data.pair_id)}/decision`, {
    method: 'POST', headers: auth(credentials.admin_token),
    body: JSON.stringify({ approve: true, access_mode: 'code', data_egress_ack: true }),
  });
  const claimed = runClient(['pair-claim']);
  check('the grant carries the patch scope', claimed.status === 0 && (claimed.data?.scopes ?? []).includes('workspace:patch'), claimed.data?.scopes);
  runClient(['verify', `--challenge=${claimed.data.challenge}`]);

  const tools = runClient(['tools']);
  const names = (tools.data?.tools ?? []).map((tool) => tool.name);
  check('apply_patch is offered only with code access', names.includes('apply_patch'), names);

  // Preview must produce a real diff without touching the file.
  // expected_hash must be the file's current sha256: null means "create", which a
  // conflicting file rejects with VERSION_CONFLICT.
  const beforeHash = createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  const preview = runClient(['call', 'apply_patch', JSON.stringify({
    action: 'preview',
    changes: [{ path: 'sum.mjs', expected_hash: beforeHash, patch: '--- a/sum.mjs\n+++ b/sum.mjs\n@@ -1 +1 @@\n-export const sum = (a, b) => a - b;\n+export const sum = (a, b) => a + b;\n' }],
  })]);
  const patchId = callData(preview)?.preview?.id;
  const previewApprovalId = callData(preview)?.approval_id;
  const previewDigest = callData(preview)?.preview?.digest;
  check('preview returns a patch id', typeof patchId === 'string' && patchId.length > 0, { patch_id: patchId, digest: previewDigest, approval_id: previewApprovalId, raw: patchId ? undefined : (preview.data ?? preview.stderr.slice(0, 220)) });
  check('preview leaves the file untouched on disk', fs.readFileSync(target, 'utf8') === before, fs.readFileSync(target, 'utf8').trim());

  // A stale expected_hash must be rejected rather than silently overwriting.
  const stale = runClient(['call', 'apply_patch', JSON.stringify({
    action: 'preview',
    changes: [{ path: 'sum.mjs', expected_hash: '0'.repeat(64), patch: '--- a/sum.mjs\n+++ b/sum.mjs\n@@ -1 +1 @@\n-export const sum = (a, b) => a - b;\n+export const sum = (a, b) => a + b;\n' }],
  })]);
  const stalePayload = stale.data?.result ?? stale.data ?? {};
  check('a stale expected_hash is refused', stalePayload.ok === false && stalePayload.error?.code === 'VERSION_CONFLICT', { ok: stalePayload.ok, code: stalePayload.error?.code, status: stale.status });
  check('the refused preview created no patch on disk', fs.readFileSync(target, 'utf8') === before, fs.readFileSync(target, 'utf8').trim());

  // The operator must be able to review the real diff before approving.
  if (patchId) {
    const review = await fetch(`${admin}/admin/v1/workspaces/${encodeURIComponent(workspaceId)}/patches/${encodeURIComponent(patchId)}`, { headers: auth(credentials.admin_token) });
    const previewBody = await review.json();
    const diffText = JSON.stringify(previewBody);
    check('the operator can read the diff from the console API', review.status === 200 && diffText.includes('a + b'), { status: review.status, bytes: diffText.length });
  }

  const pending = await (await fetch(`${admin}/admin/v1/status`, { headers: auth(credentials.admin_token) })).json();
  const approvalId = pending.approvals?.[0]?.id ?? previewApprovalId;
  check('an approval is parked and waiting for the operator', typeof approvalId === 'string', { pending: pending.approvals?.length ?? 0, approval_id: approvalId });

  // Applying before approval must be refused.
  if (patchId) {
    const premature = runClient(['call', 'apply_patch', JSON.stringify({ action: 'apply', patch_id: patchId, approval_id: 'approval_does_not_exist' })]);
    check('apply is refused without a valid approval', premature.status !== 0 || premature.data?.ok === false, { status: premature.status, stderr: premature.stderr.trim().slice(0, 160) });
  }

  if (approvalId) {
    const decision = await (await fetch(`${admin}/admin/v1/approvals/${encodeURIComponent(approvalId)}/decision`, {
      method: 'POST', headers: auth(credentials.admin_token), body: JSON.stringify({ approve: true }),
    })).json();
    check('the operator approved the patch', decision.state === 'approved', decision);
  }

  if (patchId && approvalId) {
    const applied = runClient(['call', 'apply_patch', JSON.stringify({ action: 'apply', patch_id: patchId, approval_id: approvalId })]);
    check('apply succeeds with the approved pair', applied.status === 0 && applied.data?.ok !== false, applied.data ?? applied.stderr.slice(0, 200));

    const after = fs.readFileSync(target, 'utf8');
    check('the file actually changed on disk', after.includes('a + b') && !after.includes('a - b'), after.trim());

    // Single use: the approval is consumed exactly once. A replay must NOT re-run the
    // authorization callback, and must not write again. The engine answers "already
    // executed" from the private journal instead of re-consuming the approval.
    const replay = runClient(['call', 'apply_patch', JSON.stringify({ action: 'apply', patch_id: patchId, approval_id: approvalId })]);
    const replayed = callData(replay) ?? {};
    check('the replay does not re-execute the write', replayed.patch?.state === 'applied' && replayed.effect === 'already_executed', { state: replayed.patch?.state, effect: replayed.effect, status: replay.status });
    check('the replay leaves the file byte-identical', fs.readFileSync(target, 'utf8') === after, fs.readFileSync(target, 'utf8').trim());
    check('the approval is marked consumed, never reusable', replayed.patch?.state === 'applied', { state: replayed.patch?.state });
  }

  // The remote's own commands, through the real client, on the exec tier.
  //
  // This runs here rather than in `probe:exec` for a hard environmental reason: a child process in
  // this environment cannot read from a loopback port held by its *parent*, and that probe runs the
  // daemon in-process. This script spawns the daemon as a separate process, which is the only shape
  // where the python client can talk to it.
  //
  // It exists because of a real defect: `exec` was added to the engine, the prompt and the window's
  // picker, but not to the client's argparse whitelist — `pair-request --access-mode=exec` died
  // client-side with exit 2 and no network traffic, which looks exactly like a server refusal.
  {
    const execPairing = await (await fetch(`${admin}/admin/v1/pairings`, {
      method: 'POST', headers: auth(credentials.admin_token),
      body: JSON.stringify({ workspace_id: workspaceId, recipient: 'exec via client', max_access: 'exec', ttl_ms: 1800000 }),
    })).json();
    const execRequest = runClient(['pair-request', `--code=${execPairing.code}`, '--label=exec-client', '--access-mode=exec']);
    check('the real client can request the exec tier',
      execRequest.status === 0 && typeof execRequest.data?.pair_id === 'string',
      { status: execRequest.status, stderr: (execRequest.stderr ?? '').slice(0, 160), pair_id: execRequest.data?.pair_id });
    check('and the server accepts it rather than the request dying in argparse',
      typeof execRequest.data?.claim_secret === 'string', { claim_secret: execRequest.data?.claim_secret ? 'present' : 'MISSING' });
    await fetch(`${admin}/admin/v1/pairings/${encodeURIComponent(execRequest.data.pair_id)}/decision`, {
      method: 'POST', headers: auth(credentials.admin_token),
      body: JSON.stringify({ approve: true, access_mode: 'exec', data_egress_ack: true }),
    });
    const execClaim = runClient(['pair-claim', `--pair-id=${execRequest.data.pair_id}`, `--claim-secret=${execRequest.data.claim_secret}`]);
    check('the client claims an exec grant and reports its scopes',
      execClaim.status === 0 && execClaim.data?.access_mode === 'exec' && (execClaim.data?.scopes ?? []).includes('workspace:exec'),
      { access_mode: execClaim.data?.access_mode, scopes: execClaim.data?.scopes });
    // A workspace whose content lives in folders must not read as empty.
    //
    // Reported by the operator: the workspace root held a single directory and no files, so
    // `agent-check` reported `file_count: 0` with an empty `first_text_files` — and the remote
    // agent, whose step 7 is "read the first entry of first_text_files", concluded the workspace
    // was empty. It had no way to tell that from "everything is one level down".
    fs.mkdirSync(path.join(workspace, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'nested', 'deep.txt'), 'deep\n');

    // `agent-check` takes no arguments and prints several JSON documents, one per line — parsing
    // the whole stdout would fail on the second one, so each document is picked out by its key.
    const execCheck = spawnSync('python', [clientScript, 'agent-check'], {
      cwd: root, encoding: 'utf8', timeout: 90000,
      env: { ...process.env, ARENABRIDGE_URL: mcpUrl, ARENABRIDGE_STATE: clientState, ARENABRIDGE_TIMEOUT: '30', ARENABRIDGE_TOKEN: execClaim.data.token },
    });
    /** Every top-level JSON object in the client's output, in order. */
    const parseDocs = (stdout) => {
      const found = [];
      let depth = 0, start = -1;
      const text = stdout ?? '';
      for (let i = 0; i < text.length; i += 1) {
        if (text[i] === '{') { if (depth === 0) start = i; depth += 1; }
        else if (text[i] === '}') {
          depth -= 1;
          if (depth === 0 && start >= 0) {
            try { found.push(JSON.parse(text.slice(start, i + 1))); } catch { /* not a document */ }
            start = -1;
          }
        }
      }
      return found;
    };
    const docs = parseDocs(execCheck.stdout);
    if (!docs.some((doc) => doc.first_text_files)) console.log('DEBUG agent-check stdout:', JSON.stringify((execCheck.stdout ?? '').slice(-600)));
    const toolsDoc = docs.find((doc) => Array.isArray(doc.tools));
    check('agent-check lists run_command for an exec grant', toolsDoc?.tools?.includes('run_command'),
      { tools: toolsDoc?.tools });
    const listing = docs.find((doc) => doc.first_text_files);
    check('agent-check finds a readable file inside a subdirectory',
      listing?.first_text_files?.some((entry) => entry.includes('nested/deep.txt') || entry.includes('nested\\deep.txt')),
      { first_text_files: listing?.first_text_files, searched: listing?.subdirectories_searched });
    check('and it names the directories so the caller can go deeper',
      Array.isArray(listing?.directory_names) && listing.directory_names.some((name) => name.includes('nested')),
      { directory_names: listing?.directory_names });
    check('and it says not to read an empty root as an empty workspace',
      /do not report the workspace as empty|report what you see/.test(listing?.note ?? ''),
      { note: listing?.note });
  }

  // The audit trail must show the whole sequence: request -> local decision -> single use.
  //
  // This fetch follows a multi-second `spawnSync` of the python client, and Node's HTTP server
  // closes idle keep-alive sockets after 5s. undici can then hand this request a socket the
  // daemon has already closed, which surfaces as a bare `TypeError: fetch failed` with
  // `cause: ECONNRESET` — measured here on roughly one run in three. The dead socket is dropped
  // when that happens, so one retry is enough; a real HTTP error is never retried.
  const getEvents = async () => {
    try {
      return await (await fetch(`${admin}/admin/v1/events`, { headers: auth(credentials.admin_token) })).json();
    } catch (error) {
      const cause = error?.cause?.code;
      if (cause !== 'ECONNRESET' && cause !== 'EPIPE') throw error;
      return await (await fetch(`${admin}/admin/v1/events`, { headers: auth(credentials.admin_token) })).json();
    }
  };
  const events = await getEvents();
  const types = (events.events ?? []).map((event) => event.type);
  const unique = [...new Set(types)];
  check('the requested approval is recorded', unique.includes('approval.requested'), unique);
  check('the local decision is recorded', unique.includes('approval.decided'), unique);
  check('the single-use consumption is recorded', unique.includes('approval.consumed'), unique);
  check('the applied write is recorded as a completed patch tool', types.includes('tool.completed'), unique);
  const blob = JSON.stringify(events);
  check('the audit log still holds no credentials or file bodies', !blob.includes(credentials.admin_token) && !blob.includes(credentials.api_token) && !blob.includes('a + b'), undefined);
} catch (error) {
  check('write cycle completed without throwing', false, String(error));
} finally {
  daemon.kill('SIGTERM');
  await new Promise((resolve) => { const timer = setTimeout(resolve, 6000); daemon.once('exit', () => { clearTimeout(timer); resolve(); }); });
  if (daemon.exitCode === null) daemon.kill('SIGKILL');
}

const passed = results.filter((entry) => entry.passed).length;
fs.writeFileSync(path.join(root, 'outputs', 'write-cycle-e2e.json'), JSON.stringify({
  created_at: new Date().toISOString(),
  scope: 'Positive write path driven by the remote client: preview, local review, approval, apply, and single-use enforcement. Runs on a throwaway workspace copy.',
  total: results.length, passed, failed: results.length - passed, results,
}, null, 2) + '\n');
for (const entry of results) console.log(`${entry.passed ? 'PASS' : 'FAIL'}  ${entry.name}${entry.detail !== undefined ? ' :: ' + JSON.stringify(entry.detail).slice(0, 180) : ''}`);
console.log(`\n${passed}/${results.length} passed -> outputs/write-cycle-e2e.json`);
process.exitCode = passed === results.length ? 0 : 1;
