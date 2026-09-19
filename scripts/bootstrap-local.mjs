#!/usr/bin/env node
/**
 * One-command local bootstrap: compile if needed, create credentials if needed,
 * recover a stale lock, then run the daemon in the foreground and open the console.
 * All text handling happens in Node, so batch-file encoding problems cannot occur.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureLocalConfig } from './ensure-local-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'dist', 'apps', 'daemon', 'src', 'cli.js');
const checkOnly = process.argv.includes('--check-only');
const noOpen = process.argv.includes('--no-open');
const expose = process.argv.includes('--expose');
const configPath = process.argv.slice(2).find((value) => !value.startsWith('--')) ?? path.join(root, 'outputs', 'run-local.config.json');
const credentialsPath = path.join(root, '.arena-bridge', 'local-credentials.json');

const say = (message) => process.stdout.write(message + '\n');
const fail = (message) => { process.stderr.write('\n[start failed] ' + message + '\n'); process.exit(1); };

function openBrowser(url) {
  try {
    const [command, args] = process.platform === 'win32' ? ['explorer.exe', [url]]
      : process.platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]];
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch { return false; }
}

if (!process.versions.node.startsWith('22.')) {
  say(`note: this build was validated on Node 22.22.2; running ${process.version}. Continuing anyway.`);
}

// 1) compile when dist is missing or any source is newer than the build output
let needsBuild = !fs.existsSync(cli);
if (!needsBuild) {
  const built = fs.statSync(cli).mtimeMs;
  const newest = (directory) => {
    let latest = 0;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) latest = Math.max(latest, newest(full));
      else if (entry.name.endsWith('.ts')) latest = Math.max(latest, fs.statSync(full).mtimeMs);
    }
    return latest;
  };
  const latestSource = Math.max(newest(path.join(root, 'apps')), newest(path.join(root, 'packages')), newest(path.join(root, 'tests')));
  needsBuild = latestSource > built;
}
if (needsBuild) {
  say('[1/3] Compiling TypeScript...');
  const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tsc)) fail('node_modules/typescript is missing. Install dependencies first (see README).');
  const result = spawnSync(process.execPath, [tsc, '-p', path.join(root, 'tsconfig.json')], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) fail('TypeScript compilation failed; nothing was started.');
} else {
  say('[1/3] Build is up to date.');
}

say('');
say('==================================================================');
say('  ArenaBridge 本地启动（仅回环，不对外）');
say('==================================================================');
say('');
say('  这个模式只监听 127.0.0.1，任何外部设备都连不上。');
say('  本机客户端、模型网关、控制台可以正常使用。');
say('');
say('  要接远端 Agent（Arena 等），请改用 desktop.cmd，在窗口里点「接远端」。');
say('');

// 2) credentials
if (!fs.existsSync(credentialsPath)) {
  say('[2/3] Generating local loopback credentials...');
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'gen-credentials.mjs')], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) fail('Credential generation failed.');
} else {
  say('[2/3] Credentials already present (not overwritten).');
}
if (checkOnly) { say('--check-only: build and credentials are ready; daemon not started.'); process.exit(0); }

// 3) run — the daemon reads its credentials from the environment, so inject them here.
if (!fs.existsSync(configPath) && configPath === path.join(root, 'outputs', 'run-local.config.json')) {
  // The default config is generated on demand: it holds absolute paths, so it cannot be
  // committed, and without this a fresh clone died here on the very first command.
  const generated = ensureLocalConfig(root);
  if (generated.created) say(`[0/3] Created the local config: ${path.relative(root, generated.path)}`);
}
if (!fs.existsSync(configPath)) fail(`Config not found: ${path.relative(root, configPath)}`);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
if (!credentials.admin_token || !credentials.api_token) fail('Credential file is incomplete. Delete .arena-bridge/local-credentials.json and run this again to regenerate.');
if (credentials.admin_token === credentials.api_token) fail('Admin and API credentials must differ.');

// A credentials file written before mcp_token existed has no such key. Falling back to
// api_token here would silently hand the daemon two identical credentials, and it would
// then refuse to start with an error that looks unrelated to the real cause. Repair the
// file in place instead (gen-credentials keeps existing tokens and only adds the missing one).
if (!credentials.mcp_token) {
  say('  local credentials predate mcp_token; adding one in place (existing tokens are kept).');
  const repair = spawnSync(process.execPath, [path.join(root, 'scripts', 'gen-credentials.mjs')], { cwd: root, stdio: 'inherit' });
  if (repair.status !== 0) fail('Could not add mcp_token to the existing credential file.');
  Object.assign(credentials, JSON.parse(fs.readFileSync(credentialsPath, 'utf8')));
  if (!credentials.mcp_token) fail('Credential repair reported success but mcp_token is still missing.');
}

if (expose) {
  // Addresses rotate (temporary privacy addresses), so bind the wildcard, not one literal.
  // The effective config goes to a separate file so exposure never persists silently.
  config.remote_ingress = { enabled: true, acknowledge_exposure: true, bind_address: '::', allow_cidrs: [], require_grant: true };
}
const effectiveConfigPath = expose ? path.join(path.dirname(configPath), 'run-local.exposed.json') : configPath;
if (expose) fs.writeFileSync(effectiveConfigPath, JSON.stringify(config, null, 2) + '\n');

say('[3/3] Starting daemon');
say('');
// A hard kill (common on Windows) leaves the state lock behind. Recover only after
// confirming the recorded owner process is really gone; never break a live lock.
const stateDirectory = path.resolve(root, config.state_directory);
const lockFile = path.join(stateDirectory, 'daemon.lock');
if (fs.existsSync(lockFile)) {
  let owner;
  try { owner = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { fail('daemon.lock is unreadable. Inspect it by hand; it was not removed.'); }
  let alive = true;
  try { process.kill(owner.pid, 0); } catch { alive = false; }
  if (alive) fail(`Another daemon is already running (pid ${owner.pid}). Stop that one first, or remove ${path.relative(root, lockFile)} only after confirming the process is gone.`);
  fs.rmSync(lockFile);
  say(`  recovered a stale lock left by pid ${owner.pid} (process is no longer running)`);
}

say(`  Console (open this)   http://127.0.0.1:${config.ports.admin}/console`);
say(`  Model gateway         http://127.0.0.1:${config.ports.api}/v1   model=${config.gateway?.alias ?? 'n/a'}  key=api_token`);
if (config.remote_ingress?.enabled) {
  const globals = [];
  for (const [name, list] of Object.entries((await import('node:os')).networkInterfaces())) {
    for (const entry of list ?? []) {
      const value = entry.address.split('%')[0];
      if (entry.family === 'IPv6' && !entry.internal && /^[23]/.test(value) && name === '以太网') globals.push(value);
    }
  }
  say('');
  say('  ===== REMOTE INGRESS IS ON =====');
  say(`  MCP is listening on every IPv6 address, port ${config.ports.mcp}.`);
  for (const address of globals) say(`    http://[${address}]:${config.ports.mcp}/mcp`);
  if (!globals.length) say('    (no global IPv6 address found on 以太网 right now)');
  say('');
  say('  Before pointing anything external at this:');
  say('    1. Windows Firewall needs an inbound allow rule for that TCP port.');
  say('    2. The router must forward inbound traffic to this host.');
  say('    3. Confirm from a phone on cellular data: it should answer 401, not time out.');
  say('  Admin and API ports stay on 127.0.0.1 and are never exposed.');
} else {
  say(`  Workspace MCP         http://127.0.0.1:${config.ports.mcp}/mcp`);
}
say('');
say(`  Credentials file: ${path.relative(root, credentialsPath)}`);
if (config.remote_ingress?.enabled) say('  WARNING: remote ingress is ON. Stop the daemon when you are done.');
say('  Press Ctrl+C to stop.');
say('');

const child = spawn(process.execPath, [cli, 'serve', '--config', effectiveConfigPath], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    ARENABRIDGE_ADMIN_TOKEN: process.env.ARENABRIDGE_ADMIN_TOKEN || credentials.admin_token,
    ARENABRIDGE_API_TOKEN: process.env.ARENABRIDGE_API_TOKEN || credentials.api_token,
    ARENABRIDGE_MCP_TOKEN: process.env.ARENABRIDGE_MCP_TOKEN || credentials.mcp_token,
},
});

// Open the console once the admin port actually answers, so the user never has to
// guess the URL or paste a token into a blank 401 page.
if (!noOpen && config.ports.admin !== 0) {
  const consoleUrl = `http://127.0.0.1:${config.ports.admin}/console`;
  // Hand the token over in the URL fragment so the operator does not have to go find
  // it in a JSON file. Fragments are never sent to the server and never logged; the
  // console strips it from the address bar with history.replaceState once it reads it.
  const unlockedUrl = `${consoleUrl}#t=${encodeURIComponent(credentials.admin_token)}`;
  const deadline = Date.now() + 20000;
  void (async () => {
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${config.ports.admin}/admin/v1/status`, {
          headers: { Authorization: `Bearer ${credentials.admin_token}` }, signal: AbortSignal.timeout(1000),
        });
        await response.text();
        if (response.ok) { say(`  opening ${consoleUrl} in your browser (use --no-open to skip)`); openBrowser(unlockedUrl); return; }
      } catch { /* keep waiting */ }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  })();
}

await new Promise((resolve) => child.once('exit', resolve));
process.exit(child.exitCode ?? 0);
