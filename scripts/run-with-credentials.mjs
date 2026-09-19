#!/usr/bin/env node
/** Runs the daemon in the foreground using the stored local credentials. Ctrl+C stops it. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureLocalConfig, localConfigPath } from './ensure-local-config.mjs';
import { ensureLocalCredentials } from './gen-credentials.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = process.argv[2] ?? localConfigPath(root);
// Both local-state files are generated on demand. Neither can be committed — one records absolute
// paths, the other holds secrets — so reading them directly meant a fresh clone failed here with
// an ENOENT for a file it had no way to produce. Only the default config is generated; a path the
// caller supplied is theirs to provide.
if (configPath === localConfigPath(root)) ensureLocalConfig(root);
const { credentials } = ensureLocalCredentials(root);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

if (config.arena_enabled !== false) {
  console.error('arena_enabled must stay false: no Arena/LMArena authorization is recorded.');
  process.exit(1);
}

const lockFile = path.join(config.state_directory, 'daemon.lock');
if (fs.existsSync(lockFile)) {
  const owner = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  let alive = true;
  try { process.kill(owner.pid, 0); } catch { alive = false; }
  if (alive) {
    console.error(`Another daemon is already running (pid ${owner.pid}). Stop it first.`);
    process.exit(1);
  }
  fs.rmSync(lockFile);
  console.log(JSON.stringify({ event: 'stale_lock_removed', owner_pid: owner.pid, note: 'previous owner is no longer running' }));
}

const child = spawn(process.execPath, [path.join(root, 'dist', 'apps', 'daemon', 'src', 'cli.js'), 'serve', '--config', configPath], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    ARENABRIDGE_ADMIN_TOKEN: credentials.admin_token,
    ARENABRIDGE_API_TOKEN: credentials.api_token,
    ARENABRIDGE_MCP_TOKEN: credentials.mcp_token ?? credentials.api_token,
  },
});
console.log(`\n控制台: http://127.0.0.1:${config.ports.admin}/console  （用 admin_token 解锁）`);
console.log(`模型网关: http://127.0.0.1:${config.ports.api}/v1  （模型名 ${config.gateway?.alias ?? 'n/a'}，API Key 用 api_token）`);
if (config.remote_ingress?.enabled) console.log(`⚠ 远程入口已开启: MCP 绑定在 ${config.remote_ingress.bind_address}:${config.ports.mcp}`);
else console.log('远程入口未开启：MCP 端口只在 127.0.0.1。');
console.log('');
child.once('exit', (code) => { process.exitCode = code ?? 0; });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
