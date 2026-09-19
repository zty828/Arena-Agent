/**
 * Does an exposed daemon actually bind the port the tunnel was told to forward to, and does it
 * still enforce its boundary there?
 *
 * This is the ordering that the Arena connect flow depends on: reserve a port, open the tunnel
 * to it, then restart the daemon in exposed mode on that same port. Before the remote port was
 * pinned, the daemon chose its own port on restart, so the tunnel forwarded to nothing.
 *
 * Note on Host headers: `fetch` silently drops an explicit `Host`, so the allowlist cases below
 * must use raw `http.request`. Using fetch here would produce a false FAIL (the request would
 * carry 127.0.0.1 and be rejected by auth before the allowlist could be observed).
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createDaemon } = await import(pathToFileURL(path.join(root, 'dist', 'apps', 'daemon', 'src', 'server.js')).href);
const { exposedIngress } = await import(pathToFileURL(path.join(root, 'dist', 'apps', 'desktop', 'src', 'tunnel-mode.js')).href);

// The same reservation the window performs.
function reserveRemotePort() {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

// Raw POST so that Host survives the trip. Returns the status code.
function post(port, hostHeader, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        setHost: false,
        headers: { Host: hostHeader, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...extraHeaders },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, host: hostHeader }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

let failures = 0;
function check(ok, message) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`);
}

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-pin-'));
const pinned = await reserveRemotePort();
console.log('pinned remote port:', pinned);
const allowedHost = 'pin-check.trycloudflare.com';

const daemon = await createDaemon({
  schema_version: 1,
  state_directory: stateDir,
  ports: { api: 0, mcp: 0, mcp_remote: pinned, admin: 0 },
  workspaces: [{ root, display_name: 'pin-check' }],
  response_mode: 'json',
  security_profile: 'local_trusted_development',
  arena_enabled: false,
  remote_ingress: exposedIngress(allowedHost),
  gateway: { type: 'disabled' },
}, { adminToken: 'a'.repeat(40), clientToken: 'b'.repeat(40), mcpToken: 'c'.repeat(40) });

const reported = daemon.urls.mcp_remote;
console.log('daemon reports mcp_remote:', JSON.stringify(reported));
console.log('');

check(
  reported === `http://127.0.0.1:${pinned}`,
  reported === `http://127.0.0.1:${pinned}`
    ? `the remote listener bound the pinned port ${pinned}, so a tunnel created beforehand reaches it`
    : `expected http://127.0.0.1:${pinned} but the daemon reported ${JSON.stringify(reported)}`,
);

const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

// 1) An unauthenticated call through the allowed host must be refused by auth, not by the allowlist.
const anonymous = await post(pinned, allowedHost, rpc);
check(
  anonymous.status === 401,
  anonymous.status === 401
    ? 'a call that presents the paired host but no grant is refused (HTTP 401)'
    : `expected 401 for an unauthenticated call, got ${anonymous.status}`,
);

// 2) An unlisted Host must be refused by the boundary before auth is even considered.
const wrongHost = await post(pinned, 'evil.example.com', rpc);
check(
  wrongHost.status === 403,
  wrongHost.status === 403
    ? 'an unlisted Host on the remote port is refused by the boundary (HTTP 403)'
    : `expected 403 for an unlisted Host, got ${wrongHost.status}`,
);

// 3) A cross-origin request from a foreign page must be refused.
const crossOrigin = await post(pinned, allowedHost, rpc, { Origin: 'https://evil.example.com' });
check(
  crossOrigin.status === 403,
  crossOrigin.status === 403
    ? 'a cross-origin request is refused (HTTP 403)'
    : `expected 403 for a cross-origin request, got ${crossOrigin.status}`,
);

// 4) The loopback listener must not be reachable via the allowlisted host trick on the local port.
const localPort = Number(new URL(daemon.urls.mcp).port);
const localViaRemoteHost = await post(localPort, allowedHost, rpc);
check(
  localViaRemoteHost.status === 401 || localViaRemoteHost.status === 403,
  `the local listener still rejects a call carrying the tunnel host (HTTP ${localViaRemoteHost.status})`,
);

console.log('');
console.log(failures === 0 ? 'all checks passed' : `${failures} check(s) failed`);

await daemon.close();
fs.rmSync(stateDir, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
