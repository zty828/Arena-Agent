#!/usr/bin/env node
/**
 * Stops the locally started daemon by PID file, then waits for the state lock to
 * be released. If the process is already gone, the lock is left in place on
 * purpose: a stale lock must be inspected locally, never auto-deleted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logDirectory = path.join(root, 'outputs', 'local-run');
const pidFile = path.join(logDirectory, 'daemon.pid');
const lockFile = path.join(root, '.arena-bridge', 'run', 'daemon.lock');

if (!fs.existsSync(pidFile)) {
  console.log(JSON.stringify({ event: 'not_running', note: 'No pid file; nothing was stopped' }));
  process.exit(0);
}
const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
let alive = true;
try { process.kill(pid, 0); } catch { alive = false; }

if (alive) {
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { alive = false; break; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (alive) {
    console.log(JSON.stringify({ event: 'still_running', pid, note: 'Graceful stop timed out. The lock is intentionally left in place; inspect the process before forcing anything.' }));
    process.exit(1);
  }
}
fs.rmSync(pidFile, { force: true });
console.log(JSON.stringify({ event: 'stopped', pid, lock_released: !fs.existsSync(lockFile), lock_file: fs.existsSync(lockFile) ? path.relative(root, lockFile) : null }));
