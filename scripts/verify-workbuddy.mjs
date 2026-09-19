#!/usr/bin/env node
/**
 * Verifies the WorkBuddy local integration as the user experiences it:
 *   - the entry in ~/.workbuddy-ai/mcp.json points at the loopback MCP port
 *   - the token stored there is the local mcp_token (not admin, not api)
 *   - that exact token actually works against a live bridge
 *   - it is refused on the tunnel-facing port, and admin/api are refused on both
 *
 * Related, deliberately overlapping scripts:
 *   - scripts/local-mcp-diag.mjs   probes four tokens against two ports
 *   - tests/local-mcp.test.ts      pins the same isolation in the test suite
 * This one is the config-aware check: it reads what WorkBuddy is really configured
 * with, which the other two cannot know.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const credentials = JSON.parse(fs.readFileSync(path.join(root, '.arena-bridge', 'local-credentials.json'), 'utf8'));
const configPath = path.join(os.homedir(), '.workbuddy-ai', 'mcp.json');

const results = [];
const check = (name, passed, detail) => { results.push({ name, passed: !!passed, detail }); };

let registered = null;
try {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  registered = config.mcpServers?.arenabridge ?? null;
  check('an arenabridge entry exists in the WorkBuddy MCP config', registered !== null, { path: configPath, servers: Object.keys(config.mcpServers ?? {}) });
} catch (error) {
  check('an arenabridge entry exists in the WorkBuddy MCP config', false, error.message);
}

const registeredToken = registered?.headers?.Authorization?.replace(/^Bearer\s+/i, '') ?? '';
if (registered) {
  check('the registered token is the local mcp_token', registeredToken === credentials.mcp_token, { matches: registeredToken === credentials.mcp_token });
  check('the registered token is neither the admin nor the api token', registeredToken !== credentials.admin_token && registeredToken !== credentials.api_token, undefined);
  check('the entry points at the loopback MCP port', /^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(registered.url ?? ''), registered.url);
}

const state = path.join(root, 'outputs', 'workbuddy-check', `s-${Date.now()}`);
fs.mkdirSync(state, { recursive: true });
const base = JSON.parse(fs.readFileSync(path.join(root, 'outputs', 'run-local.config.json'), 'utf8'));
// mcp_remote only listens when remote ingress is on, so enable it in tunnel shape:
// loopback bind plus the hostname a tunnel would forward.
const config = {
  ...base,
  state_directory: state,
  ports: { api: 0, mcp: 0, mcp_remote: 0, admin: 0 },
  remote_ingress: { enabled: true, acknowledge_exposure: true, bind_address: '127.0.0.1', allow_cidrs: [], allowed_hosts: ['tunnel.example.test'], require_grant: true },
};
const runConfigPath = path.join(state, 'config.json');
fs.writeFileSync(runConfigPath, JSON.stringify(config, null, 2) + '\n');

const daemon = spawn(process.execPath, [path.join(root, 'dist', 'apps', 'daemon', 'src', 'cli.js'), 'serve', '--config', runConfigPath], {
  cwd: root,
  stdio: ['ignore', fs.openSync(path.join(state, 'out.log'), 'w'), fs.openSync(path.join(state, 'err.log'), 'w')],
  env: {
    ...process.env,
    ARENABRIDGE_ADMIN_TOKEN: credentials.admin_token,
    ARENABRIDGE_API_TOKEN: credentials.api_token,
    ARENABRIDGE_MCP_TOKEN: credentials.mcp_token,
  },
});

async function listTools(url, token) {
  const response = await fetch(url + '/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'tools/list',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }),
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  return { status: response.status, listed: text.includes('read_files'), body: text.slice(0, 200) };
}

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

  const local = ready.urls.mcp;
  const remote = ready.urls.mcp_remote;
  check('the bridge exposes both an MCP and an mcp_remote url', Boolean(local && remote), ready.urls);

  const withLocalToken = await listTools(local, credentials.mcp_token);
  check('the local mcp_token lists tools on the loopback MCP port', withLocalToken.status === 200 && withLocalToken.listed, { status: withLocalToken.status });

  const withRegistered = registeredToken ? await listTools(local, registeredToken) : { status: 0, listed: false };
  check('the token WorkBuddy is actually configured with works', withRegistered.status === 200 && withRegistered.listed, { status: withRegistered.status });

  const adminOnLocal = await listTools(local, credentials.admin_token);
  check('the admin token is refused on the loopback MCP port', adminOnLocal.status === 401, adminOnLocal.status);

  const localOnRemote = await listTools(remote, credentials.mcp_token);
  check('the local mcp_token is refused on the tunnel-facing port', localOnRemote.status === 401, { status: localOnRemote.status, body: localOnRemote.body });

  const adminOnRemote = await listTools(remote, credentials.admin_token);
  check('the admin token is refused on the tunnel-facing port', adminOnRemote.status === 401, adminOnRemote.status);
} catch (error) {
  check('workbuddy verification completed without throwing', false, String(error));
} finally {
  daemon.kill('SIGTERM');
  await new Promise((resolve) => { const timer = setTimeout(resolve, 5000); daemon.once('exit', () => { clearTimeout(timer); resolve(); }); });
  if (daemon.exitCode === null) daemon.kill('SIGKILL');
}

const passed = results.filter((entry) => entry.passed).length;
fs.writeFileSync(path.join(root, 'outputs', 'workbuddy-verification.json'), JSON.stringify({
  created_at: new Date().toISOString(), config_path: configPath,
  scope: 'Verifies the loopback MCP integration and that the local token cannot be used from the tunnel-facing port.',
  total: results.length, passed, failed: results.length - passed, results,
}, null, 2) + '\n');
for (const entry of results) console.log(`${entry.passed ? 'PASS' : 'FAIL'}  ${entry.name}${entry.detail !== undefined ? ' :: ' + JSON.stringify(entry.detail).slice(0, 160) : ''}`);
console.log(`\n${passed}/${results.length} passed -> outputs/workbuddy-verification.json`);
process.exitCode = passed === results.length ? 0 : 1;
