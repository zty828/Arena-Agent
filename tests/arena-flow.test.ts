/**
 * The Arena connection flow's pure parts: the ingress config a tunnel needs, and the prompt
 * the operator pastes into Arena.
 *
 * These are unit-tested rather than only exercised through the window because both have a
 * failure mode that is invisible from the outside:
 *  - A prompt that names a file the workspace does not contain makes the remote agent report
 *    a failure that looks like a bridge problem.
 *  - An ingress allowlist built from an unvalidated string is a security boundary, and the
 *    value it is built from arrives from a URL.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildArenaPrompt, type AccessMode } from '../apps/desktop/src/prompt.js';
import { closedIngress, exposedIngress, normaliseHostname, parseTunnelUrl, portOf } from '../apps/desktop/src/tunnel-mode.js';

// --- the exposed listener ------------------------------------------------------------

test('A01 the exposed listener is loopback-bound, host-allowlisted and grant-only', () => {
  const ingress = exposedIngress('calm-river-1234.trycloudflare.com');
  assert.equal(ingress.enabled, true);
  assert.equal(ingress.acknowledge_exposure, true, 'the daemon refuses exposure without this');
  assert.equal(ingress.bind_address, '127.0.0.1', 'the bridge itself must never leave loopback');
  assert.deepEqual(ingress.allowed_hosts, ['calm-river-1234.trycloudflare.com']);
  assert.equal(ingress.require_grant, true, 'an exposed listener without a grant is an open door');
});

test('A02 exposure without a hostname is refused, because the daemon would refuse it anyway', () => {
  assert.throws(() => exposedIngress(''), /hostname is required/);
  assert.throws(() => exposedIngress('not a hostname'), /hostname is required/);
});

test('A03 the default ingress block is closed', () => {
  const ingress = closedIngress();
  assert.equal(ingress.enabled, false);
  assert.equal(ingress.acknowledge_exposure, false);
  assert.deepEqual(ingress.allowed_hosts, []);
});

test('A04 a hostname that could smuggle a host header rule is rejected', () => {
  // The allowlist is compared against an attacker-controlled header, so nothing but a bare
  // DNS name may reach it: no wildcard, no second host, no bare literal, no empty label.
  for (const bad of ['*.example.com', 'example.com evil.test', 'localhost', '127.0.0.1', 'a..b', '']) {
    assert.equal(normaliseHostname(bad), '', `should have been rejected: ${bad}`);
  }
  // A path and a port are not rejections: both are stripped, and the remaining name is what
  // the allowlist must match. A Host header always carries `host:port`, so refusing to
  // normalise this would make the feature unusable rather than safer. What matters is that
  // no path segment or port digit can end up inside the allowlist entry.
  assert.equal(normaliseHostname('https://example.com/x'), 'example.com');
  assert.equal(normaliseHostname('example.com:443'), 'example.com');
  assert.ok(!normaliseHostname('https://example.com/x?evil=1').includes('/'));
  assert.ok(!normaliseHostname('example.com:8443').includes(':'));
});

test('A05 a URL is reduced to its hostname, and case/port do not matter', () => {
  assert.equal(normaliseHostname('https://CALM-river-1234.trycloudflare.com'), 'calm-river-1234.trycloudflare.com');
  assert.equal(normaliseHostname('calm-river-1234.trycloudflare.com:443'), 'calm-river-1234.trycloudflare.com');
  assert.equal(normaliseHostname('https://a.b.example.com/path?x=1'), 'a.b.example.com');
  assert.equal(exposedIngress('https://x-1.trycloudflare.com').allowed_hosts[0], 'x-1.trycloudflare.com');
});

// --- the prompt ----------------------------------------------------------------------

const prompt = (accessMode: AccessMode = 'ask') => buildArenaPrompt({
  publicUrl: 'https://calm-river-1234.trycloudflare.com',
  pairingCode: '-abc_DEF123',
  workspaceRoot: 'F:\\work\\synthetic',
  recipient: 'Arena Agent (desktop window)',
  accessMode,
});

test('A06 the prompt carries the real endpoint and pairing code', () => {
  const text = prompt();
  assert.match(text, /https:\/\/calm-river-1234\.trycloudflare\.com\/client\.py/);
  assert.match(text, /--code='-abc_DEF123'/, 'a leading dash must survive as a value');
  assert.match(text, /export ARENABRIDGE_URL='https:\/\/calm-river-1234\.trycloudflare\.com'/);
  // The workspace being exposed is named, so the operator reading the prompt sees what they
  // are about to hand over before they paste it.
  assert.match(text, /F:\\work\\synthetic/);
});

test('A07 the prompt never names a file it cannot know exists', () => {
  // The one-click script ended with `read_files {"files":[{"path":"sum.mjs"}]}` — a fixture
  // filename that is simply wrong against any other workspace. The prompt must not do that.
  const text = prompt();
  assert.doesNotMatch(text, /sum\.mjs/, 'the prompt must not hard-code a fixture file');
  assert.match(text, /first_text_files/, 'it must ask the agent to discover a real file instead');
});

test('A08 every step names a command the client script actually implements', () => {
  const text = prompt();
  for (const command of ['pair-request', 'pair-claim', 'verify', 'agent-check', 'call read_files']) {
    assert.ok(text.includes(command), `the prompt must use ${command}`);
  }
  // The handshake order is the one the daemon enforces; a prompt that claims before approval
  // would fail and read as a bridge defect.
  assert.ok(text.indexOf('pair-request') < text.indexOf('pair-claim'), 'request must precede claim');
  assert.ok(text.indexOf('pair-claim') < text.indexOf('verify'), 'claim must precede verify');
});

test('A09 the prompt forbids the failure modes that make a report worthless', () => {
  const text = prompt();
  assert.match(text, /不要编造"已连接"或"已完成"/);
  assert.match(text, /原样报告错误信息并停止/);
  // The agent must park at the approval and wait, rather than claiming a grant it does not
  // have. The wording is checked against the actual sentence in the prompt.
  assert.match(text, /在我说"已批准"之前不要继续/);
  assert.match(text, /停下来等我批准/);
});

test('A10 a trailing slash on the endpoint does not produce a doubled path', () => {
  const text = buildArenaPrompt({ publicUrl: 'https://x-1.trycloudflare.com/', pairingCode: 'c', workspaceRoot: '/w', recipient: 'r', accessMode: 'ask' });
  assert.doesNotMatch(text, /\.com\/\/client\.py/);
  assert.match(text, /https:\/\/x-1\.trycloudflare\.com\/client\.py/);
});

// --- the access mode -----------------------------------------------------------------
//
// Reported by the operator: the prompt always asked for `ask`, and editing it to `code` by
// hand failed with a permission error. The cause was that the window minted every pairing code
// with `max_access: 'ask'`, and the daemon refuses any request above the code's ceiling with
// 403 and offers no way to raise it. So the mode has to be chosen up front and carried
// consistently into the code, the prompt and the approval.

test('A11 the prompt carries the access mode actually granted to the code', () => {
  // Not hard-coded to ask any more: it must follow whatever the operator selected.
  assert.match(prompt('ask'), /--access-mode=ask/);
  assert.match(prompt('plan'), /--access-mode=plan/);
  assert.match(prompt('code'), /--access-mode=code/);
  // And it must be stated in prose too, so a reader sees it without parsing the command.
  assert.match(prompt('code'), /本次授权的访问模式：可写/);
  assert.match(prompt('ask'), /本次授权的访问模式：只读/);
});

test('A12 the prompt tells the agent not to raise the mode itself, and why', () => {
  const text = prompt('ask');
  // Without this, an agent that decides it needs to write will edit the flag, get a 403, and
  // report a permission problem — which is exactly the confusion that was reported.
  assert.match(text, /不要自己把 --access-mode 改成更高的档位/);
  assert.match(text, /403/, 'it must name the failure it would actually get');
  // And it must point at the real remedy rather than leaving the agent stuck.
  assert.match(text, /由我重新签发配对码/);
});

test('A13 read-only modes say plainly that writes will be refused', () => {
  for (const mode of ['ask', 'plan'] as const) {
    const text = prompt(mode);
    assert.match(text, /只读/, `${mode} must be described as read-only`);
    assert.match(text, /任何写操作都会被拒绝/, `${mode} must warn that writes are refused`);
  }
  // code must NOT claim to be read-only, and must not promise unattended writes either.
  const code = prompt('code');
  assert.doesNotMatch(code, /只读：任何写操作都会被拒绝/);
  assert.match(code, /每一次真正写盘都需要我在本机单独批准/);
  assert.match(code, /不要以为提交了就写进去了/);
});

// --- the header cannot contradict the write rules -------------------------------------
//
// Reported as "the prompt the AI receives conflicts with the actual rules". It was literally
// true inside one prompt: the header printed the generic label for `code` ("每次写盘仍需本机
// 单独批准") while the unattended paragraph a few lines below said nobody would read the diff
// and not to wait. The remote is told both things and has to guess which is in force, and the
// header is the first thing it reads — so the label has to be derived from the posture, not
// from the access mode alone.

test('A17 the header states the same write regime as the rules below it', () => {
  const base = {
    publicUrl: 'https://calm-river-1234.trycloudflare.com', pairingCode: '-abc_DEF123',
    workspaceRoot: 'F:\\work\\synthetic', recipient: 'Arena Agent (desktop window)',
  };
  const attended = buildArenaPrompt({ ...base, accessMode: 'code', autoApproveWrites: false });
  const unattended = buildArenaPrompt({ ...base, accessMode: 'code', autoApproveWrites: true });
  // Attended: header and body agree that a human approves every write.
  assert.match(attended, /本次授权的访问模式：可写（code，每次写盘仍需本机单独批准）/);
  assert.match(attended, /每一次真正写盘都需要我在本机单独批准/);
  // Unattended: the header must NOT keep claiming the opposite of the paragraph below it.
  assert.doesNotMatch(unattended, /每次写盘仍需本机单独批准/, 'the header must not contradict the unattended rules');
  assert.match(unattended, /本次授权的访问模式：可写（code，无人值守/);
  assert.match(unattended, /自动放行/);
  // And the switch still cannot make a read-only session sound writable.
  const askUnattended = buildArenaPrompt({ ...base, accessMode: 'ask', autoApproveWrites: true });
  assert.doesNotMatch(askUnattended, /无人值守|自动放行/, 'ask + the switch is still read-only');
});

test('A18 the prompt names the tab that actually exists, and states the approval lifetime', () => {
  const base = {
    publicUrl: 'https://calm-river-1234.trycloudflare.com', pairingCode: '-abc_DEF123',
    workspaceRoot: 'F:\\work\\synthetic', recipient: 'Arena Agent (desktop window)',
    accessMode: 'code' as const, autoApproveWrites: true, autoApproveUnlimited: true,
  };
  const text = buildArenaPrompt(base);
  // The audit page is 活动 in both the desktop window and the console; pointing the remote at a
  // page called 动态 sends it looking for something that does not exist.
  assert.doesNotMatch(text, /「动态」页/);
  assert.match(text, /「活动」页/);
  // Auto-approvals still expire (5 min by default, capped by the grant), so an unattended remote
  // that previews and then applies much later is refused. Naming it prevents the agent reading
  // APPROVAL_REQUIRED as "the unattended switch is broken".
  assert.match(text, /批准本身有有效期/);
  assert.match(text, /重新 preview 一次/);
});

// --- the flow must survive a sandbox that forgets /tmp -------------------------------
//
// Reported from a real Arena run: step 3 returned a pair_id, the operator approved, and step 4
// failed with `can't open file '/tmp/ab_client.py'`. The file had existed moments earlier, so it
// had not failed to download — the sandbox had discarded /tmp between turns. The same wipe takes
// the state file with it, which holds pair_id, claim_secret and the grant token, so a flow that
// re-reads them from disk cannot finish. Every step therefore has to carry its own inputs.

test('A19 no step depends on a file left behind by an earlier step', () => {
  const text = buildArenaPrompt({
    publicUrl: 'https://calm-river-1234.trycloudflare.com', pairingCode: '-abc_DEF123',
    workspaceRoot: 'F:\\work\\synthetic', recipient: 'Arena Agent (desktop window)', accessMode: 'code',
  });
  // Named rather than implied: an agent that is not told will assume /tmp persists and will read
  // the failure as a broken bridge.
  assert.match(text, /tmp/, 'the prompt must name the risk');
  assert.match(text, /不会在两轮对话之间保留 \/tmp|沙箱把 \/tmp 清了/);
  // Step 4 must not rely on the state file for the claim secret.
  assert.match(text, /pair-claim --pair-id='<第 3 步的 pair_id>' --claim-secret=/);
  // Steps 5-7 need the grant token, which lives in the same disposable state file.
  for (const command of ['verify', 'agent-check', 'call read_files']) {
    const line = text.split('\n').find((l) => l.includes(command) && l.includes('ab_client.py')) ?? '';
    assert.match(line, /ARENABRIDGE_TOKEN=/, `${command} must carry the token explicitly`);
  }
  // And the recovery instruction has to be spelled out, or the agent stops at a false dead end.
  assert.match(text, /重跑第 1 步/);
});

// --- the grant's own clock, which is not the unattended window's -----------------------
//
// Reported from a real run: the prompt said the unattended window "has no expiry", the remote
// read that as "this session has no expiry", and only noticed from a raw `expires_at` in the
// claim response that its grant died an hour later — 40 minutes before it did. The grant always
// expires; the switch is about whether writes need a nod, which is a different question.

test('A20 the prompt states the grant lifetime and keeps it apart from the unattended window', () => {
  const base = {
    publicUrl: 'https://calm-river-1234.trycloudflare.com', pairingCode: '-abc_DEF123',
    workspaceRoot: 'F:\\work\\synthetic', recipient: 'Arena Agent (desktop window)',
    accessMode: 'code' as const,
  };
  // A timed grant states its deadline.
  const timed = buildArenaPrompt({ ...base, autoApproveWrites: true, autoApproveUnlimited: true, grantTtlMs: 3600000 });
  assert.match(timed, /本次授权的有效期：约 60 分钟/);
  assert.match(timed, /从第 4 步领取成功那一刻开始算/);
  assert.match(timed, /到期后所有调用都会失败/, 'a timed grant must say what its expiry looks like');
  // The unattended sentence must not read as a statement about the session as a whole.
  assert.match(timed, /无人值守窗口/);
  assert.match(timed, /授权说的是/, 'the two clocks must be named as different things');
  // A session-scoped grant (the window's default) must be described as bounded by the session —
  // "never expires" would be wrong in the one case that matters and would send the agent into a
  // retry loop against a bridge that is gone.
  const sessionScoped = buildArenaPrompt({ ...base, autoApproveWrites: true, autoApproveUnlimited: true, grantTtlMs: 0 });
  assert.match(sessionScoped, /本次授权的有效期：没有墙钟到期时间/);
  assert.match(sessionScoped, /直到这次 bridge 会话结束/);
  assert.match(sessionScoped, /关窗口、断开隧道、切换工作目录/);
  assert.match(sessionScoped, /不要反复重试/, 'a refusal must not be read as "retry until it works"');
  // No invented deadline on the lifetime line itself (the unattended bullet elsewhere in the
  // prompt legitimately mentions the 5-minute approval window).
  const ttlLine = sessionScoped.split('\n').find((line) => line.includes('本次授权的有效期')) ?? '';
  assert.doesNotMatch(ttlLine, /分钟/, 'no invented deadline for a session-scoped grant');
  // When the TTL is not known it must still point at where the deadline is reported.
  const unknown = buildArenaPrompt({ ...base });
  assert.match(unknown, /由我签发时设定/);
  assert.match(unknown, /expires_in/);
  // And the claim step has to tell the agent to record both values it now prints.
  assert.match(unknown, /记下输出里的 token 和 challenge/);
});

// --- the single-shot write, and only where it applies -----------------------------------
//
// Requested by the operator: with the unattended window open the preview is approved the instant
// it is created, so the second round trip buys latency and nothing else. The prompt has to say
// so — an agent that does not know will keep doing it in two calls — and it must say it ONLY
// there: telling an attended session about a shape that is refused with 403 would send it into
// an error path it cannot recover from.

test('A21 the single-shot write is described only where it is actually available', () => {
  const base = {
    publicUrl: 'https://calm-river-1234.trycloudflare.com', pairingCode: '-abc_DEF123',
    workspaceRoot: 'F:\\work\\synthetic', recipient: 'Arena Agent (desktop window)',
    accessMode: 'code' as const,
  };
  const unattended = buildArenaPrompt({ ...base, autoApproveWrites: true, autoApproveUnlimited: true });
  assert.match(unattended, /action:"write"/);
  assert.match(unattended, /写盘一步就行/);
  assert.match(unattended, /只在无人值守窗口开着时可用/, 'the condition has to be stated, not implied');
  // The two-step path must stay valid, so the prompt cannot present one as the only option.
  assert.match(unattended, /想分两步（preview → apply）也完全可以/);
  // Attended: no mention of a shape that would be refused.
  const attended = buildArenaPrompt({ ...base, autoApproveWrites: false });
  assert.doesNotMatch(attended, /action:"write"/, 'an attended session must not be told about it');
  // Both must document the patch shape, which is where a remote loses a round trip to a zod error.
  for (const text of [attended, unattended]) {
    assert.match(text, /expected_hash/);
    assert.match(text, /unified diff/);
    assert.match(text, /不支持删除、移动、重命名/);
  }
});

// --- the tunnel URL boundary ---------------------------------------------------------
//
// The tunnel writer is plain JavaScript outside the TypeScript build, so `ok: true` is a claim
// rather than proof. An unvalidated url used to reach `new URL()` and throw a bare
// `Invalid URL` out of an IPC handler, which the operator saw only as
// "Error occurred in handler for 'arena:connect'". The hostname derived here also goes straight
// into the daemon's Host-header allowlist, so a permissive validator would widen the boundary of
// an internet-facing listener.

test('A11 a well-formed quick-tunnel url yields the hostname the allowlist needs', () => {
  const parsed = parseTunnelUrl('https://calm-river-1234.trycloudflare.com');
  assert.equal(parsed?.hostname, 'calm-river-1234.trycloudflare.com');
  assert.equal(parsed?.url, 'https://calm-river-1234.trycloudflare.com');
});

test('A12 a blank or empty url is refused rather than throwing later', () => {
  // The exact failure that was observed: success reported, url empty.
  assert.equal(parseTunnelUrl(''), undefined);
  assert.equal(parseTunnelUrl('   '), undefined);
  assert.equal(parseTunnelUrl(undefined), undefined);
  assert.equal(parseTunnelUrl(null), undefined);
  assert.equal(parseTunnelUrl(42), undefined);
});

test('A13 the tunnel url must be https on the tunnel domain, so it cannot widen the allowlist', () => {
  // A different host must not be accepted: it would be added to the remote listener's
  // allowlist and become reachable.
  assert.equal(parseTunnelUrl('https://evil.example.com'), undefined);
  // Not a subdomain of the tunnel domain.
  assert.equal(parseTunnelUrl('https://nottrycloudflare.com'), undefined);
  // Plain http would mean the path is not the TLS-terminated tunnel it claims to be.
  assert.equal(parseTunnelUrl('http://calm-river-1234.trycloudflare.com'), undefined);
  // A trailing-label trick must not match.
  assert.equal(parseTunnelUrl('https://trycloudflare.com.evil.example.com'), undefined);
});

test('A14 a url with a port or path still resolves to a bare hostname', () => {
  const parsed = parseTunnelUrl('https://calm-river-1234.trycloudflare.com:443/some/path?x=1');
  assert.equal(parsed?.hostname, 'calm-river-1234.trycloudflare.com');
});

test('A15 the empty string a daemon reports for an absent listener yields no port instead of throwing', () => {
  // The crash that was reported from the Connect button. The daemon reports an absent optional
  // listener as "", not undefined, and "" survives `??` — so a bare `new URL(value ?? fallback)`
  // threw ERR_INVALID_URL out of the IPC handler and reached the operator as an opaque
  // "Error occurred in handler for 'arena:connect'".
  assert.equal(portOf(''), undefined);
  assert.equal(portOf('   '), undefined);
  assert.equal(portOf(undefined), undefined);
  assert.equal(portOf(null), undefined);
  assert.equal(portOf(0), undefined);
  // A real loopback listener still resolves.
  assert.equal(portOf('http://127.0.0.1:48271'), 48271);
  // Anything that is not a usable URL is refused rather than throwing.
  assert.equal(portOf('not a url'), undefined);
  assert.equal(portOf('http://127.0.0.1/'), undefined);
});

test('A16 a live remote listener is recognised from the url the daemon actually reports', () => {
  // The window decides "is this bridge reachable from the tunnel?" from this. A previous version
  // matched the literal text `mcp_remote` against the URL, which can never match: the daemon
  // reports a bare `http://127.0.0.1:<port>`. That made the indicator permanently false, so the
  // operator was told "not connected" by a bridge that was in fact exposed. The test is now
  // "does this parse to a port?", and this pins both directions.
  const exposed = 'http://127.0.0.1:61872';
  const loopbackOnly = '';
  assert.notEqual(portOf(exposed), undefined, 'a bound remote listener must read as exposed');
  assert.equal(portOf(loopbackOnly), undefined, 'an absent remote listener must read as not exposed');
  // The exact regression: the reported URL does not contain the listener's name.
  assert.ok(!exposed.includes('mcp_remote'), 'the reported url never carries the listener name');
});
