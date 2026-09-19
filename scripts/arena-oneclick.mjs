#!/usr/bin/env node
/**
 * One-click Arena test launcher, tunnel edition.
 *
 * "npm run arena" runs this. It:
 *   compiles if needed -> recovers a stale lock -> opens a Cloudflare quick tunnel
 *   -> starts the bridge on loopback with that tunnel hostname allowed -> waits for
 *   readiness -> creates a one-time pairing code -> builds the paste-ready prompt
 *   -> copies it to the clipboard -> opens the console and Arena -> keeps running.
 *
 * Why a tunnel instead of a direct address: the remote sandbox has IPv4 egress only
 * and no IPv6 route, and this host is behind NAT, so there is no address the sandbox
 * can dial. The bridge therefore stays on 127.0.0.1 and only the tunnel is public,
 * which also means no firewall rule and no inbound IPv6 are needed.
 *
 * Privacy: Cloudflare terminates TLS, so it can read the MCP traffic. Test with a
 * synthetic workspace, never with private source.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'dist', 'apps', 'daemon', 'src', 'cli.js');
const configPath = path.join(root, 'outputs', 'run-local.config.json');
const effectivePath = path.join(root, 'outputs', 'run-local.tunnel.json');
const credentialsPath = path.join(root, '.arena-bridge', 'local-credentials.json');
const promptPath = path.join(root, 'outputs', 'arena-prompt.txt');
const logDirectory = path.join(root, 'outputs', 'local-run');

const noOpen = process.argv.includes('--no-open');
const say = (message = '') => process.stdout.write(message + '\n');
const rule = (char = '=') => say(char.repeat(66));
function fail(message, hint) {
  say('');
  rule('!');
  say('  启动失败');
  rule('!');
  say(`  ${message}`);
  if (hint) say(`  ${hint}`);
  say('');
  process.exitCode = 1;
  return new Promise(() => {});
}
function openUrl(url) {
  if (noOpen) return;
  try {
    const [command, args] = process.platform === 'win32' ? ['explorer.exe', [url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
  } catch { /* not fatal */ }
}
function toClipboard(text, sourceFile) {
  // clip.exe reads stdin using the console codepage (GBK on zh-CN Windows) and turns
  // UTF-8 into mojibake while still exiting 0, so use PowerShell and verify the value.
  const quote = (value) => value.replace(/'/g, "''");
  const run = (command) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  const set = run(`Set-Clipboard -Value (Get-Content -Raw -Encoding UTF8 -LiteralPath '${quote(sourceFile)}')`);
  if (set.status !== 0) return { ok: false, reason: `Set-Clipboard exit ${set.status}` };
  const readback = path.join(root, 'outputs', 'clipboard-readback.txt');
  if (run(`Get-Clipboard -Raw | Set-Content -LiteralPath '${quote(readback)}' -Encoding UTF8`).status !== 0) return { ok: false, reason: 'could not read the clipboard back' };
  let actual = '';
  try { actual = fs.readFileSync(readback, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'); } catch (error) { return { ok: false, reason: error.message }; }
  return actual.trimEnd() === text.replace(/\r\n/g, '\n').trimEnd() ? { ok: true } : { ok: false, reason: 'clipboard content did not match (encoding mismatch)' };
}

say('');
rule();
say('  ArenaBridge 一键测试启动（隧道模式）');
rule();
say('');

if (!fs.existsSync(credentialsPath)) {
  say('[1/5] 生成本地凭据...');
  if (spawnSync(process.execPath, [path.join(root, 'scripts', 'gen-credentials.mjs')], { cwd: root, stdio: 'inherit' }).status !== 0) await fail('凭据生成失败。');
} else say('[1/5] 凭据已存在（不会覆盖）。');

if (!fs.existsSync(cli)) {
  say('[2/5] 首次运行，编译中（约 10 秒）...');
  const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tsc)) await fail('缺少依赖：node_modules/typescript 不存在。', '请先按 README 安装依赖。');
  if (spawnSync(process.execPath, [tsc, '-p', path.join(root, 'tsconfig.json')], { cwd: root, stdio: 'inherit' }).status !== 0) await fail('TypeScript 编译失败，未启动任何服务。');
} else say('[2/5] 已编译，跳过。');

const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
const base = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const lockFile = path.join(path.resolve(root, base.state_directory), 'daemon.lock');
if (fs.existsSync(lockFile)) {
  let owner; try { owner = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { owner = undefined; }
  let alive = false;
  if (owner?.pid) { try { process.kill(owner.pid, 0); alive = true; } catch { alive = false; } }
  if (alive) await fail(`已有一个 bridge 在运行（pid ${owner.pid}）。`, '先关掉那个窗口，或按 Ctrl+C 停止它。');
  fs.rmSync(lockFile);
  say(`       （已清理上次强杀留下的状态锁，原属主 pid ${owner?.pid ?? '未知'} 已不存在）`);
}

// ---------------------------------------------------------------- 3. tunnel
say('[3/5] 建立公网隧道（使用内置 runtime/cloudflared.exe）...');
const { startCloudflareTunnel } = await import('./tunnel-cloudflared.mjs');

// The remote listener has to be bound on the exact port the tunnel forwards to, and the daemon
// needs the tunnel hostname before it can create that listener — so the port must be decided
// here, before either half starts. Reserving it means a busy 48273 no longer produces a tunnel
// that points at nothing, and the config written below is what actually pins it.
function reserveRemotePort() {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => { try { probe.close(); } catch { /* already closed */ } resolve(undefined); });
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      probe.close(() => resolve(typeof port === 'number' && port > 0 ? port : undefined));
    });
  });
}
const remotePort = await reserveRemotePort();
if (remotePort === undefined) await fail('无法为远端监听器选定端口，隧道没有建立。', 'no free loopback port could be reserved');
say(`      远端监听端口 ${remotePort}`);

const tunnel = await startCloudflareTunnel(remotePort, { timeoutMs: 90000 });
if (!tunnel.ok) await fail(`隧道建立失败：${tunnel.reason}`, tunnel.hint ?? (tunnel.output ? `cloudflared 输出：${tunnel.output.slice(-300)}` : undefined));
const publicUrl = tunnel.url;

// `ok: true` is not proof of a usable url — the writer is plain JS outside the TypeScript build,
// so its return value is unvalidated. A malformed-but-truthy url would otherwise be accepted and
// then flow into the allowlist and the prompt, which is why the shape is checked here.
let tunnelHost;
try {
  const parsed = new URL(publicUrl);
  if (parsed.protocol !== 'https:' || !/(^|\.)trycloudflare\.com$/i.test(parsed.hostname)) throw new Error(`unexpected tunnel url ${JSON.stringify(publicUrl)}`);
  tunnelHost = parsed.hostname;
} catch (error) {
  try { tunnel.child.kill(); } catch { /* ignore */ }
  await fail(`隧道返回的地址不可用，已断开：${String(error.message ?? error)}`, 'the tunnel was up but did not report a trycloudflare.com https url');
}
say(`       公网地址 ${publicUrl}${tunnel.attempts > 1 ? `（第 ${tunnel.attempts} 次尝试成功）` : ''}`);

// ---------------------------------------------------------------- 4. bridge
say('[4/5] 启动 bridge（仅监听 127.0.0.1，不开放任何本机端口）...');
fs.mkdirSync(logDirectory, { recursive: true });
const config = {
  ...base,
  // Bind the reserved port, otherwise the tunnel would forward to whatever the base config
  // happened to name — which may be occupied, or bound by an unrelated process.
  ports: { ...base.ports, mcp_remote: remotePort },
  remote_ingress: { enabled: true, acknowledge_exposure: true, bind_address: '127.0.0.1', allow_cidrs: [], allowed_hosts: [tunnelHost], require_grant: true },
};
fs.writeFileSync(effectivePath, JSON.stringify(config, null, 2) + '\n');

const daemon = spawn(process.execPath, [cli, 'serve', '--config', effectivePath], {
  cwd: root,
  stdio: ['ignore', fs.openSync(path.join(logDirectory, 'daemon.out.log'), 'w'), fs.openSync(path.join(logDirectory, 'daemon.err.log'), 'w')],
  env: {
    ...process.env,
    ARENABRIDGE_ADMIN_TOKEN: process.env.ARENABRIDGE_ADMIN_TOKEN || credentials.admin_token,
    ARENABRIDGE_API_TOKEN: process.env.ARENABRIDGE_API_TOKEN || credentials.api_token,
    ARENABRIDGE_MCP_TOKEN: credentials.mcp_token ?? credentials.api_token,
  },
});
let daemonExited = false;
daemon.once('exit', () => { daemonExited = true; });

const adminUrl = `http://127.0.0.1:${config.ports.admin}`;
const auth = { Authorization: `Bearer ${credentials.admin_token}`, 'Content-Type': 'application/json' };
const deadline = Date.now() + 25000;
let status;
while (Date.now() < deadline && !daemonExited) {
  try {
    const response = await fetch(`${adminUrl}/admin/v1/status`, { headers: auth, signal: AbortSignal.timeout(1000) });
    if (response.ok) { status = await response.json(); break; }
    await response.text();
  } catch { /* not up yet */ }
  await new Promise((resolve) => setTimeout(resolve, 300));
}
if (!status) {
  let tail = '';
  try { tail = fs.readFileSync(path.join(logDirectory, 'daemon.err.log'), 'utf8').trim().split('\n').slice(-3).join('\n'); } catch { /* ignore */ }
  try { tunnel.child.kill(); } catch { /* ignore */ }
  await fail('bridge 没有在 25 秒内就绪。', tail || '查看 outputs/local-run/daemon.err.log');
}

// --------------------------------------------------- 5. pairing + prompt
say('[5/5] 生成一次性配对码和提示词...');
const pairingResponse = await fetch(`${adminUrl}/admin/v1/pairings`, {
  method: 'POST', headers: auth,
  body: JSON.stringify({ workspace_id: status.workspaces[0].id, recipient: 'Arena Agent (one-click test)', max_access: 'ask', ttl_ms: 1800000, grant_ttl_ms: 3600000 }),
});
const pairing = await pairingResponse.json();
if (!pairingResponse.ok || typeof pairing.code !== 'string') {
  try { tunnel.child.kill(); } catch { /* ignore */ }
  await fail(`创建配对失败：HTTP ${pairingResponse.status} ${pairing?.error?.code ?? ''} ${pairing?.error?.message ?? ''}`);
}

const prompt = `我要通过 MCP 连接我自己机器上的一个工作区桥接服务。请严格按顺序执行，不要跳步，不要假设成功。

⚠️ 你的沙箱**可能**不会在两轮对话之间保留 /tmp：实测有一次第 3 步成功后，第 4 步
/tmp/ab_client.py 就不见了（也有整轮全程都在的情况，清空更像是沙箱重启/回收触发的）。
所以每一步都要自带它需要的全部东西：脚本没了就重跑
第 1 步；pair_id、claim_secret、token、challenge 一律从上一步的输出里复制成显式参数，
不要指望上一个步骤留在 /tmp 里的任何文件。

第 1 步：下载客户端（零依赖的 Python 3 脚本；用 Python 而不是 curl，因为沙箱里的
http_proxy 变量会让 curl 无法直连，而这个地址是 HTTPS 隧道）。**后面任何一步报
"can't open file '/tmp/ab_client.py'" 时都要重跑这一步。**
  python3 - <<'PY'
import urllib.request, os
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
open('/tmp/ab_client.py','wb').write(opener.open('${publicUrl}/client.py', timeout=60).read())
print('client bytes:', os.path.getsize('/tmp/ab_client.py'))
PY
  python3 --version

第 2 步：配置（每条命令都要带上；它们不会跨轮次保留）
  export ARENABRIDGE_URL='${publicUrl}'
  export ARENABRIDGE_STATE='/tmp/ab_state.json'
  export ARENABRIDGE_TIMEOUT='60'

第 3 步：请求配对（注意 --code= 用等号，值是 base64url，可能以 - 开头）
  python3 /tmp/ab_client.py pair-request --code='${pairing.code}' --label='arena-agent' --access-mode=ask

  这一步会输出 pair_id **和 claim_secret**，两个都要记下来（claim_secret 只出现这一次）。
  把 pair_id 告诉我，然后停下来等我批准。
  我会在我自己的电脑上看到这条请求并点批准。在我说"已批准"之前不要继续。

第 4 步：我批准后，领取授权。**显式带上第 3 步的两个值**，别依赖状态文件：
  python3 /tmp/ab_client.py pair-claim --pair-id='<第 3 步的 pair_id>' --claim-secret='<第 3 步的 claim_secret>'

  记下输出里的 token 和 challenge 两个值。

第 5 步：完成握手校验
  ARENABRIDGE_TOKEN='<第 4 步的 token>' python3 /tmp/ab_client.py verify --challenge='<第 4 步的 challenge>'

第 6 步：列出可用工具
  ARENABRIDGE_TOKEN='<第 4 步的 token>' python3 /tmp/ab_client.py tools

第 7 步：读取工作区现状
  ARENABRIDGE_TOKEN='<第 4 步的 token>' python3 /tmp/ab_client.py call read_files '{"files":[{"path":"sum.mjs"}]}'

  读完之后，先用一段话告诉我你看到了什么，再等我给下一步指令。

硬性约束：
- 所有参数都用 --flag=value 形式。
- 只通过这个 MCP 端点访问工作区。不要假设沙箱里有同名项目，也不要试图在沙箱里复现它。
- 先读后写。任何写操作都需要我在本机单独批准，你只能提交预览然后等待。
- 如果任何一步失败，原样报告错误信息并停止。不要编造"已连接"或"已完成"。
- 唯一的例外：报 "can't open file '/tmp/ab_client.py'" 说明沙箱把 /tmp 清了，
  重跑第 1 步再重试这一步即可，这不是连接或授权问题，不用停下来问我。
- 不要把这个端点地址或任何返回内容发到别处。
`;
fs.writeFileSync(promptPath, prompt);

const clipboard = toClipboard(prompt, promptPath);
// The token goes in the URL fragment: never sent to the server, never logged, and the
// console strips it from the address bar as soon as it reads it.
openUrl(`${adminUrl}/console#t=${encodeURIComponent(credentials.admin_token)}`);
openUrl('https://arena.ai/agent');

rule();
say('  已就绪');
rule();
say('');
say(`  公网地址   ${publicUrl}`);
say(`  配对码     ${pairing.code}`);
say(`  有效期     30 分钟（一次性；授权有效期 1 小时）`);
say('');
if (clipboard.ok) say('  提示词     已复制到剪贴板 ✓（已校验内容一致）');
else {
  say(`  提示词     剪贴板校验未通过：${clipboard.reason}`);
  say('             已打开文本文件，请在里面 Ctrl+A、Ctrl+C');
  openUrl(promptPath);
}
say('');
say('  接下来：');
say('    1. 浏览器已打开 Arena（arena.ai/agent）');
say('    2. 在对话框里直接 Ctrl+V 粘贴，发送');
say('    3. Agent 会报出一个 pair_id，然后停下等你');
say('    4. 切到另一个标签页（本地控制台），「配对」标签里点【批准】');
say('    5. 回 Arena 告诉它"已批准"');
say('');
say(`  控制台     ${adminUrl}/console`);
say('             已带上 admin_token，打开即解锁，不用手输。');
say(`             若要求手输，用 admin_token（不是上面那个配对码）：`);
say(`             ${credentials.admin_token}`);
say('');
say(`  提示词文件 ${path.relative(root, promptPath)}`);
say(`  凭据文件   ${path.relative(root, credentialsPath)}`);
say('');
rule();
say('  本机没有开放任何端口：bridge 只听 127.0.0.1，只有隧道地址对外。');
say('  测试完请按 Ctrl+C，隧道和 bridge 会一起停止。');
rule();
say('');

await new Promise((resolve) => {
  const stop = () => { say('\n正在停止...'); try { tunnel.child.kill(); } catch { /* ignore */ } daemon.kill('SIGTERM'); resolve(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  daemon.once('exit', resolve);
});
await new Promise((resolve) => setTimeout(resolve, 3000));
if (daemon.exitCode === null) daemon.kill('SIGKILL');
await new Promise((resolve) => setTimeout(resolve, 500));
say(fs.existsSync(lockFile) ? '已停止。状态锁仍存在，下次启动会自动清理。' : '已停止，隧道已关闭，状态锁已释放。');
