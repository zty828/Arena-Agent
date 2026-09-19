#!/usr/bin/env node
/**
 * Boots a throwaway daemon, drives a remote client far enough to park a real
 * pending patch approval, then prints the console URL. Used to eyeball the
 * operator console against genuine state rather than a fixture.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const credentials = JSON.parse(fs.readFileSync(path.join(root, '.arena-bridge', 'local-credentials.json'), 'utf8'));
const stamp = Date.now();
const state = path.join(root, 'outputs', 'console-preview', `s-${stamp}`);
const workspace = path.join(root, 'outputs', 'console-preview', `ws-${stamp}`);
fs.mkdirSync(state, { recursive: true });
fs.mkdirSync(workspace, { recursive: true });
for (const name of fs.readdirSync(path.join(root, 'outputs', 'synthetic-workspace'))) {
  fs.copyFileSync(path.join(root, 'outputs', 'synthetic-workspace', name), path.join(workspace, name));
}

const config = {
  schema_version: 1, state_directory: state,
  ports: { api: 0, mcp: 0, mcp_remote: 0, admin: 0 },
  workspaces: [{ root: workspace, display_name: '控制台预览工作区' }],
  response_mode: 'json', security_profile: 'local_trusted_development',
  arena_enabled: false, gateway: { type: 'disabled' },
};
const configPath = path.join(state, 'config.json');
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

const daemon = spawn(process.execPath, [path.join(root, 'dist', 'apps', 'daemon', 'src', 'cli.js'), 'serve', '--config', configPath], {
  cwd: root, stdio: ['ignore', fs.openSync(path.join(state, 'out.log'), 'w'), fs.openSync(path.join(state, 'err.log'), 'w')],
  env: { ...process.env, ARENABRIDGE_ADMIN_TOKEN: credentials.admin_token, ARENABRIDGE_API_TOKEN: credentials.api_token, ARENABRIDGE_MCP_TOKEN: credentials.mcp_token },
});
const auth = { Authorization: `Bearer ${credentials.admin_token}`, 'Content-Type': 'application/json' };

const deadline = Date.now() + 25000;
let ready;
while (Date.now() < deadline) {
  try {
    const line = fs.readFileSync(path.join(state, 'out.log'), 'utf8').split('\n').find((e) => e.includes('daemon.ready'));
    if (line) { ready = JSON.parse(line); break; }
  } catch { /* not yet */ }
  await new Promise((r) => setTimeout(r, 300));
}
if (!ready) { console.error('not ready:', fs.readFileSync(path.join(state, 'err.log'), 'utf8').slice(-400)); process.exit(1); }

const admin = ready.urls.admin;
const clientState = path.join(state, 'client-state.json');
const client = (args) => spawnSync('python', [path.join(root, 'client', 'arena_sandbox_client.py'), ...args], {
  cwd: root, encoding: 'utf8', timeout: 90000,
  env: { ...process.env, ARENABRIDGE_URL: ready.urls.mcp, ARENABRIDGE_STATE: clientState, ARENABRIDGE_TIMEOUT: '30' },
});

const pairing = await (await fetch(`${admin}/admin/v1/pairings`, { method: 'POST', headers: auth,
  body: JSON.stringify({ workspace_id: ready.workspaces[0].id, recipient: '控制台预览', max_access: 'code', ttl_ms: 600000, grant_ttl_ms: 1800000 }) })).json();
const requested = client(['pair-request', `--code=${pairing.code}`, '--label=console-preview', '--access-mode=code']);
const pairId = JSON.parse(requested.stdout).pair_id;
await fetch(`${admin}/admin/v1/pairings/${encodeURIComponent(pairId)}/decision`, { method: 'POST', headers: auth,
  body: JSON.stringify({ approve: true, access_mode: 'code', data_egress_ack: true }) });
const claimed = JSON.parse(client(['pair-claim']).stdout);
client(['verify', `--challenge=${claimed.challenge}`]);
// Park a real approval so the "待办" tab has genuine content to render.
const target = path.join(workspace, 'sum.mjs');
const beforeHash = createHash('sha256').update(fs.readFileSync(target)).digest('hex');
const preview = client(['call', 'apply_patch', JSON.stringify({
  action: 'preview',
  changes: [{ path: 'sum.mjs', expected_hash: beforeHash, patch: '--- a/sum.mjs\n+++ b/sum.mjs\n@@ -1 +1 @@\n-export const sum = (a, b) => a - b;\n+export const sum = (a, b) => a + b;\n' }],
})]);

console.log('console-preview ready');
console.log('  state     :', state);
console.log('  console   :', admin + '/console#t=' + credentials.admin_token);
console.log('  admin token:', credentials.admin_token);
console.log('  workspace :', workspace);
console.log('  pid       :', daemon.pid);
console.log('');
console.log('  待办里已停着一张真实的写审批卡（5 分钟后过期）。');
console.log('  点「允许这次修改」会真的把 sum.mjs 从 a - b 改成 a + b。');
console.log('  按 Ctrl+C 结束这个预览（不会动你的正式环境）。');
fs.writeFileSync(path.join(root, 'outputs', 'console-preview', 'latest.json'), JSON.stringify({ state, admin, workspace, pid: daemon.pid, token: credentials.admin_token }, null, 2) + '\n');
// Keep running so the page can be inspected.
daemon.once('exit', (code) => console.log('daemon exited', code));
