/**
 * Can the operator actually choose `code` mode, and does the choice hold?
 *
 * Reported by the operator: the copied prompt always asked for `ask`, and editing it to `code`
 * by hand failed with what read like a missing permission. The cause was in our own code, not
 * in Arena and not in the daemon:
 *
 *   - apps/desktop/src/main.ts minted every pairing with `max_access: 'ask'`, and
 *   - packages/policy-engine refuses any request above the code's ceiling with 403
 *     "Requested access exceeds pairing scope", offering no way to raise it afterwards.
 *
 * So `code` was fully implemented and permanently unreachable. This probe drives a real daemon
 * and asserts both halves: the ceiling is genuinely enforced (so the guard is meaningful), and
 * a `code`-scoped code really does grant the write scope.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createDaemon } = await import(pathToFileURL(path.join(root, 'dist', 'apps', 'daemon', 'src', 'server.js')).href);
const { buildArenaPrompt } = await import(pathToFileURL(path.join(root, 'dist', 'apps', 'desktop', 'src', 'prompt.js')).href);

let failures = 0;
const check = (ok, message) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`);
};

const fixtureRoot = path.join(root, '.test-data');
fs.mkdirSync(fixtureRoot, { recursive: true });
const workspace = fs.mkdtempSync(path.join(fixtureRoot, 'mode-'));
fs.writeFileSync(path.join(workspace, 'a.md'), '# a\n');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-mode-'));
const adminToken = 'a'.repeat(48);
const daemon = await createDaemon({
  schema_version: 1,
  state_directory: stateDir,
  ports: { api: 0, mcp: 0, mcp_remote: 0, admin: 0 },
  workspaces: [{ root: workspace, display_name: 'mode-check' }],
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

// /pair/request is a plain path on the MCP listener and needs no bearer: the remote has no
// credential yet, which is the whole point of pairing.
const requestPairing = (code, mode) => fetch(daemon.urls.mcp + '/pair/request', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code, remote_label: 'Arena Agent (desktop window)', access_mode: mode }),
}).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));

const workspaceId = daemon.workspaces[0].id;
const mint = (maxAccess) => admin('POST', '/admin/v1/pairings', {
  workspace_id: workspaceId, recipient: 'Arena Agent (desktop window)',
  max_access: maxAccess, ttl_ms: 1800000, grant_ttl_ms: 3600000,
});

// ---------------------------------------------------------------------------
// 1) The ceiling is enforced — this is the behaviour the operator hit.
// ---------------------------------------------------------------------------
const askScoped = await mint('ask');
check(askScoped.status === 201, `a pairing can be minted with max_access=ask (HTTP ${askScoped.status})`);

const askOnAsk = await requestPairing(askScoped.data.code, 'ask');
check(askOnAsk.status === 202 && askOnAsk.data?.state === 'pending',
  `an ask request against an ask-scoped code is accepted (HTTP ${askOnAsk.status} state=${askOnAsk.data?.state})`);

// Same code, asking for more. This is precisely what editing the prompt by hand produced.
const askCode = await requestPairing(askScoped.data.code, 'code');
check(askCode.status === 403,
  `a code request against the SAME ask-scoped code is refused (HTTP ${askCode.status})`);

// A fresh code, because the first was consumed: prove the refusal tracks the ceiling and not
// the fact that the earlier request already moved the pairing out of `created`.
const planScoped = await mint('plan');
const planCode = await requestPairing(planScoped.data.code, 'code');
check(planCode.status === 403,
  `a code request against a plan-scoped code is also refused (HTTP ${planCode.status})`);
// ...and the message names the actual rule, so the operator can tell "ceiling" from "expired".
check(/exceeds pairing scope/i.test(JSON.stringify(planCode.data ?? {})),
  `the refusal explains it is a scope ceiling (got ${JSON.stringify(planCode.data?.error?.message ?? planCode.data)})`);

// ---------------------------------------------------------------------------
// 2) A code-scoped pairing really does grant write access, so choosing code is not theatre.
// ---------------------------------------------------------------------------
const codeScoped = await mint('code');
check(codeScoped.status === 201, `a pairing can be minted with max_access=code (HTTP ${codeScoped.status})`);
const codeOnCode = await requestPairing(codeScoped.data.code, 'code');
check(codeOnCode.status === 202 && codeOnCode.data?.state === 'pending',
  `a code request against a code-scoped code is accepted (HTTP ${codeOnCode.status} state=${codeOnCode.data?.state})`);

// Approve it exactly the way the window's button does, then claim and inspect the grant.
const approved = await admin('POST', `/admin/v1/pairings/${codeOnCode.data.pair_id}/decision`, {
  approve: true, access_mode: 'code', data_egress_ack: true,
});
check(approved.status === 200, `the window's approval call is accepted (HTTP ${approved.status})`);

const claimed = await fetch(daemon.urls.mcp + '/pair/claim', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ pair_id: codeOnCode.data.pair_id, claim_secret: codeOnCode.data.claim_secret }),
}).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));

check(claimed.data?.access_mode === 'code', `the issued grant carries mode code (got ${claimed.data?.access_mode})`);
check((claimed.data?.scopes ?? []).includes('workspace:patch'),
  `the code-mode grant includes the write scope (scopes=${JSON.stringify(claimed.data?.scopes)})`);

// The contrast that makes the above meaningful: an ask-mode grant must NOT carry it.
const askGrant = await admin('POST', '/admin/v1/pairings', {
  workspace_id: workspaceId, recipient: 'Arena Agent (desktop window)',
  max_access: 'ask', ttl_ms: 600000, grant_ttl_ms: 600000,
});
const askReq2 = await requestPairing(askGrant.data.code, 'ask');
await admin('POST', `/admin/v1/pairings/${askReq2.data.pair_id}/decision`, {
  approve: true, access_mode: 'ask', data_egress_ack: true,
});
const askClaim = await fetch(daemon.urls.mcp + '/pair/claim', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ pair_id: askReq2.data.pair_id, claim_secret: askReq2.data.claim_secret }),
}).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));

check(!(askClaim.data?.scopes ?? []).includes('workspace:patch'),
  `an ask-mode grant does NOT include the write scope (scopes=${JSON.stringify(askClaim.data?.scopes)})`);

// ---------------------------------------------------------------------------
// 3) The approval cannot exceed what was requested — so the panel's mode must match the code.
// ---------------------------------------------------------------------------
const planScoped2 = await mint('plan');
const planReq = await requestPairing(planScoped2.data.code, 'plan');
const escalate = await admin('POST', `/admin/v1/pairings/${planReq.data.pair_id}/decision`, {
  approve: true, access_mode: 'code', data_egress_ack: true,
});
check(escalate.status === 403,
  `approving ABOVE the requested mode is refused (HTTP ${escalate.status})`);

// --- the exec tier, the one that grants command execution --------------------------------
//
// Added when the operator asked for command execution with no approval step. "No approval" is not
// "no ceiling": whether a session may run commands is still decided by the pairing code, before it
// is minted, and cannot be raised afterwards. These checks pin that, plus the two facts a reader
// of the prompt has to be able to rely on: exec implies the patch scope (a shell can write files,
// so withholding it would be a limit in name only) and the prompt says out loud that commands run
// without an approval step.
const execScoped = await admin('POST', '/admin/v1/pairings', {
  workspace_id: workspaceId, recipient: 'exec ceiling', max_access: 'exec', ttl_ms: 1800000, grant_ttl_ms: 3600000,
});
check(execScoped.status === 201, `a pairing can be minted with max_access=exec (HTTP ${execScoped.status})`);
const execRequest = await fetch(daemon.urls.mcp + '/pair/request', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code: execScoped.data.code, remote_label: 'exec', access_mode: 'exec' }),
}).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
check(execRequest.status === 202, `an exec request against an exec code is accepted (HTTP ${execRequest.status})`);
await admin('POST', `/admin/v1/pairings/${execRequest.data.pair_id}/decision`, { approve: true, access_mode: 'exec', data_egress_ack: true });
const execClaim = await fetch(daemon.urls.mcp + '/pair/claim', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ pair_id: execRequest.data.pair_id, claim_secret: execRequest.data.claim_secret }),
}).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
check(execClaim.data?.scopes?.includes('workspace:exec') && execClaim.data?.scopes?.includes('workspace:patch'),
  `the exec grant carries both exec and patch scopes (${JSON.stringify(execClaim.data?.scopes)})`);
// And the ceiling still works in the other direction: a code-scoped code cannot be raised to exec.
const codeScopedAgain = await admin('POST', '/admin/v1/pairings', {
  workspace_id: workspaceId, recipient: 'code ceiling', max_access: 'code', ttl_ms: 1800000, grant_ttl_ms: 3600000,
});
const escalateToExec = await fetch(daemon.urls.mcp + '/pair/request', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code: codeScopedAgain.data.code, remote_label: 'escalate', access_mode: 'exec' }),
}).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
check(escalateToExec.status === 403,
  `a code-scoped pairing cannot be raised to exec by asking (HTTP ${escalateToExec.status})`);

const execPrompt = buildArenaPrompt({
  publicUrl: 'https://x-1.trycloudflare.com', pairingCode: 'c-1234567890',
  workspaceRoot: '/w', recipient: 'r', accessMode: 'exec',
});
check(/没有人工批准这一步/.test(execPrompt), 'the exec prompt says commands run without an approval step');
check(/exec 档/.test(execPrompt) && /run_command/.test(execPrompt), 'and it names the tool and the tier');
check(/没有交互式输入/.test(execPrompt), 'and it says interactive input is not available (no PTY)');
const codePrompt = buildArenaPrompt({
  publicUrl: 'https://x-1.trycloudflare.com', pairingCode: 'c-1234567890',
  workspaceRoot: '/w', recipient: 'r', accessMode: 'code',
});
check(!/run_command/.test(codePrompt) && !/没有人工批准这一步/.test(codePrompt),
  'a code prompt does not describe command execution at all');
const askPrompt = buildArenaPrompt({
  publicUrl: 'https://x-1.trycloudflare.com', pairingCode: 'c-1234567890',
  workspaceRoot: '/w', recipient: 'r', accessMode: 'ask',
});
check(!/run_command/.test(askPrompt), 'nor does a read-only one');

await daemon.close();

// ---------------------------------------------------------------------------
// 4) Static wiring: the mode must reach all three places, or the remote silently gets less
//    than the operator chose. The prompt is the only one of the three the remote can see.
// ---------------------------------------------------------------------------
const promptSource = fs.readFileSync(path.join(root, 'apps', 'desktop', 'src', 'prompt.ts'), 'utf8');
check(/accessMode: AccessMode/.test(promptSource), 'the prompt input requires an access mode');
check(!/--access-mode=ask['"`]/.test(promptSource), 'the prompt no longer hard-codes --access-mode=ask');

const mainSource = fs.readFileSync(path.join(root, 'apps', 'desktop', 'src', 'main.ts'), 'utf8');
check(/createPairing\(workspaceId, recipient, accessMode\)/.test(mainSource),
  'the pairing code is minted with the chosen mode (the ceiling)');
check(/max_access: maxAccess/.test(mainSource), 'createPairing sends that mode as max_access');
check(/buildArenaPrompt\(\{[^}]*accessMode/s.test(mainSource.replace(/\n/g, ' ')),
  'the prompt is built with the same mode');
check(/ipcMain\.handle\('arena:connect', async \(_event, accessMode/.test(mainSource),
  'the IPC handler accepts the mode from the renderer');
check(/normaliseAccessMode/.test(mainSource),
  'an unknown mode from the renderer falls back to the safe default');

const preloadSource = fs.readFileSync(path.join(root, 'apps', 'desktop', 'src', 'preload.cjs'), 'utf8');
check(/arenaConnect: \(accessMode\) => ipcRenderer\.invoke\('arena:connect', accessMode\)/.test(preloadSource),
  'the preload bridge forwards the mode');

// The prompt is what the remote reads, so verify the wording for each mode directly.
for (const mode of ['ask', 'plan', 'code', 'exec']) {
  const text = buildArenaPrompt({
    publicUrl: 'https://x-1.trycloudflare.com', pairingCode: 'c-1234567890',
    workspaceRoot: '/w', recipient: 'r', accessMode: mode,
  });
  check(text.includes(`--access-mode=${mode}`), `the prompt asks for ${mode} when ${mode} is selected`);
  check(text.includes('不要自己把 --access-mode 改成更高的档位'),
    `the prompt for ${mode} tells the agent not to raise the mode itself`);
}

// --- the tier list lives in four places, and they have to agree --------------------------
//
// This is the defect a remote agent hit: `exec` was added to the engine, the prompt and the
// window's picker, but not to the sandbox client's argparse whitelist. `pair-request
// --access-mode=exec` then died inside argparse with exit code 2, before a single byte went over
// the network — which is indistinguishable from a server-side refusal, so the operator and the
// remote both spent a round trip on the wrong end of the wire.
//
// The lists cannot be shared (the client is Python, the picker is HTML), so they are compared.
// Every copy has to carry the same tiers in the same order.
const readList = (label, file, pattern) => {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  const match = pattern.exec(text);
  if (!match) { check(false, `${label}: could not find the tier list`); return null; }
  return match[1].split(',').map((entry) => entry.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
};
const engineTiers = readList('engine', 'packages/policy-engine/src/index.ts', /ACCESS_MODES\s*=\s*\[([^\]]+)\]/);
const clientTiers = readList('sandbox client', 'client/arena_sandbox_client.py', /ACCESS_MODES\s*=\s*\[([^\]]+)\]/);
const windowTiers = readList('window main', 'apps/desktop/src/main.ts', /ACCESS_MODES[^=]*=\s*\[([^\]]+)\]/);
const pickerHtml = fs.readFileSync(path.join(root, 'apps/desktop/src/renderer/index.html'), 'utf8');
const pickerTiers = [...pickerHtml.matchAll(/name="arenaMode"\s+value="([^"]+)"/g)].map((match) => match[1]);
check(Array.isArray(engineTiers) && engineTiers.join(',') === 'ask,plan,code,exec',
  `the engine declares the four tiers in rank order (${JSON.stringify(engineTiers)})`);
for (const [label, list] of [['the sandbox client', clientTiers], ['the window main process', windowTiers], ['the window picker', pickerTiers]]) {
  check(Array.isArray(list) && engineTiers && list.join(',') === engineTiers.join(','),
    `${label} accepts exactly the same tiers as the engine (${JSON.stringify(list)})`);
}

// The renderer is the fifth copy, and the one that cost a round trip with a remote: it approved
// pairing requests through its own tier list (`code`/`plan` pass, everything else → `ask`), so a
// request for `exec` was answered with `ask` — the operator saw "批准" succeed and the remote
// received a read-only grant, which reads as "the exec tier never took effect".
//
// The behavioural half of that lives in `desktop:selftest` (it drives the real panel and asserts
// the decision body). What is checked here is that no such list has been reintroduced, and that
// every tier has a display label — an `exec` grant used to be shown as 只读 in the authorisation
// list, which is the one place the operator looks to see what is currently allowed.
const rendererSource = fs.readFileSync(path.join(root, 'apps', 'desktop', 'src', 'renderer', 'app.js'), 'utf8');
check(!/requested\s*===\s*'code'\s*\|\|\s*requested\s*===\s*'plan'/.test(rendererSource),
  'the renderer does not keep its own tier whitelist for approvals');
check(/const accessMode = card\.dataset\.access \|\| 'ask';/.test(rendererSource),
  'approval echoes the requested tier instead of filtering it');
const labelKeys = [...(/const TIER_LABELS = \{([\s\S]*?)\};/.exec(rendererSource)?.[1] ?? '').matchAll(/(\w+):\s*'/g)].map((match) => match[1]);
check(engineTiers && labelKeys.join(',') === engineTiers.join(','),
  `every tier has a display label, in the same order (${JSON.stringify(labelKeys)})`);
check(/const label = g\.revoked \? '已撤销' : tierLabel\(mode\);/.test(rendererSource),
  'the authorisation list labels a grant by its tier rather than assuming "not code means read-only"');

// The browser console is the other operator surface, and it had all three of the same problems:
// its picker could not mint an exec code, its approval prompt said "ask / plan / code" and
// defaulted to `ask` (so pressing Enter on an exec request handed out a read-only grant), and its
// authorisation list labelled an exec grant as 只读.
const consoleSource = fs.readFileSync(path.join(root, 'apps', 'daemon', 'src', 'console.ts'), 'utf8');
const consoleTiers = [...consoleSource.matchAll(/<option value="([^"]+)">/g)].map((match) => match[1])
  .filter((value) => (engineTiers ?? []).includes(value));
check(engineTiers && consoleTiers.join(',') === engineTiers.join(','),
  `the console can mint every tier (${JSON.stringify(consoleTiers)})`);
check(/prompt\('批准权限（ask \/ plan \/ code \/ exec）：',\s*requested\)/.test(consoleSource),
  'the console approval prompt names every tier and defaults to the requested one');
check(!/mode === 'code' \? '可写（每次需审批）' : '只读'/.test(consoleSource),
  'the console grant list does not assume "not code means read-only"');

// And the client really does accept them, run as the remote runs it. A static comparison alone
// would pass if argparse were given the right list in the wrong place.
const clientScript = path.join(root, 'client', 'arena_sandbox_client.py');
const runClient = (mode) => spawnSync('python', [clientScript, 'pair-request', '--code=' + 'x'.repeat(40), '--access-mode=' + mode], {
  cwd: root, encoding: 'utf8', timeout: 60000,
  // Nothing is listening: argparse has to get past the argument before any of that matters.
  env: { ...process.env, ARENABRIDGE_URL: 'http://127.0.0.1:1', ARENABRIDGE_TIMEOUT: '2' },
});
for (const mode of engineTiers ?? []) {
  const run = runClient(mode);
  const refused = run.status === 2 || /invalid choice/.test(run.stderr ?? '');
  check(!refused, `the client accepts --access-mode=${mode} (exit ${run.status})`);
}
const bogus = runClient('bogus');
check(bogus.status === 2 && /invalid choice/.test(bogus.stderr ?? ''),
  'and still rejects a tier that does not exist, so the check above is not vacuous');

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll checks passed.');
