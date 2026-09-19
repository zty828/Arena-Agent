#!/usr/bin/env node
/**
 * IPv6 readiness diagnostic for remote ingress.
 *
 * It reports only what can be established from this machine:
 *   - the global IPv6 addresses present on the physical adapter
 *   - whether outbound IPv6 works, and what public address the world sees
 *   - whether that public address is one of the local ones (i.e. no NAT on IPv6)
 *   - whether an inbound firewall rule exists for the chosen port
 *
 * It deliberately does NOT claim to prove inbound reachability. Free port
 * checkers do not support IPv6, and traffic between two addresses on the same
 * host is not filtered by Windows Firewall, so a local success proves nothing
 * about external access. The only reliable test is an outside network.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'outputs', 'run-local.config.json'), 'utf8'));
const port = Number(process.argv[2] ?? config.ports.mcp);

const globalAddresses = [];
for (const [name, list] of Object.entries(os.networkInterfaces())) {
  for (const entry of list ?? []) {
    const value = entry.address.split('%')[0];
    if (entry.family === 'IPv6' && !entry.internal && /^[23]/.test(value)) globalAddresses.push({ interface: name, address: value });
  }
}

let outbound = null;
try {
  const response = await fetch('https://api6.ipify.org?format=json', { signal: AbortSignal.timeout(10000) });
  outbound = (await response.json()).ip;
} catch (error) { outbound = `failed: ${error.message}`; }

const outboundMatchesLocal = typeof outbound === 'string' && globalAddresses.some((entry) => entry.address === outbound);

function firewallRules() {
  const script = `Get-NetFirewallPortFilter -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq '${port}' } | ForEach-Object { $_.LocalPort }`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 30000 });
  const lines = (result.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return { checked: result.status === 0, matches: lines };
}
const firewall = firewallRules();

const report = {
  created_at: new Date().toISOString(),
  port,
  global_ipv6_on_host: globalAddresses,
  outbound_ipv6: outbound,
  outbound_address_is_local: outboundMatchesLocal,
  nat_on_ipv6: typeof outbound === 'string' && outboundMatchesLocal === false ? 'the world sees a different address than any local one; inbound is unlikely to reach this host' : 'no evidence of address translation on IPv6',
  inbound_firewall_rule_for_port: firewall.matches.length ? firewall.matches : 'none found; unsolicited inbound TCP is blocked by default',
  not_verified: [
    'external inbound reachability (free port checkers do not support IPv6, and same-host traffic bypasses the host firewall)',
    'router or ISP inbound policy',
    'whether a remote sandbox may reach arbitrary external addresses',
  ],
  how_to_verify_for_real: [
    'Run: npm run expose',
    `Then, from a phone on cellular data (not Wi-Fi), open http://[<your-global-address>]:${port}/mcp`,
    'A JSON 401 reply means inbound works. A timeout means it is blocked by the host firewall, the router, or the ISP.',
  ],
};

fs.writeFileSync(path.join(root, 'outputs', 'net-diagnose.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
