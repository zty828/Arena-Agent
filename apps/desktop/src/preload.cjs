/**
 * Preload bridge. The renderer gets a narrow, explicit API and nothing else —
 * no Node, no filesystem, no raw IPC channel names. The admin token never crosses this
 * boundary at all: every admin-API call is proxied by the main process, which owns the token.
 *
 * Written as CommonJS because Electron preload scripts do not run through the
 * project's ESM build.
 */
const { contextBridge, ipcRenderer } = require('electron');

const MENU_CHANNELS = ['menu:open-workspace', 'menu:refresh', 'menu:view-pending', 'menu:view-activity', 'menu:view-files'];

contextBridge.exposeInMainWorld('bridgeHost', {
  /** Daemon URLs and the persisted workspace preference. No credential is included. */
  bootstrap: () => ipcRenderer.invoke('bootstrap'),
  /** Native folder picker; restarts the daemon on the chosen directory. */
  chooseWorkspace: () => ipcRenderer.invoke('workspace:choose'),
  /** Switch to a directory by path (used by the recent list and manual entry). */
  setWorkspace: (root) => ipcRenderer.invoke('workspace:set', root),
  /** Reveal a path in Explorer. */
  reveal: (target) => ipcRenderer.invoke('reveal', target),
  /**
   * Arena: expose the current workspace through a Cloudflare tunnel, create a one-time
   * pairing code, and copy the paste-into-Arena prompt. The confirmation dialog for the
   * exposure itself is raised by the main process, not here.
   *
   * `accessMode` ('ask' | 'plan' | 'code') sets the ceiling the pairing code carries. It has to
   * be passed explicitly through to the IPC call: the code is the only thing that decides whether
   * the remote can ever ask for write access, and the daemon refuses to raise it afterwards. A
   * shim that drops it silently mints every code read-only, which is the exact bug this parameter
   * exists to fix — and the only place that regression is visible is the main process, because
   * `normaliseAccessMode` quietly degrades anything missing to `ask`. The window self test asserts
   * on what the main process received for that reason, not on this function's arity.
   */
  arenaConnect: (accessMode) => ipcRenderer.invoke('arena:connect', accessMode),
  /** Close the tunnel and return the bridge to loopback-only. */
  arenaDisconnect: () => ipcRenderer.invoke('arena:disconnect'),
  /**
   * Read or toggle unattended writes. Called with no arguments it reads the current state, which
   * the panel polls so its warning banner stays accurate. Called with `(true, ttlMs)` it enables
   * the window — pass `(false)` to switch it off.
   */
  arenaAutoApprove: (enabled, ttlMs) => ipcRenderer.invoke('arena:auto-approve', enabled, ttlMs),
  /** Re-copy the prompt for the pairing that is still open. */
  arenaCopyPrompt: () => ipcRenderer.invoke('arena:copy-prompt'),
  /**
   * Mint a fresh pairing code for the tunnel that is already open and copy its prompt. Used when
   * the remote's grant has lapsed: the credential is short-lived by design, and re-pairing must
   * not require rebuilding the tunnel (new public URL, another exposure confirmation).
   */
  arenaReissuePairing: () => ipcRenderer.invoke('arena:reissue-pairing'),
  /** Current tunnel/pairing state, so the panel survives a view switch. */
  arenaState: () => ipcRenderer.invoke('arena:state'),
  /**
   * Agent Skills. The window only shows and triggers; the daemon owns the directory, validates
   * before writing, and re-discovers afterwards. `skillsChoose` opens the native directory picker
   * in the main process — the renderer never sees a filesystem path it did not ask for.
   */
  skillsList: () => ipcRenderer.invoke('skills:list'),
  skillsChoose: () => ipcRenderer.invoke('skills:choose'),
  skillsInstall: (source) => ipcRenderer.invoke('skills:install', source),
  skillsRemove: (name) => ipcRenderer.invoke('skills:remove', name),
  /**
   * Admin-API proxies. Each of these is one daemon admin operation, executed in the main
   * process with the admin token injected there. The renderer never holds the token, so none
   * of these take a path, a method or headers — only the operation's own arguments.
   */
  adminWorkspaceTree: (relPath) => ipcRenderer.invoke('admin:workspace-tree', relPath),
  adminWorkspaceFile: (relPath) => ipcRenderer.invoke('admin:workspace-file', relPath),
  adminStatus: () => ipcRenderer.invoke('admin:status'),
  adminEvents: (after) => ipcRenderer.invoke('admin:events', after),
  adminApprovalDecision: (approvalId, approve) => ipcRenderer.invoke('admin:approval-decision', approvalId, approve),
  adminPatchPreview: (workspaceId, patchId) => ipcRenderer.invoke('admin:patch-preview', workspaceId, patchId),
  adminRevokeAll: () => ipcRenderer.invoke('admin:revoke-all'),
  adminPairingDecision: (pairId, approve, accessMode) => ipcRenderer.invoke('admin:pairing-decision', pairId, approve, accessMode),
  /** Report the outcome of the window's own self test. Only used by --self-test. */
  selfTestResult: (report) => ipcRenderer.invoke('selftest:result', report),
  /**
   * Create or delete a self-test probe file in the workspace, so the self test can prove the file
   * tree follows the disk. The main process rejects this unless the window was started with
   * `--self-test`, and only accepts its own `selftest-refresh-*.txt` names.
   */
  selfTestFixture: (action, name) => ipcRenderer.invoke('selftest:fixture', action, name),
  /** Menu accelerators. Each subscription returns an unsubscribe function. */
  onMenu: (handler) => {
    const bound = MENU_CHANNELS.map((channel) => {
      const listener = () => handler(channel);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    });
    return () => bound.forEach((off) => off());
  },
});
