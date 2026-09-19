#!/usr/bin/env node
/**
 * Starts the ArenaBridge daemon detached from this process, using the local
 * loopback development credentials in .arena-bridge/local-credentials.json.
 *
 * Safety: it binds only to 127.0.0.1, refuses to start if the state directory is
 * already locked by another daemon, and never enables Arena/LMArena automation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = process.argv[2] ?? path.join(root, 'outputs', 'run-local.config.json');
const credentialsPath = path.join(root, '.arena-bridge', 'local-credentials.json');
const stateDirectory = path.join(root, '.arena-bridge', 'run');
const logDirectory = path.join(root, 'outputs', 'local-run');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`Cannot read ${path.relative(root, file)}: ${error.message}`); }
}

const config = readJson(configPath);
if (config.arena_enabled !== false) throw new Error('arena_enabled must stay false: no Arena/LMArena authorization is recorded');
const credentials = readJson(credentialsPath);
if (!credentials.admin_token || !credentials.api_token) throw new Error('Local credentials file is incomplete; delete it and re-run the generator');
if (credentials.admin_token === credentials.api_token) throw new Error('Admin and API credentials must differ');

const lockFile = path.join(stateDirectory, 'daemon.lock');
if (fs.existsSync(lockFile)) {
  let owner = 'unknown';
  try { owner = JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid ?? 'unknown'; } catch { /* keep default */ }
  throw new Error(`State directory is already locked (pid ${owner}). Run stop-local first, or inspect that process before removing the lock.`);
}

const cli = path.join(root, 'dist', 'apps', 'daemon', 'src', 'cli.js');
if (!fs.existsSync(cli)) throw new Error('dist/ is missing. Run: node node_modules/typescript/bin/tsc -p tsconfig.json');

fs.mkdirSync(logDirectory, { recursive: true });
const stdout = fs.openSync(path.join(logDirectory, 'daemon.out.log'), 'a');
const stderr = fs.openSync(path.join(logDirectory, 'daemon.err.log'), 'a');
const child = spawn(process.execPath, [cli, 'serve', '--config', configPath], {
  cwd: root,
  detached: true,
  stdio: ['ignore', stdout, stderr],
  env: {
    ...process.env,
    ARENABRIDGE_ADMIN_TOKEN: credentials.admin_token,
    ARENABRIDGE_API_TOKEN: credentials.api_token,
    ARENABRIDGE_MCP_TOKEN: credentials.mcp_token ?? credentials.api_token,
  },
});
child.unref();
fs.writeFileSync(path.join(logDirectory, 'daemon.pid'), `${child.pid}\n`);

const ready = await new Promise((resolve) => {
  const deadline = Date.now() + 20000;
  const poll = async () => {
    if (Date.now() > deadline) return resolve(undefined);
    try {
      const response = await fetch(`http://127.0.0.1:${config.ports.admin}/admin/v1/status`, { headers: { Authorization: `Bearer ${credentials.admin_token}` }, signal: AbortSignal.timeout(1000) });
      if (response.ok) return resolve(await response.json());
      await response.text();
    } catch { /* not up yet */ }
    setTimeout(poll, 250);
  };
  void poll();
});

if (!ready) {
  console.error(`Daemon did not become ready. See ${path.relative(root, logDirectory)}/daemon.err.log`);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    event: 'started',
    pid: child.pid,
    api_port: config.ports.api,
    mcp_port: config.ports.mcp,
    admin_port: config.ports.admin,
    gateway: config.gateway,
    workspaces: ready.workspaces,
    health: ready.health,
    credentials_file: path.relative(root, credentialsPath),
    logs: path.relative(root, logDirectory),
  }, null, 2));
}
