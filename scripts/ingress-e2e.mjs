#!/usr/bin/env node
/**
 * Proves the remote-ingress path works end to end on a non-loopback address,
 * using the same sandbox client a remote agent would run.
 *
 * It binds ONLY the MCP port to the given address, keeps admin/api on loopback,
 * and tears everything down afterwards. Nothing is left listening.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const credentials = JSON.parse(fs.readFileSync(path.join(root, '.arena-bridge', 'local-credentials.json'), 'utf8'));
const clientScript = path.join(root, 'client', 'arena_sandbox_client.py');

function pickBindAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list ?? []) {
      const value = entry.address.split('%')[0];
      if (entry.family === 'IPv4' && !entry.internal) return value;
    }
  }
  return null;
}
const bindAddress = process.argv[2] ?? pickBindAddress();
if (!bindAddress) { console.error('No non-loopback address found; pass one explicitly.'); process.exit(1); }

const stamp = Date.now();
const state = path.join(root, 'outputs', 'ingress-test', `state-${stamp}`);
fs.mkdirSync(state, { recursive: true });
const base = JSON.parse(fs.readFileSync(path.join(root, 'outputs', 'run-local.config.json'), 'utf8'));
const config = {
  ...base,
  state_directory: state,
  ports: { api: 0, mcp: 0, mcp_remote: 0, admin: 0 },
  remote_ingress: { enabled: true, acknowledge_exposure: true, bind_address: bindAddress, allow_cidrs: [], require_grant: true },
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

function client(args, url, statePath) {
  const result = spawnSync('python', [clientScript, ...args], {
    cwd: root, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, ARENABRIDGE_URL: url, ARENABRIDGE_STATE: statePath, ARENABRIDGE_TIMEOUT: '30' },
  });
  let data; try { data = result.stdout ? JSON.parse(result.stdout) : undefined; } catch { data = undefined; }
  return { status: result.status, stderr: result.stderr ?? '', data };
}

try {
  // Ports are ephemeral (0), so the real values come from the daemon's own ready event.
  const outLog = path.join(state, 'daemon.out.log');
  const deadline = Date.now() + 25000;
  let ready;
  while (Date.now() < deadline) {
    try {
      const text = fs.readFileSync(outLog, 'utf8');
      const line = text.split('\n').find((entry) => entry.includes('"event":"daemon.ready"'));
      if (line) { ready = JSON.parse(line); break; }
    } catch { /* not written yet */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error('daemon did not report ready; see ' + path.relative(root, path.join(state, 'daemon.err.log')));

  const adminUrl = ready.urls.admin, apiUrl = ready.urls.api;
  const statusResponse = await fetch(`${adminUrl}/admin/v1/status`, { headers: auth(credentials.admin_token) });
  const status = await statusResponse.json();
  check('daemon reported ready with a split bind layout', statusResponse.status === 200, { mcp: ready.urls.mcp, admin: adminUrl, api: apiUrl });

  const remoteMcp = ready.urls.mcp;
  check('only the MCP port moved off loopback', remoteMcp.includes(bindAddress) && adminUrl.includes('127.0.0.1') && apiUrl.includes('127.0.0.1'),
    { mcp: remoteMcp, admin: adminUrl, api: apiUrl });

  const probe = await fetch(remoteMcp + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) });
  await probe.text();
  check('non-loopback MCP port answers and demands a grant', probe.status === 401, probe.status);

  const pairing = await (await fetch(`${adminUrl}/admin/v1/pairings`, {
    method: 'POST', headers: auth(credentials.admin_token),
    body: JSON.stringify({ workspace_id: status.workspaces[0].id, recipient: `Ingress test via ${bindAddress}`, max_access: 'ask', ttl_ms: 180000 }),
  })).json();
  const clientState = path.join(state, 'client-state.json');

  const requested = client(['pair-request', '--code=' + pairing.code, '--label', 'ingress-probe'], remoteMcp, clientState);
  check('pairing request travels over the non-loopback address', requested.status === 0 && requested.data?.ok === true, requested.data ?? requested.stderr.slice(0, 300));

  await fetch(`${adminUrl}/admin/v1/pairings/${encodeURIComponent(requested.data.pair_id)}/decision`, {
    method: 'POST', headers: auth(credentials.admin_token),
    body: JSON.stringify({ approve: true, access_mode: 'ask', data_egress_ack: true }),
  });

  const claimed = client(['pair-claim'], remoteMcp, clientState);
  check('grant claimed over the non-loopback address', claimed.status === 0 && claimed.data?.ok === true, { grant_id: claimed.data?.grant_id, owner: claimed.data?.execution_owner });

  const discovered = client(['discover'], remoteMcp, clientState);
  check('discovery works over the non-loopback address', discovered.status === 0 && discovered.data?.protocol_versions?.includes('2026-07-28'), discovered.data?.protocol_versions);

  client(['verify', '--challenge=' + claimed.data.challenge], remoteMcp, clientState);
  const tools = client(['tools'], remoteMcp, clientState);
  check('tool catalog retrieved over the non-loopback address', tools.status === 0 && (tools.data?.count ?? 0) > 0, tools.data?.count);

  const read = client(['call', 'read_files', JSON.stringify({ files: [{ path: 'sum.mjs' }] })], remoteMcp, clientState);
  check('real workspace read over the non-loopback address', read.status === 0 && (callData(read)?.files?.[0]?.text ?? '').includes('export const sum'), { owner: read.data?.execution_owner });

  const unauth = await fetch(remoteMcp + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), signal: AbortSignal.timeout(5000) });
  await unauth.text();
  check('an unauthenticated remote caller gets nothing', unauth.status === 401, unauth.status);
} catch (error) {
  check('ingress E2E completed without throwing', false, String(error));
} finally {
  daemon.kill('SIGTERM');
  await new Promise((resolve) => { const timer = setTimeout(resolve, 8000); daemon.once('exit', () => { clearTimeout(timer); resolve(); }); });
  if (daemon.exitCode === null) daemon.kill('SIGKILL');
}

const passed = results.filter((entry) => entry.passed).length;
const report = {
  created_at: new Date().toISOString(),
  bind_address: bindAddress,
  scope: 'Real daemon with the MCP port bound off loopback, driven by the sandbox client. Proves the ingress path; it does NOT prove the internet can reach this address, and it does not authorize any platform.',
  total: results.length, passed, failed: results.length - passed, results,
};
fs.writeFileSync(path.join(root, 'outputs', 'ingress-e2e.json'), JSON.stringify(report, null, 2) + '\n');
for (const entry of results) console.log(`${entry.passed ? 'PASS' : 'FAIL'}  ${entry.name}`);
console.log(`\n${passed}/${results.length} checks passed on ${bindAddress} -> outputs/ingress-e2e.json`);
process.exitCode = passed === results.length ? 0 : 1;
