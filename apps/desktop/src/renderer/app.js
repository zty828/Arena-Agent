/**
 * Renderer for the ArenaBridge desktop harness.
 *
 * It holds no privilege: every action is an IPC call to the main process, which owns the
 * daemon's admin token and proxies the admin-API operations (see the admin:* wrappers on
 * window.bridgeHost). No credential ever reaches this page.
 */
'use strict';

const $ = (id) => document.getElementById(id);
const S = {
  base: '', prefs: { workspaceRoot: '', recentRoots: [] },
  workspaces: [], runs: [], approvals: [], events: [],
  selectedRun: null, selectedFile: null, diffCache: new Map(), notified: new Set(),
  // Signature of the last rendered root listing, so the poll can tell "unchanged" from "changed"
  // and skip the repaint that would collapse expanded folders. See treeSignature().
  treeSignature: '',
  currentView: 'pending', arenaOpen: false,
};

// ---------- helpers ----------

/**
 * Display labels for the access tiers, for the places where the window shows a mode it did not
 * choose itself (a grant from the event log, a request from a remote).
 *
 * The window must not keep its own *policy* about tiers — that is the daemon's job, and a second
 * copy of the rules is how `exec` got silently downgraded to `ask` at approval time. This map is
 * display only, and an unknown tier falls back to its raw value rather than to a wrong word like
 * "只读" (which is what an `exec` grant used to be labelled as, in the list whose whole purpose is
 * to tell the operator what is currently authorised).
 */
const TIER_LABELS = {
  ask: '只读',
  plan: '只读（先给计划）',
  code: '可写（每次仍需单独批准）',
  exec: '可写 + 可执行命令（命令无批准）',
};
const tierLabel = (mode) => TIER_LABELS[mode] ?? (mode || '?');

/**
 * Whether a `list_directory` entry is a directory.
 *
 * The daemon emits `type: 'directory' | 'file'`. This read `kind`, which is never present, so every
 * folder rendered as a file: the tree showed no expandable nodes, and clicking one asked the file
 * viewer to open a directory — `INVALID_ARGUMENT: Expected an ordinary file`.
 *
 * `kind` is still accepted, for the same reason the sandbox client accepts it: a listing cached
 * from an older revision should keep working rather than silently turning into files again.
 */
const isDirectoryEntry = (entry) => ['directory', 'dir'].includes(String(entry?.type ?? entry?.kind ?? '').toLowerCase());

/**
 * The one admin-API operation this page still needs: listing workspace data, file contents,
 * approvals, pairings and events. Every call is proxied by the main process, which injects the
 * admin token there — the token never crosses into this page, so a workspace switch or a tunnel
 * restart can no longer strand the window on a dead credential.
 *
 * The self test swaps this for a mock to observe what the pairing panel sends, which is why
 * the mockable indirection is kept rather than calling window.bridgeHost inline everywhere.
 */
async function api(path, options = {}) {
  const call = api.bridgeCall || ((op, ...args) => window.bridgeHost[op](...args));
  const body = options.body ? JSON.parse(options.body) : {};
  switch (path) {
    case '/admin/v1/workspace/tree?path=.': return call('adminWorkspaceTree', '.');
    case '/admin/v1/status': return call('adminStatus');
    case '/admin/v1/events?after=0': return call('adminEvents', 0);
    default: break;
  }
  let m = /^\/admin\/v1\/workspace\/tree\?path=([^&]*)$/.exec(path);
  if (m) return call('adminWorkspaceTree', decodeURIComponent(m[1]));
  m = /^\/admin\/v1\/workspace\/file\?path=([^&]*)$/.exec(path);
  if (m) return call('adminWorkspaceFile', decodeURIComponent(m[1]));
  m = /^\/admin\/v1\/approvals\/([^/]+)\/decision$/.exec(path);
  if (m) return call('adminApprovalDecision', decodeURIComponent(m[1]), body.approve === true);
  m = /^\/admin\/v1\/workspaces\/([^/]+)\/patches\/([^/]+)$/.exec(path);
  if (m) return call('adminPatchPreview', decodeURIComponent(m[1]), decodeURIComponent(m[2]));
  m = /^\/admin\/v1\/pairings\/([^/]+)\/decision$/.exec(path);
  if (m) return call('adminPairingDecision', decodeURIComponent(m[1]), body.approve === true, body.access_mode);
  if (path === '/admin/v1/revoke-all') return call('adminRevokeAll');
  throw new Error('unsupported admin operation: ' + path);
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const escAttr = esc;
const short = (v, n = 20) => String(v ?? '').slice(0, n);
const clockOf = (ms) => new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });
const timeOf = (iso) => { const d = Date.parse(iso); return isNaN(d) ? '--:--:--' : clockOf(d); };
const baseName = (p) => String(p ?? '').split(/[\\/]/).filter(Boolean).pop() || p;

/**
 * Applies a bootstrap payload (daemon URLs + workspace prefs) to the session state.
 *
 * Every daemon restart — workspace switch, arena connect/disconnect — rotates the admin token
 * and re-picks the OS-assigned ports, so the IPC that caused the restart returns this payload
 * and it must be applied before anything else polls. Skipping it was survivable only while
 * the token came from bootstrap() and the renderer re-fetched it; with the token now confined
 * to the main process, stale prefs are the remaining symptom and this is the one place they
 * get replaced.
 */
function applyBoot(boot) {
  if (!boot || typeof boot !== 'object') return;
  S.base = boot.adminUrl || '';
  S.prefs = boot.prefs || S.prefs;
}

let toastTimer = null;
function toast(message, bad = false) {
  const el = $('toast');
  el.textContent = message;
  el.className = 'toast' + (bad ? ' bad' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

/** Colour a unified diff by line prefix. Never interprets the content as markup. */
function diffHtml(diff) {
  return String(diff || '').split('\n').map((line) => {
    const cls = line.startsWith('+++') || line.startsWith('---') ? ''
      : line.startsWith('@@') ? 'hunk'
      : line.startsWith('+') ? 'add'
      : line.startsWith('-') ? 'del' : '';
    return '<div class="ln ' + cls + '">' + esc(line) + '</div>';
  }).join('');
}

// ---------- workspace ----------

function renderWorkspace() {
  const root = S.prefs.workspaceRoot || '';
  $('wsLabel').textContent = S.workspaces[0] ? S.workspaces[0].display_name : baseName(root) || '未选择';
  $('wsPath').textContent = root;
}

// ---------- file tree ----------

function renderTree(entries, container, prefix) {
  for (const entry of entries) {
    const indent = prefix.length * 12 + 8;
    if (isDirectoryEntry(entry)) {
      const btn = document.createElement('button');
      btn.className = 'node dir';
      btn.style.paddingLeft = indent + 'px';
      btn.innerHTML = '<span class="glyph">▸</span><span class="nm">' + esc(entry.name) + '</span>';
      btn.onclick = async () => {
        const open = btn.dataset.open === '1';
        const next = btn.nextElementSibling;
        if (open) { btn.dataset.open = '0'; btn.querySelector('.glyph').textContent = '▸'; if (next && next.dataset.children) next.remove(); return; }
        btn.dataset.open = '1'; btn.querySelector('.glyph').textContent = '▾';
        const holder = document.createElement('div');
        holder.dataset.children = '1';
        try {
          const listing = await api('/admin/v1/workspace/tree?path=' + encodeURIComponent(entry.path));
          renderTree(listing.entries || [], holder, prefix + ' ');
        } catch (error) {
          holder.innerHTML = '<div class="tree-empty">' + esc(error.message) + '</div>';
        }
        btn.after(holder);
      };
      container.appendChild(btn);
    } else {
      const btn = document.createElement('button');
      btn.className = 'node' + (S.selectedFile === entry.path ? ' active' : '');
      // The full relative path goes on the node itself. The active-highlight in openFile()
      // compares against this, never against the rendered text: `endsWith(basename)` marked
      // every same-named file in the tree active at once.
      btn.dataset.path = entry.path;
      btn.style.paddingLeft = indent + 'px';
      btn.innerHTML = '<span class="glyph">·</span><span class="nm">' + esc(entry.name) + '</span>';
      btn.onclick = () => openFile(entry.path);
      container.appendChild(btn);
    }
  }
}

/**
 * Fingerprint of the root listing. The tree is polled, and re-rendering it wholesale on every
 * poll is not acceptable: it throws away which folders the operator expanded and resets the
 * scroll position, so a tree that "refreshes" is worse than one that does not. Comparing this
 * signature lets the poll repaint only when the directory actually changed.
 *
 * Name, kind and size are all included because a same-named file can be replaced with different
 * contents, and `mtime_ms` is deliberately not relied on alone: the resolution of the timestamps
 * the daemon reports is not guaranteed, so an edit within the same tick could be missed.
 *
 * The kind is resolved through the same helper the renderer uses, so a path that changes from file
 * to directory (or back) is a signature change. Reading `e.kind` here made every entry look like a
 * file, which meant a folder replaced by a file was invisible to the poll.
 */
function treeSignature(entries) {
  return (entries || [])
    .map((e) => `${isDirectoryEntry(e) ? 'directory' : 'file'}:${e.name}:${e.size ?? ''}:${e.mtime_ms ?? ''}`)
    .join('|');
}

async function loadTree(options = {}) {
  const host = $('tree');
  const { force = false } = options;
  // Only show the loading placeholder when there is nothing on screen to preserve. On a poll it
  // would flash over a perfectly good tree every few seconds.
  if (!host.querySelector('.node')) host.innerHTML = '<div class="tree-empty">载入中…</div>';
  try {
    const listing = await api('/admin/v1/workspace/tree?path=.');
    const entries = listing.entries || [];
    const signature = treeSignature(entries);
    // Same contents as the render already on screen: leave the DOM alone so expanded folders and
    // scroll position survive. `force` is for the explicit refresh button and the menu item,
    // where the operator has asked for a repaint and a no-op would look broken.
    if (!force && signature === S.treeSignature && host.querySelector('.node')) return false;
    S.treeSignature = signature;
    host.innerHTML = '';
    if (!entries.length) { host.innerHTML = '<div class="tree-empty">目录为空</div>'; return true; }
    renderTree(entries, host, '');
    return true;
  } catch (error) {
    host.innerHTML = '<div class="tree-empty">' + esc(error.message) + '</div>';
    // A failed read must not leave a stale signature behind, or a tree that failed to load would
    // be considered "unchanged" once the daemon comes back.
    S.treeSignature = '';
    return false;
  }
}

async function openFile(relativePath) {
  S.selectedFile = relativePath;
  for (const n of document.querySelectorAll('#tree .node')) n.classList.toggle('active', n.dataset.path === relativePath && !n.classList.contains('dir'));
  switchView('files');
  $('fileLabel').textContent = relativePath;
  const host = $('fileView');
  host.innerHTML = '<div class="tree-empty">载入中…</div>';
  try {
    const result = await api('/admin/v1/workspace/file?path=' + encodeURIComponent(relativePath));
    const lines = String(result.text ?? '').split('\n');
    host.innerHTML = '<div class="code">' + lines.map((line, i) =>
      '<div class="row"><span class="no">' + (i + 1) + '</span><span class="src">' + esc(line) + '</span></div>'
    ).join('') + '</div>';
  } catch (error) {
    // Binary and non-UTF-8 files are refused by design (BINARY_FILE / UNSUPPORTED_ENCODING).
    // That is an expected answer, not a failure, so say so plainly instead of leaving an
    // empty pane that looks like the viewer is broken. Anything else is a real error.
    const message = String(error && error.message ? error.message : error);
    const expected = /^BINARY_FILE\b/.test(message) || /^UNSUPPORTED_ENCODING\b/.test(message);
    host.innerHTML = '<div class="tree-empty">'
      + (expected ? '这个文件不是文本，无法在查看器中显示。' : esc(message))
      + '</div>';
  }
}

// ---------- pending approvals ----------

function resolveWorkspaceFor(approval) {
  const run = S.runs.find((r) => r.id === approval.run_id);
  return (run && run.workspace_id) || (S.workspaces[0] && S.workspaces[0].id) || '';
}

function renderPending() {
  const host = $('pendingList');
  const items = S.approvals;
  const pill = $('pendingPill');
  pill.hidden = items.length === 0;
  pill.textContent = String(items.length);

  if (!items.length) {
    host.innerHTML = '<div class="empty">目前没有等待批准的写操作。<br><span class="muted">远端 Agent 每次改文件都会出现在这里；批准前磁盘不会被改动。</span></div>';
    return;
  }

  host.innerHTML = items.map((a) => {
    const patchId = /patch_[a-z0-9-]+/i.exec(a.description || '');
    const wsId = resolveWorkspaceFor(a);
    const left = a.expires_at - Date.now();
    return '<div class="pend" data-ws="' + escAttr(wsId) + '">'
      + '<div class="head">'
      + '<span class="title">请求修改工作区文件</span>'
      + '<span class="target">' + esc(patchId ? '' : '') + '</span>'
      + '<span class="countdown' + (left <= 0 ? ' expired' : '') + '" data-until="' + a.expires_at + '"></span>'
      + '</div>'
      + '<div class="ask">' + esc(a.description || '远端 Agent 请求应用补丁') + '</div>'
      + '<dl class="kv">'
      + '<dt>Run</dt><dd>' + esc(short(a.run_id)) + '…</dd>'
      + '<dt>参数摘要</dt><dd>' + esc(short(a.params_hash, 32)) + '…</dd>'
      + '</dl>'
      + '<div class="diff" id="diff-' + escAttr(a.id) + '"><div class="ln">正在读取 diff…</div></div>'
      + '<div class="btn-row">'
      + '<button class="btn-primary" data-approve="1" data-id="' + escAttr(a.id) + '">允许这次修改</button>'
      + '<button class="btn-danger" data-approve="0" data-id="' + escAttr(a.id) + '">拒绝</button>'
      + '</div></div>';
  }).join('');

  for (const btn of host.querySelectorAll('[data-approve]')) {
    btn.onclick = async () => {
      const approve = btn.dataset.approve === '1';
      if (!confirm(approve ? '允许这次写入？补丁会立即应用到工作区文件。' : '拒绝这次写入？远端会收到拒绝，文件不会改变。')) return;
      btn.disabled = true;
      try {
        await api('/admin/v1/approvals/' + encodeURIComponent(btn.dataset.id) + '/decision', { method: 'POST', body: JSON.stringify({ approve }) });
        toast(approve ? '已允许，补丁已应用' : '已拒绝');
        if (S.selectedFile) setTimeout(() => openFile(S.selectedFile).catch(() => {}), 400);
      } catch (error) { toast(error.message, true); }
      await refreshPending();
    };
  }

  for (const item of items) {
    // Prefer the structured patch_id the daemon now stores on the approval itself. The
    // description regex survives only as a fallback for approvals created before that field
    // existed — and if NEITHER yields an id, say so explicitly: the old code just skipped the
    // item, which left the "正在读取 diff…" placeholder spinning forever.
    const patchId = typeof item.patch_id === 'string' && item.patch_id
      ? item.patch_id
      : (/patch_[a-z0-9-]+/i.exec(item.description || '') || [])[0] || null;
    const holder = $('diff-' + item.id);
    if (!holder) continue;
    if (!patchId) { holder.innerHTML = '<div class="ln">无法定位补丁编号（patch id），diff 未加载</div>'; continue; }
    const wsId = resolveWorkspaceFor(item);
    if (!wsId) { holder.innerHTML = '<div class="ln">无法确定工作区</div>'; continue; }
    fetchDiff(patchId, wsId).then((preview) => {
      if (!preview || !preview.changes) { holder.innerHTML = '<div class="ln">diff 不可用（补丁可能已被清理）</div>'; return; }
      holder.innerHTML = preview.changes.map((c) => '<div class="fname">' + esc(c.path) + '</div>' + diffHtml(c.diff)).join('');
    });
  }
}

async function fetchDiff(patchId, workspaceId) {
  const key = workspaceId + '/' + patchId;
  if (S.diffCache.has(key)) return S.diffCache.get(key);
  try {
    const preview = await api('/admin/v1/workspaces/' + encodeURIComponent(workspaceId) + '/patches/' + encodeURIComponent(patchId));
    S.diffCache.set(key, preview);
    return preview;
  } catch { S.diffCache.set(key, null); return null; }
}

function tickCountdowns() {
  for (const el of document.querySelectorAll('[data-until]')) {
    const left = Number(el.dataset.until) - Date.now();
    if (left <= 0) { el.textContent = '已过期'; el.classList.add('expired'); continue; }
    const s = Math.ceil(left / 1000);
    el.textContent = s >= 60 ? (Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') + ' 后过期') : (s + ' 秒后过期');
  }
}

// ---------- activity ----------

const EVENT_TEXT = {
  'daemon.started': ['服务启动', 'ok'], 'pairing.created': ['生成配对邀请', ''],
  'pairing.requested': ['远端请求接入', ''], 'pairing.decided': ['本机决定配对', ''],
  'grant.issued': ['签发授权', 'ok'], 'grant.verified': ['远端完成挑战', 'ok'],
  'grants.revoked_all': ['撤销全部授权', 'bad'], 'run.created': ['创建 run', ''],
  'run.state': ['run 状态变更', ''], 'approval.requested': ['请求写入审批', 'wait'],
  'approval.decided': ['本机审批评审', ''], 'approval.consumed': ['审批已消费（写入执行）', 'ok'],
  'tool.completed': ['工具执行完成', 'ok'], 'tool.failed': ['工具执行失败', 'bad'],
};
const TOOL_TEXT = {
  bridge_health: '握手确认', list_directory: '列目录', find_files: '找文件', search_files: '搜内容',
  read_files: '读文件', apply_patch: '改文件', set_todos: '更新任务列表',
  report_progress: '上报进度', lsp: '语义查询', get_diagnostics: '取诊断',
};

function describe(event) {
  const entry = EVENT_TEXT[event.type] || [event.type, ''];
  const p = event.payload || {};
  let detail = '';
  if (event.type === 'tool.completed' || event.type === 'tool.failed') {
    detail = TOOL_TEXT[p.action] || p.action || '未知工具';
    if (p.duration_ms !== undefined) detail += ' · ' + p.duration_ms + 'ms';
    if (p.code) detail += ' · ' + p.code;
  } else if (event.type === 'grant.issued') detail = '权限 ' + (p.mode || '?');
  else if (event.type === 'approval.decided') detail = p.state === 'approved' ? '已允许' : '已拒绝';
  else if (event.type === 'approval.requested') detail = '补丁 ' + short(p.patch_id, 14) + '…';
  return { label: entry[0], tone: entry[1], detail };
}

function renderActivity() {
  const byRun = new Map();
  for (const e of S.events) {
    const key = e.run_id || '__local__';
    if (!byRun.has(key)) byRun.set(key, []);
    byRun.get(key).push(e);
  }
  const host = $('timeline');
  if (!byRun.size) { host.innerHTML = '<div class="empty">还没有任何活动。</div>'; return; }
  host.innerHTML = [...byRun.entries()].reverse().map(([runId, list]) => {
    const granted = list.find((e) => e.type === 'grant.issued');
    const failed = list.filter((e) => e.type === 'tool.failed').length;
    const ok = list.filter((e) => e.type === 'tool.completed').length;
    const writes = list.filter((e) => e.type === 'approval.consumed').length;
    const title = runId === '__local__' ? '本机（无 run）' : 'run ' + short(runId, 18) + '…';
    return '<div class="run-card" data-run="' + escAttr(runId) + '">'
      + '<div class="run-head"><strong>' + esc(title) + '</strong>'
      + (granted ? '<span class="tag">权限 ' + esc(granted.payload.mode || '?') + '</span>' : '')
      + '<span class="tag ok">' + ok + ' 次工具</span>'
      + (writes ? '<span class="tag write">' + writes + ' 次写入</span>' : '')
      + (failed ? '<span class="tag bad">' + failed + ' 次失败</span>' : '')
      + '<button class="ghost" data-inspect="' + escAttr(runId) + '" style="margin-left:auto">检查</button>'
      + '</div><div class="tl">'
      + list.map((e) => {
        const d = describe(e);
        return '<div class="ev ' + d.tone + '"><span class="t">' + timeOf(e.timestamp) + '</span>' + esc(d.label)
          + (d.detail ? ' <span class="meta">' + esc(d.detail) + '</span>' : '') + '</div>';
      }).join('')
      + '</div></div>';
  }).join('');
  for (const btn of host.querySelectorAll('[data-inspect]')) btn.onclick = () => inspectRun(btn.dataset.inspect);
}

function inspectRun(runId) {
  S.selectedRun = runId;
  const list = S.events.filter((e) => (e.run_id || '__local__') === runId);
  const run = S.runs.find((r) => r.id === runId);
  const body = $('inspectorBody');
  const tools = list.filter((e) => e.type === 'tool.completed' || e.type === 'tool.failed');
  body.innerHTML = '<div class="grp"><h4>运行</h4>'
    + '<div class="item"><div class="k">ID</div><div class="v">' + esc(runId) + '</div></div>'
    + (run ? '<div class="item"><div class="k">模式</div><div class="v">' + esc(run.mode) + '</div></div>'
      + '<div class="item"><div class="k">执行归属</div><div class="v">' + esc(run.execution_owner) + '</div></div>'
      + '<div class="item"><div class="k">状态</div><div class="v">' + esc(run.state) + '</div></div>' : '')
    + '</div>'
    + '<div class="grp"><h4>工具调用 (' + tools.length + ')</h4>'
    + (tools.length ? tools.map((e) => {
      const p = e.payload || {};
      const ok = e.type === 'tool.completed';
      return '<div class="item"><div class="v" style="color:' + (ok ? 'var(--ok)' : 'var(--del-fg)') + '">'
        + esc(TOOL_TEXT[p.action] || p.action || '?') + '</div>'
        + '<div class="k">' + (p.duration_ms ?? '?') + 'ms' + (p.code ? ' · ' + esc(p.code) : '') + '</div></div>';
    }).join('') : '<div class="tree-empty">无</div>')
    + '</div>'
    + '<div class="grp"><h4>审批</h4>'
    + (list.filter((e) => e.type.startsWith('approval')).map((e) => {
      const p = e.payload || {};
      return '<div class="item"><div class="v">' + esc(e.type.replace('approval.', '')) + (p.state ? ' · ' + esc(p.state) : '') + '</div>'
        + '<div class="k">' + timeOf(e.timestamp) + '</div></div>';
    }).join('') || '<div class="tree-empty">无</div>')
    + '</div>';
}

// ---------- grants ----------

function renderGrants() {
  const issued = new Map();
  for (const e of S.events) {
    if (e.type === 'grant.issued' && e.payload && e.payload.grant_id) issued.set(e.payload.grant_id, { ...e.payload, at: e.timestamp });
    if (e.type === 'grants.revoked_all') for (const g of issued.values()) g.revoked = true;
  }
  const host = $('grantList');
  if (!issued.size) { host.innerHTML = '<div class="empty">当前没有任何远端授权。<span class="muted"><br>用 arena.cmd 生成配对邀请来授权一个远端 Agent。</span></div>'; return; }
  host.innerHTML = '<table><thead><tr><th>授权</th><th>权限</th><th>工作区</th><th>状态</th><th>签发</th></tr></thead><tbody>'
    + [...issued.values()].reverse().map((g) => {
      const mode = g.mode || '?';
      // An `exec` grant used to fall into the "not code" branch and be shown as 只读 — in the one
      // list whose job is to tell the operator what is currently authorised.
      const tone = g.revoked ? 'bad' : mode === 'ask' || mode === 'plan' ? 'ok' : 'write';
      const label = g.revoked ? '已撤销' : tierLabel(mode);
      const ws = S.workspaces.find((w) => w.id === g.workspace_id);
      return '<tr><td><code>' + esc(short(g.grant_id, 18)) + '…</code></td><td>' + esc(mode) + '</td>'
        + '<td>' + esc(ws ? ws.display_name : short(g.workspace_id, 14)) + '</td>'
        + '<td><span class="tag ' + tone + '">' + esc(label) + '</span></td>'
        + '<td class="muted">' + timeOf(g.at) + '</td></tr>';
    }).join('') + '</tbody></table>';
}

// ---------- Arena: expose the workspace to a remote agent ----------
//
// The confirm dialog for the exposure itself is raised by the main process — it is the step
// that must not be skippable, and a renderer could be reloaded or edited. Everything here is
// presentation: show what is open, how long it stays open, and how to shut it down.

function arenaShowPanel(which, extra) {
  $('arenaIdle').hidden = which !== 'idle';
  $('arenaLive').hidden = which !== 'live';
  $('arenaBusy').hidden = which !== 'busy';
  if (which === 'busy' && extra) $('arenaBusyText').textContent = extra;
}

const ACCESS_MODE_TEXT = { ask: '只读（ask）', plan: '只读并给出计划（plan）', code: '可写（code，写盘仍需单独批准）',
  exec: '可写 + 可执行命令（exec，命令直接执行，写盘仍需单独批准）' };
// The same label while unattended writes are on. It has to be a different string, not a suffix
// on the attended one: the panel used to keep saying "写盘仍需单独批准" right above a banner
// saying nobody reads the diff, and the operator reading this screen is the person who has to
// know which of the two is true.
const ACCESS_MODE_TEXT_UNATTENDED = { code: '可写（code，无人值守写入已开启：写盘自动放行）',
  exec: '可写 + 可执行命令（exec，无人值守：写盘自动放行，命令直接执行）' };

// ---------- unattended writes ----------
//
// The one control in this window that lowers the session's safety. It exists as an explicit
// opt-in for operators who want the write loop to run without them, and it removes the single
// human check on what reaches the disk: with it on, whatever the remote agent decides to write
// lands immediately. The UI therefore does two things everywhere else does not do them:
//   - it states the consequence in the panel itself, not in a doc, rather than only labelling
//     the switch;
//   - while it is on it shows a banner that cannot be dismissed, and a dedicated off button,
//     because the failure mode is forgetting that it is on.
let autoState = { enabled: false, expiresAt: null, unlimited: false };

/** Sentinel the daemon uses for "no expiry". Mirrors AUTO_APPROVE_NO_EXPIRY in the policy engine. */
const NO_EXPIRY = 0;

/** Seconds left, or null when the switch is off. Expiry is enforced by the daemon; this mirrors it. */
function autoRemaining() {
  if (!autoState.enabled) return null;
  // Unlimited: no countdown at all. Returning a big number would be worse than null — the banner
  // would show a fake deadline that never arrives.
  if (autoState.unlimited || !autoState.expiresAt) return Infinity;
  return Math.max(0, Math.ceil((autoState.expiresAt - Date.now()) / 1000));
}

function renderAutoApprove() {
  const left = autoRemaining();
  const on = left !== null && left > 0;
  const unlimited = left === Infinity;
  const banner = $('arenaAutoBanner');
  const offButton = $('arenaAutoOff');
  if (banner) {
    banner.hidden = !on;
    if (on) {
      // The no-expiry case gets a different sentence on purpose: "剩余 0:00" or an invented
      // deadline would both imply a safety net that is not there.
      banner.innerHTML = unlimited
        ? '<b>无人值守写入已开启，且不会自动失效</b>——远端提交的改动会立即落盘，<b>没有人先看 diff</b>。'
          + '它只会在你关闭它、或断开隧道时停止。'
        : (() => {
          const mins = Math.floor(left / 60), secs = left % 60;
          return '<b>无人值守写入已开启</b>——远端提交的改动会自动落盘，<b>没有人先看 diff</b>。'
            + `剩余 <span class="mono">${mins}:${String(secs).padStart(2, '0')}</span> 后自动失效。`;
        })();
    }
  }
  if (offButton) offButton.hidden = !on;
  if (offButton && on) offButton.textContent = unlimited ? '立即关闭无人值守写入（当前不限时长）' : '立即关闭无人值守写入';
  const toggle = $('autoApproveToggle');
  // Keep the checkbox in step with the daemon's answer: when the window is reopened against an
  // already-expired switch, an unchecked box with a visible banner would be contradictory.
  if (toggle) toggle.checked = on;
}

async function refreshAutoApprove() {
  try {
    autoState = await window.bridgeHost.arenaAutoApprove();
  } catch {
    // Cannot tell -> treat as off. Reporting "on" without confirmation would be the dangerous way
    // to be wrong, and the banner is the thing an operator relies on to know the posture.
    autoState = { enabled: false, expiresAt: null, unlimited: false };
  }
  renderAutoApprove();
}

/** Reads the TTL control. An empty/invalid value is "no expiry", not "10 minutes": quietly
 *  substituting a deadline the operator did not choose is the one error this panel cannot make. */
function selectedTtl() {
  const raw = $('autoApproveTtl')?.value;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : NO_EXPIRY;
}

async function setAutoApprove(enabled) {
  const ttl = selectedTtl();
  autoState = await window.bridgeHost.arenaAutoApprove(enabled, ttl);
  renderAutoApprove();
  // The live panel's mode label states whether writes are supervised, so it has to follow this
  // switch rather than the moment the tunnel was opened. Best effort: a failed re-read must not
  // turn a successful toggle into an error toast.
  if (S.arenaOpen) window.bridgeHost.arenaState().then(renderArenaState).catch(() => undefined);
  if (autoState.enabled) {
    // The toast must not claim a countdown that will not happen.
    const when = ttl === NO_EXPIRY ? '不限时长，直到你手动关闭' : `${Math.round(ttl / 60000)} 分钟后自动失效`;
    toast(`已开启无人值守写入（${when}）：远端写盘不再需要你批准`);
  } else {
    toast('已关闭无人值守写入：写盘重新需要你批准');
  }
}
// ---------- end unattended writes ----------

function renderArenaState(state) {
  S.arenaOpen = !!state.open;
  $('arenaWs').textContent = state.workspaceRoot || '—';
  $('arenaLiveWs').textContent = state.workspaceRoot || '—';
  if (!state.open) { arenaShowPanel('idle'); return; }
  $('arenaUrl').textContent = state.publicUrl;
  $('arenaCode').textContent = state.pairingCode;
  // Shown because the mode is the one thing about this session that cannot be changed
  // afterwards: if it says 只读 and the operator wanted writes, the fix is to reconnect,
  // not to edit the prompt.
  const unattendedText = ACCESS_MODE_TEXT_UNATTENDED[state.accessMode];
  const modeText = (autoState.enabled && unattendedText)
    ? unattendedText
    : (ACCESS_MODE_TEXT[state.accessMode] || state.accessMode || '—');
  $('arenaModeLabel').textContent = modeText;
  // The remote's credential lifetime, stated where the operator will see it. It is a different
  // clock from the unattended window above (which may be unlimited), and the failure it causes
  // looks like a broken bridge, so it cannot stay a surprise.
  const grantTtl = Number(state.grantTtlMs);
  $('arenaGrantTtl').textContent = typeof state.grantTtlMs !== 'number' ? '—'
    : grantTtl > 0
      ? `远端领取后 ${Math.round(grantTtl / 60000)} 分钟到期（到期后所有调用会被拒，需点「重新签发配对码」）`
      : '跟随本次 bridge 会话（关窗 / 断开 / 换工作目录 / 撤销即失效，不按小时过期）';
  arenaShowPanel('live');
  tickArenaCountdown();
}

function tickArenaCountdown() {
  const el = $('arenaCountdown');
  if (el.dataset.until) {
    const left = Number(el.dataset.until) - Date.now();
    if (left <= 0) { el.textContent = '配对码已过期'; el.classList.add('expired'); }
    else {
      const s = Math.ceil(left / 1000);
      el.textContent = '配对码 ' + (s >= 60 ? Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') : s + ' 秒') + ' 后过期';
    }
  }
}

/** Shows the outcome of a copy attempt plainly, because a mangled prompt is worse than none. */
function reportClipboard(result) {
  const host = $('arenaClip');
  if (result.clipboardOk) host.innerHTML = '<span class="ok-mark">提示词已复制到剪贴板 ✓（已读回校验内容一致）</span>';
  else host.innerHTML = '<span class="bad-mark">剪贴板写入未通过校验：' + esc(result.clipboardReason || '未知原因')
    + '<br>点「打开提示词文件」，在里面 Ctrl+A、Ctrl+C。</span>';
  host.hidden = false;
}

$('arenaStart').onclick = async () => {
  // Chosen before the pairing code is minted, because the code carries this as a hard
  // ceiling: asking a remote to use `code` against an `ask`-scoped code returns 403 and
  // there is no way to raise it later. Reading it here is what makes the choice real.
  const selected = document.querySelector('input[name="arenaMode"]:checked');
  const accessMode = selected ? selected.value : 'ask';
  arenaShowPanel('busy', accessMode === 'ask'
    ? '正在建立隧道（首次会下载 cloudflared，约 35 MB）…将以只读模式签发配对码'
    : '正在建立隧道（首次会下载 cloudflared，约 35 MB）…将以' + tierLabel(accessMode) + '签发配对码');
  try {
    const result = await window.bridgeHost.arenaConnect(accessMode);
    if (!result.ok) {
      // The failure may STILL have restarted the daemon: anything that failed after the tunnel
      // came up unwinds through disconnectArena(), which re-boots the bridge loopback-only and
      // rotates the token/ports. The fresh bootstrap rides in the result; apply it before any
      // further poll, or the window keeps hitting the dead endpoints forever.
      applyBoot(result.boot);
      arenaShowPanel('idle');
      if (result.cancelled) { toast('已取消，没有开放任何东西'); return; }
      toast(result.error || '连接失败', true);
      if (result.hint) $('arenaWs').textContent = result.hint;
      return;
    }
    // The daemon was restarted to accept the tunnel host, so every cached URL and the prefs are
    // stale. The fresh bootstrap rides in the result — apply it before showing anything as live.
    applyBoot(result.boot);
    const state = await window.bridgeHost.arenaState();
    $('arenaCountdown').dataset.until = String(result.expiresAt || '');
    renderArenaState({ ...state, open: true });
    // The prompt that was just copied states whether writes are attended or not, so the banner
    // has to be current before the operator sends it to the remote.
    await refreshAutoApprove();
    reportClipboard(result);
    await refreshPending();
    toast('隧道已开启（' + tierLabel(accessMode) + '），提示词已复制');
  } catch (error) {
    arenaShowPanel('idle');
    toast(String(error && error.message ? error.message : error), true);
  }
};

$('arenaStop').onclick = async () => {
  if (!confirm('断开隧道？远端 Agent 会立刻失去连接，bridge 回到只监听本机。')) return;
  try {
    // Kill the unattended window on the way out. Leaving it on would mean the next connection —
    // possibly days later, with a fresh tunnel and a different remote — silently inherits
    // unreviewed writes. Disconnect is the operator's "stop everything" and has to mean it.
    if (autoState.enabled) {
      await window.bridgeHost.arenaAutoApprove(false).catch(() => undefined);
      autoState = { enabled: false, expiresAt: null };
      renderAutoApprove();
    }
    const result = await window.bridgeHost.arenaDisconnect();
    // The daemon was restarted (loopback-only) if the tunnel was actually open — fresh
    // bootstrap state rides in the result rather than needing a second IPC round trip.
    applyBoot(result && result.boot);
    $('arenaClip').hidden = true;
    renderArenaState(await window.bridgeHost.arenaState());
    toast('已断开，bridge 已回到只监听本机');
  } catch (error) { toast(String(error && error.message ? error.message : error), true); }
};

// The note next to the duration control follows the selection, so the consequence of "不限时长"
// is stated where it is chosen rather than only inside a confirm dialog that is already gone.
function renderTtlNote() {
  const note = $('autoApproveTtlNote');
  if (!note) return;
  const unlimited = selectedTtl() === NO_EXPIRY;
  note.textContent = unlimited
    ? '不会自动失效：只在你手动关闭或断开隧道时停止。'
    : '到期自动失效，不需要记得关。';
  note.classList.toggle('arena-auto-ttl-note-warn', unlimited);
}
$('autoApproveTtl').onchange = renderTtlNote;
renderTtlNote();

$('autoApproveToggle').onchange = async (event) => {
  const want = event.target.checked;
  // Turning it OFF never needs a dialog: friction on the safe direction is how a dangerous
  // setting ends up staying on. Turning it ON does, and the dialog states the consequence rather
  // than asking "are you sure?", which people click through.
  if (want) {
    const ttl = selectedTtl();
    const unlimited = ttl === NO_EXPIRY;
    const agreed = confirm(
      '开启无人值守写入？\n\n'
      + '开启后，远端 Agent 提交的每一次改动预览都会被自动批准并写入磁盘，'
      + '不会再有人先看 diff。'
      + (unlimited
        ? '\n\n注意：你选的是「不限时长」，它会一直有效，直到你手动关闭或断开隧道——不会有任何自动失效。'
        : `\n\n${Math.round(ttl / 60000)} 分钟后自动失效。`)
      + '\n\n如果 Agent 读到的内容里藏有诱导性指令，它写下的东西会直接落到你的磁盘。\n\n'
      + '只在你确定可以随时重建、且没有隐私内容的目录上开启。'
    );
    if (!agreed) { event.target.checked = false; return; }
  }
  try {
    await setAutoApprove(want);
  } catch (error) {
    // The daemon is the authority; if it refused, put the checkbox back so the UI never claims a
    // state the bridge is not in.
    event.target.checked = !want;
    renderAutoApprove();
    toast(String(error && error.message ? error.message : error), true);
  }
};

$('arenaAutoOff').onclick = async () => {
  try {
    await setAutoApprove(false);  } catch (error) { toast(String(error && error.message ? error.message : error), true); }
};

$('arenaCopy').onclick = async () => {
  const result = await window.bridgeHost.arenaCopyPrompt();
  if (!result.ok) { toast(result.error || result.reason || '复制失败', true); return; }
  reportClipboard({ clipboardOk: true });
  toast('提示词已重新复制');
};

$('arenaReveal').onclick = async () => {
  const state = await window.bridgeHost.arenaState();
  await window.bridgeHost.reveal(state.promptPath);
};

// The remote's grant is short-lived by design, so a long session will outlive it. Re-pairing
// must not mean rebuilding the tunnel (new public URL + another exposure confirmation), so this
// mints a fresh code against the session that is already open and copies its prompt.
$('arenaReissue').onclick = async () => {
  const btn = $('arenaReissue');
  // Not re-entrant: minting a second code while the first request is in flight would leave two
  // outstanding codes and race the clipboard write. Disabled until the request settles, in
  // finally, so even a thrown error re-enables it.
  btn.disabled = true;
  try {
    const result = await window.bridgeHost.arenaReissuePairing();
    if (!result.ok) { toast(result.error || '重新签发失败', true); return; }
    $('arenaCountdown').dataset.until = String(result.expiresAt || '');
    renderArenaState(await window.bridgeHost.arenaState());
    reportClipboard(result);
    toast('已签发新的配对码，提示词已复制；让远端从第 1 步重跑（隧道没断）');
  } catch (error) { toast(String(error && error.message ? error.message : error), true); }
  finally { btn.disabled = false; }
};

let arenaTimer = null;
async function refreshArena() {
  const state = await window.bridgeHost.arenaState();
  if (state.open && state.expiresAt) $('arenaCountdown').dataset.until = String(state.expiresAt);
  renderArenaState(state);
  await refreshArenaPairRequests();
}

/**
 * Lists pairing requests that are waiting for a local decision, and offers the approve action.
 *
 * These are NOT write approvals and deliberately do not live on the 待办 page: a pairing request
 * arrives before any run or patch exists, so 待办 (which lists `approvals`) is empty at exactly
 * the moment the operator needs to act. Until this existed, a request really did arrive and sit
 * at `state: pending` in the database while the window showed nothing to approve anywhere — the
 * operator reasonably concluded the request had never been sent.
 */
async function refreshArenaPairRequests() {
  const host = $('arenaPairRequests');
  if (!host) return;
  let pending = [];
  try {
    const status = await api('/admin/v1/status');
    pending = status.pairings || [];
  } catch (error) {
    // Never leave a stale "no requests" impression when the lookup itself failed: that is the
    // exact false negative this panel exists to prevent.
    host.innerHTML = '<div class="arena-pair-none">无法读取配对请求：' + esc(error.message) + '</div>';
    return;
  }
  if (!pending.length) {
    host.innerHTML = '<div class="arena-pair-none">等待远端 Agent 请求配对…（本页每秒自动刷新）</div>';
    return;
  }
  host.innerHTML = pending.map((p) => {
    const left = p.expires_at - Date.now();
    const minutes = left > 0 ? Math.ceil(left / 60000) : 0;
    return '<div class="arena-pair-card" data-pair="' + escAttr(p.pair_id) + '" data-ws="' + escAttr(p.workspace_id)
      + '" data-access="' + escAttr(p.requested_access || p.max_access || 'ask') + '">'
      + '<div class="arena-pair-head"><strong>收到配对请求</strong>'
      + '<span class="muted">' + minutes + ' 分钟后过期</span></div>'
      + '<dl class="kv">'
      + '<dt>来自</dt><dd>' + esc(p.remote_label || p.recipient || '未标注') + '</dd>'
      + '<dt>请求权限</dt><dd>' + esc(p.requested_access || p.max_access || '—')
      + ' <span class="muted">（' + esc(tierLabel(p.requested_access || p.max_access)) + '）</span></dd>'
      + '<dt>pair_id</dt><dd class="mono">' + esc(p.pair_id) + '</dd>'
      + '</dl>'
      + '<p class="arena-warn">批准后，这个远端 Agent 即可通过隧道读取该工作区。读取内容会离开本机。</p>'
      + '<div class="btn-row">'
      + '<button class="btn-primary arena-approve">批准</button>'
      + '<button class="btn-danger arena-deny">拒绝</button>'
      + '</div>'
      + '</div>';
  }).join('');
}

/** Sends the decision the daemon expects for one pairing request. */
async function decidePairing(pairId, approve, accessMode) {
  const body = { approve, access_mode: accessMode, data_egress_ack: true };
  return api('/admin/v1/pairings/' + encodeURIComponent(pairId) + '/decision', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// Delegated so the buttons survive the panel being re-rendered every second.
$('arenaPairRequests').addEventListener('click', async (event) => {
  const button = event.target.closest('.arena-approve, .arena-deny');
  if (!button) return;
  const card = button.closest('.arena-pair-card');
  if (!card) return;
  const pairId = card.dataset.pair;
  const approve = button.classList.contains('arena-approve');
  // The daemon requires an explicit access_mode and refuses one that exceeds what was requested,
  // so echoing the request back can never grant more than was asked for.
  //
  // This used to keep its own list — `code` and `plan` passed through, everything else became
  // `ask` — and that is exactly how `exec` was silently downgraded: the operator approved a
  // request for `exec`, the remote received `ask`, and the mismatch read as "the exec tier never
  // took effect". A whitelist here can only ever *lose* a tier the daemon already accepted.
  const accessMode = card.dataset.access || 'ask';

  for (const b of card.querySelectorAll('button')) b.disabled = true;
  button.textContent = approve ? '批准中…' : '拒绝中…';
  try {
    await decidePairing(pairId, approve, accessMode);
    toast(approve ? '已批准。回 Arena 告诉它「已批准」。' : '已拒绝这条配对请求。');
    await refreshArenaPairRequests();
  } catch (error) {
    for (const b of card.querySelectorAll('button')) b.disabled = false;
    button.textContent = approve ? '批准' : '拒绝';
    toast('操作失败：' + error.message, true);
  }
});

// ---------- refresh orchestration ----------

async function refreshStatus() {
  const status = await api('/admin/v1/status');
  S.workspaces = status.workspaces || [];
  S.runs = status.runs || [];
  S.approvals = status.approvals || [];
  renderWorkspace();
}

async function refreshPending() {
  await refreshStatus();
  renderPending();
  tickCountdowns();
  $('pendingStamp').textContent = '更新于 ' + clockOf(Date.now());
  if ($('notifyToggle').checked) {
    for (const a of S.approvals) {
      if (S.notified.has(a.id)) continue;
      S.notified.add(a.id);
      try { new Notification('ArenaBridge：有新的写请求', { body: a.description || '远端请求修改工作区文件' }); } catch { /* ignore */ }
    }
  }
}

async function refreshEvents() {
  const data = await api('/admin/v1/events?after=0');
  S.events = data.events || [];
}

async function refreshActivity() { await refreshEvents(); renderActivity(); }
async function refreshGrants() { await refreshEvents(); renderGrants(); }
async function refreshRawEvents() { await refreshEvents(); $('events').textContent = JSON.stringify(S.events, null, 2); }

// Skills. The list is metadata only — the same progressive-disclosure rule the daemon's
// `list_skills` follows — so this panel can show every installed skill without pulling any of
// their text into the window.
async function refreshSkills() {
  renderSkills(await window.bridgeHost.skillsList());
}

function renderSkills(data) {
  const list = $('skillsList');
  list.textContent = '';
  const skills = data?.skills ?? [];
  $('skillsRoot').textContent = data?.roots?.length ? `安装到 ${data.roots[0]}` : '';
  $('skillsStatus').textContent = skills.length
    ? `已安装 ${skills.length} 个技能`
    : '还没有安装任何技能。点上面的按钮，选一个包含 SKILL.md 的目录。';

  for (const skill of skills) {
    const row = document.createElement('div');
    row.className = 'skill-row';
    const head = document.createElement('div');
    head.className = 'skill-head';
    const name = document.createElement('strong');
    name.textContent = skill.name;
    const count = document.createElement('span');
    count.className = 'muted';
    count.textContent = `${skill.file_count} 个文件`;
    const remove = document.createElement('button');
    remove.className = 'ghost';
    remove.textContent = '删除';
    remove.onclick = async () => {
      if (!window.confirm(`删除技能「${skill.name}」？`)) return;
      try {
        await window.bridgeHost.skillsRemove(skill.name);
        toast(`已删除 ${skill.name}`);
        await refreshSkills();
      } catch (error) { toast(error.message, true); }
    };
    head.append(name, count, remove);
    const description = document.createElement('p');
    description.className = 'muted';
    description.textContent = skill.description;
    row.append(head, description);
    // `allowed-tools` is shown and labelled for what it is: a claim by the skill, not a permission
    // this bridge grants. Showing it without that label would read as a capability.
    if (skill['allowed-tools']) {
      const declared = document.createElement('p');
      declared.className = 'muted';
      declared.textContent = `技能自称可用的工具：${skill['allowed-tools']}（仅展示，不授予权限）`;
      row.append(declared);
    }
    list.append(row);
  }

  // A skill that failed validation, or one shadowed by a same-named skill in an earlier root, is
  // reported rather than hidden: "not installed" and "installed but silently not loading" are
  // indistinguishable from the outside, and only the operator can act on the difference.
  const problems = [
    ...(data?.invalid ?? []),
    ...(data?.shadowed ?? []).map((s) => ({ directory: s.directory, reason: `被 ${s.shadowed_by} 遮蔽` })),
  ];
  const box = $('skillsProblems');
  box.hidden = problems.length === 0;
  box.textContent = '';
  if (problems.length) {
    const title = document.createElement('p');
    title.className = 'muted';
    title.textContent = `${problems.length} 个目录没有被加载：`;
    box.append(title);
    for (const problem of problems) {
      const line = document.createElement('p');
      line.className = 'muted';
      line.textContent = `${problem.directory} — ${problem.reason}`;
      box.append(line);
    }
  }
}

function switchView(view) {
  S.currentView = view;
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('active', b.dataset.view === view);
  for (const s of document.querySelectorAll('.view')) s.classList.toggle('active', s.dataset.view === view);
  const loaders = { pending: refreshPending, arena: refreshArena, activity: refreshActivity, files: async () => {}, grants: refreshGrants, events: refreshRawEvents, skills: refreshSkills };
  (loaders[view] || (async () => {}))().catch((e) => toast(e.message, true));
  if (view === 'arena' && !arenaTimer) {
    arenaTimer = setInterval(() => {
      tickArenaCountdown();
      // A pairing request appears only after the remote agent has been handed the prompt, so the
      // operator is told to "wait for it to show up". Polling is what makes that true rather than
      // a claim: without it the panel would only ever refresh when the tab is re-entered, and a
      // request that arrived a second later would look like it never came.
      if (S.currentView === 'arena' && S.arenaOpen) refreshArenaPairRequests().catch(() => {});
    }, 1000);
  }
}

// ---------- workspace switching ----------

async function applyWorkspace(result) {
  // The daemon may have been restarted even when the switch FAILED: the failure path restores
  // the previous workspace, which is a fresh daemon with fresh ports. The bootstrap payload
  // rides in the result on both paths, so apply it before doing anything else — a failed
  // switch otherwise left the window polling a dead bridge with no explanation.
  if (result) applyBoot(result.boot);
  if (!result || !result.changed) {
    if (result && result.error) toast(result.error, true);
    // The restore restart means the tree and pending list may be stale against the new daemon;
    // refresh them so the window shows what the bridge actually serves now.
    if (result && result.boot) {
      await loadTree({ force: true }).catch(() => {});
      await refreshPending().catch(() => {});
    }
    return;
  }
  S.diffCache.clear(); S.selectedFile = null; S.notified.clear();
  renderWorkspace();
  $('fileView').innerHTML = '<div class="tree-empty">尚未选择文件</div>';
  $('fileLabel').textContent = '选择左侧文件查看内容';
  await loadTree();
  await refreshPending();
  toast('已切换到 ' + baseName(S.prefs.workspaceRoot));
}

$('wsButton').onclick = async () => { await applyWorkspace(await window.bridgeHost.chooseWorkspace()); };
$('revokeBtn').onclick = async () => {
  if (!confirm('撤销全部远端授权？旧配对链接、旧 token 和旧会话将不能再发起新动作。')) return;
  try {
    const r = await api('/admin/v1/revoke-all', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    toast('已撤销 ' + r.revoked_grants + ' 个授权（epoch ' + r.epoch + '）');
    await refreshGrants();
  } catch (e) { toast(e.message, true); }
};
// `force`: the operator pressed refresh, so repaint even when the signature says nothing changed.
// Skipping the repaint here would make the button look dead.
$('treeRefresh').onclick = () => loadTree({ force: true }).catch((e) => toast(e.message, true));
$('evRefresh').onclick = () => refreshRawEvents().catch((e) => toast(e.message, true));
$('skillsRefresh').onclick = () => refreshSkills().catch((e) => toast(e.message, true));
$('skillsInstall').onclick = async () => {
  try {
    const source = await window.bridgeHost.skillsChoose();
    if (!source) return;
    const result = await window.bridgeHost.skillsInstall(source);
    toast(`已安装 ${result.name}（${result.files} 个文件）`);
    await refreshSkills();
  } catch (error) { toast(error.message, true); }
};
$('notifyToggle').onchange = () => {
  if ($('notifyToggle').checked && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
};
for (const b of document.querySelectorAll('#tabs button')) b.onclick = () => switchView(b.dataset.view);

window.bridgeHost.onMenu((channel) => {
  if (channel === 'menu:open-workspace') $('wsButton').click();
  else if (channel === 'menu:refresh') { loadTree({ force: true }).catch(() => {}); refreshPending().catch(() => {}); }
  else if (channel === 'menu:view-pending') switchView('pending');
  else if (channel === 'menu:view-activity') switchView('activity');
  else if (channel === 'menu:view-files') switchView('files');
});

/**
 * Resolves once the boot sequence has actually finished, or throws with the boot error.
 * Set by the boot block below; the self test awaits it so it never asserts against a
 * half-rendered window.
 */
let bootSettled;
const bootDone = new Promise((resolve, reject) => { bootSettled = { resolve, reject }; });

// ---------- boot ----------

let poll = null;
setInterval(tickCountdowns, 1000);
// Keep the unattended-write banner's countdown moving, and notice expiry locally rather than
// waiting for the next poll. The daemon is still the authority (it re-checks on every write), but
// a banner that claims "0:03 left" forever would be worse than no banner.
setInterval(() => { if (autoState.enabled) renderAutoApprove(); }, 1000);

(async () => {
  try {
    const boot = await window.bridgeHost.bootstrap();
    applyBoot(boot);
    renderWorkspace();
    await loadTree();
    await refreshPending();
    // The Arena panel names the directory it would expose, so it must be filled from the
    // start rather than only once the tab is opened — otherwise the one screen whose whole
    // job is to say *what* is being handed over shows a dash until it is too late.
    renderArenaState(await window.bridgeHost.arenaState());
    // Read the unattended-write switch at boot: it lives in the daemon's state, so a window
    // reopened while it is on (or while it has expired) must show the truth immediately rather
    // than after the first poll.
    await refreshAutoApprove();
    $('dot').className = 'dot ok';
    $('statusText').textContent = '本地运行中';
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    poll = setInterval(async () => {
      try {
        await refreshPending();
        // Keep the tree in step with the disk. Without this the file list was whatever it looked
        // like when the window booted: a remote agent could write a file, the operator could
        // approve it, and the tree would still show the old contents until the refresh button was
        // pressed. `loadTree()` compares a signature and only repaints on a real change, so this
        // does not collapse expanded folders or fight the operator's scrolling.
        await loadTree();
        // Re-read the unattended-write switch so an expiry (or a change made elsewhere) is
        // reflected in the banner without the operator having to reload the window.
        await refreshAutoApprove();
        if (S.currentView === 'activity') { await refreshEvents(); renderActivity(); }
        $('dot').className = 'dot ok'; $('statusText').textContent = '本地运行中';
      } catch {
        $('dot').className = 'dot bad'; $('statusText').textContent = '连接中断';
      }
    }, 2500);
    bootSettled.resolve();
  } catch (e) {
    $('dot').className = 'dot bad'; $('statusText').textContent = '启动失败'; toast(e.message, true);
    bootSettled.reject(e);
  }
})();

// ---------- self test ----------
// `desktop.cmd --self-test` renders the window, asserts the real data paths answered, reports
// the result, and exits. Without it there is no way to tell "the window opened" from "the
// window is showing live bridge data" — and a blank shell looks identical to a healthy one
// from the outside.
if (new URLSearchParams(location.search).get('selfTest') === '1') {
  (async () => {
    const report = { ok: true, checks: [], errors: [] };
    const check = (label, ok, detail) => { report.checks.push({ label, ok: !!ok, detail: detail === undefined ? '' : String(detail) }); if (!ok) report.ok = false; };
    check('the preload bridge is reachable', !!window.bridgeHost);
    // Wait for the real boot to finish rather than for the first field to be assigned:
    // loadTree() and refreshPending() are awaited there, so this is the true "rendered" point.
    try {
      await Promise.race([
        bootDone,
        new Promise((_r, reject) => setTimeout(() => reject(new Error('the boot sequence did not finish within 15s')), 15000)),
      ]);
    } catch (error) {
      report.errors.push(String(error && error.message ? error.message : error));
    }
    check('the main process returned an admin URL', /^http:\/\/127\.0\.0\.1:\d+$/.test(S.base), S.base);
    // The admin token must NOT reach the page: bootstrap no longer carries one, and every
    // admin-API call is proxied by the main process. If a token reappears here, the whole
    // renderer-side token story (dead-token polling, token in devtools) is back.
    const bootProbe = await window.bridgeHost.bootstrap();
    check('bootstrap hands no admin token to the renderer', !('token' in (bootProbe || {})) && typeof S.token === 'undefined',
      'token' in (bootProbe || {}) ? 'token present in the bootstrap payload' : 'absent');
    check('the workspace was reported', !!(S.workspaces[0] || S.prefs.workspaceRoot), S.workspaces[0] ? S.workspaces[0].display_name : S.prefs.workspaceRoot);
    const treeNodes = document.querySelectorAll('#tree .node').length;
    check('the file tree rendered', treeNodes > 0, treeNodes + ' node(s)');
    // The tree has to track the disk, not just render once at boot. A real report: a remote agent
    // wrote a file, the write was approved, and the list still showed the pre-write contents until
    // the refresh button was pressed. So change the disk out from under the window and require the
    // poll to notice on its own, with no refresh click.
    if (treeNodes > 0) {
      const probeName = `selftest-refresh-${Date.now()}.txt`;
      const listed = () => [...document.querySelectorAll('#tree .node')].some((n) => n.textContent.includes(probeName));
      // One poll interval is 2500 ms; wait through a few cycles before calling it a failure.
      const waitFor = async (predicate) => {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          if (predicate()) return true;
          await new Promise((r) => setTimeout(r, 400));
        }
        return predicate();
      };
      try {
        await window.bridgeHost.selfTestFixture('create', probeName);
        const seen = await waitFor(listed);
        check('the file tree picks up a new file without pressing refresh', seen,
          seen ? probeName : `${probeName} never appeared within 10s — the tree is not polling`);
      } catch (e) {
        check('the tree auto-refresh probe could create a file', false, String(e && e.message ? e.message : e));
      }
      // The removal check is about the tree, but the cleanup is about the fixture: the workspace
      // this runs against is shared, and a leftover probe file makes other suites that assert the
      // directory contents exactly (daemon-gateway D02) fail for reasons that have nothing to do
      // with them. So delete first, unconditionally, and only then assert on the tree.
      let cleaned = true;
      try {
        await window.bridgeHost.selfTestFixture('delete', probeName);
      } catch (e) {
        cleaned = false;
        check('the tree auto-refresh probe could delete its file', false, String(e && e.message ? e.message : e));
      }
      if (cleaned) {
        const gone = await waitFor(() => !listed());
        check('the file tree drops a removed file without pressing refresh', gone,
          gone ? 'removed' : `${probeName} still listed after removal`);
      }
      // Belt and braces: if anything above threw unexpectedly, the file must still not survive the
      // run. A second delete of an already-deleted file is a no-op (`force: true`).
      try { await window.bridgeHost.selfTestFixture('delete', probeName); } catch { /* reported above */ }

      // A folder has to render as a folder, and clicking it has to expand it.
      //
      // This was broken for as long as the tree existed: the renderer read `entry.kind` while the
      // daemon emits `type`, so every folder was rendered as a file and clicking one asked the
      // viewer to open a directory — `INVALID_ARGUMENT: Expected an ordinary file`. Nothing caught
      // it because the fixture is flat, so the folder branch never ran. The probe creates its own
      // directory, exercises the real tree, and removes it again in the `finally`.
      const dirName = `selftest-dir-${Date.now()}`;
      const nodeMatching = (predicate) => [...document.querySelectorAll('#tree .node')].find(predicate);
      // `waitFor` above answers a boolean; this one has to hand back the element, because the
      // assertions below click it.
      const waitForNode = async (predicate) => {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          const found = predicate();
          if (found) return found;
          await new Promise((r) => setTimeout(r, 300));
        }
        return predicate();
      };
      try {
        await window.bridgeHost.selfTestFixture('create', dirName);
        await window.bridgeHost.selfTestFixture('create', `${dirName}/inner.txt`);
        const dirNode = await waitForNode(() => nodeMatching((n) => n.classList.contains('dir') && n.textContent.includes(dirName)));
        check('a folder in the workspace renders as a folder, not as a file', !!dirNode,
          dirNode ? dirNode.textContent.trim() : `${dirName} never rendered with the dir class`);
        if (dirNode) {
          dirNode.click();
          const child = await waitForNode(() => nodeMatching((n) => !n.classList.contains('dir') && n.textContent.includes('inner.txt')));
          check('expanding a folder lists the files inside it', !!child,
            child ? child.textContent.trim() : 'inner.txt never appeared after expanding');
          if (child) {
            child.click();
            const rows = await waitFor(() => document.querySelectorAll('#fileView .code .row').length > 0);
            check('a file inside a folder opens in the viewer', rows,
              rows ? 'rendered' : $('fileView').textContent.trim().slice(0, 60));
          }
        }
      } catch (e) {
        check('the folder probe could create and expand a directory', false, String(e && e.message ? e.message : e));
      } finally {
        // Unconditional, and before any assertion about the tree: this runs against a shared
        // fixture, and a leftover directory would break suites that assert the root listing.
        try { await window.bridgeHost.selfTestFixture('delete', dirName); } catch { /* best effort */ }
        // Wait for the tree to notice, rather than leaving a stale node behind. The next check in
        // this run picks a text file out of the tree and opens it — with the directory gone from
        // disk but still on screen, it clicked a deleted file and reported "0 line(s)", which
        // looked like a broken viewer and was really this probe's leftover.
        const gone = await waitFor(() => !nodeMatching((n) => n.textContent.includes(dirName)));
        check('a removed folder disappears from the tree', gone,
          gone ? 'removed' : `${dirName} still listed after removal`);
      }
    }
    check('the status indicator is healthy', $('dot').className.includes('ok'), $('dot').className + ' / ' + $('statusText').textContent);
    check('the pending view rendered', $('pendingList').innerHTML.length > 0, $('pendingList').textContent.trim().slice(0, 60));
    // Exercise the file viewer against a real file so the read path is proven, not assumed.
    //
    // Pick a *text* file deliberately. The tree lists whatever the workspace holds, and the
    // first entry is often an image or another binary; the viewer is required to refuse those
    // (BINARY_FILE), so asserting "lines rendered" on whatever happens to sort first makes the
    // check depend on the directory contents rather than on the viewer working.
    //
    // `desktop.ini` is excluded: it matches the extension list but Windows stores it UTF-16,
    // so the bridge correctly refuses it as UNSUPPORTED_ENCODING. Including it would make this
    // check assert that a correctly-refused file renders.
    const textExt = /\.(?:mjs|cjs|js|ts|tsx|jsx|json|md|txt|ya?ml|toml|css|html?|py|sh|ps1|sql|csv|log)$/i;
    const files = [...document.querySelectorAll('#tree .node:not(.dir)')];
    const visible = (n) => n.textContent.trim();
    const textFile = files.find((n) => textExt.test(visible(n)) && !/^desktop\.ini$/i.test(visible(n)));
    if (textFile) {
      textFile.click();
      for (let i = 0; i < 60 && !document.querySelector('#fileView .code'); i++) await new Promise((r) => setTimeout(r, 100));
      const rows = document.querySelectorAll('#fileView .code .row').length;
      check('a text file opened in the viewer', rows > 0, rows + ' line(s) for ' + $('fileLabel').textContent);
    } else {
      check('a text file opened in the viewer', false, 'no text file in the tree');
    }
    // A refused file must end up as a readable explanation, never as a stuck "载入中…" or a
    // silent empty pane. Wait for the placeholder to be *replaced*, not merely for text to be
    // present — the placeholder itself is text, so a "not empty" poll would pass immediately
    // and assert nothing.
    const refusedFile = files.find((n) => /\.(?:png|jpe?g|gif|webp|bmp|ico|mp4|mov|mp3|zip|pdf|exe|dll)$/i.test(visible(n)));
    if (refusedFile) {
      refusedFile.click();
      const settled = () => {
        const text = $('fileView').textContent.trim();
        return text.length > 0 && !text.startsWith('载入中') ? text : '';
      };
      for (let i = 0; i < 60 && !settled(); i++) await new Promise((r) => setTimeout(r, 100));
      const shown = settled();
      check('a file that cannot be read as text settles on an explanation, not a stuck placeholder',
        shown.length > 0 && !document.querySelector('#fileView .code'),
        shown.slice(0, 50) + ' — ' + visible(refusedFile));
    }
    // --- Arena flow -----------------------------------------------------------------
    // Asserted here because the whole point of this feature is that it exists *in the
    // window*: before it, the only way to copy the prompt was arena.cmd. The tab and its
    // button must therefore be present and wired to the preload API, and the exposure
    // confirmation must be a main-process call — a renderer-only confirm() would be
    // skippable, which is exactly the guarantee the operator is relying on.
    const arenaTab = [...document.querySelectorAll('#tabs button')].find((b) => b.dataset.view === 'arena');
    check('the window has a tab for connecting a remote Agent', !!arenaTab, arenaTab ? arenaTab.textContent.trim() : 'no such tab');
    check('the connection button is present', !!$('arenaStart'), $('arenaStart') ? $('arenaStart').textContent.trim() : 'missing');
    // Ask the main process for the real state: proves the tunnel/pairing IPC path answers,
    // which the markup alone does not.
    const arena = await window.bridgeHost.arenaState();
    check('the main process reports the tunnel state', typeof arena?.open === 'boolean' && typeof arena?.workspaceRoot === 'string',
      `open=${arena?.open} workspace=${baseName(arena?.workspaceRoot || '')}`);
    check('the bridge is loopback-only until the operator exposes it', arena?.open === false && arena?.exposed === false,
      `open=${arena?.open} exposed=${arena?.exposed}`);
    // Switch to the tab and confirm the idle panel is the one showing, so a fresh window
    // never looks like something is already exposed.
    if (arenaTab) {
      arenaTab.click();
      for (let i = 0; i < 30 && $('arenaIdle').hidden; i++) await new Promise((r) => setTimeout(r, 100));
      const shown = !$('arenaIdle').hidden && $('arenaLive').hidden;
      check('the Arena tab opens on the not-connected panel', shown,
        `idle=${!$('arenaIdle').hidden} live=${!$('arenaLive').hidden}`);
      check('the exposed directory is named before anything is opened',
        $('arenaWs').textContent.trim() !== '' && $('arenaWs').textContent.trim() !== '—',
        $('arenaWs').textContent.trim());
      // The pairing-request panel. This is the fix for a real report: a request arrived and sat
      // at `pending` in the database while the window offered nothing to approve, because the
      // window had no code to list or decide pairings at all. Guard the whole path, not just the
      // markup: the panel must exist, and it must report honestly when the lookup fails.
      check('the Arena tab has a place to show pairing requests', !!$('arenaPairRequests'),
        $('arenaPairRequests') ? 'present' : 'missing');
      const pairHost = $('arenaPairRequests');
      if (pairHost) {
        // Drive it against the live daemon: this is the same call the panel makes every second.
        const status = await api('/admin/v1/status');
        check('the daemon answers the pairing list the panel reads', Array.isArray(status.pairings),
          `pairings=${Array.isArray(status.pairings) ? status.pairings.length : typeof status.pairings}`);
        check('no pairing is left awaiting approval in a fresh window', (status.pairings || []).length === 0,
          `${(status.pairings || []).length} pending`);
        // With none pending the panel must say so explicitly, so "nothing to approve" can never
        // be confused with "the panel is broken and rendered nothing".
        await refreshArenaPairRequests();
        check('the panel states plainly that it is waiting, rather than rendering nothing',
          pairHost.textContent.includes('等待远端 Agent 请求配对'),
          pairHost.textContent.trim().slice(0, 40));
      }
      // The access-mode picker. A real report: the prompt always asked for `ask` and editing it
      // to `code` failed, because every pairing code was minted with `max_access: 'ask'` and the
      // daemon refuses anything above the code's ceiling. The picker is what makes the mode a
      // choice rather than an unchangeable default, so guard that it exists, defaults to the
      // safe option, and reaches the IPC call.
      const modeInputs = [...document.querySelectorAll('input[name="arenaMode"]')];
      check('the operator can choose the access mode before connecting', modeInputs.length === 4,
        `found ${modeInputs.length} option(s)`);
      check('the access mode defaults to read-only',
        modeInputs.length === 4 && modeInputs.filter((i) => i.checked).length === 1 && modeInputs.find((i) => i.checked).value === 'ask',
        modeInputs.find((i) => i.checked)?.value ?? 'none checked');
      check('every access mode the daemon accepts is offered',
        ['ask', 'plan', 'code', 'exec'].every((m) => modeInputs.some((i) => i.value === m)),
        modeInputs.map((i) => i.value).join(','));
      // Report the whole option list, not a prefix of it. A truncated detail is how a real failure
      // reads as nonsense: the earlier run printed "只读（ask）可以读文件；任何写操作都" — cut off
      // mid-sentence by the 60-char slice, with no hint that the assertion was about `code`.
      const modeText = (value) => {
        const label = modeInputs.find((i) => i.value === value)?.closest('label');
        return label ? label.textContent.replace(/\s+/g, ' ').trim() : '';
      };
      check('code mode states that each write still needs local approval',
        /每次真正写盘前仍需你/.test(modeText('code')),
        modeText('code') || 'no code option found');
      // Read-only modes must not be described as if they could write. Both halves are checked
      // against the *right* option; matching the fieldset as a whole would pass on either mode's
      // text, which is precisely the confusion the picker is meant to remove.
      check('the read-only modes say writes are refused',
        /任何写操作都会被拒/.test(modeText('ask')) && /与 ask 一样只读/.test(modeText('plan')),
        `ask: ${modeText('ask').slice(0, 40)} | plan: ${modeText('plan').slice(0, 40)}`);
      // The exec tier is the one whose consequence is not "it can change files". It has to say, in
      // the picker itself, that there is no approval step and that it runs with the operator's own
      // privileges — a picker that lists it as "code plus a bit" would be the whole problem.
      check('exec mode states that commands run with no approval step',
        /没有批准这一步/.test(modeText('exec')) && /shell 命令/.test(modeText('exec')),
        modeText('exec') || 'no exec option found');

      // The approval path, driven with a real click.
      //
      // This is where `exec` was silently downgraded: the panel had its own list of tiers
      // (`code`/`plan` passed through, everything else became `ask`), so approving a request for
      // `exec` handed the remote a read-only grant. The operator clicked 批准 and saw success; the
      // remote reported `access_mode: "ask"`, which reads as "the exec tier never took effect".
      const savedBridgeCall = api.bridgeCall;
      const sent = [];
      try {
        api.bridgeCall = async (op, ...args) => {
          if (op === 'adminStatus') {
            return { pairings: [{ pair_id: 'pair_probe', workspace_id: 'ws_probe', requested_access: 'exec', max_access: 'exec', expires_at: Date.now() + 60000, remote_label: 'probe' }] };
          }
          sent.push({ op, args });
          return {};
        };
        await refreshArenaPairRequests();
        const approveButton = document.querySelector('#arenaPairRequests .arena-approve');
        check('an exec pairing request offers an approve action', !!approveButton, approveButton ? 'present' : 'missing');
        approveButton?.click();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const decision = sent.find((call) => call.op === 'adminPairingDecision');
        check('approving an exec request sends exec rather than a downgraded tier',
          decision?.args?.[2] === 'exec' && decision?.args?.[1] === true,
          `op=${JSON.stringify(decision?.op)} args=${JSON.stringify(decision?.args)}`);
      } finally {
        api.bridgeCall = savedBridgeCall;
        await refreshArenaPairRequests().catch(() => {});
      }
      // Prove the mode actually crosses the bridge, rather than reading a function's `.length`.
      // Arity is not a usable signal here: `(x = 1) => …` reports 0 (length stops at the first
      // defaulted parameter) and contextBridge may re-wrap the function, so a `.length` assertion
      // fails on stylistically-different but perfectly correct code.
      //
      // So invoke it — but only observe the call, never await it. `arenaConnect` opens a tunnel
      // and then blocks on a confirmation dialog; awaiting it hangs a headless run (the window
      // reported nothing, and the harness gave up after 30s). Swallowing the promise loses
      // nothing: the main process logs the mode it received before any of that work starts.
      const connectResult = window.bridgeHost.arenaConnect('code');
      if (connectResult && typeof connectResult.catch === 'function') connectResult.catch(() => undefined);
      // Give the IPC round trip a moment to land in the main process's stdout.
      await new Promise((r) => setTimeout(r, 300));

      // Unattended writes: the highest-risk control in this window. These guard the three things
      // that make it safe to offer at all — it is off unless asked for, the consequence is stated
      // where the switch is rather than only in a document, and it can be turned off from the live
      // panel without hunting for it. The switch is never *flipped* here: a self test must not
      // leave behind a machine that approves its own writes.
      const autoToggle = $('autoApproveToggle');
      check('the window offers an unattended-write switch', !!autoToggle, autoToggle ? 'present' : 'missing');
      check('unattended writes are off unless switched on', autoToggle ? autoToggle.checked === false : false,
        autoToggle ? `checked=${autoToggle.checked}` : 'no toggle');
      check('the switch states the consequence of enabling it',
        /去掉唯一的人工把关/.test($('autoApproveWarn')?.textContent ?? ''),
        ($('autoApproveWarn')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 64));
      check('the switch names prompt injection as the risk',
        /提示注入/.test($('autoApproveWarn')?.textContent ?? ''), 'mentions 提示注入');
      // The 有效时长 control. This used to be a <label> wrapping the <select>, which made the
      // select the label's implicit control — and a label click toggles its control's popup, so
      // the click that opened the dropdown also closed it and the value never changed ("不可选").
      // The structural assertion is the regression guard: if the select is inside a label again,
      // `closest('label')` finds one and this check fails.
      const ttlSel = $('autoApproveTtl');
      check('the duration control exists', !!ttlSel, ttlSel ? 'present' : 'missing');
      check('the duration control is selectable (not nested in a label)',
        !!ttlSel && !ttlSel.closest('label'),
        ttlSel ? (ttlSel.closest('label') ? 'nested in <label> — clicks would toggle the popup' : 'not inside a label') : 'no control');
      check('the duration control offers an unlimited option',
        !!ttlSel && Array.from(ttlSel.options).some((o) => o.value === '0'),
        ttlSel ? Array.from(ttlSel.options).map((o) => o.value).join(',') : 'no control');
      // Selecting a value must actually stick — the point of the bug report was that it did not.
      if (ttlSel) {
        ttlSel.value = '1800000';
        check('picking a duration value takes effect', ttlSel.value === '1800000', `value=${ttlSel.value}`);
        ttlSel.value = '0';
        check('picking unlimited takes effect', ttlSel.value === '0' && selectedTtl() === 0,
          `value=${ttlSel.value} selectedTtl=${selectedTtl()}`);
        // The note beside the control must not describe a deadline that will not happen.
        renderTtlNote();
        check('the note says there is no expiry when unlimited is picked',
          /不会自动失效/.test($('autoApproveTtlNote')?.textContent ?? '') && !/到期自动失效/.test($('autoApproveTtlNote')?.textContent ?? ''),
          ($('autoApproveTtlNote')?.textContent ?? '').trim());
        ttlSel.value = '600000';
        renderTtlNote();
        check('the note goes back to describing a deadline when a duration is picked',
          /到期自动失效/.test($('autoApproveTtlNote')?.textContent ?? ''),
          ($('autoApproveTtlNote')?.textContent ?? '').trim());
      }
      check('there is a way to switch it off from the live panel', !!$('arenaAutoOff'),
        $('arenaAutoOff') ? 'present' : 'missing');
      // Hidden while off, but it must exist: a banner that cannot render would leave the operator
      // believing the absence of a warning meant the absence of the setting.
      check('a warning banner exists for the on state', !!$('arenaAutoBanner'),
        $('arenaAutoBanner') ? 'present' : 'missing');
      // And the daemon's own answer must be readable from the window, or the banner could never
      // become accurate. Read-only on purpose.
      const autoFromDaemon = await window.bridgeHost.arenaAutoApprove();
      check('the window can read the unattended-write state', typeof autoFromDaemon?.enabled === 'boolean',
        `enabled=${JSON.stringify(autoFromDaemon?.enabled)}`);
      check('the daemon reports unattended writes as off in a fresh window', autoFromDaemon?.enabled === false,
        `enabled=${JSON.stringify(autoFromDaemon?.enabled)}`);
      // The two sentences an operator reads while it is on. The switch itself is never flipped
      // here — a self test must not leave behind a machine that approves its own writes — so the
      // state is simulated and restored, and what is asserted is the display branch: an unlimited
      // window must not be given a countdown, and the mode label must stop claiming supervision.
      const savedAuto = autoState;
      try {
        autoState = { enabled: true, expiresAt: 0, unlimited: true };
        renderAutoApprove();
        const bannerText = $('arenaAutoBanner')?.textContent ?? '';
        check('an unlimited window is announced as one that never expires',
          $('arenaAutoBanner')?.hidden === false && /不会自动失效/.test(bannerText) && !/剩余/.test(bannerText),
          bannerText.replace(/\s+/g, ' ').trim().slice(0, 60));
        renderArenaState({ open: true, accessMode: 'code', workspaceRoot: '-', publicUrl: '-', pairingCode: '-', grantTtlMs: 3600000 });
        const modeText = $('arenaModeLabel')?.textContent ?? '';
        check('the live panel stops saying writes are supervised while unattended is on',
          /无人值守/.test(modeText) && !/仍需/.test(modeText), modeText);
        // The remote's credential is a second clock, and the one that catches people out. A timed
        // grant has to state its deadline; a session-scoped one must say what actually ends it,
        // because "no expiry" would be wrong in the one case that matters.
        const ttlText = $('arenaGrantTtl')?.textContent ?? '';
        check('the live panel states a timed grant deadline and how to renew it',
          /60 分钟/.test(ttlText) && /重新签发/.test(ttlText), ttlText);
        renderArenaState({ open: true, accessMode: 'code', workspaceRoot: '-', publicUrl: '-', pairingCode: '-', grantTtlMs: 0 });
        const sessionText = $('arenaGrantTtl')?.textContent ?? '';
        check('a session-scoped grant says what ends it instead of claiming to never expire',
          /跟随本次 bridge 会话/.test(sessionText) && /关窗/.test(sessionText) && !/分钟到期/.test(sessionText),
          sessionText);
        check('there is a way to re-pair without tearing the tunnel down', !!$('arenaReissue'),
          $('arenaReissue') ? 'present' : 'missing');
      } finally {
        autoState = savedAuto;
        renderAutoApprove();
      }
    }

    // Skills. Two things are asserted: that the panel exists and states the read-only boundary,
    // and that what it renders is metadata — the same progressive-disclosure rule the daemon
    // enforces on `list_skills`. A panel that rendered bodies would look identical in a screenshot
    // and would quietly undo the point of the format.
    const skillsView = document.querySelector('.view[data-view="skills"]');
    check('there is a skills tab', !!document.querySelector('#tabs button[data-view="skills"]'));
    check('there is a skills panel', !!skillsView);
    check('the skills panel offers an install button', !!$('skillsInstall'), $('skillsInstall') ? 'present' : 'missing');
    const skillsProse = skillsView?.textContent ?? '';
    check('the skills panel states that a skill cannot execute anything',
      /只读/.test(skillsProse) && /不授予任何执行权/.test(skillsProse), skillsProse.slice(0, 80));
    renderSkills({ roots: ['/tmp/skills'], skills: [{ name: 'demo-skill', description: 'A skill used by the self test.', file_count: 3, 'allowed-tools': 'Bash(git:*) Read' }], invalid: [], shadowed: [] });
    const skillsText = $('skillsList')?.textContent ?? '';
    check('the panel renders a skill name and description', /demo-skill/.test(skillsText) && /used by the self test/.test(skillsText), skillsText);
    check('the panel labels allowed-tools as a claim rather than a permission', /仅展示，不授予权限/.test(skillsText), skillsText);
    renderSkills({ roots: ['/tmp/skills'], skills: [], invalid: [{ directory: '/x/broken', reason: 'name is required' }], shadowed: [] });
    check('a skill that failed validation is surfaced rather than hidden',
      /name is required/.test($('skillsProblems')?.textContent ?? ''), $('skillsProblems')?.textContent);
    await window.bridgeHost.selfTestResult(report);
  })().catch((e) => window.bridgeHost.selfTestResult({ ok: false, checks: [], errors: [String(e && e.message ? e.message : e)] }));
}

window.addEventListener('error', (event) => {
  if (new URLSearchParams(location.search).get('selfTest') === '1') {
    void window.bridgeHost.selfTestResult({ ok: false, checks: [], errors: ['window error: ' + event.message] });
  }
});
