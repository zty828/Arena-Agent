/**
 * The grant's lifetime: session-scoped by default, and still bounded.
 *
 * Reported by the operator: "1 小时自动过期要重新配对太反人类了". A fixed hour was the wrong shape.
 * The credential is already bound to the daemon epoch, which `recoverOnStart` rotates on every
 * start, so it cannot outlive the session anyway — closing the window, disconnecting, switching
 * workspace or revoking all end it. All the hour achieved was stopping a long task in the middle,
 * at a moment neither side could explain.
 *
 * The interesting assertions are therefore not "it works". They are:
 *   1. a session-scoped grant carries a value no wall-clock comparison can ever trip, and really
 *      does keep working (the thing the operator asked for);
 *   2. a *timed* grant still expires — otherwise "no expiry" could just be a broken expiry check,
 *      and every other lifetime assertion here would pass for the wrong reason;
 *   3. it dies with the session: after a restart the old token is refused. This is the half that
 *      makes (1) acceptable, and without it "no wall-clock expiry" would mean "no bound at all";
 *   4. revocation kills it too, immediately, without waiting for anything.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createDaemon } = await import(pathToFileURL(path.join(root, 'dist', 'apps', 'daemon', 'src', 'server.js')).href);
const { GRANT_NO_EXPIRY_AT } = await import(pathToFileURL(path.join(root, 'dist', 'packages', 'policy-engine', 'src', 'index.js')).href);

let failures = 0;
const check = (ok, message) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`);
};

// The workspace policy denies paths outside the repository, so the fixture lives under
// `.test-data/` like the other probes' fixtures.
const fixtureRoot = path.join(root, '.test-data');
fs.mkdirSync(fixtureRoot, { recursive: true });
const workspace = fs.mkdtempSync(path.join(fixtureRoot, 'lifetime-'));
fs.writeFileSync(path.join(workspace, 'seed.txt'), 'seed\n');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-lifetime-'));
const ADMIN = 'a'.repeat(48);
const config = () => ({
  schema_version: 1, state_directory: stateDir, ports: { api: 0, mcp: 0, mcp_remote: 0, admin: 0 },
  workspaces: [{ root: workspace, display_name: 'lifetime' }],
  response_mode: 'json', security_profile: 'local_trusted_development', arena_enabled: false,
  remote_ingress: { enabled: false, acknowledge_exposure: false, bind_address: '127.0.0.1', allow_cidrs: [], allowed_hosts: [], require_grant: true },
  gateway: { type: 'disabled' },
});
const creds = () => ({ adminToken: ADMIN, clientToken: 'b'.repeat(48), mcpToken: 'c'.repeat(48) });

let daemon = await createDaemon(config(), creds());
const admin = (method, route, body) => fetch(daemon.urls.admin + route, {
  method,
  headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
  ...(body ? { body: JSON.stringify(body) } : {}),
}).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));

const MODERN = '2026-07-28';
let sequence = 0;
const callTool = (token, name, args) => {
  sequence += 1;
  return fetch(daemon.urls.mcp + '/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'tools/call', 'Mcp-Name': name,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: sequence, method: 'tools/call',
      params: {
        name, arguments: args,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN,
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': { name: 'grant-lifetime-check', version: '1.0.0' },
        },
      },
    }),
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
};
const envelope = (rpc) => rpc?.data?.result?.structuredContent ?? null;
/** A refusal arrives as an HTTP status or as an error envelope inside a 200 body. */
const refused = (rpc) => rpc.status >= 400 || envelope(rpc)?.ok === false;

/** Runs the whole pairing handshake for a fresh code and returns the grant token. */
const pairAndClaim = async (grantTtlMs) => {
  const workspaceId = daemon.workspaces[0].id;
  const body = { workspace_id: workspaceId, recipient: 'lifetime-check', max_access: 'code', ttl_ms: 1800000 };
  if (grantTtlMs !== undefined) body.grant_ttl_ms = grantTtlMs;
  const pairing = await admin('POST', '/admin/v1/pairings', body);
  const requested = await fetch(daemon.urls.mcp + '/pair/request', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: pairing.data.code, remote_label: 'lifetime-check', access_mode: 'code' }),
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
  await admin('POST', `/admin/v1/pairings/${requested.data.pair_id}/decision`, { approve: true, access_mode: 'code', data_egress_ack: true });
  const claim = await fetch(daemon.urls.mcp + '/pair/claim', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pair_id: requested.data.pair_id, claim_secret: requested.data.claim_secret }),
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
  return { token: claim.data?.token, challenge: claim.data?.challenge, grantId: claim.data?.grant_id, expiresAt: claim.data?.expires_at };
};

// ---------------------------------------------------------------------------
// 1) The default (no grant_ttl_ms at all) is session-scoped, and really works.
// ---------------------------------------------------------------------------
const sessionGrant = await pairAndClaim(undefined);
check(typeof sessionGrant.token === 'string' && sessionGrant.token.length > 20,
  `a pairing with no grant_ttl_ms still issues a token (${sessionGrant.token ? 'present' : 'MISSING'})`);
check(sessionGrant.expiresAt === GRANT_NO_EXPIRY_AT,
  `its expires_at is the no-wall-clock sentinel, not a date (got ${JSON.stringify(sessionGrant.expiresAt)})`);
// A sentinel that is not actually far in the future would make every `expires_at <= Date.now()`
// check in the authorisation path reject the grant — the feature would simply not work.
check(GRANT_NO_EXPIRY_AT > Date.now() + 1000 * 60 * 60 * 24 * 365 * 100,
  'the sentinel is far enough away that no wall-clock comparison can trip on it');

const verify1 = await callTool(sessionGrant.token, 'bridge_health', { challenge: sessionGrant.challenge });
check(envelope(verify1)?.ok === true, `the session-scoped grant completes the challenge (ok=${JSON.stringify(envelope(verify1)?.ok)})`);
const read1 = await callTool(sessionGrant.token, 'list_directory', { path: '.' });
check(envelope(read1)?.ok === true, `and it can read (ok=${JSON.stringify(envelope(read1)?.ok)})`);

// `grant_ttl_ms: 0` is the same request by another route and must agree.
const explicitZero = await pairAndClaim(0);
check(explicitZero.expiresAt === GRANT_NO_EXPIRY_AT,
  `grant_ttl_ms:0 means the same thing as omitting it (got ${JSON.stringify(explicitZero.expiresAt)})`);

// A malformed value is still a caller bug. Reading a negative TTL as "unlimited" would widen a
// broken request into an unbounded credential, which is the worst available reading.
const negative = await admin('POST', '/admin/v1/pairings', { workspace_id: daemon.workspaces[0].id, recipient: 'x', max_access: 'code', ttl_ms: 600000, grant_ttl_ms: -1 });
check(negative.status === 400, `a negative grant_ttl_ms is refused rather than read as unlimited (HTTP ${negative.status})`);
const overMax = await admin('POST', '/admin/v1/pairings', { workspace_id: daemon.workspaces[0].id, recipient: 'x', max_access: 'code', ttl_ms: 600000, grant_ttl_ms: 7200000 });
check(overMax.status === 400, `an explicit TTL above the cap is still refused (HTTP ${overMax.status})`);

// ---------------------------------------------------------------------------
// 2) A timed grant still expires. Without this, "no expiry" could simply be a broken check.
// ---------------------------------------------------------------------------
const timed = await pairAndClaim(600000);
check(typeof timed.expiresAt === 'number' && timed.expiresAt < GRANT_NO_EXPIRY_AT && timed.expiresAt > Date.now(),
  `an explicit TTL still produces a real deadline (got ${JSON.stringify(timed.expiresAt)})`);
const timedVerify = await callTool(timed.token, 'bridge_health', { challenge: timed.challenge });
check(envelope(timedVerify)?.ok === true, 'a timed grant works while it is valid');
// Move its stored deadline into the past rather than sleeping, so the probe stays fast while
// still exercising the real expiry check (which reads the stored value, not a cached flag).
const timedRow = daemon.store.get('grants', timed.grantId);
daemon.store.put('grants', { ...timedRow, expires_at: Date.now() - 1 });
const afterExpiry = await callTool(timed.token, 'list_directory', { path: '.' });
check(refused(afterExpiry), `an expired grant is refused (code=${JSON.stringify(envelope(afterExpiry)?.error?.code ?? afterExpiry.status)})`);

// ---------------------------------------------------------------------------
// 3) The bound that makes (1) acceptable: the grant dies with the session.
//    A restart rotates the epoch, and `authorize` binds every grant to it.
// ---------------------------------------------------------------------------
await daemon.close();
daemon = await createDaemon(config(), creds());
const afterRestart = await callTool(sessionGrant.token, 'list_directory', { path: '.' });
check(refused(afterRestart),
  `after the daemon restarts, the session-scoped grant is refused (code=${JSON.stringify(envelope(afterRestart)?.error?.code ?? afterRestart.status)})`);
const storedEpoch = daemon.store.get('settings', 'epoch')?.value;
check(typeof storedEpoch === 'number' && storedEpoch >= 2,
  `the restart really rotated the epoch (epoch=${JSON.stringify(storedEpoch)})`);
// The refusal above is over-determined on purpose: the restart also marks the run `unknown`,
// which blocks new actions on its own. Measured — removing the epoch comparison from `assertActive`
// does NOT turn this probe red, because that second mechanism still refuses. So the epoch half is
// recorded structurally as well, which is the only way to keep it visible: a later change that
// resumes runs across a restart must not silently revive an old credential.
const staleGrant = daemon.store.get('grants', sessionGrant.grantId);
check(staleGrant?.epoch < storedEpoch,
  `the surviving grant row is bound to the previous epoch (grant=${JSON.stringify(staleGrant?.epoch)} daemon=${JSON.stringify(storedEpoch)})`);
check(daemon.store.get('runs', staleGrant?.run_id)?.state === 'unknown',
  `and its run was not resumed (state=${JSON.stringify(daemon.store.get('runs', staleGrant?.run_id)?.state)})`);

// ---------------------------------------------------------------------------
// 4) Revocation ends it immediately, without waiting for anything.
// ---------------------------------------------------------------------------
const revocable = await pairAndClaim(undefined);
const beforeRevoke = await callTool(revocable.token, 'bridge_health', { challenge: revocable.challenge });
check(envelope(beforeRevoke)?.ok === true, 'a fresh session-scoped grant works');
const revoked = await admin('POST', '/admin/v1/revoke-all', { confirm: true });
check(revoked.status === 200, `revoking all grants succeeds (HTTP ${revoked.status})`);
const afterRevoke = await callTool(revocable.token, 'list_directory', { path: '.' });
check(refused(afterRevoke),
  `and the grant is refused straight away (code=${JSON.stringify(envelope(afterRevoke)?.error?.code ?? afterRevoke.status)})`);

console.log('');
if (failures === 0) console.log('All checks passed.');
else console.log(`${failures} check(s) failed.`);
await daemon.close().catch(() => undefined);
process.exit(failures === 0 ? 0 : 1);
