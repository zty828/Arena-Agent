/**
 * Can the window see and approve a pairing request?
 *
 * The reported failure: the remote agent submitted a pairing request and got a pair_id back, but
 * nothing appeared in the window to approve. The request WAS in the database at state `pending`
 * — the window simply had no code to list or decide pairings. It only ever CREATED them. The
 * on-screen instructions pointed at the 待办 page, which lists write approvals, not pairings.
 *
 * This drives the real daemon over the same admin API the window uses, and asserts the whole
 * operator-visible path: the request shows up in GET /admin/v1/status, and the exact decision
 * call the new button makes is accepted.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createDaemon } = await import(pathToFileURL(path.join(root, 'dist', 'apps', 'daemon', 'src', 'server.js')).href);

let failures = 0;
const check = (ok, message) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`);
};

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-pair-'));
const adminToken = 'a'.repeat(48);
const daemon = await createDaemon({
  schema_version: 1,
  state_directory: stateDir,
  ports: { api: 0, mcp: 0, mcp_remote: 0, admin: 0 },
  workspaces: [{ root, display_name: 'pair-check' }],
  response_mode: 'json',
  security_profile: 'local_trusted_development',
  arena_enabled: false,
  remote_ingress: { enabled: false, acknowledge_exposure: false, bind_address: '127.0.0.1', allow_cidrs: [], allowed_hosts: [], require_grant: true },
  gateway: { type: 'disabled' },
}, { adminToken, clientToken: 'b'.repeat(48), mcpToken: 'c'.repeat(48) });

const admin = daemon.urls.admin;
const auth = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };
const call = async (method, route, body) => {
  const res = await fetch(admin + route, { method, headers: auth, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
  return { status: res.status, data };
};

const workspaceId = daemon.workspaces[0].id;

// 1) The window creates a pairing code — this part already worked.
const created = await call('POST', '/admin/v1/pairings', {
  workspace_id: workspaceId, recipient: 'Arena Agent (desktop window)', max_access: 'ask', ttl_ms: 1800000, grant_ttl_ms: 3600000,
});
check(created.status === 201 && typeof created.data?.code === 'string', `the window can mint a pairing code (HTTP ${created.status})`);
const code = created.data.code;

// 2) A fresh pairing is 'created', so it must NOT yet be offered for approval.
let status = await call('GET', '/admin/v1/status');
check((status.data.pairings || []).length === 0, 'a pairing that nobody has requested yet is not shown as awaiting approval');

// 3) The remote agent requests the pairing over the wire. This is what produced the reported
//    pair_id. Done over the MCP listener so it exercises the real submission path. The route is
//    deliberately auth-exempt (the remote agent has no credential yet) and returns 202.
const mcpPort = Number(new URL(daemon.urls.mcp).port);
const requested = await fetch(`http://127.0.0.1:${mcpPort}/pair/request`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code, remote_label: 'Arena Agent (desktop window)', access_mode: 'ask' }),
});
const requestedBody = await requested.text();
check(requested.status === 202, `the remote agent can submit a pair request (HTTP ${requested.status})`);
let reportedPairId;
try { reportedPairId = JSON.parse(requestedBody).pair_id; } catch { /* reported below */ }
check(typeof reportedPairId === 'string' && reportedPairId.startsWith('pair_'), `the request returns a pair_id to the agent (${reportedPairId ?? requestedBody.slice(0, 120)})`);

// 4) THE REPORTED BUG: the request must now be visible to the operator.
status = await call('GET', '/admin/v1/status');
const pending = status.data.pairings || [];
check(pending.length === 1, `the request is listed for the operator to approve (${pending.length} pending)`);
if (pending.length) {
  const p = pending[0];
  // The pair_id the operator sees must be the one the agent was told, or they cannot correlate them.
  check(p.pair_id === reportedPairId, 'the listed pair_id matches the one the remote agent reported');
  // Every field the new panel renders must be present, or the card would render blanks.
  for (const field of ['pair_id', 'workspace_id', 'requested_access', 'recipient', 'expires_at']) {
    check(p[field] !== undefined && p[field] !== null, `the pending entry carries ${field}`);
  }
  // The approve button sends exactly this shape; it must be accepted.
  const decided = await call('POST', `/admin/v1/pairings/${p.pair_id}/decision`, { approve: true, access_mode: 'ask', data_egress_ack: true });
  check(decided.status === 200 && decided.data?.state === 'approved', `approving it from the window succeeds (HTTP ${decided.status}, state ${decided.data?.state})`);

  // 5) After approval it must leave the pending list, so the operator is not asked twice.
  status = await call('GET', '/admin/v1/status');
  check((status.data.pairings || []).length === 0, 'an approved request no longer shows as awaiting approval');
}

// 6) The daemon must refuse an approval that exceeds what was requested — the panel passes the
//    requested mode through, so this guards against a mismatch between the two.
const created2 = await call('POST', '/admin/v1/pairings', {
  workspace_id: workspaceId, recipient: 'Arena Agent (desktop window)', max_access: 'ask', ttl_ms: 600000, grant_ttl_ms: 600000,
});
await fetch(`http://127.0.0.1:${mcpPort}/pair/request`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code: created2.data.code, remote_label: 'x', access_mode: 'ask' }),
});
status = await call('GET', '/admin/v1/status');
const second = (status.data.pairings || [])[0];
if (second) {
  const escalated = await call('POST', `/admin/v1/pairings/${second.pair_id}/decision`, { approve: true, access_mode: 'code', data_egress_ack: true });
  check(escalated.status === 403, `approving with more access than requested is refused (HTTP ${escalated.status})`);
  const unacknowledged = await call('POST', `/admin/v1/pairings/${second.pair_id}/decision`, { approve: true, access_mode: 'ask' });
  check(unacknowledged.status !== 200, `approving without data_egress_ack is refused (HTTP ${unacknowledged.status})`);
  // Denial must also work, since the panel offers it.
  const denied = await call('POST', `/admin/v1/pairings/${second.pair_id}/decision`, { approve: false, access_mode: 'ask', data_egress_ack: true });
  check(denied.status === 200 && denied.data?.state === 'denied', `denying from the window succeeds (HTTP ${denied.status}, state ${denied.data?.state})`);
}

console.log('');
console.log(failures === 0 ? 'the window can see and approve a pairing request' : `${failures} check(s) failed`);

await daemon.close();
fs.rmSync(stateDir, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
