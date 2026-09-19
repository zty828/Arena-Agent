#!/usr/bin/env node
/**
 * Confirms the tunnel serves content to an outside client.
 *
 * Requests from this host are useless here: the Clash proxy answers with a fake IP
 * (198.18.0.10) for the tunnel hostname and resets the connection. So ask a third
 * party's server to fetch the tunnel URL and report what came back.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const credentials = JSON.parse(fs.readFileSync(path.join(root, '.arena-bridge', 'local-credentials.json'), 'utf8'));
const { startCloudflareTunnel } = await import('./tunnel-cloudflared.mjs');

const state = path.join(root, 'outputs', 'tunnel-external', `s-${Date.now()}`);
fs.mkdirSync(state, { recursive: true });
const base = JSON.parse(fs.readFileSync(path.join(root, 'outputs', 'run-local.config.json'), 'utf8'));
const config = { ...base, state_directory: state, ports: { api: 0, mcp: 0, admin: 0 } };
const configPath = path.join(state, 'config.json');
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
const daemon = spawn(process.execPath, [path.join(root, 'dist', 'apps', 'daemon', 'src', 'cli.js'), 'serve', '--config', configPath], {
  cwd: root, stdio: ['ignore', fs.openSync(path.join(state, 'daemon.out.log'), 'w'), fs.openSync(path.join(state, 'daemon.err.log'), 'w')],
  env: { ...process.env, ARENABRIDGE_ADMIN_TOKEN: credentials.admin_token, ARENABRIDGE_API_TOKEN: credentials.api_token },
});

// Server-side fetchers: each one retrieves our URL from its own network, not ours.
const FETCHERS = [
  { name: 'codetabs', build: (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}` },
  { name: 'allorigins', build: (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}` },
  { name: 'jina', build: (url) => `https://r.jina.ai/${url}` },
  { name: 'corsproxy', build: (url) => `https://corsproxy.io/?${encodeURIComponent(url)}` },
];

const report = { created_at: new Date().toISOString(), attempts: [] };
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
  const local = await fetch(`http://127.0.0.1:${port}/client.py`, { signal: AbortSignal.timeout(10000) });
  report.local_bytes = (await local.text()).length;

  tunnel = await startCloudflareTunnel(port);
  if (!tunnel.ok) throw new Error(tunnel.reason);
  const url = tunnel.url;
  report.public_url = url;
  report.target = `${url}/client.py`;

  // Give Cloudflare a moment to finish wiring the route.
  await new Promise((resolve) => setTimeout(resolve, 8000));

  for (const fetcher of FETCHERS) {
    const entry = { fetcher: fetcher.name };
    try {
      const response = await fetch(fetcher.build(report.target), { signal: AbortSignal.timeout(45000) });
      const body = await response.text();
      entry.status = response.status;
      entry.bytes = body.length;
      entry.contains_client = body.includes('arena_sandbox_client');
      entry.served = response.ok && body.includes('arena_sandbox_client');
      entry.sample = entry.served ? undefined : body.slice(0, 180).replace(/\s+/g, ' ');
    } catch (error) { entry.error = error.cause?.code ?? error.message; }
    report.attempts.push(entry);
    console.log(JSON.stringify(entry));
  }

  const served = report.attempts.filter((entry) => entry.served);
  report.verdict = served.length
    ? `the tunnel serves external clients (confirmed via ${served.map((entry) => entry.fetcher).join(', ')}); the local ECONNRESET is a proxy artifact on this host only`
    : 'no external fetcher could retrieve the tunnel URL';
  fs.writeFileSync(path.join(root, 'outputs', 'tunnel-external.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('\n' + report.verdict);
} catch (error) {
  console.log('error:', error.message);
  fs.writeFileSync(path.join(root, 'outputs', 'tunnel-external.json'), JSON.stringify({ ...report, error: error.message }, null, 2) + '\n');
} finally {
  try { tunnel?.child?.kill(); } catch { /* ignore */ }
  daemon.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 4000));
  if (daemon.exitCode === null) daemon.kill('SIGKILL');
}
