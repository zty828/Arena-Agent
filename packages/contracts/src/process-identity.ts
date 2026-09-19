/**
 * Process identity, for telling a live daemon apart from a recycled pid.
 *
 * A state lease records the pid of the process holding it. Pids are not identities: Windows
 * (and any OS with a finite pid space) recycles them, so a lease left behind by a dead daemon
 * can end up naming a completely unrelated process that happens to have been given the same
 * number afterwards. Checking only `process.kill(pid, 0)` therefore cannot distinguish:
 *
 *   * the real daemon still running  -> keep the lock, refuse to start a second daemon
 *   * an unrelated process with a recycled pid -> the lock is stale, it must be cleared
 *
 * In practice the recycled pid landed on a Windows service, where the liveness probe fails
 * with EPERM instead of ESRCH and reads as "alive but not ours" — so the desktop harness
 * refused to start and showed nothing at all, which is the worst possible failure mode.
 *
 * The fix is to record something about the holder that a recycled pid will not reproduce:
 * the process start time. This module is the single place that reads it, so the lease writer
 * and the lease validator can never disagree about how identity is defined.
 */
import { spawnSync } from 'node:child_process';

/** .NET DateTime ticks are 100 ns intervals since 0001-01-01; this is that date as Unix ticks. */
const DOTNET_EPOCH_TICKS = 621355968000000000;

/**
 * Start time of a process as epoch milliseconds, or undefined when it cannot be read.
 *
 * Read through the OS rather than through a dependency, because this runs during daemon
 * startup and desktop window startup — before anything else can be assumed to work. It is
 * deliberately best-effort: an unreadable start time degrades to "unknown", and callers treat
 * unknown conservatively rather than guessing.
 */
export function processStartedAtMs(pid: number): number | undefined {
  return process.platform === 'win32' ? windowsStartTimeMs(pid) : posixStartTimeMs(pid);
}

function windowsStartTimeMs(pid: number): number | undefined {
  const script = `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().Ticks`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
  const ticks = Number((result.stdout ?? '').trim());
  if (!Number.isFinite(ticks) || ticks <= 0) return undefined;
  return Math.round((ticks - DOTNET_EPOCH_TICKS) / 10000);
}

function posixStartTimeMs(pid: number): number | undefined {
  // `ps -o lstart=` output is not reliably parseable across locales; elapsed seconds is.
  const result = spawnSync('ps', ['-o', 'etimes=', '-p', String(pid)], { encoding: 'utf8', timeout: 8000 });
  const seconds = Number((result.stdout ?? '').trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Date.now() - seconds * 1000;
}

/**
 * Is the process now holding `pid` the same process the lease was written for?
 *
 * 'different' is the only verdict strong enough to justify clearing a lock: a false 'different'
 * would let two daemons share one state directory, which is the corruption the lease exists to
 * prevent. 'unknown' therefore keeps the conservative behaviour.
 */
export function sameProcessAs(pid: number, expectedStartedAt: unknown): 'same' | 'different' | 'unknown' {
  if (typeof expectedStartedAt !== 'number' || !Number.isFinite(expectedStartedAt)) return 'unknown';
  const actual = processStartedAtMs(pid);
  if (actual === undefined) return 'unknown';
  // Start time is recorded at coarse resolution and read back with clock jitter, so compare
  // with a tolerance rather than for equality.
  return Math.abs(actual - expectedStartedAt) <= 2000 ? 'same' : 'different';
}
