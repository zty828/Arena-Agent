import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createDaemon, ConfigSchema } from '../apps/daemon/src/server.js';
import { newSecret } from '../packages/contracts/src/index.js';

// fetch() silently drops the Host header, so rebinding must be tested over raw HTTP.
function rawStatus(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers }, (response) => { response.resume(); resolve(response.statusCode ?? 0); });
    request.on('error', reject);
    request.end();
  });
}

// Creates a fresh state directory; deliberately does not recursively delete anything.
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workspaceRoot = path.join(project, 'outputs', 'synthetic-workspace');
const stamp = Date.now();
const baseConfig = (state: string) => ({
  schema_version: 1, state_directory: state, ports: { api: 0, mcp: 0, admin: 0 },
  workspaces: [{ root: workspaceRoot, display_name: 'Console test workspace' }],
  response_mode: 'json', security_profile: 'local_trusted_development', arena_enabled: false,
});

test('C01 admin console shell loads unauthenticated but exposes no data', async t => {
  const state = path.join(project, 'outputs', 'console-test', `state-${stamp}-c01`);
  const adminToken = newSecret(), clientToken = newSecret();
  const daemon = await createDaemon(baseConfig(state), { adminToken, clientToken });
  try {
    // Every obvious entry URL must land on the console, so a bare host:port works.
    for (const entry of ['/', '/console', '/console/', '/index.html']) {
      const page = await fetch(daemon.urls.admin + entry);
      const html = await page.text();
      assert.equal(page.status, 200, `entry ${entry} should serve the console`);
      assert.match(page.headers.get('content-type') ?? '', /text\/html/, `entry ${entry} content type`);
      assert.match(html, /ArenaBridge 本地控制台/, `entry ${entry} body`);
    }
    const page = await fetch(daemon.urls.admin + '/console');
    const html = await page.text();
    const csp = page.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    // The shell must not embed any credential or workspace path.
    assert.equal(html.includes(adminToken), false);
    assert.equal(html.includes(clientToken), false);
    assert.equal(html.includes(workspaceRoot), false);
    // Data endpoints still require the token.
    const status = await fetch(daemon.urls.admin + '/admin/v1/status');
    await status.text();
    assert.equal(status.status, 401);
    const authed = await fetch(daemon.urls.admin + '/admin/v1/status', { headers: { Authorization: `Bearer ${adminToken}` } });
    const statusBody = await authed.json() as any;
    assert.equal(authed.status, 200);
    assert.equal(statusBody.workspaces.length, 1);
    // The console is admin-port only.
    const elsewhere = await fetch(daemon.urls.api + '/console');
    await elsewhere.text();
    assert.equal(elsewhere.status, 401);
    const mcpConsole = await fetch(daemon.urls.mcp + '/console');
    await mcpConsole.text();
    assert.equal(mcpConsole.status, 401);
  } finally { await daemon.close(); }
});

test('C02 same-origin console requests are allowed while cross-origin and rebinding stay blocked', async t => {
  const state = path.join(project, 'outputs', 'console-test', `state-${stamp}-c02`);
  const adminToken = newSecret(), clientToken = newSecret();
  const daemon = await createDaemon(baseConfig(state), { adminToken, clientToken });
  const origin = new URL(daemon.urls.admin).origin;
  try {
    const sameOrigin = await fetch(daemon.urls.admin + '/admin/v1/status', { headers: { Authorization: `Bearer ${adminToken}`, Origin: origin } });
    await sameOrigin.text();
    assert.equal(sameOrigin.status, 200);

    for (const bad of ['https://attacker.example', 'http://localhost:9999', 'null']) {
      const response = await fetch(daemon.urls.admin + '/admin/v1/status', { headers: { Authorization: `Bearer ${adminToken}`, Origin: bad } });
      await response.text();
      assert.equal(response.status, 403, `Origin ${bad} must be rejected`);
    }
    // A rebinding attempt presents an attacker Host header.
    assert.equal(await rawStatus(daemon.urls.admin + '/admin/v1/status', { Authorization: `Bearer ${adminToken}`, Host: 'attacker.example' }), 403);
    // The loopback console keeps the strict host allowlist, so a wildcard name is refused.
    assert.equal(await rawStatus(daemon.urls.admin + '/console', { Host: 'attacker.example' }), 403);
  } finally { await daemon.close(); }
});

test('C04 the console says which credential was pasted instead of a bare 401', async t => {
  const state = path.join(project, 'outputs', 'console-test', `state-${stamp}-c04`);
  const adminToken = newSecret(), clientToken = newSecret();
  const daemon = await createDaemon(baseConfig(state), { adminToken, clientToken });
  const admin = daemon.urls.admin;
  const attempt = async (token: string) => {
    const response = await fetch(`${admin}/admin/v1/status`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await response.json() as any;
    return { status: response.status, message: body?.error?.message ?? '' };
  };
  try {
    // A pairing code is 43 base64url characters, exactly like an admin token, so the
    // console must name the mistake rather than say "invalid".
    const pairing = await (await fetch(`${admin}/admin/v1/pairings`, {
      method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_id: (await (await fetch(`${admin}/admin/v1/status`, { headers: { Authorization: `Bearer ${adminToken}` } })).json() as any).workspaces[0].id, recipient: 'credential mixup test', max_access: 'ask', ttl_ms: 600000 }),
    })).json() as any;

    const withPairingCode = await attempt(pairing.code);
    assert.equal(withPairingCode.status, 401);
    assert.match(withPairingCode.message, /pairing code/i, withPairingCode.message);

    const withApiToken = await attempt(clientToken);
    assert.equal(withApiToken.status, 401);
    assert.match(withApiToken.message, /API client token/i, withApiToken.message);

    const apiPortRejectsAdmin = await fetch(`${daemon.urls.api}/v1/models`, { headers: { Authorization: `Bearer ${adminToken}` } });
    const apiBody = await apiPortRejectsAdmin.json() as any;
    assert.equal(apiPortRejectsAdmin.status, 401);
    assert.match(apiBody.error.message, /admin token/i, apiBody.error.message);

    const garbage = await attempt('x'.repeat(43));
    assert.equal(garbage.status, 401);
    assert.equal(garbage.message, 'Credential is invalid for this endpoint');

    // The real token still works.
    assert.equal((await attempt(adminToken)).status, 200);

    // The launcher hands the token over in the URL fragment; the console must accept it
    // and the server must never see it.
    const page = await fetch(`${admin}/console#t=${encodeURIComponent(adminToken)}`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.ok(html.includes('location.hash'), 'console reads the fragment');
    assert.equal(html.includes(adminToken), false, 'the shell must not embed the handed token');
  } finally { await daemon.close(); }
});

test('C03 remote ingress is opt-in, acknowledged, and never applies to admin or api', async t => {
  // Enabled without acknowledgement is refused.
  await assert.rejects(
    createDaemon({ ...baseConfig(path.join(project, 'outputs', 'console-test', `state-${stamp}-c03a`)), remote_ingress: { enabled: true, bind_address: '::', acknowledge_exposure: false } }, { adminToken: newSecret(), clientToken: newSecret() }),
    { code: 'INVALID_CONFIG' },
  );
  // Enabled but still loopback is refused as a misconfiguration.
  await assert.rejects(
    createDaemon({ ...baseConfig(path.join(project, 'outputs', 'console-test', `state-${stamp}-c03b`)), remote_ingress: { enabled: true, bind_address: '127.0.0.1', acknowledge_exposure: true } }, { adminToken: newSecret(), clientToken: newSecret() }),
    { code: 'INVALID_CONFIG' },
  );
  // Grant authentication cannot be turned off.
  assert.equal(ConfigSchema.safeParse({ ...baseConfig('x'), remote_ingress: { enabled: true, bind_address: '::', acknowledge_exposure: true, require_grant: false } }).success, false);

  // A real non-loopback bind: only the MCP port moves, admin and api stay on loopback.
  const state = path.join(project, 'outputs', 'console-test', `state-${stamp}-c03c`);
  const adminToken = newSecret(), clientToken = newSecret();
  const daemon = await createDaemon(
    { ...baseConfig(state), remote_ingress: { enabled: true, bind_address: '::', acknowledge_exposure: true, allow_cidrs: ['::/0'] } },
    { adminToken, clientToken },
  );
  try {
    // The exposed listener moves; the local one never does.
    assert.match(daemon.urls.mcp_remote, /^http:\/\/\[::\]:\d+$/);
    assert.match(daemon.urls.mcp, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(daemon.urls.admin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(daemon.urls.api, /^http:\/\/127\.0\.0\.1:\d+$/);
    // Unauthenticated remote callers still get nothing without a grant.
    const unauth = await fetch(daemon.urls.mcp_remote + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    await unauth.text();
    assert.equal(unauth.status, 401);
    // The loopback console still works.
    const console = await fetch(daemon.urls.admin + '/console');
    await console.text();
    assert.equal(console.status, 200);
  } finally { await daemon.close(); }
});
