/**
 * Command execution, the edit helper and real regex search.
 *
 * Requested by the operator: "增加一下命令执行的能力，并且补全其他缺失能力，全流程参考主流 Harness",
 * with command execution explicitly allowed to run *without* any approval step.
 *
 * That choice removes the last thing standing between a remote agent and arbitrary code on this
 * machine, so the checks that matter here are not "does echo work". They are the bounds and the
 * records that are left once approval is gone:
 *
 *   - the tier gate: a `code` grant cannot run a command at all, however it asks;
 *   - the working directory cannot leave the workspace;
 *   - the daemon's own credentials are not in the child environment (otherwise one `echo %VAR%`
 *     escalates a workspace grant into full local admin);
 *   - a command cannot outlive its deadline, and killing it kills its whole tree — a shell that
 *     dies while `node` keeps running is the failure mode that makes "stop" a lie;
 *   - output is capped, and every command is recorded with its text and hash, because that log is
 *     now the operator's only account of what ran;
 *   - revoking access terminates what is already running;
 *   - a catastrophic regex cannot wedge the bridge (the daemon serves all three ports from one
 *     event loop, so a pattern that never returns is a whole-product outage).
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

const fixtureRoot = path.join(root, '.test-data');
fs.mkdirSync(fixtureRoot, { recursive: true });
const workspace = fs.mkdtempSync(path.join(fixtureRoot, 'exec-'));
fs.writeFileSync(path.join(workspace, 'seed.txt'), 'seed\n');
fs.writeFileSync(path.join(workspace, 'dup.txt'), 'same\nsame\n');
// The line must FAIL to match the pattern below: `(a+)+$` on a run of `a`s matches instantly,
// and only the failing case backtracks. Measured: with a trailing `b` it does not return in 5s.
fs.writeFileSync(path.join(workspace, 'slow.txt'), `${'a'.repeat(2000)}b\n`);

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-exec-'));
// The credential is deliberately a distinctive string, not a repeated letter: the environment
// check below is only meaningful if the value it looks for cannot appear by accident.
const ADMIN_TOKEN_VALUE = 'admin-secret-value-that-must-not-leak';
const ADMIN = ADMIN_TOKEN_VALUE;
// The real deployment injects the credentials into the daemon's *process environment*
// (`ARENABRIDGE_ADMIN_TOKEN=... cli.js serve`). Reproducing that here is what makes the
// environment check below able to fail: without a variable to leak, it would pass for the
// wrong reason and prove nothing.
process.env.ARENABRIDGE_ADMIN_TOKEN = ADMIN_TOKEN_VALUE;
process.env.ARENABRIDGE_API_TOKEN = 'api-secret-value-that-must-not-leak';
process.env.ARENABRIDGE_MCP_TOKEN = 'mcp-secret-value-that-must-not-leak';
const daemon = await createDaemon({
  schema_version: 1, state_directory: stateDir, ports: { api: 0, mcp: 0, mcp_remote: 0, admin: 0 },
  workspaces: [{ root: workspace, display_name: 'exec-check' }],
  response_mode: 'json', security_profile: 'local_trusted_development', arena_enabled: false,
  remote_ingress: { enabled: false, acknowledge_exposure: false, bind_address: '127.0.0.1', allow_cidrs: [], allowed_hosts: [], require_grant: true },
  gateway: { type: 'disabled' },
}, { adminToken: ADMIN_TOKEN_VALUE, clientToken: 'b'.repeat(48), mcpToken: 'c'.repeat(48) });

const admin = (method, route, body) => fetch(daemon.urls.admin + route, {
  method,
  headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
  ...(body ? { body: JSON.stringify(body) } : {}),
}).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));

const MODERN = '2026-07-28';
let sequence = 0;
const rpc = (token, method, params, name) => {
  sequence += 1;
  return fetch(daemon.urls.mcp + '/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': MODERN, 'Mcp-Method': method, ...(name ? { 'Mcp-Name': name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: sequence, method, params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN,
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': { name: 'exec-check', version: '1.0.0' },
        },
      },
    }),
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
};
const callTool = (token, name, args) => rpc(token, 'tools/call', { name, arguments: args }, name);
const envelope = (rpcResult) => rpcResult?.data?.result?.structuredContent ?? null;
// A refusal arrives in three shapes: an HTTP status, a tool-error envelope inside a 200 body, or
// a JSON-RPC error (which is what an unadvertised tool gets: the transport answers
// `-32602 Tool ... not found`). Checking only one of them would read a refusal as success.
const refused = (rpcResult) => rpcResult.status >= 400 || envelope(rpcResult)?.ok === false || !!rpcResult.data?.error;

/** Pairs with the given ceiling and returns the grant token. */
const pair = async (maxAccess) => {
  const pairing = await admin('POST', '/admin/v1/pairings', {
    workspace_id: daemon.workspaces[0].id, recipient: `exec-check-${maxAccess}`, max_access: maxAccess, ttl_ms: 1800000,
  });
  const requested = await fetch(daemon.urls.mcp + '/pair/request', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: pairing.data.code, remote_label: `exec-check-${maxAccess}`, access_mode: maxAccess }),
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
  await admin('POST', `/admin/v1/pairings/${requested.data.pair_id}/decision`, { approve: true, access_mode: maxAccess, data_egress_ack: true });
  const claim = await fetch(daemon.urls.mcp + '/pair/claim', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pair_id: requested.data.pair_id, claim_secret: requested.data.claim_secret }),
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
  await callTool(claim.data.token, 'bridge_health', { challenge: claim.data.challenge });
  return claim.data;
};

// ---------------------------------------------------------------------------
// 1) The tier gate. "No approval" is not the same as "no gate": a code grant must not be able to
//    run a command, and the tool must not even be advertised to it.
// ---------------------------------------------------------------------------
const codeGrant = await pair('code');
const execGrant = await pair('exec');
check(execGrant.scopes.includes('workspace:exec') && execGrant.scopes.includes('workspace:patch'),
  `the exec tier carries both the exec and patch scopes (${JSON.stringify(execGrant.scopes)})`);
check(!codeGrant.scopes.includes('workspace:exec'),
  `the code tier does not carry the exec scope (${JSON.stringify(codeGrant.scopes)})`);

const codeTools = (await rpc(codeGrant.token, 'tools/list', { limit: 100 })).data?.result?.tools ?? [];
const execTools = (await rpc(execGrant.token, 'tools/list', { limit: 100 })).data?.result?.tools ?? [];
const names = (tools) => tools.map((tool) => tool.name);
check(!names(codeTools).includes('run_command'),
  `run_command is not offered to a code grant (${JSON.stringify(names(codeTools))})`);
check(names(execTools).includes('run_command'), 'run_command is offered to an exec grant');
check(names(execTools).includes('edit_file'), 'edit_file is offered to a write tier');
check(!names((await rpc((await pair('ask')).token, 'tools/list', { limit: 100 })).data?.result?.tools ?? []).includes('edit_file'),
  'edit_file is not offered to a read-only grant');

const refusedExec = await callTool(codeGrant.token, 'run_command', { command: 'echo nope' });
check(refused(refusedExec),
  `a code grant cannot run a command (${JSON.stringify(refusedExec.data?.error?.message ?? envelope(refusedExec)?.error?.code ?? refusedExec.status)})`);
// Two layers, and both are asserted: the tool is not advertised to a code grant, and the
// dispatch re-checks the scope rather than trusting the list. A future change that widens the
// list would still be refused by the second.
const toolSource = fs.readFileSync(path.join(root, 'apps', 'daemon', 'src', 'tools.ts'), 'utf8');
check(/name==='run_command'\)\{\s*\n\s*this\.policy\.authorize\(context,'workspace:exec'\)/.test(toolSource),
  'and the dispatch re-checks the exec scope instead of trusting the advertised list');

// ---------------------------------------------------------------------------
// 2) It runs, and it runs in the workspace.
// ---------------------------------------------------------------------------
const echoed = await callTool(execGrant.token, 'run_command', { command: 'echo hello' });
const echoedData = envelope(echoed)?.data;
check(envelope(echoed)?.ok === true && echoedData?.exit_code === 0,
  `a command runs and reports its exit code (ok=${JSON.stringify(envelope(echoed)?.ok)} exit=${JSON.stringify(echoedData?.exit_code)})`);
check(typeof echoedData?.stdout === 'string' && echoedData.stdout.includes('hello'),
  `its stdout comes back (${JSON.stringify(echoedData?.stdout)})`);
check(typeof echoedData?.cwd === 'string' && path.resolve(echoedData.cwd) === path.resolve(workspace),
  `it starts in the workspace root (${JSON.stringify(echoedData?.cwd)})`);
check(typeof echoedData?.shell === 'string' && echoedData.shell.length > 0,
  `the shell is named rather than left implicit (${JSON.stringify(echoedData?.shell)})`);

const escaped = await callTool(execGrant.token, 'run_command', { command: 'echo x', cwd: '..' });
check(refused(escaped) && envelope(escaped)?.error?.code === 'PATH_DENIED',
  `a cwd outside the workspace is refused (code=${JSON.stringify(envelope(escaped)?.error?.code ?? escaped.status)})`);

// ---------------------------------------------------------------------------
// 3) The daemon's credentials are not handed to the child. Without this, one command that prints
//    its environment escalates a workspace grant into local admin.
// ---------------------------------------------------------------------------
const envProbe = await callTool(execGrant.token, 'run_command', { command: 'set' });
const envText = `${envelope(envProbe)?.data?.stdout ?? ''}${envelope(envProbe)?.data?.stderr ?? ''}`;
check(!envText.includes(ADMIN_TOKEN_VALUE),
  'the admin credential is not in the child environment');
check(!/ARENABRIDGE_/i.test(envText), `no ARENABRIDGE_* variable is inherited (matched=${JSON.stringify(envText.match(/ARENABRIDGE_\w+/i)?.[0] ?? null)})`);
check(!envText.includes('api-secret-value-that-must-not-leak') && !envText.includes('mcp-secret-value-that-must-not-leak'),
  'and neither are the other two credentials the daemon holds');

// ---------------------------------------------------------------------------
// 4) Timeout, and the tree really dies. A shell that exits while its child keeps working would
//    make "the command timed out" a false statement.
// ---------------------------------------------------------------------------
const lateFile = path.join(workspace, 'late.txt');
// The delayed side effect lands 4s in and the assertion waits 5.2s. That window is sized for how
// the cleanup actually works: the timeout result returns immediately, while the descendant sweep
// has to start an interpreter whose startup is a few hundred ms (more under load). A tighter
// window measured a race in the *probe*, not a surviving process — it went red once under load
// even though the sweep had already done its job.
const slow = await callTool(execGrant.token, 'run_command', {
  command: 'node -e "setTimeout(()=>require(\'fs\').writeFileSync(\'late.txt\',\'x\'),4000)"',
  timeout_ms: 600,
});
const slowData = envelope(slow)?.data;
check(slowData?.timed_out === true && slowData?.signal === 'timeout',
  `a command that overruns its deadline is reported as timed out (timed_out=${JSON.stringify(slowData?.timed_out)} signal=${JSON.stringify(slowData?.signal)})`);
check(slowData?.duration_ms < 2000, `and the timeout is reported promptly (${JSON.stringify(slowData?.duration_ms)} ms)`);
await new Promise((resolve) => setTimeout(resolve, 5200));
check(!fs.existsSync(lateFile),
  'the killed command never reached its later side effect, so the whole process tree was killed');

// ---------------------------------------------------------------------------
// 5) Output is capped.
// ---------------------------------------------------------------------------
const chatty = await callTool(execGrant.token, 'run_command', { command: 'node -e "process.stdout.write(\'x\'.repeat(200000))"' });
const chattyData = envelope(chatty)?.data;
check(chattyData?.stdout_bytes >= 200000 && chattyData?.truncated === true,
  `a chatty command is capped and flagged (bytes=${JSON.stringify(chattyData?.stdout_bytes)} truncated=${JSON.stringify(chattyData?.truncated)})`);
check((chattyData?.stdout ?? '').length <= 65536,
  `the returned stdout respects the cap (${(chattyData?.stdout ?? '').length})`);

// ---------------------------------------------------------------------------
// 6) The record. With no approval in front of it, this event is the operator's only account of
//    what ran, so it has to carry the command and a hash of it.
// ---------------------------------------------------------------------------
const commandEvents = daemon.store.events(0, 500).filter((event) => event.type === 'command.completed');
check(commandEvents.length >= 4, `every command is recorded (${commandEvents.length} command.completed)`);
const sample = commandEvents.find((event) => (event.payload.command_preview ?? '').includes('echo hello'));
check(!!sample, 'the record includes the command text');
check(typeof sample?.payload.command_hash === 'string' && sample.payload.command_hash.length === 64,
  `and a hash of the exact command line (${JSON.stringify(sample?.payload.command_hash?.slice(0, 12))})`);
check(sample?.payload.exit_code === 0, `with its exit code (${JSON.stringify(sample?.payload.exit_code)})`);

// ---------------------------------------------------------------------------
// 7) Revoking terminates what is already running.
// ---------------------------------------------------------------------------
const inFlight = callTool(execGrant.token, 'run_command', { command: 'node -e "setTimeout(()=>{},15000)"', timeout_ms: 14000 });
await new Promise((resolve) => setTimeout(resolve, 500));
const revoke = await admin('POST', '/admin/v1/revoke-all', { confirm: true });
check(revoke.status === 200 && revoke.data?.killed_commands >= 1,
  `revoking reports the commands it killed (killed=${JSON.stringify(revoke.data?.killed_commands)})`);
const settled = await inFlight;
check(String(envelope(settled)?.data?.signal ?? '').startsWith('killed'),
  `and the in-flight command ends as killed rather than running on (signal=${JSON.stringify(envelope(settled)?.data?.signal)})`);

// ---------------------------------------------------------------------------
// 8) edit_file: same pipeline as apply_patch, friendlier authoring.
// ---------------------------------------------------------------------------
const execGrant2 = await pair('exec');
const ambiguous = await callTool(execGrant2.token, 'edit_file', { path: 'dup.txt', old_string: 'same', new_string: 'other', expected_hash: null });
check(envelope(ambiguous)?.error?.code === 'EDIT_AMBIGUOUS',
  `an ambiguous old_string is refused instead of picking one (code=${JSON.stringify(envelope(ambiguous)?.error?.code)})`);
const missingText = await callTool(execGrant2.token, 'edit_file', { path: 'seed.txt', old_string: 'not-in-the-file', new_string: 'x', expected_hash: null });
check(envelope(missingText)?.error?.code === 'EDIT_NOT_FOUND',
  `text that is not there is refused (code=${JSON.stringify(envelope(missingText)?.error?.code)})`);
const wrongHash = await callTool(execGrant2.token, 'edit_file', { path: 'seed.txt', old_string: 'seed', new_string: 'planted', expected_hash: '0'.repeat(64) });
check(envelope(wrongHash)?.error?.code === 'VERSION_CONFLICT',
  `a pinned hash that does not match is refused (code=${JSON.stringify(envelope(wrongHash)?.error?.code)})`);

// With the unattended window open it applies in one call, exactly like apply_patch action=write.
await admin('POST', '/admin/v1/auto-approve', { enabled: true, confirm: true });
const edited = await callTool(execGrant2.token, 'edit_file', { path: 'seed.txt', old_string: 'seed', new_string: 'planted', expected_hash: null });
check(envelope(edited)?.ok === true && envelope(edited)?.data?.state === 'applied',
  `edit_file applies through the same pipeline (state=${JSON.stringify(envelope(edited)?.data?.state)} error=${JSON.stringify(envelope(edited)?.error?.code ?? null)})`);
check(fs.readFileSync(path.join(workspace, 'seed.txt'), 'utf8').includes('planted'),
  'and the file really changed');
await admin('POST', '/admin/v1/auto-approve', { enabled: false });

// ---------------------------------------------------------------------------
// 9) Real regex, and the guarantee that a hostile one cannot take the bridge down with it.
// ---------------------------------------------------------------------------
const regexHit = await callTool(execGrant2.token, 'search_files', { pattern: 'plante[dn]', regex: true });
check(envelope(regexHit)?.data?.matches?.some((match) => match.path === 'seed.txt'),
  `regex search matches (${JSON.stringify(envelope(regexHit)?.data?.matches?.map((m) => m.path))})`);
const regexBad = await callTool(execGrant2.token, 'search_files', { pattern: '([', regex: true });
check(refused(regexBad) && envelope(regexBad)?.error?.code === 'INVALID_ARGUMENT',
  `an invalid pattern is refused with a reason (code=${JSON.stringify(envelope(regexBad)?.error?.code)})`);

// `(a+)+$` against a long run of `a`s is the classic catastrophic backtracking case. It must be
// stopped by the deadline, and — the part that actually matters — the daemon must still be serving
// afterwards, since all three ports share one event loop.
const started = Date.now();
const catastrophic = await callTool(execGrant2.token, 'search_files', { pattern: '(a+)+$', regex: true });
const elapsed = Date.now() - started;
check(envelope(catastrophic)?.error?.code === 'REGEX_TIMEOUT',
  `a catastrophic pattern is stopped by the deadline (code=${JSON.stringify(envelope(catastrophic)?.error?.code)} in ${elapsed}ms)`);
check(elapsed < 8000, `and it returns rather than hanging (${elapsed}ms)`);
const stillAlive = await callTool(execGrant2.token, 'bridge_health', {});
check(envelope(stillAlive)?.ok === true,
  'the daemon still answers after a catastrophic pattern, so one search cannot wedge the bridge');

// NOTE: the real client is deliberately NOT driven from here. In this environment a child process
// cannot read from a loopback port held by its parent — the connection is accepted and then no byte
// ever arrives — and this probe runs the daemon in-process. The client's own tier handling is
// covered where it can actually run: `probe:access-mode` executes the script's argparse for every
// tier (exactly the failure a remote hit: `--access-mode=exec` dying client-side with exit 2 and no
// network traffic at all), and `write-cycle-e2e` drives the whole flow through a separately spawned
// daemon.

console.log('');
if (failures === 0) console.log('All checks passed.');
else console.log(`${failures} check(s) failed.`);
await daemon.close().catch(() => undefined);
process.exit(failures === 0 ? 0 : 1);
