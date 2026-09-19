#!/usr/bin/env node
/**
 * Rehearses exactly what the remote agent will do, over the real global IPv6:
 * fetch the client script from the bridge with curl, then run the full handshake
 * and a real workspace read. Nothing is simulated; the only difference from Arena
 * is that the caller is this machine instead of a remote sandbox.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const credentials = JSON.parse(fs.readFileSync(path.join(root, '.arena-bridge', 'local-credentials.json'), 'utf8'));

function globalIPv6() {
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const entry of list ?? []) {
      const value = entry.address.split('%')[0];
      if (entry.family === 'IPv6' && !entry.internal && /^[23]/.test(value) && name === '以太网') return value;
    }
  }
  return null;
}
const address = process.argv[2] ?? globalIPv6();
if (!address) { console.error('No global IPv6 found. Pass one explicitly.'); process.exit(1); }

const stamp = Date.now();
const state = path.join(root, 'outputs', 'arena-flow', `s-${stamp}`);
fs.mkdirSync(state, { recursive: true });
const base = JSON.parse(fs.readFileSync(path.join(root, 'outputs', 'run-local.config.json'), 'utf8'));
const config = {
  ...base, state_directory: state, ports: { api: 0, mcp: 0, mcp_remote: 0, admin: 0 },
  remote_ingress: { enabled: true, acknowledge_exposure: true, bind_address: '::', allow_cidrs: [], require_grant: true },
};
const configPath = path.join(state, 'config.json');
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

const out = fs.openSync(path.join(state, 'daemon.out.log'), 'w');
const err = fs.openSync(path.join(state, 'daemon.err.log'), 'w');
const daemon = spawn(process.execPath, [path.join(root, 'dist', 'apps', 'daemon', 'src', 'cli.js'), 'serve', '--config', configPath], {
  cwd: root, stdio: ['ignore', out, err],
  env: {
    ...process.env,
    ARENABRIDGE_ADMIN_TOKEN: credentials.admin_token,
    ARENABRIDGE_API_TOKEN: credentials.api_token,
    ARENABRIDGE_MCP_TOKEN: credentials.mcp_token ?? credentials.api_token,
  },
});

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

const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
const downloaded = path.join(state, 'ab_client.py');
const clientState = path.join(state, 'ab_state.json');

function runClient(args) {
  const result = spawnSync('python', [downloaded, ...args], {
    cwd: root, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, ARENABRIDGE_URL: mcpUrl, ARENABRIDGE_STATE: clientState, ARENABRIDGE_TIMEOUT: '30' },
  });
  let data; try { data = result.stdout ? JSON.parse(result.stdout) : undefined; } catch { data = undefined; }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', data };
}

let mcpUrl = '';
try {
  const deadline = Date.now() + 25000;
  let ready;
  while (Date.now() < deadline) {
    try {
      const text = fs.readFileSync(path.join(state, 'daemon.out.log'), 'utf8');
      const line = text.split('\n').find((entry) => entry.includes('daemon.ready'));
      if (line) { ready = JSON.parse(line); break; }
    } catch { /* not yet */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error('daemon did not become ready; see ' + path.relative(root, path.join(state, 'daemon.err.log')));
  const admin = ready.urls.admin;
  const port = new URL(ready.urls.mcp).port;
  mcpUrl = `http://[${address}]:${port}`;
  check('bridge is bound for remote ingress', ready.urls.mcp.includes('::') || ready.urls.mcp.includes(address), ready.urls.mcp);

  // Step 1: the agent fetches the client over the network, exactly as the prompt says.
  // Python rather than curl: a sandbox http_proxy breaks curl against a raw IPv6 literal.
  const fetchScript = `
import urllib.request, os, sys
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
data = opener.open(sys.argv[1], timeout=30).read()
open(sys.argv[2], 'wb').write(data)
print(len(data))
`;
  const fetched = spawnSync('python', ['-c', fetchScript, `${mcpUrl}/client.py`, downloaded], { encoding: 'utf8', timeout: 40000 });
  const size = fs.existsSync(downloaded) ? fs.statSync(downloaded).size : 0;
  check('agent can fetch the client script over the global address', fetched.status === 0 && size > 5000, { status: fetched.status, bytes: size, stderr: (fetched.stderr ?? '').slice(0, 200) });
  check('fetched script is the real client', fs.existsSync(downloaded) && fs.readFileSync(downloaded, 'utf8').includes('arena_sandbox_client'), size);

  const status = await (await fetch(`${admin}/admin/v1/status`, { headers: auth(credentials.admin_token) })).json();

  // Step 3: pair-request
  const pairing = await (await fetch(`${admin}/admin/v1/pairings`, {
    method: 'POST', headers: auth(credentials.admin_token),
    body: JSON.stringify({ workspace_id: status.workspaces[0].id, recipient: 'Arena flow rehearsal', max_access: 'ask', ttl_ms: 300000 }),
  })).json();
  const requested = runClient(['pair-request', `--code=${pairing.code}`, '--label=arena-agent', '--access-mode=ask']);
  check('pair-request succeeds over the global address', requested.status === 0 && requested.data?.ok === true, requested.data ?? requested.stderr.slice(0, 300));

  // Step 4: local operator approves, then claim
  const decision = await (await fetch(`${admin}/admin/v1/pairings/${encodeURIComponent(requested.data.pair_id)}/decision`, {
    method: 'POST', headers: auth(credentials.admin_token),
    body: JSON.stringify({ approve: true, access_mode: 'ask', data_egress_ack: true }),
  })).json();
  check('local operator approval is required and applied', decision.state === 'approved', decision.state);

  const claimed = runClient(['pair-claim']);
  check('pair-claim returns a scoped grant and a challenge', claimed.status === 0 && claimed.data?.ok === true && typeof claimed.data.challenge === 'string', { grant: claimed.data?.grant_id, owner: claimed.data?.execution_owner, mode: claimed.data?.access_mode });

  // Step 5: challenge
  const verified = runClient([`--challenge=${claimed.data.challenge}`.startsWith('--') ? 'verify' : 'verify', `--challenge=${claimed.data.challenge}`]);
  check('challenge verification succeeds', verified.status === 0 && verified.data?.data?.protocol_ready === true, verified.data?.data ?? verified.stderr.slice(0, 300));

  // Step 6: tools
  const tools = runClient(['tools']);
  const names = (tools.data?.tools ?? []).map((tool) => tool.name);
  check('tool catalog is returned', tools.status === 0 && names.includes('read_files'), names);

  // Step 7: real read
  const read = runClient(['call', 'read_files', JSON.stringify({ files: [{ path: 'sum.mjs' }] })]);
  const text = callData(read)?.files?.[0]?.text ?? '';
  check('agent reads a real workspace file over the global address', read.status === 0 && text.includes('export const sum'), { bytes: text.length, owner: read.data?.execution_owner });

  // Guard rails the agent must not be able to bypass
  const write = runClient(['call', 'apply_patch', JSON.stringify({ action: 'preview', changes: [{ path: 'sum.mjs', expected_hash: null, patch: '--- a/sum.mjs\n+++ b/sum.mjs\n@@ -1 +1 @@\n-a\n+b\n' }] })]);
  check('read-only grant cannot preview a write', write.status !== 0 || write.data?.ok === false, { status: write.status, stderr: write.stderr.trim().slice(0, 160) });

  const secrets = runClient(['call', 'read_files', JSON.stringify({ files: [{ path: '.env' }] })]);
  check('sensitive paths are refused', secrets.status !== 0 || secrets.data?.ok === false, { status: secrets.status, stderr: secrets.stderr.trim().slice(0, 160) });
} catch (error) {
  check('arena flow rehearsal completed without throwing', false, String(error));
} finally {
  daemon.kill('SIGTERM');
  await new Promise((resolve) => { const timer = setTimeout(resolve, 6000); daemon.once('exit', () => { clearTimeout(timer); resolve(); }); });
  if (daemon.exitCode === null) daemon.kill('SIGKILL');
}

const passed = results.filter((entry) => entry.passed).length;
const report = {
  created_at: new Date().toISOString(), address, endpoint: mcpUrl,
  scope: 'Rehearsal of the exact remote-agent steps over the real global IPv6. The caller is this machine, so it does NOT prove an external sandbox can reach the address.',
  total: results.length, passed, failed: results.length - passed, results,
};
fs.writeFileSync(path.join(root, 'outputs', 'arena-flow-rehearsal.json'), JSON.stringify(report, null, 2) + '\n');
for (const entry of results) console.log(`${entry.passed ? 'PASS' : 'FAIL'}  ${entry.name}`);
console.log(`\n${passed}/${results.length} passed -> outputs/arena-flow-rehearsal.json`);
process.exitCode = passed === results.length ? 0 : 1;
