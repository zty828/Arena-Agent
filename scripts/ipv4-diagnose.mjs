#!/usr/bin/env node
/**
 * IPv4 egress reality check.
 *
 * The remote sandbox has IPv4 egress but no IPv6 route at all, so the only viable
 * paths are: a public IPv4 on this host (rare on residential lines) or a tunnel.
 * This script answers "is a public IPv4 even possible here?" without guessing.
 */
import { spawnSync } from 'node:child_process';

const out = {};
const fetchJson = async (url) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
    return await response.json();
  } catch (error) { return { error: error.message }; }
};

out.public_ipv4 = (await fetchJson('https://api.ipify.org?format=json')).ip ?? null;
out.public_ipv6 = (await fetchJson('https://api6.ipify.org?format=json')).ip ?? null;

// Local private addresses, to compare against the public one.
const os = await import('node:os');
out.local_ipv4 = [];
for (const [name, list] of Object.entries(os.networkInterfaces())) {
  for (const entry of list ?? []) {
    if (entry.family === 'IPv4' && !entry.internal) out.local_ipv4.push({ interface: name, address: entry.address });
  }
}

function isCgnat(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isInteger(value))) return false;
  // 100.64.0.0/10 carrier-grade NAT
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

if (out.public_ipv4) {
  out.public_ipv4_is_cgnat = isCgnat(out.public_ipv4);
  out.public_ipv4_matches_local = out.local_ipv4.some((entry) => entry.address === out.public_ipv4);
}

out.verdict = !out.public_ipv4 ? 'could not determine the public IPv4'
  : out.public_ipv4_is_cgnat ? 'the public IPv4 is in 100.64.0.0/10 (carrier-grade NAT). Inbound port forwarding will not work; a tunnel is required.'
  : out.public_ipv4_matches_local ? 'the host holds a public IPv4 directly. Port forwarding may work.'
  : 'the public IPv4 differs from every local address, so the host is behind NAT. Inbound requires router port forwarding; if the ISP shares that address, forwarding still will not help.';

// Is a tunnel client already available?
const which = (name) => {
  const result = spawnSync('where', [name], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  return result.status === 0 ? (result.stdout ?? '').split(/\r?\n/)[0].trim() : null;
};
out.tunnel_clients_present = { cloudflared: which('cloudflared'), ngrok: which('ngrok'), ssh: which('ssh') };

out.next_step = out.tunnel_clients_present.cloudflared
  ? 'cloudflared is present. A quick tunnel needs no account: cloudflared tunnel --url http://127.0.0.1:48271'
  : 'No cloudflared found. Install it, or use an SSH-based tunnel (ssh is present on Windows 10+).';

console.log(JSON.stringify(out, null, 2));
