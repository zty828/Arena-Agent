#!/usr/bin/env node
/**
 * End-to-end test of the sandbox MCP client against a real daemon.
 * Exercises: pairing request -> local approval -> claim -> challenge -> discover
 * -> tools -> a real workspace read. Proves the remote-agent path works without
 * needing a public address, by running the client against loopback.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(root, 'outputs', 'run-local.config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const credentials = JSON.parse(fs.readFileSync(path.join(root, '.arena-bridge', 'local-credentials.json'), 'utf8'));
const clientScript = path.join(root, 'client', 'arena_sandbox_client.py');
const statePath = path.join(root, 'outputs', 'sandbox-client-state.json');
const logs = path.join(root, 'outputs', 'local-run');
fs.mkdirSync(logs, { recursive: true });

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

const admin = `http://127.0.0.1:${config.ports.admin}`;
const mcp = `http://127.0.0.1:${config.ports.mcp}`;

function runClient(args, env) {
  const result = spawnSync('python', [clientScript, ...args], {
    cwd: root, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, ARENABRIDGE_URL: mcp, ARENABRIDGE_STATE: statePath, ARENABRIDGE_TIMEOUT: '30', ...env },
  });
  let parsed; try { parsed = result.stdout ? JSON.parse(result.stdout) : undefined; } catch { parsed = undefined; }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', data: parsed, error: result.error };
}

const lockFile = path.join(config.state_directory, 'daemon.lock');
if (fs.existsSync(lockFile)) {
  const owner = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  let alive = true;
  try { process.kill(owner.pid, 0); } catch { alive = false; }
  if (alive) { console.error(`daemon already running (pid ${owner.pid})`); process.exit(1); }
  fs.rmSync(lockFile);
}

const out = fs.openSync(path.join(logs, 'sandbox-e2e.out.log'), 'w');
const err = fs.openSync(path.join(logs, 'sandbox-e2e.err.log'), 'w');
const daemon = spawn(process.execPath, [path.join(root, 'dist', 'apps', 'daemon', 'src', 'cli.js'), 'serve', '--config', configPath], {
  cwd: root, stdio: ['ignore', out, err],
  env: {
    ...process.env,
    ARENABRIDGE_ADMIN_TOKEN: credentials.admin_token,
    ARENABRIDGE_API_TOKEN: credentials.api_token,
    ARENABRIDGE_MCP_TOKEN: credentials.mcp_token ?? credentials.api_token,
  },
});

const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
async function waitReady() {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${admin}/admin/v1/status`, { headers: auth(credentials.admin_token), signal: AbortSignal.timeout(1000) });
      if (response.ok) return await response.json();
      await response.text();
    } catch { /* keep polling */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('daemon not ready');
}

try {
  const status = await waitReady();
  check('daemon ready for sandbox client test', true, { workspaces: status.workspaces.length });
  fs.rmSync(statePath, { force: true });

  // The sandbox has no Python? Then this whole path is unavailable; report honestly.
  const probe = spawnSync('python', ['--version'], { encoding: 'utf8' });
  check('python 3 is available to the client', probe.status === 0, (probe.stdout || probe.stderr || '').trim());

  // 1) local operator creates a one-time pairing invitation
  const pairing = await (await fetch(`${admin}/admin/v1/pairings`, {
    method: 'POST', headers: auth(credentials.admin_token),
    body: JSON.stringify({ workspace_id: status.workspaces[0].id, recipient: 'Sandbox client E2E', max_access: 'ask', ttl_ms: 180000 }),
  })).json();
  check('operator created a pairing invitation', typeof pairing.code === 'string', { pair_id: pairing.pair_id });

  // 2) the sandbox client requests pairing with that code
  const requested = runClient(['pair-request', '--code=' + pairing.code, '--label', 'arena-sandbox-e2e', '--access-mode', 'ask']);
  check('sandbox client requested pairing and stored its claim secret', requested.status === 0 && requested.data?.ok === true, requested.data ?? requested.stderr.slice(0, 300));

  // 3) claiming before approval must not yield a token
  const tooEarly = runClient(['pair-claim']);
  check('claim before local approval returns no token', tooEarly.status === 2 && !(tooEarly.data?.token), { status: tooEarly.status, state: tooEarly.data?.state });

  // 4) local operator approves
  const decision = await (await fetch(`${admin}/admin/v1/pairings/${encodeURIComponent(requested.data.pair_id)}/decision`, {
    method: 'POST', headers: auth(credentials.admin_token),
    body: JSON.stringify({ approve: true, access_mode: 'ask', data_egress_ack: true }),
  })).json();
  check('operator approved the pairing', decision.state === 'approved', decision);

  // 5) claim the grant
  const claimed = runClient(['pair-claim']);
  check('sandbox client claimed a scoped grant with a challenge', claimed.status === 0 && claimed.data?.ok === true && typeof claimed.data.challenge === 'string', {
    grant_id: claimed.data?.grant_id, mode: claimed.data?.access_mode, owner: claimed.data?.execution_owner, scopes: claimed.data?.scopes,
  });

  // 6) discovery over the sandbox client
  const discovered = runClient(['discover']);
  check('sandbox client performed MCP discovery', discovered.status === 0 && discovered.data?.protocol_versions?.includes('2026-07-28'), {
    versions: discovered.data?.protocol_versions, server: discovered.data?.server,
  });

  // 7) a tool call before the challenge is verified must be refused
  const premature = runClient(['call', 'read_files', JSON.stringify({ files: [{ path: 'sum.mjs' }] })]);
  check('workspace read is refused until the challenge is confirmed', premature.status !== 0 || premature.data?.ok === false, { status: premature.status, stderr: premature.stderr.trim().slice(0, 200) });

  // 8) confirm the challenge
  const verified = runClient(['verify', '--challenge=' + claimed.data.challenge]);
  check('challenge confirmed through bridge_health', verified.status === 0 && verified.data?.ok === true && verified.data?.data?.protocol_ready === true, verified.data?.data ?? verified.stderr.slice(0, 300));

  // 9) list tools
  const tools = runClient(['tools']);
  const names = (tools.data?.tools ?? []).map((tool) => tool.name);
  check('sandbox client listed the real tool catalog', tools.status === 0 && names.includes('read_files') && names.includes('list_directory'), names);

  // 10) actually read a file through the bridge
  const read = runClient(['call', 'read_files', JSON.stringify({ files: [{ path: 'sum.mjs' }] })]);
  const text = callData(read)?.files?.[0]?.text;
  check('sandbox client read a real workspace file through the bridge', read.status === 0 && typeof text === 'string' && text.includes('export const sum'), {
    execution_owner: read.data?.execution_owner, bytes: text?.length, hash: callData(read)?.files?.[0]?.version_hash?.slice(0, 12),
  });

  // 11) writing must be refused for an ask-scope grant
  const write = runClient(['call', 'apply_patch', JSON.stringify({ action: 'preview', changes: [{ path: 'sum.mjs', expected_hash: null, patch: '--- a/sum.mjs\n+++ b/sum.mjs\n@@ -1 +1 @@\n-a\n+b\n' }] })]);
  check('read-only grant cannot preview a patch', write.status !== 0 || write.data?.ok === false, { status: write.status, stderr: write.stderr.trim().slice(0, 200) });

  // 12) revoke, then the same token must stop working
  await fetch(`${admin}/admin/v1/revoke-all`, { method: 'POST', headers: auth(credentials.admin_token), body: JSON.stringify({ confirm: true }) });
  const afterRevoke = runClient(['tools']);
  check('revoked grant cannot list tools any more', afterRevoke.status !== 0 && /401|403|AUTHORIZATION|AUTH_REQUIRED/i.test(afterRevoke.stderr), afterRevoke.stderr.trim().slice(0, 200));
} catch (error) {
  check('sandbox client E2E completed without throwing', false, String(error));
} finally {
  daemon.kill('SIGTERM');
  await new Promise((resolve) => { const timer = setTimeout(resolve, 8000); daemon.once('exit', () => { clearTimeout(timer); resolve(); }); });
  if (daemon.exitCode === null) daemon.kill('SIGKILL');
}

const passed = results.filter((entry) => entry.passed).length;
const report = {
  created_at: new Date().toISOString(),
  scope: 'Real daemon plus the stdlib-only sandbox client over loopback. Proves the remote-agent path works; it does NOT prove a public address is reachable from Arena.',
  environment: { node: process.version, platform: process.platform },
  total: results.length, passed, failed: results.length - passed, results,
};
fs.writeFileSync(path.join(root, 'outputs', 'sandbox-client-e2e.json'), JSON.stringify(report, null, 2) + '\n');
for (const entry of results) console.log(`${entry.passed ? 'PASS' : 'FAIL'}  ${entry.name}`);
console.log(`\n${passed}/${results.length} checks passed -> outputs/sandbox-client-e2e.json`);
process.exitCode = passed === results.length ? 0 : 1;
