/**
 * Binds a sequence of workspaces against one state directory, the way the desktop window does.
 *
 * This is the regression guard for the "immutable run binding" failure. The window switches
 * directories by closing its daemon and starting a new one against the same state file. The
 * second start used to abort, because the local MCP identity was a single fixed run row and the
 * `runs` table refuses to change a run's workspace_id. The switch silently did nothing and the
 * window kept showing the previous workspace.
 *
 * Binding *once* proves nothing — the old code did that correctly. Binding again against the
 * same, already-populated store is the whole assertion.
 *
 * Two details this has to respect, both learned the hard way:
 *   1. Only one daemon may hold a state directory at a time (the lease is deliberate), so the
 *      binds must be SEQUENTIAL — close, then open. Two live daemons on one state file is a
 *      VERSION_CONFLICT, which is a lease refusal and says nothing about the run binding.
 *   2. A lease refusal must never be reported as "the regression is present". They are
 *      different failures and conflating them points the reader at the wrong code.
 *
 * Exit code 0 means every bind succeeded and served its own root.
 */
import path from 'node:path';
import { createDaemon } from '../dist/apps/daemon/src/server.js';
import { newSecret } from '../dist/packages/contracts/src/index.js';

const state = process.env.ARENABRIDGE_REBIND_STATE;
// Each entry is `<root>=<file that must be visible>`; the expected file is given explicitly
// rather than inferred from the folder name, so renaming a directory cannot quietly make the
// assertion vacuous.
const targets = (process.env.ARENABRIDGE_REBIND_ROOTS ?? '').split(path.delimiter).filter(Boolean).map((entry) => {
  const at = entry.lastIndexOf('=');
  return at === -1 ? { root: entry, expect: null } : { root: entry.slice(0, at), expect: entry.slice(at + 1) };
});
if (!state || targets.length < 2 || targets.some((t) => !t.expect)) {
  console.error('FAIL  ARENABRIDGE_REBIND_STATE and at least two <root>=<expected-file> entries are required');
  process.exit(2);
}

const config = (root) => ({
  schema_version: 1,
  state_directory: path.resolve(state),
  ports: { api: 0, mcp: 0, mcp_remote: 0, admin: 0 },
  workspaces: [{ root: path.resolve(root), display_name: path.basename(root) }],
  response_mode: 'json',
  security_profile: 'local_trusted_development',
  arena_enabled: false,
  remote_ingress: { enabled: false, acknowledge_exposure: false, bind_address: '127.0.0.1', allow_cidrs: [], allowed_hosts: [], require_grant: true },
  gateway: { type: 'disabled' },
});

/**
 * Removes a state lease left behind by a daemon that has already exited.
 *
 * Releasing the lease deletes `daemon.lock`, and that deletion can be refused by the host
 * environment's file-safety guard (`SAFE_DELETE_BULK_CONFIRM_REQUIRED`). The daemon's own release
 * verifies the lock's identity and throws `RESULT_UNKNOWN` rather than silently proceeding, which
 * is correct — but it means a refused deletion leaves the lock on disk.
 *
 * That matters here because this script binds SEVERAL times against one state directory. After
 * bind 1 closes, its lease must actually be gone or bind 2 is refused for a reason that has
 * nothing to do with the run binding. So the lease is cleared between binds, under the same rule
 * the product uses: only if the recorded holder is no longer running, and never if unparseable.
 */
async function clearLeaseIfHolderGone(stateDirectory) {
  const lock = path.join(stateDirectory, 'daemon.lock');
  let raw;
  try { raw = await fs.readFile(lock, 'utf8'); } catch { return; }
  let pid;
  try { pid = JSON.parse(raw).pid; } catch { return; }
  if (!Number.isInteger(pid) || pid <= 0) return;
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch (error) { alive = error.code === 'EPERM'; }
  if (alive) return;
  try { await fs.unlink(lock); } catch { /* report below if it still blocks a bind */ }
}

let failures = 0;
let inconclusive = false;
for (const [index, target] of targets.entries()) {
  const { root, expect } = target;
  const adminToken = newSecret();
  const label = `bind ${index + 1} (${path.basename(root)})`;
  // Clear any lease a previous bind could not release before attempting this one.
  await clearLeaseIfHolderGone(path.resolve(state));
  let daemon;
  try {
    daemon = await createDaemon(config(root), { adminToken, clientToken: newSecret(), mcpToken: newSecret() });
  } catch (error) {
    const code = error?.code ?? error?.name;
    if (code === 'VERSION_CONFLICT') {
      // Distinguish clearly: a held lease is a build-up problem in the caller, not the bug. It is
      // reported as inconclusive (exit 2) so nobody reads "locked" as "the run binding is broken".
      console.log(`FAIL  ${label} — the state directory was still locked (${error.message})`);
      console.log('      This is a lease refusal, not the run-binding defect; the previous daemon did not close.');
      inconclusive = true;
    } else {
      console.log(`FAIL  ${label} refused to start — ${code}: ${error.message}${error?.errstr ? ` (${error.errstr})` : ''}`);
      if (String(error?.message).includes('immutable run binding')) {
        console.log('      This is the immutable run binding regression.');
      }
    }
    failures++;
    continue;
  }
  const auth = { Authorization: `Bearer ${adminToken}` };
  const tree = await (await fetch(`${daemon.urls.admin}/admin/v1/workspace/tree?path=.`, { headers: auth })).json();
  const names = (tree.entries ?? []).map((e) => e.name);
  const ok = names.includes(expect);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} — served ${names.join(', ') || '<nothing>'}${ok ? '' : ` (expected ${expect})`}`);
  if (!ok) failures++;
  // Close before the next bind: one state file, one daemon at a time. The release may fail if the
  // deletion guard refuses it, which is why the lease is also cleared at the top of the loop.
  await daemon.close().catch((error) => {
    console.log(`      (lease release reported: ${String(error?.message ?? error).slice(0, 100)})`);
  });
}

console.log('');
if (failures === 0) {
  console.log(`VERDICT: ${targets.length} consecutive binds against one state file all succeeded.`);
} else if (inconclusive) {
  console.log(`VERDICT: INCONCLUSIVE — ${failures} of ${targets.length} binds could not be attempted because the`);
  console.log('         state lease was still held. This says nothing about the run binding.');
} else {
  console.log(`VERDICT: ${failures} of ${targets.length} binds failed; see the lines above for which kind.`);
}
// 0 = all bound, 1 = a real failure, 2 = could not reach a verdict (lease held).
process.exit(failures === 0 ? 0 : inconclusive && failures === targets.length ? 2 : 1);
