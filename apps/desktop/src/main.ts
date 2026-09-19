/**
 * Electron main process for the ArenaBridge desktop harness.
 *
 * Design position: this is a *front-end*, not a second brain. It owns no policy and
 * makes no authorization decisions. It boots the same daemon the CLI boots, points a
 * window at the same admin API, and renders it as a native application instead of a
 * browser tab. Everything the remote model is allowed to do is still decided by the
 * policy engine behind the admin API.
 *
 * The daemon runs in this process (not a child) so that closing the window reliably
 * stops it, and so the renderer can reach the admin API without the operator ever
 * seeing a port number or a bearer token.
 */
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, shell, Menu } from 'electron';
import { createDaemon, type DaemonHandle } from '../../daemon/src/server.js';
import { newSecret } from '../../../packages/contracts/src/index.js';
import { sameProcessAs } from '../../../packages/contracts/src/process-identity.js';
import { buildArenaPrompt, type AccessMode } from './prompt.js';
import { closedIngress, exposedIngress, parseTunnelUrl, portOf } from './tunnel-mode.js';

// --- path constants -----------------------------------------------------------------
// All of these must be computed before any app.* call that consumes them, and before the
// window is created. A throw anywhere in this module means the app loads with the default
// Electron bootstrap instead of ours, which is why they come first.

// Resolve the project root from this file's own location rather than from app.getAppPath().
// The probe (scripts/probe-apppath.mjs) established that getAppPath() returns the directory
// of the *entry script*, which is not a stable anchor: as soon as an argument is passed the
// semantics shift, and joins built from it get doubled. import.meta.url cannot drift.
//
// Layout: <repo>/dist/apps/desktop/src/main.js, so the repo root is four levels up from the
// file's directory. The compiled path is asserted below so this cannot silently go stale.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, '..', '..', '..', '..');
const workspaceStateDir = path.join(repoRoot, 'outputs', 'desktop');
const workspaceConfigPath = path.join(workspaceStateDir, 'workspace.json');

/**
 * Where the bridge database and its lease live. ARENABRIDGE_STATE_DIR lets the automated test
 * use its own scratch state, so a test run can never contend with, or leave a stale lease in,
 * the directory an operator is using.
 */
const stateDirPath = ((): string => {
  const override = process.env.ARENABRIDGE_STATE_DIR;
  return typeof override === 'string' && override.trim() ? path.resolve(override) : path.join(workspaceStateDir, 'state');
})();

// Every asset the window needs, anchored to repoRoot so none of them depend on getAppPath().
const assetPaths = {
  preload: path.join(repoRoot, 'dist', 'apps', 'desktop', 'src', 'preload.cjs'),
  page: path.join(repoRoot, 'dist', 'apps', 'desktop', 'src', 'renderer', 'index.html'),
};

/** True under `desktop.cmd --self-test`: render, verify, print a report, exit. */
const selfTest = process.argv.includes('--self-test');
/** True under the automated end-to-end test, which also needs startup visibility. */
const e2e = !!process.env.ARENABRIDGE_E2E || process.argv.includes('--e2e-test');
/**
 * Trace every startup stage to stdout when running unattended. When the process dies without a
 * message the log order is the only way to tell where it stopped, and both the self test and
 * the end-to-end test capture stdout. Silent during normal interactive use.
 */
const trace = (stage: string): void => {
  if (selfTest || e2e) process.stdout.write(`[startup] ${stage}\n`);
};

/**
 * Under the end-to-end test, log filesystem failures from inside the daemon.
 *
 * The bridge maps most IO faults to a deliberately opaque IO_ERROR so a remote caller cannot
 * probe the host. That is the right default, but it means an unattended test sees only
 * "Filesystem operation failed" with no errno, and diagnosing it would require guessing. This
 * records the real code and path locally, only when the test asks for it.
 */
if (e2e) {
  const promises = fs.promises as unknown as Record<string, unknown>;
  // Wrap every promise-returning member, not a hand-picked list: the previous attempt missed
  // the failing call, and guessing which fs function a library uses is not a diagnosis.
  for (const name of Object.keys(promises)) {
    const original = promises[name];
    if (typeof original !== 'function') continue;
    const bound = (original as (...args: unknown[]) => unknown).bind(fs.promises);
    promises[name] = (...args: unknown[]) => {
      try {
        const result = bound(...args);
        if (result === null || typeof (result as PromiseLike<unknown>)?.then !== 'function') return result;
        return Promise.resolve(result).catch((error: NodeJS.ErrnoException) => {
          const target = typeof args[0] === 'string' ? args[0] : String(args[0]);
          process.stdout.write(`[fs] ${name} failed ${error?.code ?? 'unknown'} on ${target}\n`);
          throw error;
        });
      } catch (error) {
        const target = typeof args[0] === 'string' ? args[0] : String(args[0]);
        process.stdout.write(`[fs] ${name} threw ${(error as NodeJS.ErrnoException)?.code ?? 'unknown'} on ${target}\n`);
        throw error;
      }
    };
  }
}

/**
 * Fail loudly at startup if the path arithmetic is wrong. Without this the app comes up with
 * a blank window and no explanation; with it, the operator gets the actual resolved paths.
 */
function assertLayout(): void {
  const problems: string[] = [];
  if (!fs.existsSync(workspaceStateDir)) {
    try { fs.mkdirSync(workspaceStateDir, { recursive: true }); }
    catch { problems.push(`cannot create the state directory ${workspaceStateDir}`); }
  }
  for (const [label, target] of Object.entries(assetPaths)) {
    if (!fs.existsSync(target)) problems.push(`the ${label} is missing at ${target}`);
  }
  // main.js itself must sit under <repoRoot>/dist/apps/desktop/src, or repoRoot is wrong.
  if (!moduleDir.startsWith(path.join(repoRoot, 'dist'))) {
    problems.push(`the resolved project root ${repoRoot} does not contain ${moduleDir}; run npm run build`);
  }
  if (problems.length) {
    const message = ['The desktop harness cannot start:', ...problems.map((p) => '  - ' + p)].join('\n');
    process.stdout.write(message + '\n');
    if (!selfTest && !e2e) dialog.showErrorBox('启动失败', message);
    app.exit(1);
  }
}

// --- Chromium switches --------------------------------------------------------------
// These must be set before app.whenReady().

// This machine has no usable GPU path for Electron: the GPU process exits immediately, and
// after a few restarts Chromium declares "GPU process isn't usable. Goodbye." and aborts the
// whole application. That is a hard process death, not a warning, so it cannot be handled as
// an error later.
//
// Software rendering is the right answer for this UI regardless: it is a text-and-grid
// operator console, not a canvas or video surface, so the compositor costs nothing here and
// a GPU dependency would only add a failure mode.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-software-rasterizer');
// Belts and braces: the switches above apply to the browser process, but the *renderer* is
// the process that actually tries to bring up the GPU compositor, and it is the one whose
// crash-loop triggers the "Goodbye" abort. Telling it to fall back to SwiftShader software
// rendering is what actually stops the abort on this machine.
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('use-angle', 'swiftshader');
// Electron binds a userData directory under %APPDATA% by default. Keeping it inside the repo
// makes the desktop harness self-contained and leaves the user's profile untouched.
app.setPath('userData', path.join(workspaceStateDir, 'profile'));

// --- startup tracing ----------------------------------------------------------------

/**
 * Once the self test has reported, its verdict is final. Shutdown is then best-effort: a
 * refusal to remove the state lease must not rewrite a pass into a failure.
 */
let settledExitCode: number | undefined;
process.on('uncaughtException', (error) => {
  if (settledExitCode !== undefined) { trace('ignoring an exception during shutdown: ' + String(error?.message ?? error)); return; }
  process.stdout.write(`[startup] uncaught exception: ${error?.stack ?? String(error)}\n`);
  app.exit(1);
});
process.on('unhandledRejection', (reason) => {
  if (settledExitCode !== undefined) { trace('ignoring a rejection during shutdown: ' + String(reason)); return; }
  process.stdout.write(`[startup] unhandled rejection: ${String(reason)}\n`);
  app.exit(1);
});
trace('module evaluated');

interface DesktopPrefs { workspaceRoot: string; recentRoots: string[] }

let daemon: DaemonHandle | undefined;
let window: BrowserWindow | undefined;
let selfTestTimer: NodeJS.Timeout | undefined;
/** The operator credential for this process lifetime. Never written to disk. */
let adminToken = '';

/**
 * Publishes the endpoints, credential and workspace the running daemon actually bound to.
 *
 * Only written under ARENABRIDGE_E2E, and only so an automated test can drive the same daemon
 * the window is showing. It is never written during normal operation, because a token on disk
 * is exactly what keeping it in memory is meant to avoid.
 */
function publishE2eHandshake(workspaceRoot: string): void {
  if (!process.env.ARENABRIDGE_E2E) return;
  const payload = {
    admin_url: daemon?.urls.admin ?? '',
    mcp_url: daemon?.urls.mcp ?? '',
    token: adminToken,
    workspace: workspaceRoot,
    workspace_id: daemon?.workspaces[0]?.id ?? '',
    pid: process.pid,
    published_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(workspaceStateDir, 'e2e-handshake.json'), JSON.stringify(payload, null, 2) + '\n');
}

function readPrefs(): DesktopPrefs {
  try {
    const parsed = JSON.parse(fs.readFileSync(workspaceConfigPath, 'utf8')) as Partial<DesktopPrefs>;
    if (typeof parsed.workspaceRoot === 'string' && parsed.workspaceRoot) {
      return { workspaceRoot: parsed.workspaceRoot, recentRoots: Array.isArray(parsed.recentRoots) ? parsed.recentRoots.slice(0, 12) : [] };
    }
  } catch { /* first run */ }
  // Default to the synthetic fixture so the very first launch has something safe to show.
  const synthetic = path.join(repoRoot, 'outputs', 'synthetic-workspace');
  return { workspaceRoot: synthetic, recentRoots: [] };
}

/**
 * The workspace to open. ARENABRIDGE_WORKSPACE_ROOT lets an automated test point the harness
 * at a scratch copy without touching the operator's saved preference — which matters because
 * the test must not write to the real workspace.
 */
function initialWorkspace(): string {
  const override = process.env.ARENABRIDGE_WORKSPACE_ROOT;
  if (typeof override === 'string' && override.trim()) return path.resolve(override);
  return readPrefs().workspaceRoot;
}

function writePrefs(prefs: DesktopPrefs): void {
  fs.mkdirSync(workspaceStateDir, { recursive: true });
  fs.writeFileSync(workspaceConfigPath, JSON.stringify(prefs, null, 2) + '\n');
}

/** The workspace the running daemon is serving, or the one it would serve next. */
function currentWorkspaceRoot(): string {
  return daemon?.workspaces[0]?.root ?? initialWorkspace();
}

/**
 * True when the running daemon has a remote listener the tunnel can reach. The window shows
 * this so the operator can never be told "connected to Arena" by a bridge that is loopback-only.
 *
 * The daemon reports an absent remote listener as the empty string, and a present one as a real
 * loopback URL — so the test is "does this parse to a port", not "does the string mention
 * mcp_remote". Matching on that literal name would never be true, because the URL the daemon
 * reports is just `http://127.0.0.1:<port>`.
 */
function isExposed(): boolean {
  return portOf(daemon?.urls.mcp_remote) !== undefined;
}

/**
 * Boot the bridge for one workspace root. Each workspace switch restarts the daemon:
 * a workspace is bound to a run immutably, so switching is a new daemon, not a
 * mutation of an existing binding.
 *
 * `exposeHost` is the tunnel hostname to accept remote traffic for. It has to be known at
 * daemon start, because the remote listener's Host allowlist is fixed when the listener is
 * created — so the tunnel is opened first and the daemon is (re)started with its hostname.
 * Without it the daemon comes up loopback-only, which is the default and the safe state.
 *
 * `remotePort` pins the remote listener's port. It must be passed whenever `exposeHost` is, for
 * the reason given at the call site: the port has to be agreed before the tunnel is opened, and
 * an OS-chosen port would not be known until after this restart.
 */
async function startDaemon(workspaceRoot: string, exposeHost?: string, remotePort?: number): Promise<void> {
  if (daemon) { await daemon.close(); daemon = undefined; }
  const stateDir = stateDirPath;
  fs.mkdirSync(stateDir, { recursive: true });
  adminToken = newSecret();
  // A desktop app gets killed without warning: the operator closes the window, or Windows
  // terminates it, or the process crashes. Any of those leaves the state lease behind. The
  // lease check exists to stop two daemons sharing one state directory, which is a real
  // corruption risk — so the answer is not to delete the lock blindly, but to confirm the
  // recorded holder is gone before clearing it.
  clearLeaseIfHolderIsGone(stateDir);
  daemon = await createDaemon({
    schema_version: 1,
    state_directory: stateDir,
    // Port 0 = let the OS pick free ports; the renderer is told where to look, so
    // nothing has to be memorised and nothing collides with a running CLI instance.
    // The remote port is the exception: port 0 would be reassigned on every restart and the
    // tunnel needs to be told a stable number before it opens, so it is pinned when exposing.
    ports: { api: 0, mcp: 0, mcp_remote: exposeHost ? (remotePort ?? 0) : 0, admin: 0 },
    workspaces: [{ root: workspaceRoot, display_name: path.basename(workspaceRoot) || workspaceRoot }],
    response_mode: 'json',
    security_profile: 'local_trusted_development',
    arena_enabled: false,
    remote_ingress: exposeHost ? exposedIngress(exposeHost) : closedIngress(),
    gateway: { type: 'disabled' },
  }, { adminToken, clientToken: newSecret(), mcpToken: newSecret() });
}

/**
 * Removes a stale daemon lease left by a process that is no longer running.
 *
 * The lease records the owning pid. If that pid is alive *and is still the process that wrote
 * the lease*, the lock is real and is left alone so the daemon surfaces its normal "state
 * directory is locked" error. If the holder is gone, the lock cannot be protecting anything and
 * is moved aside with a logged explanation. A lock that cannot be parsed is never removed.
 *
 * Why a bare pid test is not enough: Windows recycles pids. A daemon killed with the window
 * that started it leaves its pid in the lease, and the OS is then free to hand that same number
 * to any later process — in practice, a system service. `process.kill(pid, 0)` on such a
 * service fails with EPERM rather than ESRCH, which reads as "exists but is not ours" and used
 * to mean the harness refused to start forever, with no daemon running and nothing on screen to
 * explain it. The lease therefore also records start-time metadata, checked here so a recycled
 * pid is recognised as a stale lease.
 */
function clearLeaseIfHolderIsGone(stateDir: string): void {
  const lock = path.join(stateDir, 'daemon.lock');
  let raw: string;
  try { raw = fs.readFileSync(lock, 'utf8'); } catch { return; }
  let parsed: { pid?: unknown; pid_started_at?: unknown };
  try { parsed = JSON.parse(raw) as { pid?: unknown; pid_started_at?: unknown }; } catch {
    trace('lease present but unreadable; leaving it in place');
    return;
  }
  const pid = parsed.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    trace('lease present without a usable pid; leaving it in place');
    return;
  }
  // process.kill(pid, 0) sends no signal; it only asks whether the process exists.
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch (error) {
    // ESRCH means no such process, so the lease is stale. EPERM means something exists under
    // that pid but belongs to another user — which is exactly what a recycled pid looks like,
    // so it must be identity-checked rather than trusted.
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') alive = false;
  }
  if (alive) {
    const verdict = holderMatchesLease(pid, parsed.pid_started_at);
    if (verdict === 'different') {
      trace(`lease names pid ${pid}, but that pid now belongs to a different process (recycled); treating the lease as stale`);
    } else if (verdict === 'unknown' && !holderLooksLikeOurDaemon(pid)) {
      // Leases written before start times were recorded cannot be identity-checked. Rather than
      // leaving the window unable to start at all — which is how this was found — fall back to
      // asking whether the pid is even plausibly ours. A node/electron process could be a real
      // daemon and is left alone; anything else (in practice a Windows service holding a
      // recycled pid) is not something ArenaBridge ever runs as.
      trace(`lease names pid ${pid} with no recorded start time, and ${pid} is not a node process; treating the lease as stale`);
    } else {
      // 'same' is a real daemon; 'unknown' cannot be proven either way, and clearing a real lock
      // risks two daemons sharing one state directory. Both keep the conservative behaviour.
      trace(`lease is held by process ${pid}, which is alive but not ours; leaving it in place`);
      return;
    }
  }
  quarantineLease(lock, pid);
}

/**
 * Is the process now holding `pid` the same process that wrote the lease?
 *
 * Delegates to the shared identity check so the lease writer (the daemon) and the lease
 * validator (this process) can never disagree about what identity means.
 */
function holderMatchesLease(pid: number, expected: unknown): 'same' | 'different' | 'unknown' {
  return sameProcessAs(pid, expected);
}

/**
 * Is `pid` plausibly an ArenaBridge daemon, based on the executable name?
 *
 * Only used as a fallback for leases that predate start-time recording. ArenaBridge runs as a
 * node process (the CLI) or an electron process (the desktop harness), so a pid whose image is
 * neither cannot be the daemon the lease claims to protect. Returns true when the name cannot
 * be read, so an unreadable name keeps the conservative behaviour.
 */
function holderLooksLikeOurDaemon(pid: number): boolean {
  const queried = process.platform === 'win32' ? windowsImageName(pid) : posixImageName(pid);
  if (queried === undefined) return true;
  return /^(node|electron)(\.exe)?$/i.test(queried);
}

function windowsImageName(pid: number): string | undefined {
  const script = `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).ProcessName`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
  const name = (result.stdout ?? '').trim();
  return name ? name : undefined;
}

function posixImageName(pid: number): string | undefined {
  const result = spawnSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 8000 });
  const name = (result.stdout ?? '').trim();
  return name ? path.basename(name) : undefined;
}

/** Move a stale lease aside. Never delete: a rename preserves the evidence atomically. */
function quarantineLease(lock: string, pid: number): void {
  const quarantine = path.join(path.dirname(lock), 'daemon.lock.orphaned');
  try {
    fs.renameSync(lock, quarantine);
  } catch (error) {
    trace(`could not move the stale lease ${lock} aside: ${String((error as Error)?.message ?? error)}`);
    return;
  }
  trace(`moved a stale state lease left by exited process ${pid} to daemon.lock.orphaned`);
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: '#14161a',
    show: false,
    title: 'ArenaBridge',
    autoHideMenuBar: true,
    webPreferences: {
      preload: assetPaths.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  window.once('ready-to-show', () => window?.show());
  window.on('closed', () => { window = undefined; });
  // The harness is a local tool; never let it navigate anywhere but its own page.
  window.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: 'deny' }; });
  void window.loadFile(assetPaths.page, selfTest ? { query: { selfTest: '1' } } : undefined);
  // In self-test mode the renderer must be allowed to fail loudly rather than silently
  // showing an empty shell, so surface every console message and load failure.
  if (selfTest) {
    window.webContents.on('console-message', (_event, level, message) => {
      console.log(`[renderer:${level}] ${message}`);
    });
    window.webContents.on('did-fail-load', (_event, code, description) => {
      console.error(`[renderer] the page failed to load: ${description} (${code})`);
    });
  }
}

/** A real application menu: the accelerator set an IDE-like tool is expected to have. */
function buildMenu(): void {
  const send = (channel: string) => () => window?.webContents.send(channel);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [
        { label: '打开工作目录…', accelerator: 'CmdOrCtrl+O', click: send('menu:open-workspace') },
        { label: '刷新', accelerator: 'CmdOrCtrl+R', click: send('menu:refresh') },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', role: 'quit' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '待办', accelerator: 'CmdOrCtrl+1', click: send('menu:view-pending') },
        { label: '活动', accelerator: 'CmdOrCtrl+2', click: send('menu:view-activity') },
        { label: '文件', accelerator: 'CmdOrCtrl+3', click: send('menu:view-files') },
        { type: 'separator' },
        { label: '切换开发者工具', accelerator: 'F12', role: 'toggleDevTools' },
        { label: '重新加载', click: send('menu:refresh') },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 ArenaBridge',
          click: () => {
            void dialog.showMessageBox({
              type: 'info', title: '关于 ArenaBridge', message: 'ArenaBridge 桌面 Harness',
              detail: '远端的模型只能请求；动手的永远是你。\n所有写操作都需要在本窗口内逐次批准。',
            });
          },
        },
      ],
    },
  ]));
}

// --- IPC: the renderer never talks to the daemon's HTTP surface directly. It asks the
// --- main process, which holds the credential. That keeps the token out of the page.

ipcMain.handle('bootstrap', () => ({
  adminUrl: daemon?.urls.admin ?? '',
  apiUrl: daemon?.urls.api ?? '',
  mcpUrl: daemon?.urls.mcp ?? '',
  token: adminToken,
  prefs: { ...readPrefs(), workspaceRoot: initialWorkspace() },
  version: app.getVersion(),
}));

ipcMain.handle('workspace:choose', async () => {
  const result = await dialog.showOpenDialog(window!, { properties: ['openDirectory'], title: '选择工作目录' });
  if (result.canceled || !result.filePaths[0]) return { changed: false };
  return switchWorkspace(result.filePaths[0]);
});

ipcMain.handle('workspace:set', async (_event, root: string) => {
  if (typeof root !== 'string' || !root.trim()) return { changed: false, error: '路径为空' };
  return switchWorkspace(root);
});

async function switchWorkspace(root: string): Promise<{ changed: boolean; error?: string }> {
  const resolved = path.resolve(root);
  try {
    if (!fs.statSync(resolved).isDirectory()) return { changed: false, error: '不是一个目录' };
  } catch { return { changed: false, error: '目录不存在：' + resolved }; }
  const prefs = readPrefs();
  prefs.recentRoots = [resolved, ...prefs.recentRoots.filter((r) => r !== resolved)].slice(0, 12);
  prefs.workspaceRoot = resolved;
  // The previous root, captured before anything is torn down. startDaemon() closes the running
  // daemon first, so a failed switch would otherwise leave the window with NO bridge at all —
  // worse than not switching, because the tree, the pending list and the event log all stop
  // updating with no explanation.
  const previousRoot = daemon?.workspaces[0]?.root;
  try {
    // Only record the new root once the daemon has actually bound to it. Writing it first means
    // a failed start leaves the window claiming a workspace the bridge is not serving, and the
    // next launch would retry the same broken directory with no record of what went wrong.
    await startDaemon(resolved);
  } catch (error) {
    // Surface the reason instead of letting the promise reject. A rejected ipcMain.handle
    // reaches the renderer as `Error occurred in handler for 'workspace:choose'`, which tells
    // the operator nothing — that is exactly how the "immutable run binding" failure presented
    // before it was fixed.
    const detail = String((error as Error)?.message ?? error);
    trace(`workspace switch to ${resolved} failed: ${detail}`);
    let recovered = false;
    if (previousRoot && previousRoot !== resolved) {
      // Best effort: put the operator back on the root that was working. If even that fails the
      // window is left bridgeless, and the message says so rather than implying a working state.
      try {
        await startDaemon(previousRoot);
        writePrefs({ ...prefs, workspaceRoot: previousRoot });
        publishE2eHandshake(previousRoot);
        recovered = true;
      } catch (restoreError) {
        trace(`restoring ${previousRoot} also failed: ${String((restoreError as Error)?.message ?? restoreError)}`);
      }
    }
    return {
      changed: false,
      error: recovered
        ? `切换失败：${detail}（已保留原来的工作目录）`
        : `切换失败：${detail}`,
    };
  }
  writePrefs(prefs);
  // The automated test drives whichever daemon the window is showing, and it reads the
  // endpoints from the handshake. Without republishing, a switch would leave the test talking
  // to the previous workspace's ports and quietly exercising the wrong daemon.
  publishE2eHandshake(resolved);
  return { changed: true };
}

ipcMain.handle('reveal', (_event, target: string) => {
  if (typeof target === 'string' && fs.existsSync(target)) shell.showItemInFolder(target);
});

// --- Arena: exposing the workspace to a remote agent ---------------------------------
//
// The whole flow lives in this process, not in the renderer, because it starts a child
// process, copies to the clipboard and restarts the daemon — none of which the renderer is
// allowed to do. The renderer only asks for it and displays the result.
//
// Every step is reversible and every step that matters is confirmed in the window first:
// nothing is exposed until the operator has read what exposure means and accepted it.

/** The live tunnel. Only one at a time; the tunnel is torn down when the window closes. */
let tunnel: { url: string; host: string; child: { kill: (signal?: NodeJS.Signals) => boolean } } | undefined;
/** Set while a pairing is outstanding, so the window can show the code without re-creating it. */
let activePairing: { code: string; pairId: string; workspaceId: string; expiresAt: number; recipient: string; accessMode: AccessMode; grantTtlMs: number } | undefined;

/**
 * Copies text to the Windows clipboard through PowerShell, then reads it back and compares.
 *
 * `clip.exe` reads stdin using the console code page (GBK on a zh-CN machine) and converts
 * UTF-8 to mojibake while still exiting 0, which is why it is not used. The read-back is not
 * paranoia either: a silently mangled prompt is worse than no prompt, because the operator
 * only finds out after pasting it into Arena.
 */
function copyToClipboard(text: string): { ok: boolean; reason?: string } {
  const run = (command: string) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  const source = path.join(workspaceStateDir, 'arena-prompt.txt');
  fs.writeFileSync(source, text, 'utf8');
  const quote = (value: string) => value.replace(/'/g, "''");
  const set = run(`Set-Clipboard -Value (Get-Content -Raw -Encoding UTF8 -LiteralPath '${quote(source)}')`);
  if (set.status !== 0) return { ok: false, reason: `Set-Clipboard exit ${set.status}` };
  const readback = path.join(workspaceStateDir, 'clipboard-readback.txt');
  if (run(`Get-Clipboard -Raw | Set-Content -LiteralPath '${quote(readback)}' -Encoding UTF8`).status !== 0) return { ok: false, reason: 'could not read the clipboard back' };
  let actual = '';
  try { actual = fs.readFileSync(readback, 'utf8').replace(/^\uFEFF/, ''); }
  catch (error) { return { ok: false, reason: String((error as Error)?.message ?? error) }; }
  return actual.replace(/\r\n/g, '\n').trimEnd() === text.replace(/\r\n/g, '\n').trimEnd()
    ? { ok: true }
    : { ok: false, reason: '剪贴板内容与提示词不一致（编码问题）' };
}

/**
 * The explicit, per-session confirmation. It is a modal dialog rather than an inline
 * checkbox because the consequence is not a setting: it publishes the workspace to the
 * public internet for as long as the window is open.
 */
async function confirmExposure(workspaceRoot: string, accessMode: AccessMode): Promise<boolean> {
  const modeLine = accessMode === 'exec'
    // The one tier whose consequence is not "it can change files": with command execution there is
    // no approval step and no sandbox, so the dialog says so in those words rather than describing
    // it as an extension of write access.
    ? '访问模式：可写 + 可执行命令（exec）——远端可以直接在这台机器上跑 shell 命令，'
      + '**没有批准这一步**，用的是你的账户权限（工作目录被限制在下面这个目录内，有超时与输出上限）。'
      + '写盘仍需你批准（除非同时开着无人值守写入）。'
    : accessMode === 'code'
    ? '访问模式：可写（code）——远端可以提交改动预览，但每次真正写盘前你都要在「待办」里单独批准一次。'
    : `访问模式：只读（${accessMode}）——远端只能读，任何写操作都会被拒绝。`;
  const { response } = await dialog.showMessageBox(window!, {
    type: 'warning',
    buttons: ['取消', '我知道风险，开始暴露'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: '把工作目录暴露到公网？',
    message: '接下来这个目录会被公网上的远端 Agent 读到',
    detail: [
      `要暴露的目录：\n${workspaceRoot}`,
      '',
      modeLine,
      '',
      '三件事必须知道：',
      '1. 隧道由 Cloudflare 终止 TLS，Cloudflare 能看到 MCP 明文（文件名、文件内容、diff）。',
      '2. Arena 官方声明 Agent Mode 的数据会进入公开排行榜。',
      '3. 内容是给远端模型看的：只要授权还在，它就能读这个目录下任何没被策略拒绝的文件。',
      '',
      '只对合成/无隐私目录这么做。关掉窗口就会立刻断开隧道。',
    ].join('\n'),
  });
  return response === 1;
}

/**
 * Opens the tunnel, restarts the daemon with the tunnel hostname allowed, creates the
 * one-time pairing code and returns the paste-ready prompt.
 *
 * Failure is reported as data, never thrown: a rejected ipcMain.handle reaches the renderer
 * as `Error occurred in handler for 'arena:connect'`, which tells the operator nothing.
 */
async function connectArena(accessMode: AccessMode = 'ask'): Promise<Record<string, unknown>> {
  if (tunnel) return { ok: false, error: '隧道已经开着。先断开再重连。' };
  const workspaceRoot = currentWorkspaceRoot();
  if (!(await confirmExposure(workspaceRoot, accessMode))) return { ok: false, cancelled: true };

  // Which port the tunnel should forward to.
  //
  // The remote listener only exists while the daemon is in exposed mode, and its port is chosen
  // by the OS (`mcp_remote: 0`) every time the daemon restarts — so at the moment the operator
  // clicks Connect there is no port to read, and reading one produced an empty string that threw
  // out of this handler. Waiting for a port is not an option either: the daemon needs the tunnel
  // hostname before it can bind the listener, and the hostname only exists after the tunnel is
  // up. Both halves therefore have to agree on the port up front, so it is pinned here and the
  // restart below is told to bind it. cloudflared tolerates the origin being down while it
  // starts, which is what makes this ordering possible.
  const remotePort = await reserveRemotePort();
  if (remotePort === undefined) {
    return {
      ok: false,
      error: '无法为远端监听器选定端口，隧道没有建立。',
      hint: 'no free loopback port could be reserved',
    };
  }

  try {
    trace('arena: starting the cloudflare tunnel');
    // The writer refuses to run the tunnel at all unless it was confirmed, so this call is
    // only reached once the operator has accepted the dialog above.
    //
    // The path is built from repoRoot, NOT written as a relative specifier. `scripts/` sits
    // beside `dist/`, and this file is compiled into `dist/apps/desktop/src/`, so a relative
    // `../../../scripts/...` would resolve to `dist/scripts/...` at runtime — a directory that
    // does not exist — and the import would fail with MODULE_NOT_FOUND the moment the operator
    // pressed Connect. Anchoring on repoRoot is how every other asset in this file is located.
    // The `.mjs` writer has no type declarations and is not part of the TS build, so the
    // import is left untyped and narrowed here rather than asserted into silence.
    const tunnelWriterPath = path.join(repoRoot, 'scripts', 'tunnel-cloudflared.mjs');
    if (!fs.existsSync(tunnelWriterPath)) {
      return {
        ok: false,
        error: '缺少隧道脚本，隧道没有建立。',
        hint: `expected the tunnel writer at ${tunnelWriterPath}`,
      };
    }
    const { startCloudflareTunnel } = await import(pathToFileURL(tunnelWriterPath).href) as {
      startCloudflareTunnel: (port: number, options?: { timeoutMs?: number; attempts?: number }) => Promise<
        { ok: true; url: string; child: { kill: (signal?: NodeJS.Signals) => boolean }; output?: string } | { ok: false; reason: string; hint?: string; output?: string }>;
    };
    const result = await startCloudflareTunnel(remotePort, { timeoutMs: 90000 });
    if (!result.ok) {
      return {
        ok: false,
        error: `隧道建立失败：${result.reason}`,
        hint: result.hint ?? (result.output ? result.output.slice(-300) : undefined),
      };
    }
    // `ok: true` is not proof of a usable URL. The writer is plain JS outside the TypeScript
    // build, so its return value is unvalidated at the type level, and a malformed-but-truthy
    // url would otherwise throw a bare `Invalid URL` out of the IPC handler — reaching the
    // operator as "Error occurred in handler for 'arena:connect'", which explains nothing.
    // Validate the shape here so a bad value is reported as a tunnel problem instead.
    const parsedUrl = parseTunnelUrl(result.url);
    if (!parsedUrl) {
      await disconnectArena().catch(() => undefined);
      trace(`arena: the tunnel reported success without a usable url: ${JSON.stringify(result.url ?? null)}`);
      return {
        ok: false,
        error: '隧道已建立但没有返回可用的地址，已断开以避免留下一个对外暴露的 bridge。',
        hint: result.output ? result.output.slice(-300) : undefined,
      };
    }
    const host = parsedUrl.hostname;
    tunnel = { url: parsedUrl.url, host, child: result.child };

    // Now the daemon can accept traffic for that hostname. This is a restart, so the admin
    // token changes; the renderer re-reads it from bootstrap().
    trace(`arena: restarting the bridge with remote host ${host}`);
    await startDaemon(workspaceRoot, host, remotePort);
    publishE2eHandshake(workspaceRoot);

    const workspaceId = daemon!.workspaces[0]!.id;
    const recipient = 'Arena Agent (desktop window)';
    // The mode is fixed on the pairing record here and cannot be raised later: the daemon
    // refuses any request above it (403), and refuses an approval above what was requested.
    // So the operator's choice must reach all three places — the code, the prompt and the
    // approval — or the remote silently ends up with less than the operator believes.
    const pairing = await createPairing(workspaceId, recipient, accessMode);
    activePairing = { code: pairing.code, pairId: pairing.pair_id, workspaceId, expiresAt: pairing.expires_at, recipient, accessMode, grantTtlMs: pairing.grant_ttl_ms };
    // Logged from here rather than at the IPC boundary so the trace shows the mode that actually
    // went into the code, the prompt and the pairing record — the three places that must agree.
    trace(`arena: minting the pairing code with access mode ${accessMode}`);

    // The unattended-write switch is read straight from the daemon, so the prompt describes the
    // posture that is actually in force rather than what this function assumed. If it is on, the
    // prompt must not tell the agent to stop and wait for an approval that will never come.
    const autoApprove = await readAutoApprove();
    const prompt = buildArenaPrompt({
      publicUrl: result.url,
      pairingCode: pairing.code,
      workspaceRoot,
      recipient,
      accessMode,
      autoApproveWrites: autoApprove.enabled,
      autoApproveExpiresAt: autoApprove.expiresAt ?? undefined,
      autoApproveUnlimited: autoApprove.unlimited,
      grantTtlMs: pairing.grant_ttl_ms,
    });
    const clipboard = copyToClipboard(prompt);
    trace(`arena: ready at ${result.url} mode=${accessMode} unattended=${autoApprove.enabled}${autoApprove.unlimited ? ' (no expiry)' : ''} (clipboard ${clipboard.ok ? 'verified' : 'NOT verified'})`);
    return {
      ok: true,
      publicUrl: result.url,
      tunnelHost: host,
      pairingCode: pairing.code,
      pairId: pairing.pair_id,
      expiresAt: pairing.expires_at,
      workspaceRoot,
      accessMode,
      autoApproveWrites: autoApprove.enabled,
      autoApproveExpiresAt: autoApprove.expiresAt,
      autoApproveUnlimited: autoApprove.unlimited,
      promptPath: path.join(workspaceStateDir, 'arena-prompt.txt'),
      clipboardOk: clipboard.ok,
      clipboardReason: clipboard.reason,
    };
  } catch (error) {
    // Anything that fails after the tunnel came up must not leave it running: an exposed
    // bridge the operator believes is closed is the worst outcome of all.
    await disconnectArena().catch(() => undefined);
    const detail = String((error as Error)?.message ?? error);
    trace(`arena: connect failed: ${detail}`);
    return { ok: false, error: detail };
  }
}

/**
 * Pick a free loopback port to bind the remote MCP listener on, before the tunnel opens.
 *
 * Binding port 0 and closing the socket is inherently racy — another process could take the
 * port in the gap — but the alternative is worse: the daemon would choose the port only after
 * it restarts with the hostname, by which point the tunnel has already been told where to
 * forward. The gap here is milliseconds and the port is only ever bound on loopback, so a
 * collision surfaces as a normal "state directory is locked"-style daemon start error rather
 * than as a silently broken tunnel.
 */
function reserveRemotePort(): Promise<number | undefined> {
  // `listen` is asynchronous, so the address is only available once the listening callback
  // fires, and the socket must actually be closed before returning — otherwise the daemon can
  // try to bind a port this process still holds.
  return new Promise((resolve) => {
    const probe = createServer();
    const giveUp = () => { try { probe.close(); } catch { /* already closed */ } resolve(undefined); };
    probe.once('error', giveUp);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      probe.close(() => resolve(typeof port === 'number' && port > 0 ? port : undefined));
    });
  });
}

/**
 * Creates the one-time invitation through the daemon's own admin API, never directly.
 *
 * `maxAccess` is the ceiling the code carries. The daemon rejects any request above it with
 * a 403 and offers no way to raise it afterwards, so this value decides — permanently, for
 * this code — whether the remote can ever do anything but read.
 */
/** How long the one-time pairing code itself is valid. It is an invitation, not access. */
const PAIRING_CODE_TTL_MS = 1800000;
/**
 * How long the credential the remote ends up holding stays valid: 0 = no wall-clock expiry, i.e.
 * "as long as this bridge session lasts".
 *
 * A fixed hour here was the wrong shape. The credential is already bound to the daemon epoch,
 * which rotates on every start, so it cannot outlive the session anyway — closing the window,
 * disconnecting, switching workspace or revoking all end it. All the hour did was stop a
 * long-running task in the middle, at a moment nothing on either side could explain, and the
 * operator's only recourse was to re-pair. See `GRANT_NO_EXPIRY_AT` in the policy engine.
 */
const GRANT_TTL_MS = 0;

async function createPairing(workspaceId: string, recipient: string, maxAccess: AccessMode): Promise<{ code: string; pair_id: string; expires_at: number; grant_ttl_ms: number }> {
  // Via `adminRequest` because re-issuing a code happens after an arbitrary idle period — the
  // exact case where the pooled socket may already be gone (see the helper).
  const response = await adminRequest('/admin/v1/pairings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // `grant_ttl_ms: 0` = session-scoped. Sent explicitly rather than omitted so the request
    // says what it means; the schema accepts either.
    body: JSON.stringify({ workspace_id: workspaceId, recipient, max_access: maxAccess, ttl_ms: PAIRING_CODE_TTL_MS, grant_ttl_ms: GRANT_TTL_MS }),
  });
  const body = await response.json() as { code?: string; pair_id?: string; expires_at?: number; error?: { code?: string; message?: string } };
  if (!response.ok || typeof body.code !== 'string' || typeof body.pair_id !== 'string') {
    throw new Error(`创建配对失败：HTTP ${response.status} ${body?.error?.code ?? ''} ${body?.error?.message ?? ''}`.trim());
  }
  // Returned so the prompt can state the grant's lifetime. It is a different clock from the
  // unattended-write window, and a remote that is not told about it treats the expiry as a
  // broken bridge — which is exactly what happened on a real run.
  return { code: body.code, pair_id: body.pair_id, expires_at: Number(body.expires_at ?? 0), grant_ttl_ms: GRANT_TTL_MS };
}

/**
 * Reads the unattended-write switch from the daemon.
 *
 * Never throws: this is consulted while building the prompt, and a failure to read it must not
 * abort a connection that is otherwise fine. It reports "off" when it cannot tell, because the
 * safe reading of an unknown posture is the supervised one — the prompt would then tell the agent
 * to wait for an approval, which is merely slower, rather than promising it writes freely.
 */
/**
 * A request to our own daemon that survives one dead pooled connection.
 *
 * Node closes idle keep-alive sockets after 5s. When the window has been busy elsewhere (a
 * tunnel handshake, a patch approval, a long render) the next request can be handed a socket the
 * daemon has already closed, and undici surfaces that as a bare `TypeError: fetch failed` with
 * `cause: ECONNRESET` — measured on this machine, roughly one run in three, on the very first
 * request after a multi-second gap. The dead socket is dropped from the pool when that happens,
 * so a single retry opens a fresh one.
 *
 * This matters most on the *off* direction: a failed read of the unattended-write switch is
 * merely reported as "off", but a failed clear would leave the switch on after the session that
 * justified it has ended. `cause` is checked so a real HTTP error is never retried as if it were
 * a transport fault.
 */
async function adminRequest(pathname: string, init: RequestInit = {}): Promise<Response> {
  const url = `${daemon!.urls.admin}${pathname}`;
  const options: RequestInit = { ...init, headers: { Authorization: `Bearer ${adminToken}`, ...(init.headers ?? {}) } };
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(5000) });
  } catch (error) {
    const cause = (error as { cause?: { code?: string } })?.cause?.code;
    if (cause !== 'ECONNRESET' && cause !== 'ECONNREFUSED' && cause !== 'EPIPE') throw error;
    trace(`admin request to ${pathname} hit a dead pooled socket (${cause}); retrying once`);
    return await fetch(url, { ...options, signal: AbortSignal.timeout(5000) });
  }
}

async function readAutoApprove(): Promise<{ enabled: boolean; expiresAt: number | null; unlimited: boolean }> {
  try {
    const response = await adminRequest('/admin/v1/auto-approve');
    if (!response.ok) return { enabled: false, expiresAt: null, unlimited: false };
    const body = await response.json() as { enabled?: boolean; expires_at?: number | null; unlimited?: boolean };
    return {
      enabled: body.enabled === true,
      expiresAt: typeof body.expires_at === 'number' ? body.expires_at : null,
      // Only a daemon that says so counts. A missing field is not "unlimited" — that reading would
      // let an older/incompatible daemon make the prompt promise a window nothing enforces.
      unlimited: body.enabled === true && body.unlimited === true,
    };
  } catch {
    return { enabled: false, expiresAt: null, unlimited: false };
  }
}

/**
 * Switches unattended writes off, best effort and never fatal.
 *
 * The switch is stored in the daemon's state directory, so it outlives the window unless
 * someone turns it off. For a time-boxed window that is survivable — the deadline still stops
 * it. For an *unlimited* window there is no second line of defence at all: the operator closes
 * the window, the bridge stops, and the next launch silently resumes approving writes for
 * whatever remote pairs next. That is precisely the inheritance the feature promises not to
 * have, so the guarantee is enforced here, on every path that ends a session, rather than in a
 * click handler the operator may never reach (closing the window does not run it).
 *
 * Cleared before the daemon is torn down or restarted, because after that there is nothing
 * left to talk to.
 */
async function clearUnattendedWrites(reason: string): Promise<void> {
  if (!daemon || !adminToken) return;
  try {
    const response = await adminRequest('/admin/v1/auto-approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    trace(`arena: unattended writes cleared (${reason}) http=${response.status}`);
  } catch (error) {
    // A failure here must never stop the shutdown, and must never be silent either: the whole
    // point of the call is that "off" is the safe direction, so an unclear outcome is reported
    // as a warning rather than retried or assumed.
    trace(`arena: could not clear unattended writes on ${reason}: ${String((error as Error)?.message ?? error)}`);
  }
}

/** Closes the tunnel and puts the daemon back to loopback-only. Safe to call when idle. */
async function disconnectArena(): Promise<boolean> {
  const had = !!tunnel;
  if (tunnel) {
    try { tunnel.child.kill(); } catch { /* already gone */ }
    tunnel = undefined;
  }
  activePairing = undefined;
  if (had) {
    // Ending the exposed session ends the unattended window with it. The renderer also does
    // this before calling disconnect, but a tunnel that dies on its own (or a connect that
    // fails halfway and unwinds through here) must not leave the switch behind.
    await clearUnattendedWrites('disconnect');
    // Put the bridge back to loopback-only rather than leaving the remote listener up. The
    // port would be unreachable without the tunnel, but "unreachable" is a property of the
    // network, not of our config, and the config is what we control.
    trace('arena: tunnel closed, restoring loopback-only bridge');
    await startDaemon(currentWorkspaceRoot());
    publishE2eHandshake(currentWorkspaceRoot());
  }
  return had;
}

/**
 * Mints a fresh pairing code for the tunnel that is already open, and copies the new prompt.
 *
 * The grant a remote receives is deliberately short-lived and it starts counting when the
 * remote claims it, so a long session outlives its own credential. Without this, continuing
 * meant tearing the tunnel down and rebuilding it — a new public URL, another exposure
 * confirmation, another prompt — which is a lot of ceremony for "the hour is up". Nothing about
 * the exposure changes here: same tunnel, same workspace, same access mode, same confirmation
 * that was already given for this session. Only the code, and therefore the credential it leads
 * to, is new.
 */
async function reissuePairing(): Promise<Record<string, unknown>> {
  if (!tunnel || !activePairing) return { ok: false, error: '当前没有进行中的隧道，先开启隧道。' };
  const { workspaceId, recipient, accessMode } = activePairing;
  try {
    const pairing = await createPairing(workspaceId, recipient, accessMode);
    activePairing = { ...activePairing, code: pairing.code, pairId: pairing.pair_id, expiresAt: pairing.expires_at, grantTtlMs: pairing.grant_ttl_ms };
    const autoApprove = await readAutoApprove();
    const prompt = buildArenaPrompt({
      publicUrl: tunnel.url, pairingCode: pairing.code,
      workspaceRoot: currentWorkspaceRoot(), recipient, accessMode,
      grantTtlMs: pairing.grant_ttl_ms,
      autoApproveWrites: autoApprove.enabled,
      autoApproveExpiresAt: autoApprove.expiresAt ?? undefined,
      autoApproveUnlimited: autoApprove.unlimited,
    });
    const clipboard = copyToClipboard(prompt);
    trace(`arena: reissued a pairing code, mode=${accessMode} (clipboard ${clipboard.ok ? 'verified' : 'NOT verified'})`);
    return {
      ok: true, pairingCode: pairing.code, pairId: pairing.pair_id, expiresAt: pairing.expires_at,
      accessMode, grantTtlMs: pairing.grant_ttl_ms,
      clipboardOk: clipboard.ok, clipboardReason: clipboard.reason,
      promptPath: path.join(workspaceStateDir, 'arena-prompt.txt'),
    };
  } catch (error) {
    // Reported as data for the same reason `connectArena` does: a rejected ipcMain.handle
    // reaches the renderer as an opaque "Error occurred in handler for ...".
    return { ok: false, error: String((error as Error)?.message ?? error) };
  }
}

/**
 * Re-copies the prompt for the pairing that is still outstanding.
 *
 * It re-reads the unattended-write switch instead of reusing whatever was true when the tunnel
 * opened. The switch can be turned on *after* connecting, and this button is the natural thing
 * to press right after doing so — a prompt rebuilt from stale state would keep telling the
 * remote that every write waits for a local approval while the daemon is in fact letting them
 * through, which is the one contradiction this prompt must never contain.
 */
async function copyPromptAgain(): Promise<{ ok: boolean; reason?: string; error?: string }> {
  if (!tunnel || !activePairing) return { ok: false, error: '当前没有进行中的隧道/配对。' };
  const autoApprove = await readAutoApprove();
  const prompt = buildArenaPrompt({
    publicUrl: tunnel.url, pairingCode: activePairing.code,
    workspaceRoot: currentWorkspaceRoot(), recipient: activePairing.recipient,
    accessMode: activePairing.accessMode,
    grantTtlMs: activePairing.grantTtlMs,
    autoApproveWrites: autoApprove.enabled,
    autoApproveExpiresAt: autoApprove.expiresAt ?? undefined,
    autoApproveUnlimited: autoApprove.unlimited,
  });
  return copyToClipboard(prompt);
}

const ACCESS_MODES: AccessMode[] = ['ask', 'plan', 'code', 'exec'];
/** Anything the renderer sends is untrusted input; an unknown mode falls back to the safe one. */
function normaliseAccessMode(value: unknown): AccessMode {
  return ACCESS_MODES.includes(value as AccessMode) ? value as AccessMode : 'ask';
}

ipcMain.handle('arena:connect', async (_event, accessMode?: unknown) => {
  // Recorded before `connectArena` does anything: the self test fires this call without awaiting
  // it (see the note on `selfTestRequestedMode`), so the tunnel and the confirmation dialog must
  // not be able to delay or prevent the observation.
  if (selfTest) selfTestRequestedMode = normaliseAccessMode(accessMode);
  return connectArena(normaliseAccessMode(accessMode));
});
ipcMain.handle('arena:disconnect', async () => ({ ok: true, wasOpen: await disconnectArena() }));
/**
 * Unattended writes. GET is polled by the panel so its banner stays honest; POST toggles it.
 *
 * The daemon is the authority on whether this is on (it enforces the expiry on every write), so
 * this only forwards. Enabling is deliberately routed through the daemon rather than stored in
 * the window: otherwise a window that believed the switch was on could disagree with a daemon
 * that had already expired it.
 */
ipcMain.handle('arena:auto-approve', async (_event, enabled?: unknown, ttlMs?: unknown) => {
  if (enabled === undefined) return readAutoApprove();
  if (!daemon || !adminToken) throw new Error('bridge 尚未启动，无法切换无人值守写入');
  // 0 (or a non-number) means no expiry. This is forwarded verbatim rather than defaulted to a
  // duration: silently substituting a deadline the operator did not pick is the one thing this
  // path must not do, and the daemon rejects genuinely malformed values.
  const ttl = typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : 0;
  const response = await adminRequest('/admin/v1/auto-approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(enabled === true ? { enabled: true, ttl_ms: ttl, confirm: true } : { enabled: false }),
  });
  const body = await response.json() as { enabled?: boolean; expires_at?: number | null; unlimited?: boolean; error?: { message?: string } };
  if (!response.ok) throw new Error(`切换无人值守写入失败：HTTP ${response.status} ${body?.error?.message ?? ''}`.trim());
  const unlimited = body.enabled === true && body.unlimited === true;
  trace(`arena: unattended writes ${body.enabled ? (unlimited ? 'ENABLED with no expiry' : `ENABLED until ${new Date(Number(body.expires_at)).toISOString()}`) : 'disabled'}`);
  return { enabled: body.enabled === true, expiresAt: typeof body.expires_at === 'number' ? body.expires_at : null, unlimited };
});
ipcMain.handle('arena:copy-prompt', () => copyPromptAgain());
ipcMain.handle('arena:reissue-pairing', () => reissuePairing());
ipcMain.handle('arena:state', () => ({
  open: !!tunnel,
  publicUrl: tunnel?.url ?? '',
  tunnelHost: tunnel?.host ?? '',
  pairingCode: activePairing?.code ?? '',
  expiresAt: activePairing?.expiresAt ?? 0,
  accessMode: activePairing?.accessMode ?? '',
  // The grant's own lifetime, so the panel can say it out loud instead of letting the operator
  // discover it when a long session stops working. It starts at claim time, which is why this is
  // reported as a duration rather than as a deadline.
  grantTtlMs: activePairing?.grantTtlMs ?? 0,
  workspaceRoot: currentWorkspaceRoot(),
  exposed: isExposed(),
  promptPath: path.join(workspaceStateDir, 'arena-prompt.txt'),
}));

/**
 * Writes or removes a probe file inside the current workspace, for the self test only.
 *
 * The renderer cannot touch the filesystem, and the daemon has no direct admin write endpoint —
 * writes are supposed to go through apply_patch plus a local approval. That is exactly why the
 * self test needs this hook: to prove the file tree tracks the disk, something has to change the
 * disk out from under it, and doing that here reproduces what a remote write looks like after it
 * lands. Guarded on `selfTest` so it is unreachable in a normal window, and confined to the
 * workspace root so it can never remove or overwrite anything the fixture does not own.
 */
ipcMain.handle('selftest:fixture', async (_event, action?: unknown, name?: unknown) => {
  if (!selfTest) throw new Error('the fixture hook is only available under --self-test');
  // The fixture only ever creates and deletes its own probe entries: no traversal, no absolute
  // paths, and a fixed prefix, so a caller cannot aim this at a real file. Three shapes, all of
  // them self-test names:
  //   selftest-refresh-<id>.txt          a file at the workspace root
  //   selftest-dir-<id>                  a directory
  //   selftest-dir-<id>/inner.txt        one file inside that directory
  // The directory shape exists because the tree's folder branch was never exercised: the shared
  // fixture is flat, so a renderer that treated every folder as a file still passed every check.
  if (typeof name !== 'string') throw new Error(`refusing to touch ${JSON.stringify(name ?? null)}: not a self-test probe path`);
  const isProbeFile = /^selftest-refresh-[A-Za-z0-9-]+\.txt$/.test(name);
  const isProbeDir = /^selftest-dir-[A-Za-z0-9-]+$/.test(name);
  const isProbeInner = /^selftest-dir-[A-Za-z0-9-]+\/inner\.txt$/.test(name);
  if (!(isProbeFile || isProbeDir || isProbeInner)) {
    throw new Error(`refusing to touch ${JSON.stringify(name)}: not a self-test probe path`);
  }
  const target = path.join(currentWorkspaceRoot(), name);
  if (action === 'create') {
    if (isProbeDir) fs.mkdirSync(target, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, isProbeFile ? 'auto-refresh probe\n' : 'inner probe\n', 'utf8');
    }
  } else if (action === 'delete') {
    // The directory is removed recursively, so deleting it also removes anything inside — the
    // caller does not have to remember the order, and a leftover cannot poison a later suite.
    if (isProbeDir) fs.rmSync(target, { recursive: true, force: true });
    else fs.rmSync(target, { force: true });
  } else throw new Error(`unknown fixture action ${JSON.stringify(action ?? null)}`);
  return { ok: true, action, name };
});

/**
 * Closes the daemon without letting any shutdown failure change the process outcome.
 *
 * Releasing the state lease deletes daemon.lock, and that delete can be refused by the host
 * environment's file-safety guard. That refusal is not a harness failure — the lease is
 * cleaned up on the next start by clearLeaseIfHolderIsGone() — so it must never turn an
 * otherwise successful run into a non-zero exit.
 */
async function closeDaemonQuietly(): Promise<void> {
  // The tunnel goes first and unconditionally. If it outlived the window, the workspace would
  // stay reachable on the public internet with nothing left to approve anything.
  if (tunnel) {
    try { tunnel.child.kill(); trace('tunnel closed on shutdown'); }
    catch (error) { trace('tunnel close reported: ' + String((error as Error)?.message ?? error)); }
    tunnel = undefined;
  }
  // Closing the window stops the bridge, so it ends the session's write posture with it. An
  // unlimited unattended window would otherwise be the one piece of that session the next
  // launch inherits — with no deadline left to stop it.
  await clearUnattendedWrites('shutdown');
  try { await daemon?.close(); }
  catch (error) { trace('daemon close reported: ' + String((error as Error)?.message ?? error)); }
  daemon = undefined;
}

// --- self test: proves the window renders live bridge data, then exits ---
// A window that opens but shows nothing is indistinguishable from a healthy one when all
// you have is "the process started". This makes the difference checkable.
let selfTestFinished = false;
/**
 * The access mode the self test asked for, captured before any tunnel work begins. The renderer
 * cannot await `arenaConnect` (it opens a tunnel, then blocks on a confirmation dialog, which
 * hangs a headless run), so it fires the call and this side reports what actually arrived. A
 * mode that failed to cross contextBridge is indistinguishable from a correct one *except*
 * here: `normaliseAccessMode` silently degrades anything unrecognised to `ask`, so without this
 * the exact regression — a zero-argument preload shim minting every code read-only — would pass
 * every other check in the suite.
 */
let selfTestRequestedMode: string | undefined;
ipcMain.handle('selftest:result', (_event, report: unknown) => {
  if (!selfTest || selfTestFinished) return;
  selfTestFinished = true;
  if (selfTestTimer) clearTimeout(selfTestTimer);
  const lines: string[] = [];
  const value = report as { ok?: boolean; checks?: { label: string; ok: boolean; detail?: string }[]; errors?: string[] };
  const checks = [...(value?.checks ?? [])];
  if (selfTestRequestedMode !== undefined) {
    checks.push({
      label: 'the preload forwards the accessMode parameter',
      ok: selfTestRequestedMode === 'code',
      detail: selfTestRequestedMode === 'code'
        ? 'the main process received code'
        : `the main process saw "${selfTestRequestedMode}" instead of code — the mode was dropped in transit`,
    });
  }
  for (const item of checks) lines.push(`${item.ok ? 'PASS' : 'FAIL'}  ${item.label}${item.detail ? '  — ' + item.detail : ''}`);
  for (const error of value?.errors ?? []) lines.push(`ERROR ${error}`);
  const failed = checks.filter((c) => !c.ok).length + (value?.errors?.length ?? 0);
  process.stdout.write(lines.join('\n') + '\n');
  process.stdout.write(failed === 0 ? '\nWindow self test passed.\n' : `\n${failed} window self test check(s) failed.\n`);
  const code = failed === 0 ? 0 : 1;
  // Record the decided exit code before shutting down: the shutdown path must not be able to
  // override a verdict that has already been reported.
  settledExitCode = code;
  void closeDaemonQuietly().finally(() => { app.exit(code); });
});

app.whenReady().then(async () => {
  trace('app ready');
  trace(`resolved project root: ${repoRoot}`);
  assertLayout();
  const workspaceRoot = initialWorkspace();
  trace('workspace: ' + workspaceRoot);
  try {
    await startDaemon(workspaceRoot);
    trace('daemon started at ' + daemon?.urls.admin);
    publishE2eHandshake(workspaceRoot);
  } catch (error) {
    trace('daemon failed: ' + String((error as Error)?.message ?? error));
    // A failed start must exit non-zero, otherwise `--self-test` reports success on a bridge
    // that never came up. In self-test mode the message goes to stdout instead of a modal, so
    // an unattended run cannot block on a dialog nobody will click.
    if (selfTest) {
      process.stdout.write(`ERROR the bridge did not start: ${String((error as Error)?.message ?? error)}\n\nWindow self test failed.\n`);
      app.exit(1);
      return;
    }
    dialog.showErrorBox('启动失败', String((error as Error)?.message ?? error));
    app.exit(1);
    return;
  }
  buildMenu();
  trace('menu built');
  createWindow();
  trace('window created');
  if (selfTest) {
    selfTestTimer = setTimeout(() => {
      if (selfTestFinished) return;
      process.stdout.write('ERROR the window did not report a result within 30s.\n\nWindow self test failed.\n');
      settledExitCode = 1;
      void closeDaemonQuietly().finally(() => app.exit(1));
    }, 30000);
  }
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => { app.quit(); });
/**
 * Quitting is deferred by exactly one turn so the shutdown work can finish.
 *
 * `void closeDaemonQuietly()` was fine while the only thing it had to do was kill the tunnel
 * child synchronously. It is not fine now that it also switches unattended writes off: that is
 * a POST to the daemon, and a process that exits without waiting for it leaves the stored
 * setting on disk — which for an unlimited window means the next launch inherits it. The flag
 * makes the second, real `before-quit` pass straight through instead of deferring forever.
 */
let shutdownStarted = false;
app.on('before-quit', (event) => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  event.preventDefault();
  if (settledExitCode === undefined) settledExitCode = 0;
  void Promise.race([
    closeDaemonQuietly(),
    // Shutdown is best-effort work, so it gets a bounded wait rather than the ability to keep
    // the window alive indefinitely if the daemon has stopped answering.
    new Promise((resolve) => { setTimeout(resolve, 5000); }),
  ]).finally(() => app.quit());
});
