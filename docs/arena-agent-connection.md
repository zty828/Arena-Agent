# 接入 Arena Agent：完整步骤

> **先读这一段（2026-09-19 更新）。** 本文写于只有命令行入口的时候，里面的 `arena.cmd` / `start.cmd` 命令**已经随脚本一起删除**。现在接远端只有一条路：**双击 `desktop.cmd`，在窗口里点「接远端」**——选访问模式 → 显式确认暴露 → 窗口自己建隧道、重启 daemon、生成配对码与提示词。本文下面关于"为什么必须走隧道""隐私代价""沙箱会清 `/tmp`"的结论**仍然成立**，它们是机制分析，不是操作步骤；遇到具体命令时请以 `desktop.cmd` 窗口和 README 为准。

**修正我之前的判断。** 我上次说"官方文档没写 MCP，所以接不了"，这个推理是错的。

正确机制是：**Arena Agent 的 bash sandbox 里跑一个 MCP 客户端**，去连你的公网地址。这不需要 Arena 提供"MCP Connector"功能，只需要 sandbox 能出网、能跑脚本。你自己的需求文档里其实就写了这条路——"网页 Agent 的原生 MCP Connector **或其联网执行环境运行 MCP 客户端**"。ShunCode 走的应该也是这条路。

所以缺的零件只有一个：**沙箱里能跑的客户端**。我已经写好并实测了（`client/arena_sandbox_client.py`，Python 3 标准库，零依赖）。

---

## 为什么必须走隧道（Arena 沙箱实测结论）

Arena 侧 Agent 的原始诊断：

```
OSError: [Errno 101] Network is unreachable   ← 失败在 sock.connect()
沙箱 IPv6：只有 ::1/128 和 fe80::/64，没有全局地址，没有默认路由
沙箱 IPv4：default via 169.254.0.22，example.com / api.github.com 均 200
```

**沙箱是 IPv4-only 出网环境。** 它没有 IPv6 默认路由，所以任何公网 IPv6 字面量都会在内核层直接 `ENETUNREACH`——包根本没出去，不是防火墙、不是代理、也不是服务没起。

本机侧同样没有可用地址：

```
公网身份（经代理）: 199.30.91.155 | Mumbai, IN | AS219401 Yeah Tech LLC
本机地址: 192.168.1.5（私有）, 198.18.0.1（Clash fake-IP）, 172.29.128.1（Hyper-V）
```

那个"公网 IP"是你代理的出口节点，不是你家宽带。加上 NAT 和 CGNAT，**没有任何地址是沙箱能直接拨到的**，中继不可避免。

所以现在的方案是：**bridge 只听 `127.0.0.1`，由 Cloudflare 隧道对外**。副作用是更好的：

- 不需要开防火墙入站规则
- 不需要 IPv6 入站
- 不需要 `remote_ingress` 绑定任何非回环地址
- 对外只有一条 HTTPS 隧道地址，管理端口始终只在回环

## 已验证的部分（本机实测）

| 验证 | 结果 |
|---|---|
| 沙箱客户端 ↔ 真实 daemon 完整闭环（配对→批准→领取→challenge→发现→列工具→读真实文件→撤权） | **14/14 通过** → `outputs/sandbox-client-e2e.json` |
| 非回环地址上的同一闭环（MCP 绑 `192.168.1.5`，admin/api 仍回环，匿名 401） | **9/9 通过** → `outputs/ingress-e2e.json` |
| 真实全球 IPv6 上的同一闭环 | **9/9 通过** → `outputs/ingress-e2e.json` |
| Arena 流程预演（按提示词逐步执行） | **11/11 通过** → `outputs/arena-flow-rehearsal.json` |
| **真实 Cloudflare 公网隧道上的完整闭环**：隧道建立 → Host 白名单 → 未列域名拒绝 → 经公网下载客户端 → 匿名 401 → 配对 → 批准 → 领取 → 列工具 → 读真实文件 | **10/10 通过** → `outputs/tunnel-e2e.json` |
| 出站 IPv6 可用、无 NAT | `outputs/net-diagnose.json` |

**软件侧与隧道侧均已就绪。**

## 把 Arena 接上去：一键

**双击 `desktop.cmd`，在窗口里点「接远端」。** 完事。

窗口会完成：编译（按需）→ 清理遗留锁 → 建立 Cloudflare 隧道 → 以「仅回环 + 允许隧道域名」重启 bridge → 等就绪 → 生成一次性配对码 → 生成提示词并**复制到剪贴板（已校验内容）** → 保持运行。**关窗口即断隧道。**

```
  公网地址   https://<随机词>-<随机词>-<随机词>.trycloudflare.com
  配对码     <43 个字符的一次性随机串，30 分钟内有效>
  提示词     已复制到剪贴板 ✓（已校验内容一致）
```

你只需要：**Ctrl+V → 发送 → 点批准 → 说"已批准"**。**关窗口时隧道和 bridge 一起关闭。**

### 控制台会自动解锁

一键脚本把 `admin_token` 放在 URL fragment（`/console#t=...`）里交给浏览器——**fragment 不会发送到服务器、不会进服务器日志**，控制台读取后立刻用 `history.replaceState` 把它从地址栏清掉。

**不要用配对码登录控制台。** 配对码和 `admin_token` 都是 43 个字符的随机串，肉眼分不出来，但用途完全不同：

| 值 | 用途 | 出现在哪 |
|---|---|---|
| `admin_token` | 登录本地控制台（端口 48272） | `.arena-bridge/local-credentials.json` |
| `api_token` | 调模型网关（端口 48270） | 同一个文件 |
| 配对码 | 给远端 Agent 用来发起配对 | 一键脚本窗口 / 提示词里 |

粘错时控制台会直接告诉你是哪一种，而不是只报 `invalid`：

```
That is a pairing code, not the console credential. Use admin_token from .arena-bridge/local-credentials.json
That is the API client token (port 48270), not the admin token (port 48272)
```

### 隐私代价（必须知道）

隧道由 Cloudflare 终止 TLS，**Cloudflare 能看到 MCP 流量明文**（文件内容、路径、Diff）。加上 Arena 侧官方声明这些数据会进**公开** agent leaderboard，等于内容经过两方。

所以：用合成项目测，不要指真实代码库。

### 分步版本

```bash
node scripts/tunnel.mjs 48271          # 只建隧道
node scripts/tunnel-e2e.mjs            # 本机验证隧道全链路
node scripts/tunnel-external-check.mjs # 从第三方服务器验证隧道对外可用
node scripts/net-diagnose.mjs          # IPv6 与防火墙状态
node scripts/ipv4-diagnose.mjs         # IPv4 出口与 NAT 判断
node scripts/tunnel-reachability.mjs   # 各隧道服务连通性
```

### 有效期

- 配对邀请：**30 分钟**，一次性，本身不授予权限
- 授权 grant：**跟随本次 bridge 会话**（没有墙钟到期时间；关窗/断开/换工作目录/撤销即失效），可随时在控制台「撤销全部授权」


## 当前网络状态（2026-09-17 实测）

```
以太网 | 2409:8a20:xxxx:xxxx:xxxx:xxxx:xxxx:xxxx | Origin=RouterAdvertisement
以太网 | 2409:8a20:xxxx:xxxx:xxxx:xxxx:xxxx:yyyy | Origin=RouterAdvertisement  ← 外部看到的地址
以太网 | Category=Private | IPv6Connectivity=Internet
以太网 -> fe80::1 metric=256
UseTemporaryAddresses=Enabled   ← 地址会轮换，必须绑 ::
入站防火墙规则(48271)：无
```

结论：
- ✅ 有原生全球 IPv6 前缀（中国移动 `2409:8a20::/32`）
- ✅ 出站 IPv6 正常，且没有 NAT
- ⚠️ **没有 48271 的入站放行规则** → 外部连接会被 Windows 防火墙拦掉
- ❓ 路由器/运营商是否放行入站，未知

## 还差两步（都需要管理员权限，请你自己执行）

```powershell
# 1) 放行入站 TCP 48271（Private 配置文件）
New-NetFirewallRule -DisplayName "ArenaBridge MCP 48271" -Direction Inbound `
  -Protocol TCP -LocalPort 48271 -Action Allow -Profile Private, Domain

# 2) 确认路由器放行 IPv6 入站
#    这一步没有通用命令，需要登录你的光猫/路由器后台
#    中国移动家宽默认通常对 IPv6 入站是关闭的，需要手动开或加端口映射
```

撤销：

```powershell
Remove-NetFirewallRule -DisplayName "ArenaBridge MCP 48271"
```

## 用手机 10 秒验证入站是否真的通

这是唯一可靠的验证方式。**免费的外部端口检测服务都不支持 IPv6**（portchecker.io 明确回复 "IPv6 is not currently supported"），而且同一台机器上的两个地址互连**不经过 Windows 防火墙**，所以本机自测通过不等于外部能连。

```bash
# 1) 本机以暴露模式启动
npm run expose
```

它会打印真实地址，形如：
```
http://[2409:8a20:xxxx:xxxx:xxxx:xxxx:xxxx:xxxx]:48271/mcp
http://[2409:8a20:xxxx:xxxx:xxxx:xxxx:xxxx:yyyy]:48271/mcp
```

2) **手机关掉 Wi-Fi、用蜂窝数据**，浏览器打开上面任一条。

| 看到什么 | 说明 |
|---|---|
| `{"error":{"code":"AUTH_REQUIRED",...}}` | ✅ 入站通了，可以进 Arena 测试 |
| 一直转圈/超时 | ❌ 被防火墙、路由器或运营商拦了，先解决网络 |

注意 `--expose` 只把 MCP 端口对外，**admin/api 永远只在 127.0.0.1**；暴露配置写在 `run-local.exposed.json`，不会污染基础配置，下次普通启动自动回到只监听回环。

## 把 Arena 接上去：一键（IPv6 直连，已被隧道取代）

**双击 `desktop.cmd`，在窗口里点「接远端」。** 完事。

> 下面这一段是**隧道方案之前**的 IPv6 直连记录，保留下来是因为它解释了"为什么本机自测通过不等于外部能连"。直连需要放行入站、需要运营商给到公网 IPv6，而隧道两者都不需要，所以窗口里现在走的是隧道。**不要照着这段去开防火墙规则**——它已经不是推荐路径了。

旧流程（历史记录）：编译（按需）→ 清理遗留锁 → 以 IPv6 暴露模式启动 bridge → 等它就绪 → 生成一次性配对码 → 生成提示词并**复制到剪贴板** → 打开控制台和 Arena → 打印状态，然后保持运行。

```
==================================================================
  已就绪
==================================================================

  对外地址   http://[2409:8a20:xxxx:xxxx:...]:48271
  配对码     <43 个字符的一次性随机串，30 分钟内有效>
  有效期     30 分钟（一次性；授权本身跟随本次 bridge 会话，不按小时过期）

  提示词     已复制到剪贴板 ✓

  接下来：
    1. 浏览器已打开 Arena（arena.ai/agent）
    2. 在对话框里直接 Ctrl+V 粘贴，发送
    3. Agent 会报出一个 pair_id，然后停下等你
    4. 切到另一个标签页（本地控制台），「配对」标签里点【批准】
    5. 回 Arena 告诉它"已批准"
```

你只需要：**Ctrl+V → 发送 → 点批准 → 说"已批准"**。

测试完在窗口里按 **Ctrl+C** 停止，MCP 端口随即关闭。

### 为什么客户端要用 Python 而不是 curl

沙箱环境普遍导出 `http_proxy`/`https_proxy`。curl 会试图把请求发给代理，直连 IPv6 就失败了（实测报 `curl: (27) Out of memory`）。Python 的 urllib **默认也读这些变量**，所以客户端内部显式禁用了代理（`ProxyHandler({})`），可用 `ARENABRIDGE_USE_PROXY=1` 重新开启。这是实测踩出来的坑，不是理论推测。

### 剪贴板编码（中文 Windows 的坑）

不要用 `clip.exe` 往剪贴板写中文。它按控制台代码页（中文系统是 GBK/936）读取 stdin，喂 UTF-8 字节会变成 `涓枃娴嬭瘯` 这种乱码，而且 **退出码仍然是 0**，只看退出码发现不了。

实测三种方式：

| 方式 | 结果 |
|---|---|
| `clip.exe` 喂 UTF-8 字节 | 乱码 `涓枃娴嬭瘯...` |
| `clip.exe` 喂 UTF-16LE + BOM 文件 | 中文正确，但残留一个 BOM 字符 |
| PowerShell `Set-Clipboard` 读 UTF-8 文件 | **完全一致** ✓ |

一键脚本用的是第三种，并且会**把剪贴板读回来逐字比对**；不一致就自动打开提示词文件让你手动 Ctrl+A / Ctrl+C。诊断脚本保留在 `scripts/clipboard-probe.mjs`。

### 分步版本（需要单独控制时）

```bash
npm run expose                  # 只启动，不生成提示词
node scripts/arena-prompt.mjs   # 单独生成提示词
node scripts/arena-flow-test.mjs # 本机预演整套流程
node scripts/net-diagnose.mjs    # 检查 IPv6 与防火墙状态
```

### 有效期说明

- 配对邀请：**30 分钟**，一次性。邀请本身不授予任何权限。
- 授权 grant：**跟随本次 bridge 会话**，之后需重新配对。可随时在控制台「撤销全部授权」。

## 数据风险（必须先知道）

Arena 官方公告原文：

> "The data generated from all of these real-world tasks will power a **public agent leaderboard**"

帮助中心原文：

> "Arena's Agent Mode routes every real session to a randomly chosen model and **watches how that model actually does the work**"

意思是：**通过桥接读出去的每一个文件内容、路径、Diff，都会进入评测 trace，并可能成为公开排行榜数据的一部分。** 这是官方对 Agent Mode 数据用途的说明，不是我的推测。

所以：

- 用**合成测试项目**先跑通，别一上来就指你的真实代码库。
- 不要让它读 `.env`、密钥、客户资料（桥接本身会拒绝这类路径，但别靠这个兜底）。
- 需要更严格控制时，换用你有权使用的正式模型 API（走 `/v1/chat/completions`），那条路不经过评测平台。

## 排错

| 现象 | 原因 |
|---|---|
| `cannot reach ...` | 地址不可达：IPv6 没启用、路由器没放行、防火墙没开、或 daemon 没在跑 |
| `pairing request rejected (HTTP 403)` | 配对码过期（默认 2 分钟）或已被用过 |
| `claim before approval returns no token` | 还没在本机控制台批准，这是设计行为 |
| `AUTHORIZATION_REQUIRED` | 没做 challenge 验证，或 grant 已过期/已撤权 |
| `CAPABILITY_UNAVAILABLE` | 工具本身未实现（LSP/PTY），不是连接问题 |
| 只有读能过、写被拒 | `ask`/`plan` 权限本来就是只读；写需要 `code` + 逐次审批 |
| 远端说 `run_command` 不存在 | 那张配对码的上限不是 `exec`。命令执行是第 4 档，只在签发时选定、之后无法提高——重签一枚 `exec` 码 |

## 当前状态声明

- 软件侧：**已验证就绪**（沙箱客户端闭环 14/14、真实全球 IPv6 闭环 9/9、通配绑定已验证）。
- 网络侧：**部分打通**。IPv6 已启用、有原生全球前缀、出站正常、无 NAT；但**入站防火墙规则尚未添加**，路由器/运营商是否放行未知。
- Arena 侧：**未实测**。ShunCode 声称可用，但那是它的兼容性声明；Arena 的 sandbox 是否允许访问任意外部地址，官方没有文档承诺。
- 因此：**先完成手机蜂窝数据测试**，确认入站通了，再进 Arena 实际测试。我不会把"能连"写成"已连上"。
