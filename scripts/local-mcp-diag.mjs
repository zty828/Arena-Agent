import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const credentials = JSON.parse(fs.readFileSync(path.join(root, '.arena-bridge', 'local-credentials.json'), 'utf8'));
const state = path.join(root, 'outputs', 'local-mcp-diag', `s-${Date.now()}`);
fs.mkdirSync(state, { recursive: true });
const config = {
  schema_version: 1, state_directory: state,
  ports: { api: 0, mcp: 0, mcp_remote: 0, admin: 0 },
  workspaces: [{ root: path.join(root, 'outputs', 'synthetic-workspace'), display_name: 'diag' }],
  response_mode: 'json', security_profile: 'local_trusted_development', arena_enabled: false,
  remote_ingress: { enabled: true, acknowledge_exposure: true, bind_address: '127.0.0.1', allow_cidrs: [], allowed_hosts: ['tunnel.example'], require_grant: true },
};
const configPath = path.join(state, 'config.json');
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
const daemon = spawn(process.execPath, [path.join(root, 'dist', 'apps', 'daemon', 'src', 'cli.js'), 'serve', '--config', configPath], {
  cwd: root, stdio: ['ignore', fs.openSync(path.join(state, 'out.log'), 'w'), fs.openSync(path.join(state, 'err.log'), 'w')],
  env: { ...process.env, ARENABRIDGE_ADMIN_TOKEN: credentials.admin_token, ARENABRIDGE_API_TOKEN: credentials.api_token, ARENABRIDGE_MCP_TOKEN: credentials.mcp_token, ARENABRIDGE_DEBUG_AUTH: '1' },
});

const deadline = Date.now() + 25000;
let ready;
while (Date.now() < deadline) {
  try {
    const line = fs.readFileSync(path.join(state, 'out.log'), 'utf8').split('\n').find((entry) => entry.includes('daemon.ready'));
    if (line) { ready = JSON.parse(line); break; }
  } catch { /* not yet */ }
  await new Promise((resolve) => setTimeout(resolve, 300));
}
if (!ready) { console.log('not ready'); console.log(fs.readFileSync(path.join(state, 'err.log'), 'utf8').slice(-600)); daemon.kill(); process.exit(1); }
console.log('urls:', JSON.stringify(ready.urls));

const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } });
for (const [label, url, token] of [
  ['local + mcp_token', `${ready.urls.mcp}/mcp`, credentials.mcp_token],
  ['local + admin_token', `${ready.urls.mcp}/mcp`, credentials.admin_token],
  ['local + api_token', `${ready.urls.mcp}/mcp`, credentials.api_token],
  ['remote + mcp_token', `${ready.urls.mcp_remote}/mcp`, credentials.mcp_token],
]) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list' }, body });
  const text = await response.text();
  console.log(`${label}: ${response.status} ${text.slice(0, 220)}`);
}
daemon.kill('SIGTERM');
await new Promise((resolve) => setTimeout(resolve, 3000));
if (daemon.exitCode === null) daemon.kill('SIGKILL');
