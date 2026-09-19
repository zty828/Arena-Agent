#!/usr/bin/env node
/**
 * Distinguishes two very different failure modes for the tunnel URL:
 *   a) the tunnel itself is not serving yet
 *   b) this host's proxy breaks the loop back to Cloudflare (which would NOT
 *      affect the remote sandbox, since it does not use this proxy)
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const credentials = JSON.parse(fs.readFileSync(path.join(root, '.arena-bridge', 'local-credentials.json'), 'utf8'));
const { startCloudflareTunnel } = await import('./tunnel-cloudflared.mjs');

const state = path.join(root, 'outputs', 'tunnel-diag', `s-${Date.now()}`);
fs.mkdirSync(state, { recursive: true });
const base = JSON.parse(fs.readFileSync(path.join(root, 'outputs', 'run-local.config.json'), 'utf8'));
const config = { ...base, state_directory: state, ports: { api: 0, mcp: 0, admin: 0 } };
const configPath = path.join(state, 'config.json');
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
const outHandle = fs.openSync(path.join(state, 'daemon.out.log'), 'w');
const errHandle = fs.openSync(path.join(state, 'daemon.err.log'), 'w');
const daemon = spawn(process.execPath, [path.join(root, 'dist', 'apps', 'daemon', 'src', 'cli.js'), 'serve', '--config', configPath], {
  cwd: root, stdio: ['ignore', outHandle, errHandle],
  env: { ...process.env, ARENABRIDGE_ADMIN_TOKEN: credentials.admin_token, ARENABRIDGE_API_TOKEN: credentials.api_token },
});

let tunnel;
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
  if (!ready) throw new Error('bridge not ready');
  const port = Number(new URL(ready.urls.mcp).port);

  // Local baseline: does the bridge answer on loopback?
  const local = await fetch(`http://127.0.0.1:${port}/client.py`, { signal: AbortSignal.timeout(10000) });
  console.log('loopback /client.py ->', local.status, (await local.text()).length, 'bytes');

  tunnel = await startCloudflareTunnel(port);
  if (!tunnel.ok) throw new Error(tunnel.reason);
  const url = tunnel.url;
  console.log('public url:', url);
  console.log('--- cloudflared output tail ---');
  console.log(tunnel.output.split('\n').slice(-6).join('\n'));

  // Poll for readiness instead of testing immediately: registration is not instant.
  for (let attempt = 1; attempt <= 12; attempt++) {
    try {
      const response = await fetch(`${url}/client.py`, { signal: AbortSignal.timeout(20000) });
      const body = await response.text();
      console.log(`attempt ${attempt}: status=${response.status} bytes=${body.length}`);
      if (response.ok && body.length > 1000) { console.log('TUNNEL SERVING'); break; }
    } catch (error) {
      console.log(`attempt ${attempt}: ${error.cause?.code ?? error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  // Now compare direct-vs-proxy from this host, to see whether the local proxy is the obstacle.
  for (const [label, env] of [['with proxy', {}], ['no proxy', { HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '' }]]) {
    const result = await new Promise((resolve) => {
      const child = spawn('python', ['-c', `
import urllib.request, os, sys
if os.environ.get('DISABLE_PROXY') == '1':
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
else:
    opener = urllib.request.build_opener()
try:
    data = opener.open(sys.argv[1], timeout=25).read()
    print('OK', len(data))
except Exception as error:
    print('ERR', type(error).__name__, str(error)[:160])
`, `${url}/client.py`], { encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env, DISABLE_PROXY: label === 'no proxy' ? '1' : '0' } });
      child.once('exit', () => resolve(child));
      child.stdout?.on('data', () => {});
    });
    console.log(`${label}: ${(result.stdout ?? '').trim() || (result.stderr ?? '').trim().slice(0, 200)}`);
  }
} catch (error) {
  console.log('diagnostic error:', error.message);
} finally {
  try { tunnel?.child?.kill(); } catch { /* ignore */ }
  daemon.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 4000));
  if (daemon.exitCode === null) daemon.kill('SIGKILL');
}
