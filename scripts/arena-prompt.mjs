#!/usr/bin/env node
/**
 * Generates the exact text to paste into a remote agent (Arena Agent or any
 * sandbox with bash + python3), with the real endpoint and a fresh one-time
 * pairing code already filled in.
 *
 * It needs the bridge running in exposed mode. Run "npm run expose" first.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const credentials = JSON.parse(fs.readFileSync(path.join(root, '.arena-bridge', 'local-credentials.json'), 'utf8'));
const base = JSON.parse(fs.readFileSync(path.join(root, 'outputs', 'run-local.config.json'), 'utf8'));
const exposedPath = path.join(root, 'outputs', 'run-local.exposed.json');
const effective = fs.existsSync(exposedPath) ? JSON.parse(fs.readFileSync(exposedPath, 'utf8')) : base;
const adminPort = effective.ports.admin;
const mcpPort = effective.ports.mcp;

function globalIPv6() {
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const entry of list ?? []) {
      const value = entry.address.split('%')[0];
      if (entry.family === 'IPv6' && !entry.internal && /^[23]/.test(value) && name === '以太网') return value;
    }
  }
  return null;
}

const address = process.argv[2] ?? globalIPv6();
if (!address) { console.error('No global IPv6 on 以太网. Pass one explicitly.'); process.exit(1); }

const admin = `http://127.0.0.1:${adminPort}`;
const auth = { Authorization: `Bearer ${credentials.admin_token}`, 'Content-Type': 'application/json' };

let status;
try {
  const response = await fetch(`${admin}/admin/v1/status`, { headers: auth, signal: AbortSignal.timeout(3000) });
  status = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(status));
} catch (error) {
  console.error(`Bridge is not running on ${admin} (${error.message}).`);
  console.error('Start it first:  npm run expose');
  process.exit(1);
}

const exposed = status.urls.mcp.includes(address);
if (!exposed) {
  console.error(`The bridge is running but not exposed: MCP is on ${status.urls.mcp}`);
  console.error('Restart with:  npm run expose');
  process.exit(1);
}

const pairing = await (await fetch(`${admin}/admin/v1/pairings`, {
  method: 'POST', headers: auth,
  body: JSON.stringify({ workspace_id: status.workspaces[0].id, recipient: 'Remote agent (Arena test)', max_access: 'ask', ttl_ms: 600000 }),
})).json();

const mcpUrl = `http://[${address}]:${mcpPort}`;
const prompt = `我要通过 MCP 连接我自己机器上的一个工作区桥接服务。请严格按顺序执行，不要跳步，不要假设成功。

⚠️ 你的沙箱**可能**不会在两轮对话之间保留 /tmp：实测有一次第 3 步成功后，第 4 步
/tmp/ab_client.py 就不见了（也有整轮全程都在的情况，清空更像是沙箱重启/回收触发的）。
所以每一步都要自带它需要的全部东西：脚本没了就重跑
第 1 步；pair_id、claim_secret、token、challenge 一律从上一步的输出里复制成显式参数，
不要指望上一个步骤留在 /tmp 里的任何文件。

第 1 步：下载客户端（零依赖的 Python 3 脚本；用 Python 而不是 curl，因为沙箱里的
http_proxy 变量会让 curl 无法直连 IPv6 地址）。**后面任何一步报
"can't open file '/tmp/ab_client.py'" 时都要重跑这一步。**
  python3 - <<'PY'
import urllib.request, os
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
open('/tmp/ab_client.py','wb').write(opener.open('${mcpUrl}/client.py', timeout=30).read())
print('client bytes:', os.path.getsize('/tmp/ab_client.py'))
PY
  python3 --version

第 2 步：配置（每条命令都要带上；它们不会跨轮次保留）
  export ARENABRIDGE_URL='${mcpUrl}'
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
- 不要把这个端点地址或任何返回内容发到别处。
`;

fs.writeFileSync(path.join(root, 'outputs', 'arena-prompt.txt'), prompt);
console.log(prompt);
console.log('---');
console.log(`endpoint      : ${mcpUrl}`);
console.log(`pairing code  : ${pairing.code}`);
console.log(`pair id       : ${pairing.pair_id}`);
console.log(`expires at    : ${new Date(pairing.expires_at).toLocaleString()}`);
console.log(`approve here  : ${admin}/console  -> 配对 tab`);
console.log(`saved to      : outputs/arena-prompt.txt`);
