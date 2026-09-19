#!/usr/bin/env node
/**
 * Can a stale lease left behind by a killed daemon be told apart from a live one?
 *
 * This exists because the answer used to be "no", and the consequence was the worst possible
 * failure mode: the desktop window would not start at all, with no daemon running and nothing
 * on screen to explain why. The chain was:
 *
 *   1. The window was closed, killing the daemon that it hosted. That daemon had already
 *      written `daemon.lock` naming its pid.
 *   2. Windows recycled that pid and gave it to a system service.
 *   3. The startup check asked `process.kill(pid, 0)`. Against a service owned by another
 *      account that fails with EPERM, not ESRCH — which the check read as "alive, and not
 *      ours", so it refused to clear the lock and refused to start, forever.
 *
 * The fix records the holder's start time in the lease, so a pid that has been recycled onto a
 * different process is recognised. This guard asserts all three cases, because a check that
 * only covers the stale case would pass on a build that is willing to clear a lock out from
 * under a live daemon — two daemons in one state directory, which is the corruption the lease
 * exists to prevent.
 *
 * Run: node scripts/probe-stale-lease.mjs
 *
 * Exit codes: 0 all cases behaved, 1 a case regressed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktopScript = path.join(root, 'dist', 'apps', 'desktop', 'src', 'main.js');

if (!fs.existsSync(desktopScript)) {
  console.error(`missing ${path.relative(root, desktopScript)}; run: npm run build`);
  process.exit(1);
}

const results = [];
const say = (line = '') => console.log(line);
function check(name, ok, evidence) {
  results.push({ name, ok: !!ok, evidence: evidence ?? null });
  say(`${ok ? 'PASS' : 'FAIL'}  ${name}${evidence ? `  — ${evidence}` : ''}`);
}

/**
 * Start the harness against a prepared state directory and report what it did with the lease.
 *
 * Uses --self-test purely to make the main process trace its startup stages and exit on its
 * own; the verdict of interest is the lease handling, not the window's checks.
 */
function runHarness(stateDir, keepAlive) {
  const env = {
    ...process.env,
    ARENABRIDGE_STATE_DIR: stateDir,
    CODEBUDDY_CONVERSATION_REQUEST_ID: `stale-lease-probe-${Date.now()}`,
    CODEBUDDY_TOOL_CALL_ID: `stale-lease-probe-${Date.now()}`,
  };
  const finished = spawnSync(process.execPath, ['scripts/desktop.mjs', '--self-test'], {
    cwd: root, encoding: 'utf8', timeout: 180000, env,
  });
  const output = `${finished.stdout ?? ''}${finished.stderr ?? ''}`;
  const lockPath = path.join(stateDir, 'daemon.lock');
  return {
    output,
    // A lease that was cleared is moved aside, never deleted, so its presence is the signal.
    quarantined: fs.existsSync(path.join(stateDir, 'daemon.lock.orphaned')),
    lockStillThere: fs.existsSync(lockPath),
    started: /daemon started at http:\/\/127\.0\.0\.1:\d+/.test(output),
    trace: output.split('\n').filter((line) => line.includes('[startup] lease') || line.includes('moved a stale')).join(' | '),
    keepAlive,
  };
}

const scratch = path.join(root, 'outputs', 'desktop', 'stale-lease-probe');
const fresh = (name) => {
  const dir = path.join(scratch, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

// --- case 1: the lease names a pid that is alive but is NOT the process that wrote it -------
//
// This is the recycled-pid case, and the one that caused the outage. A live unrelated process
// stands in for the service Windows handed the pid to.
{
  const dir = fresh('recycled');
  const squatter = spawn(process.execPath, ['-e', 'setTimeout(()=>{},120000)'], { stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const { processStartedAtMs } = await import(
    new URL('../dist/packages/contracts/src/process-identity.js', import.meta.url).href
  );
  const realStart = processStartedAtMs(squatter.pid);
  fs.writeFileSync(path.join(dir, 'daemon.lock'), JSON.stringify({
    pid: squatter.pid,
    // A start time that cannot belong to that process: it claims the holder started a day
    // earlier than the process now wearing the pid.
    pid_started_at: (realStart ?? Date.now()) - 86400000,
    nonce: 'probe', created_at: new Date().toISOString(),
  }));
  const outcome = runHarness(dir);
  squatter.kill();
  check(
    'a lease whose pid was recycled is recognised as stale and cleared',
    outcome.quarantined && outcome.started,
    outcome.trace || `quarantined=${outcome.quarantined} started=${outcome.started}`,
  );
}

// --- case 2: the lease belongs to a daemon that is genuinely still running -------------------
//
// Must NOT be cleared. Clearing it would let a second daemon open the same state directory.
{
  const dir = fresh('live');
  // Hold the state directory with a real daemon, exactly as a running window would.
  const held = spawnSync(process.execPath, [
    '--experimental-sqlite', 'dist/apps/daemon/src/cli.js', 'serve',
    '--config', path.join(dir, 'config.json'),
  ], { cwd: root, encoding: 'utf8', timeout: 4000, env: {
    ...process.env,
    ARENABRIDGE_ADMIN_TOKEN: 'stale-lease-probe-admin-0123456789abcdefghij',
    ARENABRIDGE_API_TOKEN: 'stale-lease-probe-api-0123456789abcdefghijkl',
    ARENABRIDGE_MCP_TOKEN: 'stale-lease-probe-mcp-0123456789abcdefghijklm',
  } });

  // The daemon needs a config; write one and retry so the lease is written by the daemon itself
  // rather than by this probe inventing a lock. That keeps the case faithful.
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    schema_version: 1, state_directory: dir,
    ports: { api: 0, mcp: 0, admin: 0, mcp_remote: 0 },
    workspaces: [{ root, display_name: 'stale-lease-probe' }],
    response_mode: 'json', security_profile: 'local_trusted_development', arena_enabled: false,
  }, null, 2));

  const daemon = spawn(process.execPath, [
    '--experimental-sqlite', 'dist/apps/daemon/src/cli.js', 'serve', '--config', path.join(dir, 'config.json'),
  ], { cwd: root, stdio: 'ignore', env: {
    ...process.env,
    ARENABRIDGE_ADMIN_TOKEN: 'stale-lease-probe-admin-0123456789abcdefghij',
    ARENABRIDGE_API_TOKEN: 'stale-lease-probe-api-0123456789abcdefghijkl',
    ARENABRIDGE_MCP_TOKEN: 'stale-lease-probe-mcp-0123456789abcdefghijklm',
  } });

  const lockPath = path.join(dir, 'daemon.lock');
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !fs.existsSync(lockPath)) await new Promise((r) => setTimeout(r, 250));

  const lease = fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, 'utf8')) : null;
  check('a running daemon writes a lease that records its start time', typeof lease?.pid_started_at === 'number', JSON.stringify(lease));

  const outcome = runHarness(dir);
  daemon.kill();
  // The harness must have declined to start a second daemon on a directory that is in use.
  check(
    'a lease held by a live daemon is left alone',
    !outcome.quarantined && !outcome.started,
    outcome.trace || `quarantined=${outcome.quarantined} started=${outcome.started}`,
  );
}

// --- case 3: a pre-fix lease (no start time) naming a non-node process ----------------------
//
// Old leases have no start time, so identity is unknown. They must still be recoverable, or an
// upgrade would leave the operator permanently unable to start the window.
{
  const dir = fresh('legacy');
  fs.writeFileSync(path.join(dir, 'daemon.lock'), JSON.stringify({
    pid: 4, nonce: 'probe', created_at: new Date().toISOString(),
  }));
  const outcome = runHarness(dir);
  // pid 4 on Windows is the System process: alive, not ours, and definitely not a node process.
  // On other platforms it may not exist at all, in which case clearing is also correct.
  check(
    'a legacy lease with no start time, naming a process that is not our daemon, is cleared',
    outcome.quarantined,
    outcome.trace || `quarantined=${outcome.quarantined}`,
  );
}

const failures = results.filter((entry) => !entry.ok).length;
say('');
if (failures === 0) say('VERDICT: a stale lease is cleared, a live one is protected, and a legacy lease can still be recovered.');
else say(`VERDICT: ${failures} case(s) failed; lease handling has regressed.`);
process.exit(failures === 0 ? 0 : 1);
