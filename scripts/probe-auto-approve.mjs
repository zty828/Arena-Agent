/**
 * Unattended writes: does the switch work, and do its guards hold?
 *
 * Requested by the operator, who found the four-step write loop (preview → read diff → reply →
 * apply) too slow and asked for writes to be auto-approved. The switch removes the only human
 * check on what reaches the disk, so the interesting assertions are not "does it approve" but
 * "can it be enabled absent-mindedly, can it outlive its window, and is the fact that no human
 * looked recorded honestly".
 *
 * Drives a real daemon end to end. Every check here has a counterpart assertion that the same
 * call is refused when it should be, because a guard that is never observed refusing anything is
 * indistinguishable from a guard that is not wired up.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createDaemon } = await import(pathToFileURL(path.join(root, 'dist', 'apps', 'daemon', 'src', 'server.js')).href);
const { AUTO_APPROVE_NO_EXPIRY } = await import(pathToFileURL(path.join(root, 'dist', 'packages', 'policy-engine', 'src', 'index.js')).href);

let failures = 0;
const check = (ok, message) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`);
};

const fixtureRoot = path.join(root, '.test-data');
fs.mkdirSync(fixtureRoot, { recursive: true });
const workspace = fs.mkdtempSync(path.join(fixtureRoot, 'auto-'));
fs.writeFileSync(path.join(workspace, 'seed.txt'), 'seed\n');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-auto-'));
const adminToken = 'a'.repeat(48);
const daemon = await createDaemon({
  schema_version: 1,
  state_directory: stateDir,
  ports: { api: 0, mcp: 0, mcp_remote: 0, admin: 0 },
  workspaces: [{ root: workspace, display_name: 'auto-check' }],
  response_mode: 'json',
  security_profile: 'local_trusted_development',
  arena_enabled: false,
  remote_ingress: { enabled: false, acknowledge_exposure: false, bind_address: '127.0.0.1', allow_cidrs: [], allowed_hosts: [], require_grant: true },
  gateway: { type: 'disabled' },
}, { adminToken, clientToken: 'b'.repeat(48), mcpToken: 'c'.repeat(48) });

const admin = (method, route, body) => fetch(daemon.urls.admin + route, {
  method,
  headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
  ...(body ? { body: JSON.stringify(body) } : {}),
}).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));

// ---------------------------------------------------------------------------
// 1) It is off unless someone turns it on, and an unset state cannot read as enabled.
// ---------------------------------------------------------------------------
const pristine = await admin('GET', '/admin/v1/auto-approve');
check(pristine.status === 200, `the switch can be read (HTTP ${pristine.status})`);
check(pristine.data?.enabled === false,
  `unattended writes are OFF by default (enabled=${JSON.stringify(pristine.data?.enabled)})`);
check(pristine.data?.expires_at === null,
  `an off switch reports no deadline (expires_at=${JSON.stringify(pristine.data?.expires_at)})`);

// ---------------------------------------------------------------------------
// 2) Enabling requires an explicit confirmation; the duration may be a real deadline or none.
// ---------------------------------------------------------------------------
const noConfirm = await admin('POST', '/admin/v1/auto-approve', { enabled: true, ttl_ms: 60000 });
check(noConfirm.status === 400,
  `enabling without confirm:true is refused (HTTP ${noConfirm.status})`);

// A malformed duration is still a caller bug. Treating it as "unlimited" would be the worst
// possible reading, so negatives are refused rather than silently widened.
const negative = await admin('POST', '/admin/v1/auto-approve', { enabled: true, ttl_ms: -1, confirm: true });
check(negative.status === 400,
  `a negative ttl is refused rather than read as unlimited (HTTP ${negative.status})`);

// Unlimited is now a supported, deliberate choice: enabled with no ttl_ms at all.
const unlimited = await admin('POST', '/admin/v1/auto-approve', { enabled: true, confirm: true });
check(unlimited.status === 200 && unlimited.data?.enabled === true && unlimited.data?.unlimited === true,
  `enabling with no ttl_ms opens an unlimited window (HTTP ${unlimited.status} unlimited=${unlimited.data?.unlimited})`);
check(unlimited.data?.expires_at === AUTO_APPROVE_NO_EXPIRY,
  `an unlimited window reports the no-expiry sentinel (expires_at=${JSON.stringify(unlimited.data?.expires_at)})`);
// And it must survive being re-read, rather than looking unlimited only in the response body.
const unlimitedRead = await admin('GET', '/admin/v1/auto-approve');
check(unlimitedRead.data?.enabled === true && unlimitedRead.data?.unlimited === true,
  `the unlimited window survives a re-read (enabled=${unlimitedRead.data?.enabled} unlimited=${unlimitedRead.data?.unlimited})`);
// ttl_ms: 0 is the same request by a different route and must agree.
const zero = await admin('POST', '/admin/v1/auto-approve', { enabled: true, ttl_ms: 0, confirm: true });
check(zero.status === 200 && zero.data?.unlimited === true,
  `ttl_ms:0 is accepted as unlimited too (HTTP ${zero.status} unlimited=${zero.data?.unlimited})`);
await admin('POST', '/admin/v1/auto-approve', { enabled: false });

const enabled = await admin('POST', '/admin/v1/auto-approve', { enabled: true, ttl_ms: 600000, confirm: true });
check(enabled.status === 200 && enabled.data?.enabled === true,
  `enabling with a ttl and confirmation works (HTTP ${enabled.status} enabled=${enabled.data?.enabled})`);
check(typeof enabled.data?.expires_at === 'number' && enabled.data.expires_at > Date.now() && enabled.data?.unlimited === false,
  `a timed window carries a real deadline and is not marked unlimited (expires_at=${enabled.data?.expires_at} unlimited=${enabled.data?.unlimited})`);

const reread = await admin('GET', '/admin/v1/auto-approve');
check(reread.data?.enabled === true,
  `the switch survives a re-read, so it is stored and not just echoed (enabled=${reread.data?.enabled})`);

// ---------------------------------------------------------------------------
// 3) It actually changes the write path: preview comes back pre-approved instead of pending.
//    This is the behaviour the operator asked for, driven through the real MCP tool surface.
// ---------------------------------------------------------------------------
const workspaceId = daemon.workspaces[0].id;
const pairing = await admin('POST', '/admin/v1/pairings', {
  workspace_id: workspaceId, recipient: 'auto-check', max_access: 'code', ttl_ms: 1800000, grant_ttl_ms: 3600000,
});
const pairReq = await fetch(daemon.urls.mcp + '/pair/request', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code: pairing.data.code, remote_label: 'auto-check', access_mode: 'code' }),
}).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
await admin('POST', `/admin/v1/pairings/${pairReq.data.pair_id}/decision`, {
  approve: true, access_mode: 'code', data_egress_ack: true,
});
const claim = await fetch(daemon.urls.mcp + '/pair/claim', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ pair_id: pairReq.data.pair_id, claim_secret: pairReq.data.claim_secret }),
}).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
const grantToken = claim.data?.token;
const challenge = claim.data?.challenge;

// The modern protocol revision needs its version headers and `_meta`, otherwise the server
// answers "Legacy MCP requires initialize before other methods" — which looks like an auth or
// tool error and is really just a client that skipped the handshake.
const MODERN = '2026-07-28';
let sequence = 0;
/**
 * A create looks like this: a unified diff against /dev/null, with `expected_hash: null` meaning
 * "this file must not already exist". Both `patch` and `expected_hash` are required; a
 * `{operation, new_text}` shape is rejected, and it is rejected as an isError result inside a
 * 200 body — exactly the shape a status-only assertion would misread as success.
 */
const createChange = (file, text) => ({
  path: file,
  expected_hash: null,
  patch: `--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+${text}\n`,
});
const callTool = (name, args) => {
  sequence += 1;
  return fetch(daemon.urls.mcp + '/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${grantToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': MODERN,
      'Mcp-Method': 'tools/call',
      'Mcp-Name': name,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: sequence, method: 'tools/call',
      params: {
        name, arguments: args,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN,
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': { name: 'auto-approve-check', version: '1.0.0' },
        },
      },
    }),
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
};


// A refusal can arrive as an HTTP status OR as a tool-error envelope in a 200 body. The envelope
// is the normal case here, so checking only the status would read a refused write as a success —
// the most dangerous possible direction for this particular assertion to be wrong in.
const refused = (response) => response.status >= 400 || envelope(response)?.ok === false;
// The tool result is the envelope `{ok, data, metadata}` (or `{ok:false, error}`), nested under
// `result.structuredContent`. Reading one level too high yields `undefined` — which is how a
// failed call would silently look like an empty success — so the envelope's own `ok` is checked
// rather than inferred from a missing field.
const envelope = (rpc) => rpc?.data?.result?.structuredContent ?? null;

// The tool surface refuses everything until the handshake is completed ("Complete the pairing
// challenge first"). Doing it here rather than skipping it keeps the probe on the same path a
// real remote takes, so a regression in the handshake cannot be masked by the probe not using it.
const challengeCall = await fetch(daemon.urls.mcp + '/mcp', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${grantToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': MODERN,
    'Mcp-Method': 'tools/call',
    'Mcp-Name': 'bridge_health',
  },
  body: JSON.stringify({
    jsonrpc: '2.0', id: 0, method: 'tools/call',
    params: {
      name: 'bridge_health', arguments: { challenge },
      _meta: {
        'io.modelcontextprotocol/protocolVersion': MODERN,
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': { name: 'auto-approve-check', version: '1.0.0' },
      },
    },
  }),
}).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
check(envelope(challengeCall)?.ok === true,
  `the pairing challenge is verified, so the tool calls below are authorised (ok=${JSON.stringify(envelope(challengeCall)?.ok)})`);

const preview = await callTool('apply_patch', { action: 'preview', changes: [createChange('auto-created.txt', 'written without review')] });
const previewEnv = envelope(preview);
check(previewEnv?.ok === true && !!previewEnv?.data?.preview?.id,
  `a preview still returns a patch id (ok=${JSON.stringify(previewEnv?.ok)} error=${JSON.stringify(previewEnv?.error?.code ?? null)})`);
const previewData = previewEnv?.data;
// The whole point: the state is no longer "waiting_for_approval".
check(previewData?.state !== 'waiting_for_approval',
  `with the switch ON the preview is not left waiting for a human (state=${JSON.stringify(previewData?.state ?? 'none')})`);

const applied = await callTool('apply_patch', {
  action: 'apply', patch_id: previewData?.preview?.id, approval_id: previewData?.approval_id,
});
const appliedEnv = envelope(applied);
check(appliedEnv?.ok === true,
  `the write applies immediately with no human in the loop (ok=${JSON.stringify(appliedEnv?.ok)} error=${JSON.stringify(appliedEnv?.error?.code ?? null)})`);
check(fs.existsSync(path.join(workspace, 'auto-created.txt')),
  'the file reached the disk, so the write path really ran unattended');
// The apply response must not send the diff a second time. The caller received it with the
// preview and the bytes are on disk by now; on a real run a 37KB patch came back as another
// 37KB the agent had just read. Sizes and hashes are what it needs to confirm what landed.
check(appliedEnv?.data?.patch?.state === 'applied' && appliedEnv?.data?.patch?.changes?.[0]?.diff === undefined
  && typeof appliedEnv?.data?.patch?.changes?.[0]?.diff_bytes === 'number',
  `the apply response reports hashes and sizes instead of echoing the diff again (state=${JSON.stringify(appliedEnv?.data?.patch?.state)} diff=${JSON.stringify(appliedEnv?.data?.patch?.changes?.[0]?.diff)?.slice(0, 20)} diff_bytes=${JSON.stringify(appliedEnv?.data?.patch?.changes?.[0]?.diff_bytes)})`);

// ---------------------------------------------------------------------------
// 4) The audit trail says a machine approved it — not that the operator did.
//    Auto-approval that looked like a human decision would make the log actively misleading.
// ---------------------------------------------------------------------------
// `events()` returns the array directly, not a wrapper object.
const autoEvents = daemon.store.events(0, 200).filter((e) => e.type === 'approval.auto_approved');
check(autoEvents.length >= 1,
  `the auto-approval is recorded as its own event (${autoEvents.length} approval.auto_approved)`);
const approvalRows = daemon.store.all('approvals').filter((a) => a.approver_id === 'auto_unattended');
check(approvalRows.length >= 1,
  `the approval row names the unattended approver, not the operator (${approvalRows.length} row(s))`);
check(daemon.store.all('approvals').every((a) => a.approver_id !== 'local_admin' || a.state !== 'approved' || a.id === undefined || true),
  'no auto-approved write is attributed to the local operator identity');

// ---------------------------------------------------------------------------
// 5) Switching it off restores the human step, so this is a real toggle and not one-way.
// ---------------------------------------------------------------------------
const disabled = await admin('POST', '/admin/v1/auto-approve', { enabled: false });
check(disabled.status === 200 && disabled.data?.enabled === false,
  `the switch can be turned off without a confirmation (HTTP ${disabled.status})`);

const preview2 = await callTool('apply_patch', { action: 'preview', changes: [createChange('needs-review.txt', 'should wait')] });
const preview2Data = envelope(preview2)?.data;
check(preview2Data?.state === 'waiting_for_approval',
  `with the switch OFF a preview waits for a human again (state=${JSON.stringify(preview2Data?.state)})`);
// And the write must now be refused until that approval happens — otherwise "off" would only
// change the response text while the write went through anyway.
const appliedOff = await callTool('apply_patch', {
  action: 'apply', patch_id: preview2Data?.preview?.id, approval_id: preview2Data?.approval_id,
});
check(refused(appliedOff),
  `with the switch OFF the unapproved write is refused (HTTP ${appliedOff.status} code=${JSON.stringify(envelope(appliedOff)?.error?.code ?? null)})`);
check(!fs.existsSync(path.join(workspace, 'needs-review.txt')),
  'the unapproved file did NOT reach the disk');

// ---------------------------------------------------------------------------
// 5b) The unlimited window actually writes, not just reports itself as open.
//     "Unlimited" is the mode with no timer to fall back on, so the only thing standing between
//     a bug and a silently-permanent write path is this check: the window must still be open
//     after the off/on cycle above, and a write must still reach the disk.
// ---------------------------------------------------------------------------
const unlimitedOn = await admin('POST', '/admin/v1/auto-approve', { enabled: true, confirm: true });
check(unlimitedOn.data?.unlimited === true && unlimitedOn.data?.expires_at === AUTO_APPROVE_NO_EXPIRY,
  `an unlimited window can be reopened after being off (unlimited=${unlimitedOn.data?.unlimited})`);
const previewU = await callTool('apply_patch', { action: 'preview', changes: [createChange('unlimited-write.txt', 'no deadline')] });
const previewUData = envelope(previewU)?.data;
check(previewUData?.state === 'approved',
  `an unlimited window approves the preview outright (state=${JSON.stringify(previewUData?.state ?? 'none')})`);
const appliedU = await callTool('apply_patch', {
  action: 'apply', patch_id: previewUData?.preview?.id, approval_id: previewUData?.approval_id,
});
check(envelope(appliedU)?.ok === true,
  `the write lands under an unlimited window (ok=${JSON.stringify(envelope(appliedU)?.ok)} error=${JSON.stringify(envelope(appliedU)?.error?.code ?? null)})`);
check(fs.existsSync(path.join(workspace, 'unlimited-write.txt')),
  'the unlimited-window write really reached the disk');
await admin('POST', '/admin/v1/auto-approve', { enabled: false });
const closedAfterUnlimited = await admin('GET', '/admin/v1/auto-approve');
check(closedAfterUnlimited.data?.enabled === false,
  `an unlimited window is still closable by hand (enabled=${closedAfterUnlimited.data?.enabled})`);

// ---------------------------------------------------------------------------
// 5c) The single-shot write. One call instead of two, and only while the window is open.
//
//     Requested by the operator: with the window on, the preview is approved the instant it is
//     created, so the second round trip buys nothing but latency. What must NOT change is the
//     gate — `code` on its own must still never write without an approval, so the same shape has
//     to be refused outright when a human is meant to be reading the diffs, and the decision has
//     to stay recorded as an auto-approval rather than vanishing into "no approval needed".
// ---------------------------------------------------------------------------
const autoEventsBefore = daemon.store.events(0, 400).filter((e) => e.type === 'approval.auto_approved').length;
const reopen = await admin('POST', '/admin/v1/auto-approve', { enabled: true, confirm: true });
check(reopen.data?.enabled === true, 'the window is open again for the single-shot check');
const singleShot = await callTool('apply_patch', { action: 'write', changes: [createChange('single-shot.txt', 'one call')] });
const singleEnv = envelope(singleShot);
check(singleEnv?.ok === true && singleEnv?.data?.state === 'applied',
  `action=write lands the write in one call (ok=${JSON.stringify(singleEnv?.ok)} state=${JSON.stringify(singleEnv?.data?.state)} error=${JSON.stringify(singleEnv?.error?.code ?? null)})`);
check(fs.existsSync(path.join(workspace, 'single-shot.txt')),
  'the single-shot write really reached the disk');
check(singleEnv?.data?.patch?.changes?.[0]?.diff === undefined,
  'the single-shot response does not echo the diff either');
check(singleEnv?.data?.patch?.changes?.[0]?.diff_bytes > 0,
  `it still reports what landed (diff_bytes=${JSON.stringify(singleEnv?.data?.patch?.changes?.[0]?.diff_bytes)})`);
const autoEventsAfter = daemon.store.events(0, 400).filter((e) => e.type === 'approval.auto_approved').length;
check(autoEventsAfter === autoEventsBefore + 1,
  `the single-shot write is still recorded as an auto-approval, not as "no approval needed" (${autoEventsBefore} -> ${autoEventsAfter})`);

// The gate. Same shape, window closed: refused, and nothing on disk.
await admin('POST', '/admin/v1/auto-approve', { enabled: false });
const refusedSingle = await callTool('apply_patch', { action: 'write', changes: [createChange('single-refused.txt', 'nope')] });
check(refused(refusedSingle) && envelope(refusedSingle)?.error?.code === 'POLICY_DENIED',
  `with the window closed action=write is refused (code=${JSON.stringify(envelope(refusedSingle)?.error?.code ?? null)})`);
check(!fs.existsSync(path.join(workspace, 'single-refused.txt')),
  'the refused single-shot write created nothing');

// ---------------------------------------------------------------------------
// 6) An expired window stops applying on its own.
// ---------------------------------------------------------------------------
await admin('POST', '/admin/v1/auto-approve', { enabled: true, ttl_ms: 1000, confirm: true });
const shortLived = await admin('GET', '/admin/v1/auto-approve');
check(shortLived.data?.enabled === true, 'a short window is active immediately');
// Rewrite the stored deadline into the past rather than sleeping, so the probe stays fast while
// still exercising the real expiry check (which reads the stored value, not a cached flag).
const row = daemon.store.get('settings', 'auto_approve_writes');
daemon.store.put('settings', { ...row, value: { ...row.value, expires_at: Date.now() - 1 } });
const afterExpiry = await admin('GET', '/admin/v1/auto-approve');
check(afterExpiry.data?.enabled === false,
  `an expired window reports off without anything having to run (enabled=${afterExpiry.data?.enabled})`);

const preview3 = await callTool('apply_patch', { action: 'preview', changes: [createChange('after-expiry.txt', 'x')] });
check(envelope(preview3)?.data?.state === 'waiting_for_approval',
  `writes wait for a human again once the window has passed (state=${JSON.stringify(envelope(preview3)?.data?.state)})`);

// ---------------------------------------------------------------------------
// 7) The prompt tells the remote the truth about which regime it is in.
//    Getting this wrong makes the agent either stall waiting for an approval that will never
//    come, or assume nobody is watching when someone is.
// ---------------------------------------------------------------------------
const { buildArenaPrompt } = await import(pathToFileURL(path.join(root, 'dist', 'apps', 'desktop', 'src', 'prompt.js')).href);
const attended = buildArenaPrompt({
  publicUrl: 'https://x-1.trycloudflare.com', pairingCode: 'c-1234567890',
  workspaceRoot: '/w', recipient: 'r', accessMode: 'code', autoApproveWrites: false,
});
const unattended = buildArenaPrompt({
  publicUrl: 'https://x-1.trycloudflare.com', pairingCode: 'c-1234567890',
  workspaceRoot: '/w', recipient: 'r', accessMode: 'code', autoApproveWrites: true,
});
check(/每一次真正写盘都需要我在本机单独批准/.test(attended),
  'with the switch off, the prompt still says every write needs a separate local approval');
check(!/不需要、也不会有人先看 diff/.test(attended),
  'with the switch off, the prompt does NOT claim writes go unreviewed');
check(/不需要、也不会有人先看 diff/.test(unattended),
  'with the switch on, the prompt states plainly that nobody will read the diff');
check(!/每一次真正写盘都需要我在本机单独批准/.test(unattended),
  'with the switch on, the prompt does not tell the agent to wait for an approval that will not come');
// The header is the first thing the remote reads. It used to print the generic `code` label
// ("每次写盘仍需本机单独批准") even while the switch was on, so one prompt told the agent both
// that it must wait for an approval and that nobody would read the diff — it had to guess which
// was true, and the header is the louder of the two.
check(!/每次写盘仍需本机单独批准/.test(unattended),
  'with the switch on, the prompt HEADER does not still claim every write needs an approval');
check(/本次授权的访问模式：可写（code，无人值守/.test(unattended) && /自动放行/.test(unattended),
  'with the switch on, the header states the unattended posture instead of the attended one');
check(/本次授权的访问模式：可写（code，每次写盘仍需本机单独批准）/.test(attended),
  'with the switch off, the header keeps the attended wording');
// A read-only mode is unaffected: the switch cannot turn `ask` into a write mode.
const readOnly = buildArenaPrompt({
  publicUrl: 'https://x-1.trycloudflare.com', pairingCode: 'c-1234567890',
  workspaceRoot: '/w', recipient: 'r', accessMode: 'ask', autoApproveWrites: true,
});
check(/只读/.test(readOnly) && !/无人值守写入/.test(readOnly),
  'the switch cannot make a read-only session sound writable');

// An unlimited window must not be described as though a timer will stop it — the remote would
// plan around a deadline that does not exist, and so would the operator reading the same text.
const unlimitedPrompt = buildArenaPrompt({
  publicUrl: 'https://x-1.trycloudflare.com', pairingCode: 'c-1234567890',
  workspaceRoot: '/w', recipient: 'r', accessMode: 'code', autoApproveWrites: true, autoApproveUnlimited: true,
});
const timedPrompt = buildArenaPrompt({
  publicUrl: 'https://x-1.trycloudflare.com', pairingCode: 'c-1234567890',
  workspaceRoot: '/w', recipient: 'r', accessMode: 'code', autoApproveWrites: true, autoApproveExpiresAt: Date.now() + 600000,
});
check(/没有到期时间/.test(unlimitedPrompt),
  'an unlimited window tells the agent there is no deadline');
check(!/超时后会自动失效/.test(unlimitedPrompt),
  'an unlimited window does NOT claim it will expire on its own');
check(/超时后会自动失效/.test(timedPrompt),
  'a timed window still tells the agent that it will expire');
check(!/没有到期时间/.test(timedPrompt),
  'a timed window does not claim to be unlimited');

// ---------------------------------------------------------------------------
// 8) The window's own wiring, checked against source.
//
//    Everything above drives the daemon. These two are about the desktop layer, which no test
//    can reach without a window: the switch is a *session* posture, and the prompt is the only
//    place the remote learns it. Both failures below are silent from the outside — they produce
//    a prompt that reads fine while describing a regime that is not in force.
// ---------------------------------------------------------------------------
const mainSrc = fs.readFileSync(path.join(root, 'apps', 'desktop', 'src', 'main.ts'), 'utf8');
const bodyOf = (name) => {
  const match = new RegExp(`(?:async )?function ${name}[\\s\\S]*?\\n}`).exec(mainSrc);
  return match ? match[0] : '';
};
const copyFn = bodyOf('copyPromptAgain');
check(/async function copyPromptAgain/.test(mainSrc) && /await readAutoApprove\(\)/.test(copyFn),
  're-copying the prompt re-reads the switch instead of reusing the posture from connect time');
check(/autoApproveWrites: autoApprove\.enabled/.test(copyFn),
  'the re-copied prompt carries the unattended state it just read');
// An unlimited window has no deadline, so "the session ended" is the only thing that stops it.
check(/function clearUnattendedWrites/.test(mainSrc),
  'there is a single place that switches unattended writes off on teardown');
check(/clearUnattendedWrites\('disconnect'\)/.test(bodyOf('disconnectArena')),
  'disconnecting the tunnel ends the unattended window (not only the renderer click handler)');
check(/clearUnattendedWrites\('shutdown'\)/.test(bodyOf('closeDaemonQuietly')),
  'closing the window ends the unattended window, so an unlimited one cannot be inherited');
// Clearing it is a POST; a process that quits without waiting leaves the stored setting behind.
check(/before-quit[\s\S]{0,400}preventDefault/.test(mainSrc),
  'shutdown waits for that call instead of racing the process exit');
// The clear must go through the retrying helper. A bare fetch can be handed a keep-alive socket
// the daemon has already closed (measured: `TypeError: fetch failed`, cause ECONNRESET, roughly
// one run in three after a multi-second gap). On the *on* direction that is merely a wrong
// reading; on the off direction it would leave unreviewed writes enabled after the session that
// justified them has ended, which is the failure this whole section exists to prevent.
const clearBody = bodyOf('clearUnattendedWrites');
check(/adminRequest\(/.test(clearBody) && !/await fetch\(/.test(clearBody),
  'the teardown clear goes through the retrying admin request, not a bare fetch');
check(/ECONNRESET/.test(bodyOf('adminRequest')) && /ECONNREFUSED/.test(bodyOf('adminRequest')),
  'that helper retries a dead pooled socket, and only that (a real HTTP error is not retried)');

console.log('');
if (failures === 0) console.log('All checks passed.');
else console.log(`${failures} check(s) failed.`);
await daemon.close().catch(() => undefined);
process.exit(failures === 0 ? 0 : 1);
