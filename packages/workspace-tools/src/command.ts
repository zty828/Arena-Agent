/**
 * Bounded command execution inside the approved workspace.
 *
 * This is the capability the project deliberately refused in stage 1 (ADR-005: "no
 * run_command, ever"). It is now implemented on the operator's explicit instruction, and the
 * reversal is recorded in docs/architecture-and-security.md rather than quietly dropped: with
 * this tool enabled, the bridge no longer keeps the remote from running arbitrary code on this
 * machine. A shell can read and write anything the daemon's user can, so nothing here is a
 * sandbox — what is left is the tier the operator chose, the audit trail, and the session
 * bounds (revoke / disconnect / restart kill the process tree).
 *
 * What this file *is* responsible for is not letting the failure modes be silent or unbounded:
 *
 *  - the working directory is resolved through the same path policy as every other tool, so a
 *    command cannot be started from outside the workspace root;
 *  - a command cannot run forever, and when its deadline passes the whole process *tree* is
 *    killed, not just the shell — `npm test` spawns children that would otherwise survive;
 *  - output is capped per stream while still being drained, so a chatty child cannot deadlock on
 *    a full pipe or hand the bridge an unbounded buffer;
 *  - the daemon's own credentials are removed from the child environment. Inheriting them would
 *    hand a remote command the admin token, which can approve, revoke and read everything;
 *  - every running child is tracked, so revoking access, cancelling a run or closing the daemon
 *    terminates what is in flight instead of leaving it running unattended.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { BridgeError } from '../../contracts/src/index.js';
import type { WorkspaceFiles } from './files.js';

/** Per-stream output budget. Beyond this the stream is drained and dropped, and flagged. */
export const COMMAND_OUTPUT_BYTES = 65536;
export const COMMAND_DEFAULT_TIMEOUT_MS = 30000;
export const COMMAND_MAX_TIMEOUT_MS = 300000;
const COMMAND_MAX_LENGTH = 4096;

export interface CommandResult {
  command: string;
  cwd: string;
  shell: string;
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  duration_ms: number;
  stdout: string;
  stderr: string;
  stdout_bytes: number;
  stderr_bytes: number;
  truncated: boolean;
}

interface Running { child: ChildProcess; kill: (reason: string) => void }

/**
 * Kills a process and everything it started.
 *
 * `child.kill()` only signals the shell. On Windows that leaves the actual work (`npm`, `node`,
 * `tsc`) running as an orphan the operator can neither see nor stop; `taskkill /T` walks the
 * tree. POSIX gets the same treatment via a process group, which requires the child to have been
 * started detached.
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => undefined); }
    catch { /* best effort */ }
    sweepDescendants(pid);
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* best effort */ }
  }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

/**
 * Kills every descendant of `pid` from the process table, after `taskkill /T` has been asked.
 *
 * Not belt-and-braces for its own sake: measured on this machine, when the command was launched
 * through the MCP request path, `taskkill /pid <shell> /T /F` reported success on the shell while
 * the `node` grandchild kept running and wrote its file two seconds after the command was
 * reported as timed out. The same command killed cleanly when the runner was called directly, so
 * the tree walk cannot be trusted to be complete here.
 *
 * The sweep is deliberately fire-and-forget: it runs on the timeout/abort path only, and blocking
 * the daemon's event loop (which serves all three ports) to wait for PowerShell would trade one
 * failure mode for a worse one. It also walks from the recorded parent id, which Windows keeps
 * after a parent exits — so an orphaned grandchild is still found.
 */
function sweepDescendants(pid: number): void {
  const script = [
    `$root=${pid};`,
    `$all=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId;`,
    `$ids=@(); $frontier=@($root);`,
    `for ($i=0; $i -lt 4; $i++) {`,
    `  $next=@(); foreach ($p in $frontier) { $next += @($all | Where-Object { $_.ParentProcessId -eq $p } | Select-Object -ExpandProperty ProcessId) };`,
    `  if ($next.Count -eq 0) { break }; $ids += $next; $frontier = $next }`,
    `if ($ids.Count -gt 0) { $ids | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }`,
  ].join(' ');
  try {
    const sweep = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: 'ignore' });
    sweep.on('error', () => undefined);
  } catch { /* best effort */ }
}

/** The shell a command runs in. Stated in the result and the docs, never guessed by the caller. */
export function commandShell(): string {
  if (process.platform === 'win32') return process.env.ComSpec ?? 'cmd.exe';
  return process.env.SHELL ?? '/bin/sh';
}

/**
 * The child environment: everything the daemon has, minus its own credentials.
 *
 * The daemon holds `ARENABRIDGE_ADMIN_TOKEN` / `API` / `MCP` in its process environment (the CLI
 * injects them). Passing those through would let one `echo $ARENABRIDGE_ADMIN_TOKEN` — or any
 * command that dumps its environment — escalate a workspace grant into full local admin, which is
 * strictly more than the operator ever granted. They are removed by prefix, so a future
 * `ARENABRIDGE_*` secret is covered without anyone having to remember this file.
 */
function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase().startsWith('ARENABRIDGE_')) continue;
    env[key] = value;
  }
  return env;
}

export class CommandRunner {
  private readonly running = new Set<Running>();

  constructor(private readonly files: WorkspaceFiles) {}

  /** How many commands are in flight, so the host can report and bound concurrency. */
  get active(): number { return this.running.size; }

  /**
   * Terminates everything in flight. Called on revoke, on run cancel and on daemon shutdown:
   * "revoked" has to mean the process is gone, not merely that new requests are refused.
   */
  killAll(reason: string): number {
    const count = this.running.size;
    for (const entry of [...this.running]) entry.kill(reason);
    return count;
  }

  async run(arg: { command: string; cwd?: string; timeout_ms?: number; signal?: AbortSignal }): Promise<CommandResult> {
    const command = arg.command;
    if (typeof command !== 'string' || !command.trim()) throw new BridgeError('INVALID_ARGUMENT', 400, 'command must be a non-empty string');
    if (command.length > COMMAND_MAX_LENGTH) throw new BridgeError('INVALID_ARGUMENT', 400, `command exceeds ${COMMAND_MAX_LENGTH} characters`);
    const timeout = arg.timeout_ms ?? COMMAND_DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > COMMAND_MAX_TIMEOUT_MS) {
      throw new BridgeError('INVALID_ARGUMENT', 400, `timeout_ms must be an integer between 1 and ${COMMAND_MAX_TIMEOUT_MS}`);
    }
    // Same path policy as every other tool: relative, no traversal, no symlink, and the resolved
    // directory must really be inside the approved root.
    const cwd = await this.files.resolve(arg.cwd ?? '.', { allowRoot: true });
    if (arg.signal?.aborted) throw new BridgeError('CLIENT_DISCONNECTED', 499, 'Request was cancelled before execution');

    const started = performance.now();
    const shell = commandShell();
    return await new Promise<CommandResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(command, {
          cwd,
          shell,
          windowsHide: true,
          // No stdin: interactive input is a PTY feature and is not implemented. A command that
          // waits for input must fail fast rather than hang until its deadline.
          stdio: ['ignore', 'pipe', 'pipe'],
          env: childEnvironment(),
          // A process group is what makes the POSIX tree kill possible.
          detached: process.platform !== 'win32',
        });
      } catch (error) {
        reject(new BridgeError('IO_ERROR', 500, `could not start the command: ${String((error as Error)?.message ?? error)}`));
        return;
      }

      let stdout = '', stderr = '';
      let stdoutBytes = 0, stderrBytes = 0, truncated = false;
      let settled = false, timedOut = false;

      const drain = (chunk: Buffer, keep: boolean) => {
        if (keep) return chunk.toString('utf8');
        return '';
      };

      const onData = (which: 'stdout' | 'stderr') => (chunk: Buffer) => {
        const size = chunk.length;
        if (which === 'stdout') {
          stdoutBytes += size;
          const room = COMMAND_OUTPUT_BYTES - Buffer.byteLength(stdout, 'utf8');
          if (room > 0) stdout += chunk.subarray(0, room).toString('utf8');
          if (size > room) truncated = true;
        } else {
          stderrBytes += size;
          const room = COMMAND_OUTPUT_BYTES - Buffer.byteLength(stderr, 'utf8');
          if (room > 0) stderr += chunk.subarray(0, room).toString('utf8');
          if (size > room) truncated = true;
        }
        // The chunk is always consumed, whether or not it is kept: a child blocked writing to a
        // full pipe would look exactly like a hung command.
        void drain(chunk, false);
      };
      child.stdout?.on('data', onData('stdout'));
      child.stderr?.on('data', onData('stderr'));

      const finish = (result: Omit<CommandResult, 'command' | 'cwd' | 'shell' | 'stdout' | 'stderr' | 'stdout_bytes' | 'stderr_bytes' | 'truncated' | 'duration_ms'>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.running.delete(entry);
        arg.signal?.removeEventListener('abort', onAbort);
        resolve({
          command, cwd, shell, ...result,
          stdout, stderr, stdout_bytes: stdoutBytes, stderr_bytes: stderrBytes, truncated,
          duration_ms: Math.round(performance.now() - started),
        });
      };

      const entry: Running = {
        child,
        kill: (reason: string) => {
          killTree(child);
          if (!settled) finish({ exit_code: null, signal: `killed:${reason}`, timed_out: false });
        },
      };
      this.running.add(entry);

      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
        finish({ exit_code: null, signal: 'timeout', timed_out: true });
      }, timeout);

      const onAbort = () => {
        killTree(child);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.running.delete(entry);
          reject(new BridgeError('CLIENT_DISCONNECTED', 499, 'The caller disconnected; the command was terminated'));
        }
      };
      arg.signal?.addEventListener('abort', onAbort, { once: true });

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.running.delete(entry);
        reject(new BridgeError('IO_ERROR', 500, `command failed to run: ${String(error.message)}`));
      });
      child.on('close', (code, signal) => {
        finish({ exit_code: code, signal: signal ?? null, timed_out: timedOut });
      });
    });
  }
}
