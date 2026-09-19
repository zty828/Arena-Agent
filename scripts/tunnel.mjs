#!/usr/bin/env node
/**
 * Zero-install SSH reverse tunnel for the local MCP port.
 *
 * Why a tunnel: the remote sandbox has IPv4 egress only and no IPv6 route, while
 * this host sits behind NAT with no public address of its own. A tunnel gives an
 * IPv4/HTTPS-reachable endpoint that the sandbox can dial.
 *
 * Uses the Windows OpenSSH client, so nothing has to be downloaded. Providers are
 * tried in order until one hands back a public URL.
 *
 * Privacy note: the tunnel provider terminates TLS, so it can see the MCP traffic
 * in plaintext. Use it with a synthetic workspace, not private source.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] ?? 48271);
const ssh = fs.existsSync('C:\\Windows\\System32\\OpenSSH\\ssh.exe') ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : 'ssh';
const knownHosts = path.join(root, '.arena-bridge', 'known_hosts');
const urlFile = path.join(root, 'outputs', 'tunnel-url.txt');
fs.mkdirSync(path.dirname(knownHosts), { recursive: true });

const PROVIDERS = [
  {
    name: 'pinggy.io',
    args: ['-p', '443', '-T', '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${knownHosts}`,
      '-o', 'ServerAliveInterval=20', '-o', 'ExitOnForwardFailure=yes',
      `-R0:localhost:${port}`, 'a.pinggy.io'],
    urlPattern: /(https?:\/\/[a-z0-9-]+\.(?:a\.pinggy\.link|pinggy\.link|a\.pinggy\.io|pinggy\.io))/i,
  },
  {
    name: 'serveo.net',
    args: ['-T', '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${knownHosts}`,
      '-o', 'ServerAliveInterval=20', '-o', 'ExitOnForwardFailure=yes',
      `-R`, `80:localhost:${port}`, 'serveo.net'],
    urlPattern: /(https:\/\/[a-z0-9-]+\.serveo\.net)/i,
  },
  {
    name: 'localhost.run',
    args: ['-T', '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${knownHosts}`,
      '-o', 'ServerAliveInterval=20', '-o', 'ExitOnForwardFailure=yes',
      `-R`, `80:localhost:${port}`, 'nokey@localhost.run'],
    urlPattern: /(https:\/\/[a-z0-9-]+\.lhr\.life)/i,
  },
];

function tryProvider(provider, timeoutMs = 45000) {
  return new Promise((resolve) => {
    const child = spawn(ssh, provider.args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, child });
    };
    const timer = setTimeout(() => finish({ ok: false, reason: `no URL within ${timeoutMs / 1000}s`, output: output.slice(-600) }), timeoutMs);
    const onData = (chunk) => {
      output += String(chunk);
      const match = provider.urlPattern.exec(output);
      if (match) finish({ ok: true, url: match[1], output: output.slice(-600) });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', (error) => finish({ ok: false, reason: error.code ?? error.message }));
    child.once('exit', (code) => finish({ ok: false, reason: `ssh exited with ${code}: ${output.trim().split('\n').slice(-3).join(' | ').slice(0, 300)}` }));
  });
}

let chosen;
for (const provider of PROVIDERS) {
  process.stdout.write(`trying ${provider.name} ... `);
  const attempt = await tryProvider(provider);
  if (attempt.ok) {
    chosen = { provider, ...attempt };
    process.stdout.write('ok\n');
    break;
  }
  process.stdout.write(`failed (${attempt.reason})\n`);
  try { attempt.child.kill(); } catch { /* already gone */ }
}

if (!chosen) {
  console.error('\nNo tunnel could be established. Nothing was exposed.');
  process.exit(1);
}

const url = chosen.url.replace(/\/$/, '');
fs.writeFileSync(urlFile, url + '\n');
process.stdout.write(`\nTUNNEL READY\n  provider : ${chosen.provider.name}\n  public   : ${url}\n  forwards : ${url} -> http://127.0.0.1:${port}\n  saved to : ${path.relative(root, urlFile)}\n\nPress Ctrl+C to close the tunnel.\n`);

const shutdown = () => { try { chosen.child.kill(); } catch { /* ignore */ } process.exit(0); };
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
chosen.child.once('exit', () => { process.stdout.write('\ntunnel closed\n'); process.exit(0); });
