/**
 * The click path, executed against the real built modules.
 *
 * The reported failure was `TypeError: Invalid URL ... input: ''` thrown out of the
 * `arena:connect` IPC handler, so the operator only saw "Error occurred in handler". This walks
 * the same decisions that handler makes, in order, using the shipped implementations — so a
 * regression in any of them fails here instead of in front of the operator.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (rel) => import(pathToFileURL(path.join(root, 'dist', rel)).href);
const { createDaemon } = await load('apps/daemon/src/server.js');
const { exposedIngress, parseTunnelUrl, portOf } = await load('apps/desktop/src/tunnel-mode.js');

let failures = 0;
const check = (ok, message) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`);
};

// --- step 1: the daemon in its default, loopback-only state -----------------------------
// This is the state the operator is in the moment they press Connect. The remote listener does
// not exist yet, and the daemon reports it as the empty string.
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-click-'));
const closed = await createDaemon({
  schema_version: 1,
  state_directory: stateDir,
  ports: { api: 0, mcp: 0, mcp_remote: 0, admin: 0 },
  workspaces: [{ root, display_name: 'click-path' }],
  response_mode: 'json',
  security_profile: 'local_trusted_development',
  arena_enabled: false,
  remote_ingress: { enabled: false, acknowledge_exposure: false, bind_address: '127.0.0.1', allow_cidrs: [], allowed_hosts: [], require_grant: true },
  gateway: { type: 'disabled' },
}, { adminToken: 'a'.repeat(40), clientToken: 'b'.repeat(40), mcpToken: 'c'.repeat(40) });

console.log(`daemon reports mcp_remote as ${JSON.stringify(closed.urls.mcp_remote)} in loopback-only mode`);
check(closed.urls.mcp_remote === '', 'the absent remote listener is reported as the empty string (the value that used to throw)');

// The old code did exactly this, and it is what the operator hit.
let oldThrew = false;
try { void new URL(closed.urls.mcp_remote ?? 'http://127.0.0.1:0').port; } catch { oldThrew = true; }
check(oldThrew, 'the old `new URL(value ?? fallback)` form really does throw on that value');

// The shipped helper must not.
let helperThrew = false;
let derived;
try { derived = portOf(closed.urls.mcp_remote); } catch { helperThrew = true; }
check(!helperThrew && derived === undefined, 'portOf() returns undefined instead of throwing, so the handler can branch cleanly');

await closed.close();
fs.rmSync(stateDir, { recursive: true, force: true });

// --- step 2: the ordering the click now uses --------------------------------------------
// Reserve a port, open the tunnel to it, restart the daemon on that same port. Only the tunnel
// is stubbed; the reservation and the daemon bind are the real ones.
function reserveRemotePort() {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => { try { probe.close(); } catch { /* closed */ } resolve(undefined); });
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      probe.close(() => resolve(typeof port === 'number' && port > 0 ? port : undefined));
    });
  });
}

const reserved = await reserveRemotePort();
check(typeof reserved === 'number' && reserved > 0, `a loopback port is reserved before the tunnel opens (${reserved})`);

// A stand-in for what cloudflared reports, so this stays offline and deterministic.
const tunnelUrl = 'https://calm-river-9999.trycloudflare.com';
const parsed = parseTunnelUrl(tunnelUrl);
check(parsed !== undefined, 'the tunnel url the writer returns is accepted');
check(parsed?.hostname === 'calm-river-9999.trycloudflare.com', 'its hostname is what goes into the allowlist');

// A malformed-but-truthy url must be refused rather than flow into the allowlist and the prompt.
check(parseTunnelUrl('') === undefined, 'a blank tunnel url is refused');
check(parseTunnelUrl('https://evil.example.com') === undefined, 'an off-domain tunnel url is refused');

// --- step 3: the daemon comes up on the reserved port, exposed --------------------------
const stateDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-click2-'));
const exposed = await createDaemon({
  schema_version: 1,
  state_directory: stateDir2,
  ports: { api: 0, mcp: 0, mcp_remote: reserved, admin: 0 },
  workspaces: [{ root, display_name: 'click-path' }],
  response_mode: 'json',
  security_profile: 'local_trusted_development',
  arena_enabled: false,
  remote_ingress: exposedIngress(parsed.hostname),
  gateway: { type: 'disabled' },
}, { adminToken: 'a'.repeat(40), clientToken: 'b'.repeat(40), mcpToken: 'c'.repeat(40) });

check(
  exposed.urls.mcp_remote === `http://127.0.0.1:${reserved}`,
  `the daemon bound the reserved port, so the tunnel reaches a live listener (${exposed.urls.mcp_remote})`,
);

// The window's own "is this reachable from the tunnel?" test, on the real value.
check(portOf(exposed.urls.mcp_remote) !== undefined, 'the window reads this bridge as exposed');
check(portOf(closed.urls.mcp_remote) === undefined, 'and reads a loopback-only bridge as not exposed');

// The tunnel host is accepted at the boundary, but not without a grant.
const status = await new Promise((resolve, reject) => {
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const req = http.request({
    host: '127.0.0.1', port: reserved, path: '/mcp', method: 'POST', setHost: false,
    headers: { Host: parsed.hostname, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
  }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  req.on('error', reject);
  req.write(payload);
  req.end();
});
check(status === 401, `the exposed listener accepts the tunnel host but still demands a grant (HTTP ${status})`);

await exposed.close();
fs.rmSync(stateDir2, { recursive: true, force: true });

console.log('');
console.log(failures === 0 ? 'the click path completes without the reported error' : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
