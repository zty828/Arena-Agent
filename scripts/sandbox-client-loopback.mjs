#!/usr/bin/env node
/**
 * Is the sandbox client itself healthy, without any relay in front of it?
 *
 * Why this exists separately from scripts/sandbox-client-e2e.mjs:
 *
 * The exposed-path probe reaches the bridge through a Cloudflare quick tunnel,
 * whose HTTP/1.x path intermittently accepts a connection and then never
 * answers. When that happens the probe cannot tell a flaky relay from a broken
 * client. This script removes the relay: the daemon listens on loopback only
 * and the real Python client talks to it directly. If this passes while the
 * tunnel probe stalls, the stall is the relay's, not the client's.
 *
 * Two traps this script deliberately avoids:
 *
 *   1. The daemon must run in a SEPARATE process. An earlier version of this
 *      check hosted the daemon in-process and drove the client with spawnSync,
 *      which blocks the Node event loop the daemon shares -> self-inflicted
 *      deadlock, which looked exactly like a client hang.
 *   2. Environment variables that intentionally break the client (a read
 *      deadline of 1s, forced retries of 1) are scrubbed, so a stray shell
 *      value cannot make this check lie.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, '..');
const client = join(project, 'client', 'arena_sandbox_client.py');
const cli = join(project, 'dist', 'apps', 'daemon', 'src', 'cli.js');

// The daemon refuses credentials shorter than 32 chars or equal to each other.
const ADMIN_TOKEN = 'loopback-probe-admin-0123456789abcdefghijklmnop';
const API_TOKEN = 'loopback-probe-api-0123456789abcdefghijklmnopqr';
const MCP_TOKEN = 'loopback-probe-mcp-0123456789abcdefghijklmnopqrs';

const results = [];
const say = (line = '') => console.log(line);
function check(name, ok, evidence) {
  results.push({ name, ok: !!ok, evidence: evidence ?? null });
  say(`${ok ? 'PASS' : 'FAIL'}  ${name}${evidence ? `  — ${evidence}` : ''}`);
}

if (!existsSync(cli)) {
  say(`missing ${cli}; run: npm run build`);
  process.exit(75);
}

const stateDir = mkdtempSync(join(tmpdir(), 'arena-loopback-probe-'));
const port = 49080 + Math.floor(Math.random() * 400);
const configPath = join(stateDir, 'loopback.config.json');
writeFileSync(
  configPath,
  `${JSON.stringify({
    schema_version: 1,
    state_directory: stateDir,
    ports: { api: port, mcp: port + 1, admin: port + 2, mcp_remote: port + 3 },
    workspaces: [{ root: project, display_name: 'loopback-probe' }],
    response_mode: 'json',
    security_profile: 'local_trusted_development',
    arena_enabled: false,
  }, null, 2)}\n`,
  'utf8',
);

function clientEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('ARENABRIDGE_')) continue;
    if (/^(http|https|all|no)_proxy$/i.test(key)) continue;
    env[key] = value;
  }
  // Pin the knobs this check depends on rather than inheriting them.
  env.ARENABRIDGE_READ_DEADLINE = '20';
  env.ARENABRIDGE_RETRIES = '2';
  env.ARENABRIDGE_URL = `http://127.0.0.1:${port + 1}`;
  env.ARENABRIDGE_STATE = join(stateDir, 'sandbox-state.json');
  env.PYTHONIOENCODING = 'utf-8';
  return { ...env, ...extra };
}

function runClient(args, timeoutMs) {
  const started = Date.now();
  const finished = spawnSync('python', [client, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: clientEnv(),
  });
  return {
    ms: Date.now() - started,
    code: finished.status,
    out: (finished.stdout ?? '').trim(),
    err: (finished.stderr ?? '').trim(),
    timedOut: finished.error?.code === 'ETIMEDOUT' || finished.signal === 'SIGTERM',
  };
}

const daemon = spawn(
  process.execPath,
  ['--experimental-sqlite', cli, 'serve', '--config', configPath],
  {
    cwd: project,
    env: {
      ...process.env,
      ARENABRIDGE_ADMIN_TOKEN: ADMIN_TOKEN,
      ARENABRIDGE_API_TOKEN: API_TOKEN,
      ARENABRIDGE_MCP_TOKEN: MCP_TOKEN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

let daemonLog = '';
daemon.stdout.on('data', (chunk) => { daemonLog += chunk; });
daemon.stderr.on('data', (chunk) => { daemonLog += chunk; });

let exit = 1;
try {
  const base = `http://127.0.0.1:${port + 1}`;
  const adminBase = `http://127.0.0.1:${port + 2}`;
  let ready = false;
  for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
    try {
      const response = await fetch(`${adminBase}/admin/v1/status`, {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        signal: AbortSignal.timeout(1500),
      });
      ready = response.ok;
      if (!ready) await response.text();
    } catch { /* not up yet */ }
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  check('the daemon is listening on loopback only', ready, `mcp ${base} admin ${adminBase}`);
  if (!ready) throw new Error('daemon did not become ready');

  const version = runClient(['--help'], 20000);
  check('the python client starts and prints usage', version.code === 0 && /pair-request/.test(version.out), `${version.ms}ms`);

  // A pairing invitation is still required: /pair/request accepts a code, not a token.
  const invited = await fetch(`${adminBase}/admin/v1/pairings`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      workspace_id: (await (await fetch(`${adminBase}/admin/v1/status`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })).json()).workspaces[0].id,
      recipient: 'loopback probe',
      max_access: 'plan',
      ttl_ms: 300000,
      grant_ttl_ms: 600000,
    }),
    signal: AbortSignal.timeout(10000),
  });
  const invitation = await invited.json();
  const code = invitation.code;
  check('the operator can create a one-time pairing code', invited.ok && !!code, `HTTP ${invited.status}`);

  // The exact call that stalls through the tunnel.
  const requested = runClient(
    ['pair-request', `--code=${code}`, '--label', 'loopback-probe'],
    60000,
  );
  const pairId = (requested.out.match(/"pair_id"\s*:\s*"([^"]+)"/) ?? [])[1] ?? null;
  check(
    'the client can request a pairing over plain loopback',
    requested.code === 0 && !!pairId,
    pairId ? `${pairId} in ${requested.ms}ms` : `exit=${requested.code} ${requested.ms}ms ${requested.err.slice(0, 200)}`,
  );

  const anonymous = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: `127.0.0.1:${port + 1}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    signal: AbortSignal.timeout(10000),
  }).catch((error) => ({ status: 0, error }));
  check(
    'an unauthenticated MCP call is still refused on loopback',
    anonymous.status === 401,
    anonymous.status ? `HTTP ${anonymous.status}` : String(anonymous.error),
  );

  const failures = results.filter((entry) => !entry.ok).length;
  say('');
  if (failures === 0) say('VERDICT: the sandbox client works against a local bridge with no relay involved.');
  else say(`VERDICT: ${failures} check(s) failed with no relay involved; this is a client or bridge problem.`);
  exit = failures === 0 ? 0 : 1;
} catch (error) {
  say(`ERROR: ${error.message}`);
  if (daemonLog.trim()) say(`daemon log tail:\n${daemonLog.slice(-1200)}`);
} finally {
  daemon.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));
  try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

process.exit(exit);
