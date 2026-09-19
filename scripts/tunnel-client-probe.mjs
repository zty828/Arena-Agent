#!/usr/bin/env node
/**
 * Can this host fetch a tunnel client at all? The proxy environment may allow
 * HTTPS to some hosts and not others, so test before recommending an install.
 * Read-only: it sends HEAD/GET requests and downloads nothing to disk.
 */
const targets = [
  { name: 'cloudflared release (github)', url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' },
  { name: 'github.com api', url: 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest' },
  { name: 'cloudflare.com', url: 'https://www.cloudflare.com/' },
  { name: 'ngrok.com', url: 'https://ngrok.com/' },
];

const results = [];
for (const target of targets) {
  const started = Date.now();
  try {
    const response = await fetch(target.url, { method: 'GET', headers: { Range: 'bytes=0-1023' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    const body = await response.arrayBuffer();
    results.push({ name: target.name, status: response.status, reachable: response.ok || response.status === 206, bytes: body.byteLength, ms: Date.now() - started });
  } catch (error) {
    results.push({ name: target.name, reachable: false, error: error.cause?.code ?? error.message, ms: Date.now() - started });
  }
}

// What does the outside world think this host's IPv4 is, and does it look like a proxy exit?
let identity = null;
try {
  const response = await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(15000) });
  identity = await response.json();
} catch (error) { identity = { error: error.message }; }

console.log(JSON.stringify({
  download_targets: results,
  public_identity: identity,
  verdict: results.some((entry) => entry.name.startsWith('cloudflared') && entry.reachable)
    ? 'cloudflared can be downloaded on this host'
    : 'cloudflared download is not reachable through the current proxy setup',
}, null, 2));
