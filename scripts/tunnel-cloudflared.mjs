#!/usr/bin/env node
/**
 * Tunnel provider: Cloudflare Quick Tunnel via cloudflared.
 *
 * Why this exists: the remote sandbox has IPv4 egress only and no IPv6 route,
 * while this host is behind NAT (and currently routes through a proxy exit), so
 * there is no address the sandbox can dial directly. A relay is unavoidable, and
 * any relay is a third party.
 *
 * Privacy: Cloudflare terminates TLS, so it can read the MCP traffic. Use this
 * with a synthetic workspace, never with private source.
 *
 * cloudflared ships inside this repository at `runtime/cloudflared.exe`, so opening a tunnel
 * needs no download at all: the release bundle is self-contained and a machine that has never
 * seen Cloudflare can still open a quick tunnel. Only when that file is absent — a source
 * checkout that did not take the release bundle — is it fetched once from the official
 * Cloudflare GitHub release into the same path. It is never installed system-wide.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The one place cloudflared is ever read from or written to: the bundled runtime directory. */
const runtimeDirectory = path.join(root, 'runtime');
const binary = path.join(runtimeDirectory, 'cloudflared.exe');
const DOWNLOAD_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';

/**
 * Returns the cloudflared to run, preferring the copy that ships with the project.
 *
 * Exported so the release packaging step can reuse it instead of duplicating the download
 * and validation rules — two copies of "what counts as a valid binary" would drift.
 */
export async function ensureCloudflaredBinary() {
  if (fs.existsSync(binary)) {
    const size = fs.statSync(binary).size;
    if (size > 10_000_000) return { path: binary, size, downloaded: false };
    fs.rmSync(binary);
  }
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  process.stdout.write('downloading cloudflared (about 35 MB, from the official Cloudflare release) ... ');
  const response = await fetch(DOWNLOAD_URL, { redirect: 'follow', signal: AbortSignal.timeout(600000) });
  if (!response.ok || !response.body) throw new Error(`download failed with HTTP ${response.status}`);
  const partial = binary + '.part';
  const handle = fs.openSync(partial, 'w');
  let total = 0;
  try {
    for await (const chunk of response.body) { fs.writeSync(handle, chunk); total += chunk.length; }
  } finally { fs.closeSync(handle); }
  if (total < 10_000_000) { fs.rmSync(partial, { force: true }); throw new Error(`download was only ${total} bytes; refusing to run it`); }
  // A Windows executable must start with "MZ"; this catches an HTML error page saved as .exe.
  const header = Buffer.alloc(2);
  const probe = fs.openSync(partial, 'r'); fs.readSync(probe, header, 0, 2, 0); fs.closeSync(probe);
  if (header.toString('ascii') !== 'MZ') { fs.rmSync(partial, { force: true }); throw new Error('downloaded file is not a Windows executable'); }
  fs.renameSync(partial, binary);
  process.stdout.write(`ok (${total} bytes)\n`);
  return { path: binary, size: total, downloaded: true };
}

// The tunnel must target the remote-only listener, never the local one.
export async function startCloudflareTunnel(localPort, { timeoutMs = 60000, attempts = 3 } = {}) {
  const info = await ensureCloudflaredBinary();
  const failures = [];
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
    const result = await attemptTunnel(info, localPort, timeoutMs);
    if (result.ok) return { ...result, binary: info.path, downloaded: info.downloaded, attempts: attempt };
    failures.push(result.output || result.reason);
    if (attempt < attempts) {
      const wait = 5000 * attempt;
      process.stdout.write(`  第 ${attempt} 次未成功（${result.reason}），${wait / 1000}s 后重试...\n`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  const last = failures.at(-1) ?? '';
  const rateLimited = /context deadline exceeded|429|too many/i.test(last);
  return {
    ok: false,
    reason: `cloudflared produced no URL after ${attempts} attempts`,
    hint: rateLimited
      ? 'Cloudflare quick tunnels are rate limited. Wait a few minutes, or create a named tunnel with your own Cloudflare account.'
      : undefined,
    output: last.slice(-500),
  };
}

async function attemptTunnel(info, localPort, timeoutMs) {
  const args = ['tunnel', '--url', `http://127.0.0.1:${localPort}`, '--no-autoupdate', '--protocol', 'http2'];
  const child = spawn(info.path, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  // cloudflared's banner also mentions its own infrastructure hosts (for example
  // api.trycloudflare.com), so the assigned tunnel hostname has to be picked out
  // rather than taking the first match.
  const INFRASTRUCTURE = new Set(['api', 'www', 'update', 'developers', 'blog', 'dash']);
  const pickUrl = () => {
    for (const match of output.matchAll(/https:\/\/([a-z0-9-]+)\.trycloudflare\.com/gi)) {
      if (!INFRASTRUCTURE.has(match[1].toLowerCase())) return match[0];
    }
    return null;
  };
  const url = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    const onData = (chunk) => {
      output += String(chunk);
      const found = pickUrl();
      if (found) { clearTimeout(timer); resolve(found); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', () => { clearTimeout(timer); resolve(null); });
    child.once('exit', () => { clearTimeout(timer); resolve(null); });
  });
  if (!url) {
    try { child.kill(); } catch { /* already gone */ }
    return { ok: false, reason: `no URL within ${timeoutMs / 1000}s`, output };
  }
  return { ok: true, url, child, output: output.slice(-400) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? 48271);
  const result = await startCloudflareTunnel(port);
  if (!result.ok) { console.error(JSON.stringify(result, null, 2)); process.exit(1); }
  console.log(JSON.stringify({ ok: true, public_url: result.url, forwards_to: `http://127.0.0.1:${port}`, binary: result.binary, downloaded_now: result.downloaded }, null, 2));
  console.log('\nPress Ctrl+C to close the tunnel.');
  const stop = () => { try { result.child.kill(); } catch { /* ignore */ } process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  result.child.once('exit', () => { console.log('tunnel closed'); process.exit(0); });
}
