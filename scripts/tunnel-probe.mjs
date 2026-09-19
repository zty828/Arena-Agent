#!/usr/bin/env node
/**
 * Checks which zero-install tunnel options are actually available on this host,
 * because the remote sandbox has IPv4 egress only and this host is behind NAT.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const probe = (command, args = ['--version']) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 12000, windowsHide: true });
  return { found: result.status === 0 || (result.stdout ?? '').length > 0 || (result.stderr ?? '').length > 0, status: result.status, version: ((result.stdout ?? '') + (result.stderr ?? '')).trim().split('\n')[0]?.slice(0, 120), error: result.error?.code };
};

const candidates = {
  'ssh (Windows OpenSSH)': probe('ssh', ['-V']),
  'cloudflared': probe('cloudflared', ['--version']),
  'ngrok': probe('ngrok', ['--version']),
  'npx (node)': probe('npx', ['--version']),
  'curl': probe('curl', ['--version']),
  'winget': probe('winget', ['--version']),
};
for (const file of ['C:\\Windows\\System32\\OpenSSH\\ssh.exe', 'C:\\Program Files\\Cloudflare\\cloudflared.exe']) {
  if (fs.existsSync(file)) candidates[file] = { found: true, note: 'present at a standard install path' };
}

// Is a proxy/tun intercepting traffic? A Clash-style fake-IP adapter is a strong signal.
const os = await import('node:os');
const adapters = [];
for (const [name, list] of Object.entries(os.networkInterfaces())) {
  for (const entry of list ?? []) {
    if (entry.family === 'IPv4' && !entry.internal) adapters.push({ name, address: entry.address, looks_like_fake_ip: entry.address.startsWith('198.18.') });
  }
}
const proxyEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(http|https|all|no)_proxy$/i.test(key)));

console.log(JSON.stringify({
  tunnel_clients: candidates,
  network_adapters: adapters,
  proxy_environment: proxyEnv,
  note: adapters.some((entry) => entry.looks_like_fake_ip)
    ? 'A 198.18.x.x adapter means a Clash/Mihomo-style proxy is intercepting traffic. The "public IP" seen by any checker is that proxy exit, not this household line.'
    : 'No fake-IP adapter detected.',
  recommendation: candidates['ssh (Windows OpenSSH)'].found || candidates['C:\\Windows\\System32\\OpenSSH\\ssh.exe']
    ? 'ssh is available: an SSH reverse tunnel needs no download.'
    : candidates['cloudflared'].found
      ? 'cloudflared is available: use a quick tunnel (no account needed).'
      : 'No tunnel client present. Either install cloudflared, or enable Windows OpenSSH Client.',
}, null, 2));
