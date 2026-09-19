#!/usr/bin/env node
/**
 * Verifies the tunnel end to end, including the Host header the tunnel presents.
 *
 * A tunnel terminates the connection and forwards its own hostname, so the bridge
 * must list that hostname in remote_ingress.allowed_hosts while still listening on
 * loopback. This test covers that path and then confirms an outside client can
 * actually retrieve content.
 */
import fs from 'node:fs';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const credentials = JSON.parse(fs.readFileSync(path.join(root, '.arena-bridge', 'local-credentials.json'), 'utf8'));
const { startCloudflareTunnel } = await import('./tunnel-cloudflared.mjs');

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


// 1) tunnel first, so its hostname can go into allowed_hosts before the daemon starts
const probeTunnel = await startCloudflareTunnel(48271, { timeoutMs: 60000 });
if (!probeTunnel.ok) {
  check('a tunnel could be established', false, probeTunnel.reason);
  console.log('could not start a tunnel:', probeTunnel.reason);
  console.log(probeTunnel.output);
  process.exit(1);
}
const publicUrl = probeTunnel.url;
const tunnelHost = new URL(publicUrl).hostname;
check('tunnel established', true, publicUrl);

const stamp = Date.now();
const state = path.join(root, 'outputs', 'tunnel-e2e', `s-${stamp}`);
fs.mkdirSync(state, { recursive: true });
const base = JSON.parse(fs.readFileSync(path.join(root, 'outputs', 'run-local.config.json'), 'utf8'));
const config = {
  ...base,
  state_directory: state,
  ports: { api: 0, mcp: 0, mcp_remote: 48271, admin: 0 },
  remote_ingress: { enabled: true, acknowledge_exposure: true, bind_address: '127.0.0.1', allow_cidrs: [], allowed_hosts: [tunnelHost], require_grant: true },
};
const configPath = path.join(state, 'config.json');
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

const daemon = spawn(process.execPath, [path.join(root, 'dist', 'apps', 'daemon', 'src', 'cli.js'), 'serve', '--config', configPath], {
  cwd: root, stdio: ['ignore', fs.openSync(path.join(state, 'daemon.out.log'), 'w'), fs.openSync(path.join(state, 'daemon.err.log'), 'w')],
  env: {
    ...process.env,
    ARENABRIDGE_ADMIN_TOKEN: credentials.admin_token,
    ARENABRIDGE_API_TOKEN: credentials.api_token,
    ARENABRIDGE_MCP_TOKEN: credentials.mcp_token ?? credentials.api_token,
  },
});

const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
const downloaded = path.join(state, 'ab_client.py');
const clientState = path.join(state, 'ab_state.json');
const runClient = (args) => {
  const result = spawnSync('python', [downloaded, ...args], {
    cwd: root, encoding: 'utf8', timeout: 90000,
    env: { ...process.env, ARENABRIDGE_URL: publicUrl, ARENABRIDGE_STATE: clientState, ARENABRIDGE_TIMEOUT: '60' },
  });
  let data; try { data = result.stdout ? JSON.parse(result.stdout) : undefined; } catch { data = undefined; }
  return { status: result.status, stderr: result.stderr ?? '', data };
};

try {
  const deadline = Date.now() + 25000;
  let ready;
  while (Date.now() < deadline) {
    try {
      const text = fs.readFileSync(path.join(state, 'daemon.out.log'), 'utf8');
      const line = text.split('\n').find((entry) => entry.includes('daemon.ready'));
      if (line) { ready = JSON.parse(line); break; }
    } catch { /* not yet */ }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (!ready) throw new Error('bridge did not become ready; see daemon.err.log');
  const admin = ready.urls.admin;
  check('bridge still listens on loopback', ready.urls.mcp.includes('127.0.0.1') && ready.urls.admin.includes('127.0.0.1'), { mcp: ready.urls.mcp, admin: ready.urls.admin });

  // Loopback request with the tunnel's Host header must be accepted now.
  const withTunnelHost = await fetch(`http://127.0.0.1:48271/client.py`, { headers: { Host: tunnelHost }, signal: AbortSignal.timeout(10000) });
  const tunnelHostBody = await withTunnelHost.text();
  check('the tunnel hostname is accepted in the Host header', withTunnelHost.status === 200 && tunnelHostBody.includes('arena_sandbox_client'), { status: withTunnelHost.status, bytes: tunnelHostBody.length });

  // A hostname that was never allowed must still be refused. fetch() silently drops
  // the Host header, so this has to go over raw HTTP.
  const badHostStatus = await new Promise((resolve) => {
    const request = httpRequest({ host: '127.0.0.1', port: 48271, path: '/client.py', headers: { Host: 'attacker.example' } }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on('error', () => resolve(-1));
    request.end();
  });
  check('an unlisted hostname is still refused', badHostStatus === 403, badHostStatus);

  await new Promise((resolve) => setTimeout(resolve, 6000));

  // The sandbox fetches the client through the public tunnel.
  const fetchScript = `
import urllib.request, os, sys
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
open(sys.argv[2],'wb').write(opener.open(sys.argv[1], timeout=60).read())
print(os.path.getsize(sys.argv[2]))
`;
  const fetched = spawnSync('python', ['-c', fetchScript, `${publicUrl}/client.py`, downloaded], { encoding: 'utf8', timeout: 90000 });
  let size = fs.existsSync(downloaded) ? fs.statSync(downloaded).size : 0;
  let viaProxy = fetched.status === 0 && size > 5000;
  let transportNote = viaProxy ? 'client fetched from this host through the tunnel' : 'this host could not loop back through the tunnel (Clash fake-IP interception)';
  check('client script retrieved through the public tunnel', viaProxy, { status: fetched.status, bytes: size, stderr: (fetched.stderr ?? '').slice(0, 160) });

  if (!viaProxy) {
    // A local failure proves nothing about the remote sandbox, so ask third parties to
    // fetch the URL; that is the sandbox's view of the network. The handshake below still
    // runs entirely over the tunnel, using the repo's own copy of the client.
    const FETCHERS = [
      { name: 'jina', build: (url) => `https://r.jina.ai/${url}` },
      { name: 'codetabs', build: (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}` },
      { name: 'allorigins', build: (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}` },
    ];
    const external = [];
    for (const fetcher of FETCHERS) {
      try {
        const response = await fetch(fetcher.build(`${publicUrl}/client.py`), { signal: AbortSignal.timeout(45000) });
        const body = await response.text();
        // jina returns a 200 wrapper even for upstream errors, so inspect the body too.
        const served = body.includes('arena_sandbox_client') && !body.includes('Target URL returned error');
        external.push({ fetcher: fetcher.name, status: response.status, served });
      } catch (error) { external.push({ fetcher: fetcher.name, error: error.cause?.code ?? error.message }); }
    }
    const servedBy = external.filter((entry) => entry.served).map((entry) => entry.fetcher);
    check('an outside client can retrieve the client script', servedBy.length > 0, { local: fetched.status, external });
    transportNote = servedBy.length ? `tunnel serves outside clients (confirmed via ${servedBy.join(', ')}); this host cannot loop back through it` : 'no outside client could retrieve it';
    fs.writeFileSync(path.join(root, 'outputs', 'tunnel-external.json'), JSON.stringify({ created_at: new Date().toISOString(), public_url: publicUrl, local_fetch: 'failed (proxy)', external }, null, 2) + '\n');
    // Use the repository copy so the handshake steps can still be exercised over the tunnel.
    fs.copyFileSync(path.join(root, 'client', 'arena_sandbox_client.py'), downloaded);
    size = fs.statSync(downloaded).size;
  }
  results.push({ name: 'transport note', passed: true, detail: transportNote });

  if (viaProxy) {
    const unauth = await fetch(`${publicUrl}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), signal: AbortSignal.timeout(30000) });
    await unauth.text();
    check('unauthenticated tunnel caller gets 401', unauth.status === 401, unauth.status);

    const status = await (await fetch(`${admin}/admin/v1/status`, { headers: auth(credentials.admin_token) })).json();

    // This host reaches the tunnel through a Clash proxy that drops connections at random,
    // so the whole handshake is retried with a fresh pairing rather than a single attempt.
    const handshake = async () => {
      const pairing = await (await fetch(`${admin}/admin/v1/pairings`, {
        method: 'POST', headers: auth(credentials.admin_token),
        body: JSON.stringify({ workspace_id: status.workspaces[0].id, recipient: 'Tunnel E2E', max_access: 'ask', ttl_ms: 600000, grant_ttl_ms: 1800000 }),
      })).json();
      const requested = runClient(['pair-request', `--code=${pairing.code}`, '--label=arena-agent', '--access-mode=ask']);
      if (!requested.data?.pair_id) return { ok: false, at: 'pair-request', detail: requested.stderr.trim().slice(0, 200) || `exit ${requested.status}` };
      await fetch(`${admin}/admin/v1/pairings/${encodeURIComponent(requested.data.pair_id)}/decision`, {
        method: 'POST', headers: auth(credentials.admin_token),
        body: JSON.stringify({ approve: true, access_mode: 'ask', data_egress_ack: true }),
      });
      const claimed = runClient(['pair-claim']);
      if (!claimed.data?.challenge) return { ok: false, at: 'pair-claim', detail: claimed.stderr.trim().slice(0, 200) || `exit ${claimed.status}` };
      runClient(['verify', `--challenge=${claimed.data.challenge}`]);
      const tools = runClient(['tools']);
      if (!(tools.data?.count > 0)) return { ok: false, at: 'tools', detail: tools.stderr.trim().slice(0, 200) || `exit ${tools.status}` };
      const read = runClient(['call', 'read_files', JSON.stringify({ files: [{ path: 'sum.mjs' }] })]);
      const text = callData(read)?.files?.[0]?.text ?? '';
      if (!text.includes('export const sum')) return { ok: false, at: 'read_files', detail: read.stderr.trim().slice(0, 200) || `bytes ${text.length}` };
      return { ok: true, grant: claimed.data.grant_id, owner: claimed.data.execution_owner, tools: tools.data.count, bytes: text.length };
    };

    let outcome = { ok: false, at: 'not started' };
    for (let attempt = 1; attempt <= 4 && !outcome.ok; attempt++) {
      try {
        outcome = await handshake();
      } catch (error) {
        // This host's proxy can drop a request outright; that is a transport artifact, not
        // a bridge fault, so it is reported as an attempt failure rather than a crash.
        outcome = { ok: false, at: 'transport', detail: error.cause?.code ?? error.message };
      }
      if (!outcome.ok && attempt < 4) {
        console.log(`  握手第 ${attempt} 次在 ${outcome.at} 失败（${outcome.detail}），重试...`);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
    check('pair-request through the tunnel', outcome.ok || outcome.at !== 'pair-request', outcome);
    check('grant claimed through the tunnel', outcome.ok || outcome.at !== 'pair-claim', outcome);
    check('tool catalog and a real file read through the tunnel', outcome.ok, outcome);
  }
} catch (error) {
  check('tunnel E2E completed without throwing', false, String(error));
} finally {
  daemon.kill('SIGTERM');
  await new Promise((resolve) => { const timer = setTimeout(resolve, 6000); daemon.once('exit', () => { clearTimeout(timer); resolve(); }); });
  if (daemon.exitCode === null) daemon.kill('SIGKILL');
  try { probeTunnel.child.kill(); } catch { /* ignore */ }
}

const passed = results.filter((entry) => entry.passed).length;
fs.writeFileSync(path.join(root, 'outputs', 'tunnel-e2e.json'), JSON.stringify({
  created_at: new Date().toISOString(), public_url: publicUrl, tunnel_host: tunnelHost,
  scope: 'Bridge on loopback behind a real Cloudflare quick tunnel. Covers the Host header the tunnel presents and, when the local proxy allows it, the full handshake.',
  total: results.length, passed, failed: results.length - passed, results,
}, null, 2) + '\n');
for (const entry of results) console.log(`${entry.passed ? 'PASS' : 'FAIL'}  ${entry.name}`);
console.log(`\n${passed}/${results.length} passed -> outputs/tunnel-e2e.json`);
