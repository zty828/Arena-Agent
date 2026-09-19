#!/usr/bin/env node
/**
 * Reports what the model gateway currently serves, and states plainly which
 * integration path each client setting belongs to.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const credentials = JSON.parse(fs.readFileSync(path.join(root, '.arena-bridge', 'local-credentials.json'), 'utf8'));
const base = JSON.parse(fs.readFileSync(path.join(root, 'outputs', 'run-local.config.json'), 'utf8'));
const state = path.join(root, 'outputs', 'gateway-report', `s-${Date.now()}`);
fs.mkdirSync(state, { recursive: true });
const config = { ...base, state_directory: state, ports: { api: 0, mcp: 0, admin: 0 } };
const configPath = path.join(state, 'config.json');
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

const daemon = spawn(process.execPath, [path.join(root, 'dist', 'apps', 'daemon', 'src', 'cli.js'), 'serve', '--config', configPath], {
  cwd: root,
  stdio: ['ignore', fs.openSync(path.join(state, 'out.log'), 'w'), fs.openSync(path.join(state, 'err.log'), 'w')],
  env: {
    ...process.env,
    ARENABRIDGE_ADMIN_TOKEN: credentials.admin_token,
    ARENABRIDGE_API_TOKEN: credentials.api_token,
    ARENABRIDGE_MCP_TOKEN: credentials.mcp_token ?? credentials.api_token,
  },
});

const report = { gateway_config: config.gateway };
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

  const auth = { Authorization: `Bearer ${credentials.api_token}`, 'Content-Type': 'application/json' };
  const models = await fetch(`${ready.urls.api}/v1/models`, { headers: auth });
  report.models_status = models.status;
  report.models = await models.json();

  const completion = await fetch(`${ready.urls.api}/v1/chat/completions`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ model: config.gateway.alias, messages: [{ role: 'user', content: 'hi' }] }),
  });
  report.completion_status = completion.status;
  const completionBody = await completion.json();
  report.completion_owner = completionBody?.choices?.[0]?.message?.content ?? completionBody?.error?.code;

  // The MCP side is a different surface entirely; report what it exposes.
  const capabilities = await fetch(`${ready.urls.admin}/bridge/v1/capabilities`, { headers: { Authorization: `Bearer ${credentials.admin_token}` } });
  const caps = await capabilities.json();
  report.mcp_surface = { transport: caps.mcp.transport, versions: caps.mcp.versions, tools: caps.tools };
  report.model_api_surface = caps.model_api;
} catch (error) {
  report.error = error.message;
} finally {
  daemon.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 3000));
  if (daemon.exitCode === null) daemon.kill('SIGKILL');
}

fs.writeFileSync(path.join(root, 'outputs', 'gateway-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
