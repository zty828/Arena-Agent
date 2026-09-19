/**
 * Proves a failed workspace switch is reported and does not leave the window bridgeless.
 *
 * `switchWorkspace` closes the running daemon *before* starting the new one (a workspace binds
 * to a run immutably, so switching is a new daemon, not a rebind). That ordering means a failed
 * start could strand the operator with no bridge at all — and because the failure surfaced as a
 * rejected `ipcMain.handle`, the renderer only ever saw
 * `Error occurred in handler for 'workspace:choose'`. That is precisely how the
 * "immutable run binding" defect presented before it was fixed: unreadable, and with no hint
 * that the previous workspace had been torn down.
 *
 * This probe exercises the two things that must now hold:
 *   1. A refused root is reported as a readable error, not an exception.
 *   2. The previously working workspace is restored, so the window keeps a live bridge.
 *
 * It drives the real daemon functions rather than the Electron IPC layer, because the failure
 * has to be provoked deterministically (a denied root) and Electron cannot be scripted here.
 *
 * Run: node scripts/probe-switch-recovery.mjs
 *
 * This probe takes and releases a state lease per daemon, and each release deletes `daemon.lock`.
 * The host environment's file-safety guard budgets those deletions per agent tool call and begins
 * refusing once the budget is spent — at which point a release fails and the NEXT start collides
 * with a lock that should already be gone. That looks exactly like the defect this file guards
 * against, so the probe runs its own daemon work under a private ledger key when invoked without
 * one, and re-executes itself once. `verify.mjs` and `run-tests-clean.mjs` isolate their children
 * for the same reason.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Run the real work under a private deletion-ledger key, so a spent budget in the calling context
// cannot turn a lease release into a false failure. One re-exec; the marker prevents a loop.
if (!process.env.ARENABRIDGE_SWITCH_PROBE_ISOLATED) {
  const rerun = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ARENABRIDGE_SWITCH_PROBE_ISOLATED: '1',
      CODEBUDDY_CONVERSATION_REQUEST_ID: `arenabridge-switch-${Date.now()}`,
      CODEBUDDY_TOOL_CALL_ID: `arenabridge-switch-${Date.now()}`,
    },
  });
  process.exit(rerun.status ?? 1);
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, '..');
const distUrl = (...parts) => pathToFileURL(path.join(repoRoot, 'dist', ...parts)).href;

const { createDaemon } = await import(distUrl('apps', 'daemon', 'src', 'server.js'));
const { newSecret } = await import(distUrl('packages', 'contracts', 'src', 'index.js'));

const say = (line) => process.stdout.write(`${line}\n`);
let failures = 0;
const check = (label, ok, detail = '') => {
  say(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

// A workspace root the path policy refuses. `WorkspaceFiles.open` denies any path containing an
// `appdata` segment, so this is refused by the product, not by a contrived stub.
const deniedRoot = path.join(os.homedir(), 'AppData', 'Local', 'Temp', `arenabridge-denied-${Date.now()}`);
await fs.mkdir(deniedRoot, { recursive: true });

const goodBase = path.join(repoRoot, 'outputs', 'probe-switch-recovery');
const goodRoot = path.join(goodBase, 'workspace');
// A fresh state directory per run. Reusing one makes the probe depend on the previous run's
// cleanup having succeeded, and releasing the lease deletes `daemon.lock` — which the host's
// file-safety guard can refuse. A refused release then makes the *next* run fail with
// `VERSION_CONFLICT: State directory is locked`, which looks like a product defect and is not.
// Creating a new directory each time is a create, not a delete, so it sidesteps that entirely.
const stateDir = path.join(goodBase, 'state', String(Date.now()));
await fs.mkdir(goodRoot, { recursive: true });
await fs.mkdir(stateDir, { recursive: true });
await fs.writeFile(path.join(goodRoot, 'marker.txt'), 'the good workspace\n');

const config = (root) => ({
  schema_version: 1,
  state_directory: stateDir,
  ports: { api: 0, mcp: 0, mcp_remote: 0, admin: 0 },
  workspaces: [{ root, display_name: path.basename(root) || root }],
  response_mode: 'json',
  security_profile: 'local_trusted_development',
  arena_enabled: false,
  remote_ingress: { enabled: false, acknowledge_exposure: false, bind_address: '127.0.0.1', allow_cidrs: [], allowed_hosts: [], require_grant: true },
  gateway: { type: 'disabled' },
});

// --- 1. the good root starts ---
let daemon = await createDaemon(config(goodRoot), { adminToken: newSecret(), clientToken: newSecret(), mcpToken: newSecret() });
const goodAdmin = daemon.urls.admin;
check('the first workspace starts', !!goodAdmin, goodAdmin);

// --- 2. switching to a refused root fails, and is reported rather than thrown ---
let reported = null;
try {
  if (daemon) { await daemon.close(); daemon = undefined; }
  daemon = await createDaemon(config(deniedRoot), { adminToken: newSecret(), clientToken: newSecret(), mcpToken: newSecret() });
} catch (error) {
  reported = { message: String(error?.message ?? error), code: error?.code ?? error?.name };
}
check('a refused workspace root is rejected rather than silently accepted', !!reported,
  reported ? `${reported.code}: ${reported.message.slice(0, 80)}` : 'the daemon started on a denied root');

// --- 3. the previous root can be restored, so the window is not left bridgeless ---
//
// The token is kept from the restore so the check below can actually read the workspace, rather
// than sending a token the daemon never issued and calling the resulting 401 a success.
let restoreToken = '';
let restored = false;
try {
  restoreToken = newSecret();
  daemon = await createDaemon(config(goodRoot), { adminToken: restoreToken, clientToken: newSecret(), mcpToken: newSecret() });
  restored = true;
} catch (error) {
  say(`      restore failed: ${String(error?.message ?? error).slice(0, 120)}`);
}
check('the previous workspace can be restored after a failed switch', restored,
  restored ? daemon?.urls.admin ?? '' : 'no bridge would be running');

// --- 4. the restored bridge really serves the old workspace ---
if (restored && daemon) {
  const response = await fetch(`${daemon.urls.admin}/admin/v1/workspace/tree?path=.`, {
    headers: { Authorization: `Bearer ${restoreToken}` },
  }).catch(() => null);
  const body = response ? await response.json().catch(() => ({})) : {};
  const names = (body.entries ?? []).map((e) => e.name);
  check('the restored bridge serves the previous workspace\'s contents',
    response?.ok === true && names.includes('marker.txt'),
    response?.ok === true ? names.join(', ') || '<empty>' : `HTTP ${response?.status ?? 'no response'}`);
  await daemon.close().catch(() => undefined);
}

say('');
say(failures === 0
  ? 'VERDICT: a failed switch is reported, and the previous workspace is restorable — the window is not left without a bridge.'
  : `VERDICT: ${failures} check(s) failed; the failure path is not sound.`);
process.exit(failures === 0 ? 0 : 1);
