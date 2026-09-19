import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createDaemon } from '../apps/daemon/src/server.js';
import { newSecret } from '../packages/contracts/src/index.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workspaceRoot = path.join(project, 'outputs', 'synthetic-workspace');
const stamp = Date.now();

const tokens = (): { adminToken: string; clientToken: string; mcpToken: string } => ({ adminToken: newSecret(), clientToken: newSecret(), mcpToken: newSecret() });
const baseConfig = (state: string, ingress = false) => ({
  schema_version: 1, state_directory: state,
  ports: { api: 0, mcp: 0, mcp_remote: 0, admin: 0 },
  workspaces: [{ root: workspaceRoot, display_name: 'Local MCP test workspace' }],
  response_mode: 'json', security_profile: 'local_trusted_development', arena_enabled: false,
  ...(ingress ? { remote_ingress: { enabled: true, acknowledge_exposure: true, bind_address: '127.0.0.1', allow_cidrs: [], allowed_hosts: ['tunnel.example'], require_grant: true } } : {}),
});

const call = async (url: string, token: string) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      // The modern era requires the method to be declared in a header as well.
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'tools/list',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, code: body?.error?.code, message: body?.error?.message, tools: body?.result?.tools?.length };
};

test('L01 a local MCP host works without pairing, but only on the local listener', async t => {
  const state = path.join(project, 'outputs', 'console-test', `state-${stamp}-l01`);
  const credentials = tokens();
  const daemon = await createDaemon(baseConfig(state, true), credentials);
  const local = `${daemon.urls.mcp}/mcp`;
  const remote = `${daemon.urls.mcp_remote}/mcp`;
  try {
    assert.match(daemon.urls.mcp_remote, /^http:\/\/127\.0\.0\.1:/, 'the remote listener stays on loopback behind the tunnel');

    // The local listener accepts the dedicated local credential, with no pairing at all.
    const localResult = await call(local, credentials.mcpToken!);
    assert.equal(localResult.status, 200, JSON.stringify(localResult));
    assert.ok(localResult.tools > 0, 'tools must be listed');

    // The listener a tunnel forwards to must refuse that same credential.
    const remoteResult = await call(remote, credentials.mcpToken!);
    assert.equal(remoteResult.status, 401, JSON.stringify(remoteResult));
    assert.equal(remoteResult.code, 'AUTH_REQUIRED');
    assert.match(remoteResult.message, /pairing code|invalid|Unknown workspace credential|bearer/i, remoteResult.message);

    // Nor may the console or model-gateway credentials open the local MCP port.
    const crossCredentials: [string, string][] = [['admin', credentials.adminToken], ['api', credentials.clientToken]];
    for (const [label, token] of crossCredentials) {
      const result = await call(local, token);
      assert.equal(result.status, 401, `${label} must not authenticate to the MCP port`);
      assert.match(result.message, /mcp_token|admin token|API client token/i, `${label}: ${result.message}`);
    }
    // And a local credential must not open the console or the gateway either.
    const adminWithMcp = await fetch(`${daemon.urls.admin}/admin/v1/status`, { headers: { Authorization: `Bearer ${credentials.mcpToken!}` } });
    await adminWithMcp.text();
    assert.equal(adminWithMcp.status, 401);

    // The client script is still reachable on both listeners; it holds no secret.
    for (const url of [local, remote]) {
      const script = await fetch(url.replace('/mcp', '/client.py'));
      const text = await script.text();
      assert.equal(script.status, 200);
      assert.ok(text.includes('arena_sandbox_client'));
      assert.equal(text.includes(credentials.mcpToken), false);
    }
  } finally { await daemon.close(); }
});

test('L02 credentials must all be independent secrets', async t => {
  const state = path.join(project, 'outputs', 'console-test', `state-${stamp}-l02`);
  const shared = newSecret();
  await assert.rejects(
    createDaemon(baseConfig(state), { adminToken: shared, clientToken: shared, mcpToken: newSecret() }),
    { code: 'INVALID_CONFIG' },
  );
  await assert.rejects(
    createDaemon(baseConfig(state), { adminToken: newSecret(), clientToken: newSecret(), mcpToken: newSecret() === undefined ? '' : 'short' }),
    { code: 'INVALID_CONFIG' },
  );
});

test('L03 without remote ingress there is no remote listener at all', async t => {
  const state = path.join(project, 'outputs', 'console-test', `state-${stamp}-l03`);
  const credentials = tokens();
  const daemon = await createDaemon(baseConfig(state, false), credentials);
  try {
    assert.equal(daemon.urls.mcp_remote, '', 'no remote listener is created when ingress is off');
    const localResult = await call(`${daemon.urls.mcp}/mcp`, credentials.mcpToken!);
    assert.equal(localResult.status, 200, JSON.stringify(localResult));
  } finally { await daemon.close(); }
});
