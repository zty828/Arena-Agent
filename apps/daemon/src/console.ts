/**
 * Self-contained local admin console. It ships no data: every panel is populated
 * by authenticated same-origin calls to the admin API, and the token is kept in
 * sessionStorage only. No external assets, no CDN, no telemetry.
 *
 * This is the operator-facing half of the bridge. The remote model does the
 * reasoning; this page is how a human stays in the loop: approve writes, watch a
 * run, and pull the plug. It holds no privileges of its own — every action it
 * offers is an existing admin endpoint, so the page can never widen the trust
 * boundary it is displaying.
 */
export const CONSOLE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ArenaBridge 本地控制台</title>
<style>
  :root { color-scheme: light; --line:#d9d9d6; --muted:#6b6b68; --bg:#faf9f7; --panel:#fff; --accent:#1f5fa8; --warn:#8a5300; --danger:#a32d2d; --ok:#2f6b2f; --add:#e6f4ea; --del:#fce8e8; }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif; background:var(--bg); color:#1c1c1a; }
  header { padding:14px 20px; background:var(--panel); border-bottom:1px solid var(--line); display:flex; gap:16px; align-items:center; flex-wrap:wrap; }
  h1 { font-size:15px; font-weight:500; margin:0; }
  .badge { font-size:12px; padding:2px 8px; border-radius:999px; border:1px solid var(--line); color:var(--muted); }
  .badge.blocked { border-color:#e0b4b4; color:var(--danger); }
  .badge.ok { border-color:#b4d3b4; color:var(--ok); }
  .badge.alert { background:var(--danger); border-color:var(--danger); color:#fff; font-weight:600; }
  main { padding:20px; max-width:1180px; }
  .gate { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:18px; max-width:620px; }
  .gate p { margin:0 0 12px; color:var(--muted); font-size:13px; }
  input[type=password], input[type=text] { width:100%; padding:8px 10px; border:1px solid var(--line); border-radius:7px; font:13px/1.5 ui-monospace,Consolas,monospace; }
  select { padding:7px 9px; border:1px solid var(--line); border-radius:7px; background:var(--panel); font:13px/1.5 inherit; }
  button { font:13px/1.5 inherit; padding:7px 13px; border:1px solid var(--line); background:var(--panel); border-radius:7px; cursor:pointer; }
  button:hover { border-color:#b9b9b5; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  button.danger { color:var(--danger); border-color:#e0b4b4; }
  nav { display:flex; gap:6px; margin:0 0 16px; flex-wrap:wrap; }
  nav button[aria-current=true] { background:#eceae6; border-color:#c9c9c5; font-weight:600; }
  nav button .count { display:inline-block; min-width:17px; margin-left:6px; padding:0 5px; border-radius:999px; background:var(--danger); color:#fff; font-size:11px; font-weight:600; }
  section { display:none; } section[data-active=true] { display:block; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:16px; margin-bottom:14px; }
  .card h2 { font-size:14px; font-weight:500; margin:0 0 10px; }
  pre { margin:0; padding:12px; background:#f6f5f3; border:1px solid var(--line); border-radius:8px; overflow:auto; max-height:420px; font:12px/1.55 ui-monospace,Consolas,monospace; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { text-align:left; padding:7px 9px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:500; }
  .row-actions { display:flex; gap:6px; }
  .note { font-size:12px; color:var(--warn); margin-top:10px; }
  .muted { color:var(--muted); }
  .toolbar { display:flex; gap:8px; align-items:center; margin-bottom:12px; flex-wrap:wrap; }
  .err { color:var(--danger); font-size:13px; margin-top:8px; }

  /* Pending-approval cards: the one thing that must never be missable. */
  .pend { border:1px solid #e0b4b4; border-left:3px solid var(--danger); border-radius:9px; padding:13px 15px; margin-bottom:11px; background:#fffbfb; }
  .pend .head { display:flex; gap:12px; align-items:baseline; flex-wrap:wrap; margin-bottom:9px; }
  .pend .title { font-weight:600; }
  .pend .countdown { font:12px/1.5 ui-monospace,Consolas,monospace; color:var(--danger); }
  .pend .countdown.expired { color:var(--muted); text-decoration:line-through; }
  .kv { display:grid; grid-template-columns:88px 1fr; gap:3px 10px; font-size:12.5px; margin-bottom:10px; }
  .kv dt { color:var(--muted); } .kv dd { margin:0; overflow-wrap:anywhere; }
  .diff { font:12px/1.5 ui-monospace,Consolas,monospace; border:1px solid var(--line); border-radius:7px; overflow:auto; max-height:330px; background:#fff; margin-bottom:10px; }
  .diff .file { padding:5px 10px; background:#f6f5f3; border-bottom:1px solid var(--line); color:var(--muted); position:sticky; top:0; }
  .diff .line { padding:0 10px; white-space:pre; }
  .diff .add { background:var(--add); }
  .diff .del { background:var(--del); }
  .diff .hunk { color:var(--accent); background:#f2f6fb; }
  .empty { padding:22px; text-align:center; color:var(--muted); background:var(--panel); border:1px dashed var(--line); border-radius:10px; }

  /* Run timeline */
  .tl { border-left:2px solid var(--line); margin-left:7px; padding-left:15px; }
  .tl .ev { position:relative; padding:4px 0; font-size:13px; }
  .tl .ev::before { content:''; position:absolute; left:-21px; top:11px; width:8px; height:8px; border-radius:50%; background:var(--line); }
  .tl .ev.ok::before { background:var(--ok); }
  .tl .ev.bad::before { background:var(--danger); }
  .tl .ev.wait::before { background:var(--warn); }
  .tl .ev .t { color:var(--muted); font:11.5px/1.5 ui-monospace,Consolas,monospace; margin-right:8px; }
  .tl .ev .meta { color:var(--muted); font:11.5px/1.5 ui-monospace,Consolas,monospace; }
  .run-head { display:flex; gap:10px; align-items:baseline; flex-wrap:wrap; margin-bottom:4px; }
  .run-head code { font-size:12px; }
</style>
</head>
<body>
<header>
  <h1>ArenaBridge 本地控制台</h1>
  <span class="badge" id="ver">版本 —</span>
  <span class="badge blocked" id="arena">Arena：blocked</span>
  <span class="badge" id="stage">stage</span>
  <span class="badge ok" id="link">实时连接中…</span>
  <span style="flex:1"></span>
  <button id="signout" hidden>退出</button>
</header>
<main>
  <div class="gate" id="gate">
    <p>这是一个只监听 <strong>127.0.0.1</strong> 的本地控制台。远端的模型只能请求，<strong>动手的永远是你</strong>。</p>
    <p style="margin:0 0 12px">请粘贴 <code>admin_token</code>——它来自 <code>.arena-bridge/local-credentials.json</code>。<br>
    <strong>不要粘贴配对码</strong>：配对码和 admin_token 都是 43 个字符的随机串，肉眼分不出来，但配对码是给远端 Agent 用的，不是用来登录控制台的。</p>
    <input type="password" id="token" placeholder="admin_token（不是配对码）" autocomplete="off" spellcheck="false">
    <div class="toolbar" style="margin-top:12px">
      <button class="primary" id="unlock">解锁</button>
      <span class="muted" id="gateMsg"></span>
    </div>
    <div class="err" id="gateErr"></div>
  </div>

  <div id="app" hidden>
    <nav>
      <button data-tab="pending" aria-current="true">待办<span class="count" id="pendCount" hidden>0</span></button>
      <button data-tab="activity">活动</button>
      <button data-tab="grants">授权台账</button>
      <button data-tab="pairings">配对</button>
      <button data-tab="tools">工具</button>
      <button data-tab="events">原始事件</button>
      <button data-tab="caps">能力与边界</button>
    </nav>

    <section data-tab="pending" data-active="true">
      <div class="toolbar">
        <button id="pRefresh">刷新</button>
        <label class="muted" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="notify"> 有新写请求时提醒我</label>
        <span class="muted" id="pStamp"></span>
      </div>
      <div id="pendingArea"></div>
    </section>

    <section data-tab="activity">
      <div class="card">
        <h2>运行时间线</h2>
        <p class="muted" style="margin:0 0 10px">按 run 分组，来自 bridge 自己的审计日志。远端 Agent 的自述不算证据，这里才是。</p>
        <div id="timeline"></div>
      </div>
    </section>

    <section data-tab="grants">
      <div class="card">
        <h2>当前远端能做什么</h2>
        <p class="muted" style="margin:0 0 10px">每个授权绑定一个 run 和一个工作区。<code>ask</code>/<code>plan</code> 只能读；<code>code</code> 可以改文件，但每次都要你在「待办」里批。</p>
        <div id="grantList"></div>
      </div>
      <div class="card">
        <h2>危险操作</h2>
        <p class="muted" style="margin:0 0 10px">撤销全部远端授权会立即阻止新的远端动作，但不会终止已在运行的命令，也不会撤销已发生的写入。</p>
        <button class="danger" id="revoke">撤销全部授权</button>
      </div>
    </section>

    <section data-tab="pairings">
      <div class="card">
        <h2>新建一次性配对邀请</h2>
        <p class="muted" style="margin:0 0 10px">配对码短时有效、单次使用。在审批之前，对方没有任何文件权限。</p>
        <div class="toolbar">
          <select id="pWorkspace"></select>
          <select id="pAccess">
            <option value="ask">ask（只读）</option>
            <option value="plan">plan（只读）</option>
            <option value="code">code（可改文件，需逐次审批）</option>
            <!-- The console is a real operator surface, and it could not mint the one tier whose
                 whole point is being chosen deliberately. -->
            <option value="exec">exec（可改文件 + 直接执行命令，命令无审批）</option>
          </select>
          <input type="text" id="pRecipient" placeholder="接收方描述，例如：我的测试客户端" style="max-width:320px">
          <button class="primary" id="pCreate">生成邀请</button>
        </div>
        <div class="err" id="pErr"></div>
        <pre id="pResult" hidden></pre>
      </div>
      <div class="card"><h2>等待本机批准的配对</h2><div id="pendingPairings"></div></div>
    </section>

    <section data-tab="tools">
      <div class="card"><h2>工作区工具 schema</h2><pre id="tools"></pre></div>
    </section>

    <section data-tab="events">
      <div class="toolbar"><button id="evRefresh">刷新</button><span class="muted">已脱敏：只含摘要与哈希，不含文件正文或凭据</span></div>
      <div class="card"><pre id="events"></pre></div>
    </section>

    <section data-tab="caps">
      <div class="card"><h2>能力矩阵（后端实际事实）</h2><pre id="caps"></pre></div>
    </section>
  </div>
</main>
<script>
const $ = (id) => document.getElementById(id);
const state = { token: '', workspaces: [], runs: [], approvals: [], lastEventSeq: 0, diffCache: new Map(), notified: new Set() };

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { Authorization: 'Bearer ' + state.token, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const text = await response.text();
  let data; try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
  if (!response.ok) throw new Error((data && data.error && (data.error.code + ': ' + data.error.message)) || ('HTTP ' + response.status));
  return data;
}
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const show = (id, value) => { const el = $(id); el.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); };
const short = (value) => String(value ?? '').slice(0, 20);
const clock = (ms) => new Date(ms).toLocaleTimeString();

function table(container, columns, rows, render) {
  const el = $(container);
  if (!rows.length) { el.innerHTML = '<p class="muted">暂无数据。</p>'; return; }
  el.innerHTML = '<table><thead><tr>' + columns.map((c) => '<th>' + esc(c) + '</th>').join('') + '</tr></thead><tbody>'
    + rows.map((row) => '<tr>' + render(row).map((cell) => '<td>' + cell + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
}

/** Render a unified diff without trusting it as HTML: colours only from line prefixes. */
function diffHtml(diff) {
  const body = String(diff || '').split('\\n').map((line) => {
    const cls = line.startsWith('+') && !line.startsWith('+++') ? 'add'
      : line.startsWith('-') && !line.startsWith('---') ? 'del'
      : line.startsWith('@@') ? 'hunk' : '';
    return '<div class="line ' + cls + '">' + esc(line) + '</div>';
  }).join('');
  return body;
}

async function fetchDiff(patchId, workspaceId) {
  if (state.diffCache.has(patchId)) return state.diffCache.get(patchId);
  try {
    const preview = await api('/admin/v1/workspaces/' + encodeURIComponent(workspaceId) + '/patches/' + encodeURIComponent(patchId));
    state.diffCache.set(patchId, preview);
    return preview;
  } catch { state.diffCache.set(patchId, null); return null; }
}

// --- Pending work: the highest-value view. A missed approval parks the remote
// --- run until it expires, so this must be loud and one-click.

function renderPending() {
  const area = $('pendingArea');
  const items = state.approvals;
  const badge = $('pendCount');
  badge.hidden = items.length === 0;
  badge.textContent = String(items.length);
  if (!items.length) {
    area.innerHTML = '<div class="empty">目前没有等待你批准的写操作。<br><span class="muted">远端 Agent 每次改文件都会在这里出现，批准前磁盘不会被改动。</span></div>';
    return;
  }
  area.innerHTML = items.map((a) => {
    // Approvals do not carry a workspace_id; the run does. Resolve it, and fall
    // back to the single mounted workspace when the run is not listable.
    const run = state.runs.find((r) => r.id === a.run_id);
    const workspaceId = (run && run.workspace_id) || (state.workspaces[0] && state.workspaces[0].id) || '';
    const left = a.expires_at - Date.now();
    const expired = left <= 0;
    return '<div class="pend" data-approval-card="' + esc(a.id) + '" data-workspace="' + esc(workspaceId) + '">'
      + '<div class="head"><span class="title">请求修改工作区文件</span>'
      + '<span class="countdown' + (expired ? ' expired' : '') + '" data-countdown="' + a.expires_at + '"></span></div>'
      + '<dl class="kv">'
      + '<dt>说明</dt><dd>' + esc(a.description || '') + '</dd>'
      + '<dt>参数摘要</dt><dd><code>' + esc(String(a.params_hash || '').slice(0, 24)) + '…</code></dd>'
      + '<dt>Run</dt><dd><code>' + esc(short(a.run_id)) + '…</code></dd>'
      + '</dl>'
      + '<div class="diff" id="diff-' + esc(a.id) + '"><div class="line muted">正在读取 diff…</div></div>'
      + '<div class="row-actions">'
      + '<button class="primary" data-approval="' + esc(a.id) + '" data-approve="true">允许这次修改</button>'
      + '<button class="danger" data-approval="' + esc(a.id) + '" data-approve="false">拒绝</button>'
      + '</div></div>';
  }).join('');
  for (const button of document.querySelectorAll('[data-approval]')) {
    button.onclick = async () => {
      const approve = button.dataset.approve === 'true';
      if (!confirm(approve ? '允许这次写入？补丁会立即应用到工作区文件。' : '拒绝这次写入？远端会收到拒绝，文件不会改变。')) return;
      try {
        await api('/admin/v1/approvals/' + encodeURIComponent(button.dataset.approval) + '/decision', { method: 'POST', body: JSON.stringify({ approve }) });
      } catch (error) { alert(String(error.message)); }
      await refreshPending();
    };
  }
  // Fill diffs asynchronously so the buttons appear immediately.
  for (const item of items) {
    const patchId = /patch_[a-z0-9-]+/i.exec(item.description || '');
    const host = $('diff-' + item.id);
    if (!patchId || !host) continue;
    const workspaceId = (host.closest('[data-workspace]') || {}).dataset?.workspace || '';
    if (!workspaceId) { host.innerHTML = '<div class="line muted">无法确定工作区，diff 未加载</div>'; continue; }
    fetchDiff(patchId[0], workspaceId).then((preview) => {
      if (!preview || !preview.changes) { host.innerHTML = '<div class="line muted">diff 不可用（补丁可能已被清理）</div>'; return; }
      host.innerHTML = preview.changes.map((change) =>
        '<div class="file">' + esc(change.path) + '</div>' + diffHtml(change.diff)
      ).join('');
    });
  }
}

function tickCountdowns() {
  for (const el of document.querySelectorAll('[data-countdown]')) {
    const left = Number(el.dataset.countdown) - Date.now();
    if (left <= 0) { el.textContent = '已过期'; el.classList.add('expired'); continue; }
    const s = Math.ceil(left / 1000);
    el.textContent = s >= 60 ? Math.floor(s / 60) + '分' + String(s % 60).padStart(2, '0') + '秒后过期' : s + '秒后过期';
  }
}

async function refreshPending() {
  const status = await api('/admin/v1/status');
  state.workspaces = status.workspaces || [];
  state.runs = status.runs || [];
  state.approvals = status.approvals || [];
  renderPending();
  tickCountdowns();
  $('pStamp').textContent = '更新于 ' + new Date().toLocaleTimeString();
  // Only alert for approvals we have not already announced.
  if ($('notify').checked) {
    for (const a of state.approvals) {
      if (state.notified.has(a.id)) continue;
      state.notified.add(a.id);
      try { new Notification('ArenaBridge：有新的写请求等待批准', { body: a.description || '远端 Agent 请求修改工作区文件' }); } catch { /* permission denied, ignore */ }
    }
  }
}

// --- Activity: turn the audit log into something a human reads in one pass. ---

const EVENT_TEXT = {
  'daemon.started': ['服务启动', 'ok'],
  'pairing.created': ['生成配对邀请', ''],
  'pairing.requested': ['远端请求接入', ''],
  'pairing.decided': ['本机决定配对', ''],
  'grant.issued': ['签发授权', 'ok'],
  'grant.verified': ['远端完成挑战', 'ok'],
  'grants.revoked_all': ['撤销全部授权', 'bad'],
  'run.created': ['创建 run', ''],
  'run.state': ['run 状态变更', ''],
  'approval.requested': ['请求写入审批', 'wait'],
  'approval.decided': ['本机审批评审', ''],
  'approval.consumed': ['审批已消费（写入执行）', 'ok'],
  'tool.completed': ['工具执行完成', 'ok'],
  'tool.failed': ['工具执行失败', 'bad'],
};
const TOOL_TEXT = {
  bridge_health: '握手确认', list_directory: '列目录', find_files: '找文件',
  search_files: '搜内容', read_files: '读文件', apply_patch: '改文件',
  set_todos: '更新任务列表', report_progress: '上报进度',
  lsp: '语义查询', get_diagnostics: '取诊断',
};

function describe(event) {
  const entry = EVENT_TEXT[event.type] || [event.type, ''];
  const payload = event.payload || {};
  let detail = '';
  if (event.type === 'tool.completed' || event.type === 'tool.failed') {
    detail = TOOL_TEXT[payload.action] || payload.action || '未知工具';
    if (payload.duration_ms !== undefined) detail += ' · ' + payload.duration_ms + 'ms';
    if (payload.code) detail += ' · ' + payload.code;
  } else if (event.type === 'grant.issued') {
    detail = '权限 ' + (payload.mode || '?');
  } else if (event.type === 'approval.decided') {
    detail = payload.state === 'approved' ? '已允许' : '已拒绝';
  } else if (event.type === 'run.state' || event.type === 'approval.requested') {
    detail = payload.state || '';
  } else if (payload.count !== undefined) {
    detail = String(payload.count) + ' 个';
  }
  return { label: entry[0], tone: entry[1], detail };
}

async function refreshActivity() {
  const data = await api('/admin/v1/events?after=0');
  const events = data.events || [];
  const byRun = new Map();
  for (const event of events) {
    const key = event.run_id || '__local__';
    if (!byRun.has(key)) byRun.set(key, []);
    byRun.get(key).push(event);
  }
  const host = $('timeline');
  if (!byRun.size) { host.innerHTML = '<p class="muted">还没有任何活动。</p>'; return; }
  const blocks = [];
  for (const [runId, list] of [...byRun.entries()].reverse()) {
    const granted = list.find((e) => e.type === 'grant.issued');
    const failed = list.filter((e) => e.type === 'tool.failed').length;
    const done = list.filter((e) => e.type === 'tool.completed').length;
    const title = runId === '__local__' ? '本机（无 run）' : 'run ' + short(runId) + '…';
    blocks.push('<div class="card"><div class="run-head">'
      + '<strong>' + esc(title) + '</strong>'
      + (granted ? '<span class="badge">权限 ' + esc(granted.payload.mode || '?') + '</span>' : '')
      + '<span class="badge' + (failed ? ' blocked' : ' ok') + '">' + done + ' 次工具成功' + (failed ? '，' + failed + ' 次失败' : '') + '</span>'
      + '</div><div class="tl">'
      + list.map((event) => {
        const d = describe(event);
        return '<div class="ev ' + d.tone + '"><span class="t">' + esc(clock(Date.parse(event.timestamp) || Date.now())) + '</span>'
          + esc(d.label) + (d.detail ? ' <span class="meta">' + esc(d.detail) + '</span>' : '') + '</div>';
      }).join('')
      + '</div></div>');
  }
  host.innerHTML = blocks.join('');
}

async function refreshGrants() {
  const status = await api('/admin/v1/status');
  const now = Date.now();
  const rows = (status.workspaces || []);
  const grantHost = $('grantList');
  // The authoritative grant list is the audit log: grants are issued per pairing.
  const data = await api('/admin/v1/events?after=0');
  const issued = new Map();
  for (const event of data.events || []) {
    if (event.type === 'grant.issued' && event.payload.grant_id) issued.set(event.payload.grant_id, { ...event.payload, at: event.timestamp });
    if (event.type === 'grants.revoked_all') for (const g of issued.values()) g.revoked = true;
    if (event.type === 'approval.consumed') { /* consumption is per-approval, not per-grant */ }
  }
  if (!issued.size) { grantHost.innerHTML = '<p class="muted">当前没有任何远端授权。</p>'; }
  else {
    grantHost.innerHTML = '<table><thead><tr><th>授权</th><th>权限</th><th>工作区</th><th>状态</th><th>签发时间</th></tr></thead><tbody>'
      + [...issued.values()].reverse().map((g) => {
        const mode = g.mode || '?';
        // exec used to fall into the "not code" branch and be listed as 只读.
        const tone = g.revoked ? 'blocked' : mode === 'ask' || mode === 'plan' ? 'ok' : 'alert';
        const label = g.revoked ? '已撤销' : ({ ask: '只读', plan: '只读（先给计划）', code: '可写（每次需审批）', exec: '可写 + 可执行命令（命令无审批）' })[mode] || mode;
        const ws = rows.find((w) => w.id === g.workspace_id);
        return '<tr><td><code>' + esc(short(g.grant_id)) + '…</code></td><td>' + esc(mode) + '</td>'
          + '<td>' + esc(ws ? ws.display_name : short(g.workspace_id)) + '</td>'
          + '<td><span class="badge ' + tone + '">' + esc(label) + '</span></td>'
          + '<td class="muted">' + esc(g.at || '') + '</td></tr>';
      }).join('') + '</tbody></table>';
  }
}

async function refreshPairings() {
  const status = await api('/admin/v1/status');
  table('pendingPairings', ['远端', '请求权限', '接收方', '过期时间', '操作'], status.pairings || [], (p) => [
    esc(p.remote_label || '（未声明）'),
    esc(p.requested_access),
    esc(p.recipient),
    esc(clock(p.expires_at)),
    '<div class="row-actions"><button data-pair="' + esc(p.pair_id) + '" data-requested="' + esc(p.requested_access || p.max_access || 'ask') + '" data-approve="true">批准</button><button class="danger" data-pair="' + esc(p.pair_id) + '" data-approve="false">拒绝</button></div>',
  ]);
  for (const button of document.querySelectorAll('[data-pair]')) {
    button.onclick = async () => {
      const approve = button.dataset.approve === 'true';
      // The default has to be what was requested, and the hint has to name every tier. This used
      // to say "ask / plan / code" and default to ask, so approving a request for exec by
      // pressing Enter handed the remote a read-only grant — the same silent downgrade the desktop
      // window had, and it reads as "the exec tier never took effect".
      const requested = button.dataset.requested || 'ask';
      const mode = approve ? (prompt('批准权限（ask / plan / code / exec）：', requested) || requested) : 'ask';
      if (approve && !confirm('确认批准：接收方 将获得 ' + mode + ' 权限，且数据会离开本机进程。继续？')) return;
      await api('/admin/v1/pairings/' + encodeURIComponent(button.dataset.pair) + '/decision', { method: 'POST', body: JSON.stringify(approve ? { approve: true, access_mode: mode, data_egress_ack: true } : { approve: false, access_mode: 'ask', data_egress_ack: true }) });
      await refreshPairings();
    };
  }
}

async function refreshTools() { show('tools', await api('/admin/v1/tool-schemas')); }
async function refreshEvents() { show('events', await api('/admin/v1/events')); }
async function refreshCaps() {
  const caps = await api('/bridge/v1/capabilities');
  show('caps', caps);
  $('ver').textContent = '版本 ' + caps.version;
  $('stage').textContent = caps.delivery_stage;
  $('arena').textContent = 'Arena：' + caps.arena.status;
}

function activate(tab) {
  for (const button of document.querySelectorAll('nav button')) button.setAttribute('aria-current', String(button.dataset.tab === tab));
  for (const section of document.querySelectorAll('section')) section.setAttribute('data-active', String(section.dataset.tab === tab));
  const loaders = { pending: refreshPending, activity: refreshActivity, grants: refreshGrants, pairings: refreshPairings, tools: refreshTools, events: refreshEvents, caps: refreshCaps };
  loaders[tab]().catch((error) => alert(String(error.message)));
}

// --- Live updates: poll the admin status cheaply. A write request that nobody
// --- notices parks the remote run until it expires, so the badge has to update
// --- even when the operator is looking at another tab.
let pollTimer = null;
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      await refreshPending();
      const active = document.querySelector('nav button[aria-current=true]');
      if (active && active.dataset.tab === 'activity') await refreshActivity();
      $('link').textContent = '实时';
      $('link').className = 'badge ok';
    } catch {
      $('link').textContent = '连接中断';
      $('link').className = 'badge blocked';
    }
  }, 3000);
}

setInterval(tickCountdowns, 1000);

$('unlock').onclick = async () => {
  state.token = $('token').value.trim();
  $('gateErr').textContent = '';
  try {
    await api('/bridge/v1/capabilities');
    sessionStorage.setItem('arenabridge.admin', state.token);
    $('gate').hidden = true; $('app').hidden = false; $('signout').hidden = false;
    await refreshPending(); await refreshCaps(); startPolling();
    if ($('notify').checked && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  } catch (error) { $('gateErr').textContent = '解锁失败：' + error.message; }
};
$('signout').onclick = () => { sessionStorage.removeItem('arenabridge.admin'); location.reload(); };
$('pRefresh').onclick = () => refreshPending().catch((e) => alert(String(e.message)));
$('evRefresh').onclick = () => refreshEvents().catch((e) => show('events', String(e.message)));
$('notify').onchange = () => {
  if ($('notify').checked && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
};
$('revoke').onclick = async () => {
  if (!confirm('撤销全部远端授权？旧配对链接、旧 token 和旧会话将不能再发起新动作。')) return;
  const result = await api('/admin/v1/revoke-all', { method: 'POST', body: JSON.stringify({ confirm: true }) });
  alert('已撤销 ' + result.revoked_grants + ' 个授权，epoch=' + result.epoch);
  await refreshGrants();
};
$('pCreate').onclick = async () => {
  $('pErr').textContent = ''; $('pResult').hidden = false;
  try {
    const result = await api('/admin/v1/pairings', { method: 'POST', body: JSON.stringify({ workspace_id: $('pWorkspace').value, recipient: $('pRecipient').value || '本地测试客户端', max_access: $('pAccess').value, ttl_ms: 120000 }) });
    show('pResult', result);
  } catch (error) { $('pErr').textContent = String(error.message); $('pResult').hidden = true; }
};
for (const button of document.querySelectorAll('nav button')) button.onclick = () => activate(button.dataset.tab);

const saved = sessionStorage.getItem('arenabridge.admin');
if (saved) { $('token').value = saved; $('unlock').click(); }
else {
  // The launcher may hand over the token in the URL fragment, which is never sent to the
  // server and never logged. Use it, then strip it from the address bar and history.
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ''));
  const handed = fragment.get('t');
  if (handed) {
    $('token').value = handed;
    history.replaceState(null, '', location.pathname + location.search);
    $('unlock').click();
  }
}
</script>
</body>
</html>
`;
