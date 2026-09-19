#!/usr/bin/env node
/**
 * End-to-end smoke test against a real daemon process on loopback.
 * Starts the daemon, exercises every public surface, then stops it.
 * It never contacts Arena/LMArena and never enables a real model backend.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureLocalConfig } from './ensure-local-config.mjs';
import { ensureLocalCredentials } from './gen-credentials.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Both local-state files are generated on demand: they record absolute paths or secrets, so
// neither can be committed, and reading them directly failed on a fresh clone with an ENOENT for
// a file the reader had no way to produce.
ensureLocalConfig(root);
const baseConfig = JSON.parse(fs.readFileSync(path.join(root, 'outputs', 'run-local.config.json'), 'utf8'));
// A private state directory, so a smoke run never fights over the lock held by a
// session the user already has open.
const config = { ...baseConfig, state_directory: path.join(root, 'outputs', 'smoke-state', `s-${Date.now()}`), ports: { api: 0, mcp: 0, admin: 0 } };
fs.mkdirSync(config.state_directory, { recursive: true });
const configPath = path.join(config.state_directory, 'config.json');
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
const { credentials } = ensureLocalCredentials(root);
const cli = path.join(root, 'dist', 'apps', 'daemon', 'src', 'cli.js');
const logs = path.join(root, 'outputs', 'local-run');
fs.mkdirSync(logs, { recursive: true });

const out = fs.openSync(path.join(logs, 'verify.out.log'), 'w');
const err = fs.openSync(path.join(logs, 'verify.err.log'), 'w');
const daemon = spawn(process.execPath, [cli, 'serve', '--config', configPath], {
  cwd: root,
  stdio: ['ignore', out, err],
  env: {
    ...process.env,
    ARENABRIDGE_ADMIN_TOKEN: credentials.admin_token,
    ARENABRIDGE_API_TOKEN: credentials.api_token,
    ARENABRIDGE_MCP_TOKEN: credentials.mcp_token,
  },
});

const api = () => live.api;
const admin = () => live.admin;
const mcp = () => live.mcp;
const live = { api: `http://127.0.0.1:${config.ports.api}`, admin: `http://127.0.0.1:${config.ports.admin}`, mcp: `http://127.0.0.1:${config.ports.mcp}` };
const results = [];
const check = (name, passed, detail) => { results.push({ name, passed: !!passed, detail }); };

async function waitForReady() {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const text = fs.readFileSync(path.join(logs, 'verify.out.log'), 'utf8');
      const line = text.split('\n').find((entry) => entry.includes('daemon.ready'));
      if (line) return JSON.parse(line);
    } catch { /* keep polling */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Daemon did not become ready within 25s; see outputs/local-run/verify.err.log');
}

const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
let status;
try {
  status = await waitForReady();
  live.api = status.urls.api; live.admin = status.urls.admin; live.mcp = status.urls.mcp;
  check('daemon reached ready state on loopback', true, { workspaces: status.workspaces.length, health: status.health, urls: status.urls });

  const health = await (await fetch(`${api()}/healthz`, { headers: auth(credentials.api_token) })).json();
  check('api port health responds with an authenticated payload', health.status === 'alive', health);

  const noAuth = await fetch(`${api()}/v1/models`);
  await noAuth.text();
  check('missing credential is rejected with 401', noAuth.status === 401, noAuth.status);

  const crossRole = await fetch(`${api()}/v1/models`, { headers: auth(credentials.admin_token) });
  await crossRole.text();
  check('admin credential cannot call the model port', crossRole.status === 401, crossRole.status);

  const mcpWithApiKey = await fetch(`${mcp()}/mcp`, { method: 'POST', headers: auth(credentials.api_token), body: '{}' });
  await mcpWithApiKey.text();
  check('model API key cannot call the workspace MCP port', mcpWithApiKey.status === 401, mcpWithApiKey.status);

  const models = await (await fetch(`${api()}/v1/models`, { headers: auth(credentials.api_token) })).json();
  check('configured alias is listed', models.data?.[0]?.id === config.gateway.alias, models);

  const completionResponse = await fetch(`${api()}/v1/chat/completions`, { method: 'POST', headers: auth(credentials.api_token), body: JSON.stringify({ model: config.gateway.alias, messages: [{ role: 'user', content: '你好，接入测试' }] }) });
  const completion = await completionResponse.json();
  check('non-streaming completion returns client-owned assistant text', completionResponse.status === 200 && completionResponse.headers.get('x-arenabridge-execution-owner') === 'client' && typeof completion.choices?.[0]?.message?.content === 'string', { status: completionResponse.status, owner: completionResponse.headers.get('x-arenabridge-execution-owner'), content: completion.choices?.[0]?.message?.content, usage: completion.usage ?? 'omitted (not zero-filled)' });

  const streamResponse = await fetch(`${api()}/v1/chat/completions`, { method: 'POST', headers: auth(credentials.api_token), body: JSON.stringify({ model: config.gateway.alias, messages: [{ role: 'user', content: '流式测试' }], stream: true }) });
  const streamText = await streamResponse.text();
  check('streaming completion ends with [DONE] and declares its streaming mode', streamText.trimEnd().endsWith('data: [DONE]') && !!streamResponse.headers.get('x-arenabridge-streaming'), { status: streamResponse.status, streaming: streamResponse.headers.get('x-arenabridge-streaming'), bytes: streamText.length });

  const unsupported = await fetch(`${api()}/v1/chat/completions`, { method: 'POST', headers: auth(credentials.api_token), body: JSON.stringify({ model: config.gateway.alias, messages: [{ role: 'user', content: 'x' }], n: 2 }) });
  const unsupportedBody = await unsupported.json();
  check('unsupported parameter is rejected, not silently dropped', unsupported.status === 422 && unsupportedBody.error?.code === 'UNSUPPORTED_PARAMETER', { status: unsupported.status, code: unsupportedBody.error?.code, param: unsupportedBody.error?.param });

  const responsesApi = await fetch(`${api()}/v1/responses`, { method: 'POST', headers: auth(credentials.api_token), body: '{}' });
  await responsesApi.text();
  check('Responses API is explicitly unsupported', responsesApi.status === 422, responsesApi.status);

  const capabilities = await (await fetch(`${admin()}/bridge/v1/capabilities`, { headers: auth(credentials.admin_token) })).json();
  check('capability page reports client ownership and blocked Arena', capabilities.model_api?.gateway?.execution_owner === 'client' && capabilities.model_api?.gateway?.tools_executed_by_gateway === false && capabilities.arena?.status === 'blocked', { owner: capabilities.model_api?.gateway?.execution_owner, tools_executed: capabilities.model_api?.gateway?.tools_executed_by_gateway, arena: capabilities.arena?.status });

  const schemas = await (await fetch(`${admin()}/admin/v1/tool-schemas`, { headers: auth(credentials.admin_token) })).json();
  check('workspace tool schemas are exposed for review', Array.isArray(schemas) && schemas.some((tool) => tool.name === 'read_files'), schemas.map((tool) => tool.name));

  const events = await (await fetch(`${admin()}/admin/v1/events`, { headers: auth(credentials.admin_token) })).json();
  const leaked = JSON.stringify(events).includes(credentials.api_token) || JSON.stringify(events).includes(credentials.admin_token);
  check('audit events contain no credentials', !leaked, { event_count: events.events?.length });

  const pairing = await (await fetch(`${admin()}/admin/v1/pairings`, { method: 'POST', headers: auth(credentials.admin_token), body: JSON.stringify({ workspace_id: status.workspaces[0].id, recipient: 'Local manual test operator', max_access: 'ask', ttl_ms: 120000 }) })).json();
  check('a short-lived single-use pairing invitation can be created', typeof pairing.code === 'string' && pairing.code.length >= 32, { pair_id: pairing.pair_id, expires_at: pairing.expires_at, warning: pairing.warning });

  const consoleResponse = await fetch(`${admin()}/console`);
  const consoleHtml = await consoleResponse.text();
  check('admin console shell is served and embeds no credential', consoleResponse.status === 200 && consoleHtml.includes('ArenaBridge 本地控制台') && !consoleHtml.includes(credentials.admin_token) && !consoleHtml.includes(credentials.api_token) && (consoleResponse.headers.get('content-security-policy') ?? '').includes("default-src 'none'"), { status: consoleResponse.status, bytes: consoleHtml.length, csp: consoleResponse.headers.get('content-security-policy') });

  const sameOrigin = await fetch(`${admin()}/admin/v1/status`, { headers: { ...auth(credentials.admin_token), Origin: new URL(admin()).origin } });
  await sameOrigin.text();
  check('same-origin console calls are allowed', sameOrigin.status === 200, sameOrigin.status);

  const crossOrigin = await fetch(`${admin()}/admin/v1/status`, { headers: { ...auth(credentials.admin_token), Origin: 'https://attacker.example' } });
  await crossOrigin.text();
  check('cross-origin calls are still rejected', crossOrigin.status === 403, crossOrigin.status);

  const ingressOff = await (await fetch(`${admin()}/bridge/v1/capabilities`, { headers: auth(credentials.admin_token) })).json();
  const mcpCall = await fetch(`${mcp()}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credentials.mcp_token}`, 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }) });
  const mcpBody = await mcpCall.json().catch(() => ({}));
  check('local MCP host can list tools with mcp_token', mcpCall.status === 200 && (mcpBody?.result?.tools?.length ?? 0) > 0, { status: mcpCall.status, tools: mcpBody?.result?.tools?.length });

  const adminOnMcp = await fetch(`${mcp()}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credentials.admin_token}`, 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  await adminOnMcp.text();
  check('admin token is refused on the MCP port', adminOnMcp.status === 401, adminOnMcp.status);

  check('remote ingress is off and admin/api stay loopback', config.remote_ingress?.enabled === false && /^http:\/\/127\.0\.0\.1:/.test(status.urls.admin) && /^http:\/\/127\.0\.0\.1:/.test(status.urls.api), { ingress: config.remote_ingress, admin: status.urls.admin, api: status.urls.api, mcp: status.urls.mcp, arena: ingressOff.arena?.status });
} catch (error) {
  check('smoke run completed without throwing', false, String(error));
} finally {
  daemon.kill('SIGTERM');
  await new Promise((resolve) => { const timer = setTimeout(resolve, 8000); daemon.once('exit', () => { clearTimeout(timer); resolve(); }); });
  if (daemon.exitCode === null) daemon.kill('SIGKILL');
}

const passed = results.filter((entry) => entry.passed).length;
const report = { created_at: new Date().toISOString(), environment: { node: process.version, platform: process.platform }, scope: 'Real loopback daemon smoke test with the Mock backend. No model inference, no Arena/LMArena contact.', total: results.length, passed, failed: results.length - passed, results };
fs.writeFileSync(path.join(root, 'outputs', 'local-run-smoke.json'), JSON.stringify(report, null, 2) + '\n');
for (const entry of results) console.log(`${entry.passed ? 'PASS' : 'FAIL'}  ${entry.name}`);
console.log(`\n${passed}/${results.length} checks passed -> outputs/local-run-smoke.json`);
process.exitCode = passed === results.length ? 0 : 1;
