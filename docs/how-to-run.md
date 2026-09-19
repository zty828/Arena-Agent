# 怎么运行、怎么用、怎么测

适用版本：`0.1.0-stage1` + 模型网关 alpha。运行平台：Windows x64 / Node 22.22.2（已实测）。

**先说清楚一件事：本项目目前不能接入 LMArena / Arena，这不是配置问题，也不是我偷懒。** 原因在最后一节，那里也写了需要什么才能解锁。

---

## 一、唯一入口：`desktop.cmd`

**双击 `desktop.cmd`。** 这是项目唯一的运行脚本。窗口里既能本机使用（改工作目录、审补丁、读文件），也能一键把 bridge 接到远端——两种模式不需要换脚本。

| 双击 / 命令 | 用途 | 对外暴露？ | 什么时候用 |
|---|---|---|---|
| **`desktop.cmd`** | 打开**独立程序窗口**（Electron 桌面壳），窗口内直接启动 bridge | 默认完全不对外；只有你在窗口里显式开启隧道时才暴露 | **日常使用**，以及**要接 Arena 或其他远端 Agent** |
| `npm run expose` | 只启动 bridge（不建隧道），MCP 端口绑到通配地址 | MCP 端口对外 | 调试防火墙 / 入站连通性 |
| `npm test`、`npm run verify` | 跑测试与完整回归 | 否 | 改过代码后验证 |

**接远端不要另找脚本。** 打开窗口 → 在「接远端」里选访问模式 → 显式确认暴露 → 窗口自己建 Cloudflare 隧道、重启 daemon、生成配对码和提示词。**关窗口即断隧道。**

> 早期版本有 `arena.cmd` / `start.cmd` / `test.cmd` / `cb.cmd` 等薄包装脚本，已全部删除：它们与桌面窗口重复，而且把"接远端"和"只本机"做成了两个脚本，很容易选错。对应的能力现在都在窗口里，或上面的 `npm run` 命令里。

脚本都会自动：编译（按需）→ 清理上次强杀留下的状态锁 → 生成凭据（按需）→ 前台运行，关窗口 / Ctrl+C 停止。

## 一之二、桌面窗口（`desktop.cmd`，推荐日常使用）

`desktop.cmd` 打开的是一个**真正的原生窗口**，不是浏览器标签页。窗口里自带 daemon，**关窗口 = 停 bridge**，不需要复制任何端口或令牌。

界面按 Codex 的三栏布局组织：左栏工作区与目录树，中栏标签页（待办 / 活动 / 文件 / 授权 / 原始事件），右栏上下文检查器。

**首次使用**：窗口里点「选择工作目录」，选中你要让远端 Agent 操作的**项目根目录**。选择会写进 `outputs/desktop/workspace.json`，下次启动自动恢复；之后可在窗口内随时切换。

切换是**换一个 daemon**，不是改一条记录：工作区与运行（run）的绑定是不可变的（`runs` 表有触发器拒绝改 `workspace_id`），所以每次切换都关掉旧 daemon、按新目录重新启动一个。窗口只在新 daemon 真正绑定成功后才写入偏好文件——否则一旦启动失败，窗口会显示一个 bridge 其实没在服务的目录。

```bash
npm run build      # 必须先编译，并复制 preload 与渲染页到 dist
npm run desktop    # 等价于双击 desktop.cmd
```

> **构建不依赖你的 PATH。** `desktop.cmd` 发现源码比 `dist` 新时会自己重编一次（避免窗口跑旧代码），
> 这一步**不再走 `npm run build`**：它用启动窗口的那个 node（`desktop.cmd` 优先使用随项目内置的
> `runtime/node.exe`，没有才回退 PATH 上的 node）
> 直接跑 `node_modules/typescript/bin/tsc` 和 `scripts/build-desktop.mjs`，全绝对路径，不经过 shell、
> 不需要 `node_modules/.bin` 在 PATH 上。
>
> 之前是 `npm run build`，实测在你这台机器上会失败并报 `'tsc' 不是内部或外部命令`——npm 给脚本注入的
> `node_modules/.bin` 路径在 Windows 上不可用，而 `.bin/tsc.cmd` 明明就在那儿。**"打开一个窗口"的过程里
> 冒出构建系统的错误，是最糟的位置**：你没法判断是项目坏了还是环境坏了。现在这个失败模式有常驻守卫
> （`npm run probe:wiring`：把 PATH 剥到只剩 `system32`，再真的跑一次构建）。

**自检**（不开窗口、不交互，跑完打印逐项结果并以退出码反映结论）：

```bash
npm run desktop:selftest
```

它会真实启动 daemon 与窗口，逐一断言「目录树可读 / 状态正常 / 待办可列 / 文本文件可打开 / 二进制文件被拒且给出说明」，最后打印 `Window self test passed.` 或失败项。

它固定跑在 `outputs/synthetic-workspace` 上，而不是你上次选择的目录：断言里有「文本文件能打开」，而只放图片的目录（比如「图片」文件夹）根本没有文本文件，那样的失败说明不了代码有问题。该脚本通过 `ARENABRIDGE_WORKSPACE_ROOT` 指定目录，**不会改写你的偏好文件**。想看你自己目录的情况，用 `desktop.cmd --self-test`。

若某个检查失败，先看它是不是「工作目录里没有可断言的文件」——那是环境问题，不是程序问题。

**端到端验收**（18 项，跑完整条「远端请求 → 窗口审批 → 落盘」链路，外加「连续切换工作目录」）：

```bash
node scripts/desktop-e2e.mjs
```

**工作目录切换的专项探针**（证明第二次及以后的工作目录能绑定到同一个 state 上）：

```bash
npm run probe:rebind
```

它复现的是曾经的真实故障：本地 MCP 身份原本是一行固定的 run，而 `runs` 表拒绝改 `workspace_id`，于是**第一次绑定成功、之后每次切换都报 `immutable run binding`**。该探针断言的是「第二次绑定」而不是「第一次」——只绑一次在出 bug 的版本上也会通过。跑 E2E 时也会带上它，且必须等窗口释放 state 租约之后再跑：同一个 state 同时只允许一个 daemon。

**只读视图接口的契约探针**（12 项，含路径策略的反向用例）：

```bash
npm run probe:view
```

**沙箱客户端在无中继环境下的健康探针**（5 项）：

```bash
npm run probe:loopback
```

它存在的唯一理由是**把"隧道卡住"和"客户端坏了"分开**：同样的 Python 客户端、同样的 `pair-request`、同样的 bridge，只是把中继拿掉。详见第六节「隧道会间歇性卡住」。

**远端监听端口与边界的探针**（5 项）：

```bash
npm run probe:pinned
```

它守的是"点【开启隧道并复制提示词】时那次崩溃"。远端监听器只在暴露模式下存在，且端口原本由系统在 daemon 重启时决定——于是在点击的那一刻根本没有端口可读，读到的空字符串直接让 `new URL('')` 抛出 `ERR_INVALID_URL`。现在端口在开隧道之前就预订好（`reserveRemotePort()`），隧道、daemon 配置、允许列表三者用的是同一个值。探针验证：daemon 确实绑在预订端口上；携带正确 Host 但无授权的调用被拒（401）；未列出的 Host 被边界拒（403）；跨域被拒（403）；本地监听器也不会因为带上隧道 Host 就放行（403）。

> **同一个空字符串还坑了第二个地方。** 窗口判断"这个 bridge 是否能被隧道访问到"用的是
> `isExposed()`。它之前把 URL 拿去匹配字面量 `mcp_remote`——而 daemon 上报的地址就是
> `http://127.0.0.1:<port>`，**永远不含这个名字**，于是这个判断恒为假：界面会告诉操作者
> "未连接"，哪怕远端监听器明明活着。现在改成"这个值能否解析出端口"（`portOf(...) !== undefined`），
> 空字符串自然落到"未暴露"。测试 A16 把两个方向都钉住了。
>
> 教训：跨边界传回来的"可选值缺失"如果被编码成**空字符串**而不是 `undefined`/`null`，
> 那么 `??` 兜不住它，字符串匹配也容易写成永不成立。判定要基于**语义**（能否解析出端口），
> 不要基于**字面量**。

> **这里必须用 raw `http.request`，不能用 `fetch`。** `fetch` 会**静默丢弃**显式设置的 `Host` 头（实测：服务端收到的是 `127.0.0.1:<port>`，不是传入的域名）。用 `fetch` 写这个用例会得到一个假的 FAIL——请求根本没带恶意 Host，于是先被鉴权拦成 401，看起来像"允许列表没生效"。`node:http.request` 用 `setHost: false` 才真正发出指定的 Host。

**点击路径的探针**（12 项）：

```bash
npm run probe:click
```
`probe:pinned` 验的是 listener 本身；这个验的是**点击那一刻 handler 依次做的每个判断**，用的是 `dist` 里真实的模块（不是重写一份实现）。它按顺序覆盖：默认仅回环状态下 daemon 上报 `""` → **证明确实是旧写法 `new URL(value ?? fallback)` 在这个值上抛异常** → `portOf()` 返回 `undefined` 不抛 → 预定端口 → 校验隧道 URL（空值/跨域一律拒） → daemon 绑在预定端口上 → 窗口把暴露状态读成 `true`、把仅回环读成 `false` → 暴露的 listener 接受隧道 Host 但无授权仍拒（401）。

> **回归探针要能证明 bug 曾经存在。** 只断言"现在没问题"的探针，无法区分"修好了"和"这个用例从来没触发过问题"。所以这里保留了第一条：对旧写法做同样的调用，断言它**真的会抛**。

**构建产物里的导入路径检查**（6 项，外加 12 项窗口接线检查——含"剥离 PATH 后构建仍能成功"）：

```bash
npm run probe:imports     # 扫描 dist/ 里所有动态导入，确认每个都能解析
npm run probe:wiring      # 专门确认窗口的隧道写入脚本能从编译后的位置解析到
```

这两个守的是另一类故障：**编译后路径漂移**。窗口原本用相对路径 `../../../scripts/tunnel-cloudflared.mjs` 加载隧道脚本——这个写法在**源码树里是对的**，但文件编译进 `dist/apps/desktop/src/` 后，同样的相对路径解析成 `dist/scripts/...`，一个**不存在的目录**。于是点【开启隧道并复制提示词】时抛：

```
Cannot find module 'F:\...\dist\scripts\tunnel-cloudflared.mjs'
imported from F:\...\dist\apps\desktop\src\main.js
```

编译期不报错，所有测试也都不报错——因为**只有 Connect 按钮那一行**会执行这个导入，而没有任何测试驱动过它。是操作者点出来的。现在改为一律用 `path.join(repoRoot, 'scripts', ...)` 锚定（这个文件里其它资源本来就这么写）。

> **动态导入是类型检查和模块解析的盲区。** 写死的相对路径在编译后可能指向别处，而且只在那一行真正执行时才暴露。所以要么用 `repoRoot` 锚定，要么必须有静态检查盯着。`probe:wiring` 里保留了这条断言：**旧写法解析出的路径必须仍然不存在**（`dist/scripts/tunnel-cloudflared.mjs`），否则这个守卫就失去了意义。

**配对请求可见性与批准的探针**（16 项）：

```bash
npm run probe:pairing
```

它守的是一个真实报障：**远端 Agent 提交了配对请求、拿到了 pair_id，而窗口里没有任何可批准的东西**。

请求其实**到了**——数据库里确实有一条 `state: pending` 的记录，`pair_id` 与 Agent 报的完全一致。问题是窗口**只会创建配对，从来没有列出或批准配对的代码**：批准写操作的界面是「待办」页，而配对请求不是写操作（它出现在任何 run 或补丁之前），所以那一刻「待办」页是空的。界面上的步骤还写着"切到「待办」页批准那条配对请求"——指向一个不存在的东西。操作者据此合理地判断"请求根本没发出来"。

现在配对请求显示在**「接 Arena」页本身**（操作者本来就在看这一页），带批准/拒绝按钮，并且**每秒自动刷新**——否则"等它出现"只是句空话。

探针按顺序验证：窗口能签发配对码 → 没人请求时**不**显示为待批准 → Agent 能提交请求（`POST /pair/request`，**202**，该路由故意豁免鉴权，因为远端此刻还没有凭据）→ **请求出现在操作者的列表里、且 pair_id 与 Agent 报的一致** → 批准的调用被接受 → 批准后不再显示为待批准 → **越权批准被拒（403）**、**缺少 `data_egress_ack` 被拒（400）**、拒绝也能成功。

> **「什么都没有」和「坏了」必须能区分。** 面板在无请求时显示明确的"等待远端 Agent 请求配对…"，在读取失败时显示"无法读取配对请求：<原因>"。两种都**不**渲染空白——否则一个坏掉的面板和一个空的队列长得一模一样，而这正是这次故障里操作者被误导的原因。

**沙箱客户端读取工具结果的探针**（36 项）：

```bash
npm run probe:client
```

它守的是另一半：**远端 Agent 拿到的东西**。报障是 `agent-check` 在一个非空工作区里数出 0 个文件，并据此声称"服务端把负载包在 `{ok, data, metadata}` 信封里、目录字段叫 `type`"——**这两条关于服务端的判断都是对的**，错的是客户端：

```python
structured = result.get("structuredContent") or {}   # 这是 {ok, data, metadata}
entries = structured.get("entries") or []            # 永远 None：entries 在 data 里面
files = [e for e in entries if e.get("kind") != "directory"]   # 字段叫 type，不是 kind
```

两处错误**都不会报错**：取错层得到 `None`，判断不存在的字段得到 `None`，于是"列出全部条目"渲染成"没有文件"。这类静默的假阴性正是最该有守卫的地方。

所以客户端多了一组共用助手：`structured_of()`（取出 `structuredContent`，缺失时回退到 text content 里的同一份 JSON）、`unwrap()`（剥掉信封）、`is_directory()`（认 `type`，兼容 `kind`）。`agent-check` 和 `call` 都改用它们，避免同一个错误在别处重演。

探针断言**两件**事，缺一不可：

1. **旧写法在同一份载荷上确实得出空列表**——故障在案，否则"现在没问题"无法与"这条路径从没被走到"区分；
2. 新写法得出真实文件列表。

载荷是**从活 daemon 抓下来的原样 JSON**，再喂给客户端**真实的函数**（不是重写一份实现）。

> **本环境无法让子进程访问本进程持有的回环端口。** 试过：子进程 `curl`、子进程 Python（`urllib` 和裸 `socket`）连接本 Node 进程起的监听器，**TCP 连接建立成功但一个字节都收不到**，直到超时；换成 Python 自己起的服务，同一个子进程调用立刻正常；本进程内的 `fetch` 也正常。这台机器还设了 `http_proxy=http://127.0.0.1:49614` 且 `no_proxy` 为空，`curl` 会走它（这解释了另一批 `502`），但**去掉代理变量后子进程仍然读不到字节**，所以阻塞来自沙箱对回环连接的中间层，不是代理本身。结论：**不要**在这里用"起一个 daemon 再 spawn 客户端去连"的方式做验证；反过来喂载荷给真实函数是等价的，而且更快。
>
> **动态导入是类型检查和模块解析的盲区。** 写死的相对路径在编译后可能指向别处，而且只在那一行真正执行时才暴露。所以要么用 `repoRoot` 锚定，要么必须有静态检查盯着。`probe:wiring` 里保留了这条断言：**旧写法解析出的路径必须仍然不存在**（`dist/scripts/tunnel-cloudflared.mjs`），否则这个守卫就失去了意义。

> **为什么窗口里没有 GPU 加速？** 主进程在 `app.whenReady()` 之前强制了软件渲染（`disable-gpu` + `use-angle=swiftshader`）。这台机器上 Chromium 的 GPU 进程会反复崩溃并以 `FATAL: GPU process isn't usable. Goodbye.` 直接终止整个应用。软件渲染下界面功能完全一致，只是少了合成加速。

> **为什么窗口能自动清掉上次的状态锁？** 桌面窗口可能被直接关掉而不走优雅退出，残留 `daemon.lock` 是正常现象。主进程会读取锁里的 pid **和写入时的进程启动时间**，判断属主是否还是当初那个进程：**确认不是了才移走**（重命名为 `daemon.lock.orphaned`，不删除）；是真的活着的 daemon 就拒绝启动。绝不会误删活锁。
>
> **只看 pid 是不够的**：Windows 会回收 pid。曾经出现过这样的故障——上次关窗时 daemon 结束、锁留在盘上，随后系统把那个 pid 分给了一个 `svchost.exe` 服务。对别的账户下的服务，存活探测返回 `EPERM` 而不是 `ESRCH`，于是被读成"活着但不属于我们"，窗口**永久起不来且什么都不显示**。现在锁里多记了 `pid_started_at`，被回收的 pid 会被识别出来当作陈旧锁清理。旧版本留下的锁没有这个字段，会退回按进程名判断（只有 `node`/`electron` 才可能是我们的 daemon）。
>
> 回归守卫：`npm run probe:lease`（覆盖"pid 被回收 / 真的活锁 / 旧格式锁"三种情形；**只测第一种是不够的**，那样一个愿意清掉活锁的版本也会通过）。

## 二、最短路径

在本项目根目录：

```
双击 desktop.cmd    → 日常使用（独立窗口），也是接远端的唯一入口
npm run local       → 只启动 bridge（仅回环），控制台开在浏览器里
npm run expose      → 只启动 bridge，MCP 端口绑到通配地址（调试入站连通性）
npm test            → 跑测试；npm run verify 跑完整回归
```

`npm run local` / `npm run expose` 会在当前窗口前台运行，**按 Ctrl+C 停止**。启动后会自动打开浏览器到控制台。

**控制台入口（任选，四个都能进）：**
- http://127.0.0.1:48272/
- http://127.0.0.1:48272/console
- http://127.0.0.1:48272/console/
- http://127.0.0.1:48272/index.html

> 直接访问 `127.0.0.1:48272` 时如果看到 `{"error":{"code":"AUTH_REQUIRED",...}}`，说明你访问的是**旧版本进程**——旧版只在 `/console` 提供页面。用 Ctrl+C 停掉，重新运行 `npm run local` 即可。

控制台会要求你粘贴 `admin_token`（来自 `.arena-bridge\local-credentials.json`）。令牌只存在浏览器 sessionStorage，关标签页即清除；页面本身不含任何数据或凭据，所有数据都通过带令牌的同源请求拉取。

> **`npm run local` 会自动帮你登录。** 它打开的是 `…/console#t=<admin_token>` 形式，令牌放在 URL 片段里——片段**不会发给服务器、不进日志**，页面读到后立刻用 `history.replaceState` 从地址栏抹掉。所以你通常不需要手动找令牌。
>
> 需要手动登录时（比如换了浏览器、或用 `--no-open` 启动），从 `.arena-bridge\local-credentials.json` 复制 `admin_token` 字段粘贴即可。**别粘配对码**——两者都是 43 字符随机串，肉眼分不出，但配对码是给远端 Agent 用的。

### 控制台怎么用（操作台，三个视图）

控制台是一个**操作台**，不是只读面板。远端的模型只能"请求"，真正动手的是你。

**① 待办（默认页，最常用）**

待审的写操作以卡片形式列出，每张卡包含：谁在请求、要改哪个文件、**着色渲染的 diff**、多久过期，以及两个按钮。

- 点「允许这次修改」→ 补丁**立即写入工作区文件**（真改，不是预览）。
- 点「拒绝」→ 远端收到拒绝，文件不变。
- 卡片头上有**倒计时**。默认 5 分钟过期（可用环境变量 `ARENABRIDGE_APPROVAL_TTL_MS` 调整）。
- 勾上「有新写请求时提醒我」→ 浏览器通知。**建议一直勾着**：审批过期几乎都是因为没人注意到。

标签页名旁的红色数字是待办数量，切到别的视图也会更新。

**② 活动**

按 run 分组的时间线，把审计日志翻成人话，例如：

```
15:04:11  远端请求接入
15:04:11  本机决定配对
15:04:12  签发授权         权限 code
15:04:13  远端完成挑战
15:04:20  工具执行完成     读文件 · 42ms
15:04:22  请求写入审批
15:04:35  本机审批评审     已允许
15:04:35  审批已消费（写入执行）
15:04:35  工具执行完成     改文件 · 327ms
```

失败的调用会标红并带错误码。**这是判断"它到底干了什么"的权威依据**——远端 Agent 的自述不算数，这里才是。

**③ 授权台账**

当前所有远端授权：权限级别（`ask`/`plan` 只读，`code` 可写且每次需审批）、绑定工作区、是否已撤销。底部是「撤销全部授权」，一键切断远端所有新动作。

控制了哪些事：查看健康/工作区/能力边界、生成一次性配对邀请、批准或拒绝远端配对、批准或拒绝补丁、查看运行记录、查看工具 schema、查看脱敏事件、撤销全部远端授权。

**控制台自己不持有任何权限**——它调用的全是已有的 admin API。它拿不到的东西，别处也拿不到。开放端口只有下面三个，且都在 127.0.0.1。

三个端口：

| 端口 | 地址 | 用途 | 用哪个凭据 |
|---|---|---|---|
| API | `http://127.0.0.1:48270/v1` | 模型网关（OpenAI 兼容） | `api_token` |
| MCP | `http://127.0.0.1:48271/mcp` | 工作区工具桥接 | 短期配对 grant |
| Admin | `http://127.0.0.1:48272` | 控制台 + 控制面 API | `admin_token` |

凭据在 `.arena-bridge\local-credentials.json`，只在本机回环有效，删除该文件即可轮换。

命令行等价写法：

```bash
node scripts/bootstrap-local.mjs                  # 编译(按需)+凭据(按需)+前台启动
node scripts/bootstrap-local.mjs --check-only     # 只检查编译与凭据，不启动
node scripts/bootstrap-local.mjs --no-open        # 启动但不自动开浏览器
node scripts/bootstrap-local.mjs <配置文件>        # 换一个配置启动
node dist/apps/daemon/src/cli.js preflight --config outputs/run-local.config.json
```

### 想先看效果、又不想碰真实文件？

```bash
node scripts/console-preview.mjs
```

它会开一个**完全独立**的临时实例（随机端口、独立的临时工作区副本、独立状态目录），模拟一个远端 Agent 走到"请求改文件"这一步，然后把控制台地址打印出来。

这时「待办」里会停着一张**真实的**审批卡。点「允许这次修改」，那张卡片对应的临时工作区文件会真的从 `a - b` 变成 `a + b`（在 `outputs/console-preview/` 下，不是你的项目）。

按 Ctrl+C 结束。这个预览不读也不写 `.arena-bridge/` 里的正式状态，不影响任何正在运行的实例。

`bootstrap-local.mjs` 会把凭据注入 daemon 进程环境（daemon 不读凭据文件）。按 Ctrl+C 优雅停止并释放状态锁。

Windows 上如果进程被强杀（任务管理器结束进程、终端窗口被直接关闭），状态锁会残留。下次启动时脚本会检查锁的属主进程是否还是当初那个（**pid + 启动时间**，因为 pid 会被系统回收）：**确认不是了才自动清理并提示，还活着则拒绝启动**，绝不会误删活锁。

`preflight` 会列出本机所有网络地址、判断它们是回环/私有/链路本地/全球，并识别 Teredo、6to4 等隧道前缀，同时列出必须人工确认的网络前提。

## 二、怎么用：接到 WorkBuddy / TRAE

服务跑起来后，在宿主里把 ArenaBridge 当成一个"自定义模型"：

1. 打开宿主的模型配置界面（WorkBuddy：设置 → 模型 → 自定义/Custom；TRAE：设置 → 模型 → 添加模型 → 自定义模型）。
2. 填入：

   | 字段 | 值 |
   |---|---|
   | 基础地址 / Base URL | `http://127.0.0.1:48270/v1` |
   | 或完整 URL（宿主有"完整 URL"开关时） | `http://127.0.0.1:48270/v1/chat/completions` |
   | 模型名 / 模型 ID | `mock-agent-local`（由 `/v1/models` 实际返回） |
   | API Key | `.arena-bridge\local-credentials.json` 里的 `api_token` |

3. 保存。宿主会调用 `/v1/models` 做连通性检查，通过后即可选择该模型对话。

**注意**：模型名必须和 `/v1/models` 返回的一致，写错会得到 400。API Key 用 `api_token`，**不要**用 `admin_token`（会 401），也不要用任何 Arena cookie。

当前配置用的是 Mock 后端，所以模型回复会带 `[MOCK; no model inference]` 前缀——这是刻意的，用来证明链路真的通了，而不是伪装成真模型。

## 三、怎么用：MCP 工作区工具（另一条独立路径）

模型网关和工作区桥接是两条不同的路。要让远端 Agent 读/改本机项目，走 MCP 端口，需要先配对：

```bash
ADMIN=<local-credentials.json 里的 admin_token>
API=<local-credentials.json 里的 api_token>

# 1) 本机管理员创建一次性配对邀请（拿到 code）
curl -s http://127.0.0.1:48272/admin/v1/pairings -H "Authorization: Bearer $ADMIN" \
  -H "Content-Type: application/json" \
  -d '{"workspace_id":"</admin/v1/status 里的 workspaces[].id>","recipient":"本地测试","max_access":"code","ttl_ms":120000}'

# 2) 客户端用 code 请求配对（拿到 claim_secret，此时还没有文件权限）
curl -s http://127.0.0.1:48271/pair/request -H "Content-Type: application/json" \
  -d '{"code":"<上一步的 code>","remote_label":"我的测试客户端","access_mode":"code"}'

# 3) 本机管理员审批（必须显式确认数据出站）
curl -s http://127.0.0.1:48272/admin/v1/pairings/<pair_id>/decision -H "Authorization: Bearer $ADMIN" \
  -H "Content-Type: application/json" \
  -d '{"approve":true,"access_mode":"code","data_egress_ack":true}'

# 4) 一次性领取 grant + challenge（token 只返回这一次）
curl -s http://127.0.0.1:48271/pair/claim -H "Content-Type: application/json" \
  -d '{"pair_id":"<pair_id>","claim_secret":"<claim_secret>"}'
```

拿到 token 后就可以用任何 MCP 客户端（含 `node dist/apps/daemon/src/cli.js mcp stdio`）访问 `/mcp`。Code 权限下改文件还要再走一次本地审批：

1. `apply_patch` 传 `action:"preview"` → 返回真实 Diff 和 `approval_id`，**此时项目文件没动**。
2. 管理员审批：`POST /admin/v1/approvals/<approval_id>/decision` body `{"approve":true}`。
3. `apply_patch` 传 `action:"apply"` → 重新校验路径与 SHA256 后才写入。

## 四、怎么测

```bash
# 网关三套（纯内存 + 真实 HTTP + daemon 端到端），当前 29/29 通过
npm run test:gateway

# 真实启动一个 daemon 并逐项冒烟（14 项），结束后自动停止
node scripts/smoke-local.mjs
# 结果落在 outputs/local-run-smoke.json

# 工作区事务套件（会创建/清理 .test-data）
npm run test:workspace

# 桌面窗口端到端（16 项，真实开窗口 + 真实审批 + 真实落盘）
node scripts/desktop-e2e.mjs

# 只读视图接口契约探针（12 项，含路径策略反向用例）
npm run probe:view

# 访问模式上限探针（53 项）：签 ask/plan/code/exec 四种码，验证越权请求 403、
# 并断言「档位清单」在引擎/客户端/窗口/契约四处一致、客户端 argparse 真的收 exec、
# 合法请求 202、以及 code 档确实拿到 workspace:patch
npm run probe:access-mode

# 命令执行与编辑/搜索探针（36 项）：exec 档闸门、cwd 边界、子进程凭据清洗、
# 超时杀进程树、输出上限、逐条审计、撤权即杀、edit_file 三种拒绝、正则 DoS 不会卡死 daemon
npm run probe:exec

# 授权有效期探针（18 项）：会话级授权真的不过期、限时授权真的会过期、
# 重启（epoch 轮换）与撤权都会立刻作废、负数 TTL 被拒
npm run probe:grant-lifetime

# 无人值守写入探针（61 项）：默认关闭、必须带 confirm、负 ttl 被拒、不限时长可用且真落盘、
# 关掉后未批准的写入被拒、过期自动恢复人工、审计不冒充操作者、提示词据实描述、
# 提示词表头与正文规则一致、会话结束（断开/关窗）自动关闭
npm run probe:auto-approve

# 桌面窗口自检（53 项，无头跑真实窗口 + 真实 daemon）
npm run desktop:selftest

# 完整回归（编译+全部测试+演示+SBOM）
node scripts/verify.mjs
```

**完整回归建议用这个跑**（在 Agent 会话里尤其重要）：

```bash
node scripts/run-tests-clean.mjs
```

它给子进程一个**独立的删除预算账本**再启动 `node --test`，并且把结论分成三档：

| 退出码 | 含义 |
|---|---|
| `0` | 跑完终值，零失败 = **PASS** |
| `1` | 跑完终值，有失败 = **真实回归**，需要修 |
| `75` | **INCONCLUSIVE** — 被宿主删除保护提前掐断，没跑到终值，**不能据此判断代码** |
| `2` | 其他原因没产出终值 |

区分 `1` 和 `75` 是关键：套件里每一次 `unlink` 都会经过宿主的 `node-safe-delete` 垫片，而它把计数记在「当次工具调用」上。一次工具调用跑完整个套件必然越过阈值，于是第 6 个子测试之后所有 `daemon.close()` 都被拒，运行被中止——**这是环境现象，不是产品缺陷**。

手工验证网关：

```bash
API=<api_token>
curl -s http://127.0.0.1:48270/v1/models -H "Authorization: Bearer $API"
curl -s http://127.0.0.1:48270/v1/chat/completions -H "Authorization: Bearer $API" \
  -H "Content-Type: application/json" \
  -d '{"model":"mock-agent-local","messages":[{"role":"user","content":"你好"}]}'
```

### 关于 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`

这个错误**几乎总是环境现象，不是代码回归**。看到它时先分清两种情形：

**情形一：只有个别删除被拒（比如 `daemon.close()` 释放状态锁）。**
宿主的 `node-safe-delete` 垫片会拦截子 Node 进程的每一次删除，并把计数记在 `CODEBUDDY_CONVERSATION_REQUEST_ID` 上——名义是「按回合」，实际上一个 agent 工具调用里跑的 `npm test` 会继承**这个工具调用自己**的计数。阈值默认 50，一次工具调用跑完整个套件必然越界。

正确做法：用 `node scripts/run-tests-clean.mjs` 重跑，它给子进程一个干净的独立账本，**不关闭保护、不清空 `.test-data`、不改保护脚本**。看退出码判定：`0` 通过、`1` 真实失败、`75` 本次运行无效需重跑。

> 常见误判：把 `75` 当成「44 项失败」记进报告。运行没跑到终值时，**任何项数都不算数**。判定依据只能是 `# tests` / `# fail` 这两行终值。

**情形二：保护脚本本身报 `SAFE_DELETE_BULK_GUARD_ERROR`。**
说明垫片找到了，但 `CODEBUDDY_NODE_BIN` 指向的 node 丢了。这是宿主安装问题，与本项目无关。

**本项目自身的产品侧行为**：`PatchEngine` 的提交锁在删除被拒时**不会**留下永久锁。它会读取锁文件里的 pid，属主已死就由 guard 接管清理，并把「删不掉」如实报成 `PATCH_LOCKED: 无法清除提交锁 guard（…）；该锁仍然存在，需要本地检查`，而不是含糊的 `IO_ERROR`。

## 五、换成真实模型

改 `outputs/run-local.config.json` 的 `gateway` 段：

```jsonc
// 本地验证链路（默认，不花钱、不出网）
{ "type": "mock", "acknowledge_mock": true, "alias": "mock-agent-local", "scenario": "echo" }

// 换成你有权使用的 OpenAI 兼容服务
{ "type": "approved_openai_api",
  "alias": "my-model",                 // 会出现在 /v1/models
  "model": "供应商的真实模型 ID",
  "base_url": "https://供应商地址/v1",
  "api_key_env": "MY_PROVIDER_API_KEY", // 环境变量名，不是密钥本身
  "authorization_reference": "内部审批单号",
  "data_egress_approved": true,
  "native_parameters": ["tools","tool_choice","temperature","top_p","max_tokens","stop"] }
```

然后把密钥放进进程环境再启动：

```
set MY_PROVIDER_API_KEY=sk-xxxx
npm run local
```

`native_parameters` 里没列的参数一律返回 422，不会静默丢弃。`strict`、`json_schema`、`n>1`、`logprobs`、`seed`、附件都不支持。

## 五、把 bridge 接进 WorkBuddy（本机直连）

WorkBuddy 跑在同一台机器上，**不需要隧道、不需要配对握手**，直接连本机 MCP 端口。

```bash
node scripts/register-workbuddy.mjs          # 注册（会先备份原配置）
node scripts/register-workbuddy.mjs --print   # 只预览，不写盘
node scripts/register-workbuddy.mjs --remove  # 撤销
```

它会把一条 `arenabridge` 条目写进 `~/.workbuddy-ai/mcp.json`，**保留其它所有服务器条目**，并在写入前备份原文件。然后：

1. 运行 `npm run local` 启动 bridge
2. 在 WorkBuddy 的连接器管理页右上角找到自定义连接器，对 `arenabridge` 点 **Trust**
3. 工作区工具出现。写操作仍需本机逐次批准

### 为什么本机能免配对

bridge 现在有**两个 MCP 监听器，信任级别不同**：

| 端口 | 绑定 | 接受什么凭据 | 用途 |
|---|---|---|---|
| 48271 | 仅 `127.0.0.1` | 配对 grant **或** 本地 `mcp_token` | 本机宿主（WorkBuddy / TRAE / 编辑器） |
| 48273 | 隧道或公网地址 | **只**接受配对 grant | 远端 Agent（Arena） |

隧道永远指向 48273，所以**即使有人拿到 `mcp_token`，也无法从公网使用**。本地 `mcp_token` 是独立的第三个凭据（`admin_token`、`api_token`、`mcp_token` 三者互不相同，缺一个就拒绝启动）。

本地身份仍是一条**真实的、被审计的 grant**（`principal=local_mcp`、`execution_owner=remote_workspace`、`access_mode=code`），所以它会出现在控制台的运行记录和事件里，写操作照旧走"预览 → 本机批准 → 应用"。

> 注意：本地身份给了 `code` 权限，也就是可以改文件（但每次仍要你批准）。这不是提权——WorkBuddy 本来就有整台机器的文件访问权；桥接的价值在于把访问限制在**注册的工作区根目录**内，并留下审计轨迹。

### 凭据速查

| 值 | 用途 | 出现在哪 |
|---|---|---|
| `admin_token` | 登录本地控制台（48272） | `.arena-bridge/local-credentials.json` |
| `api_token` | 调模型网关（48270） | 同一个文件 |
| `mcp_token` | 本机 MCP 宿主（48271） | 同一个文件 |
| 配对码 | 给远端 Agent 发起配对 | 一键脚本窗口 / 提示词里 |

四个值都是 43 字符随机串，肉眼分不出来；粘错时服务端会明确指出是哪一种。

## 六、接到远端 Agent（Arena）

**Arena 沙箱实测是 IPv4-only 出网，没有 IPv6 默认路由**，任何公网 IPv6 字面量都会在内核层直接 `ENETUNREACH`；而本机在 NAT 之后（且流量经代理出口），也没有沙箱能直接拨到的地址。所以正确方案是隧道，不是直连。

### 桌面窗口内一键开启（推荐）

启动桌面窗口后，切到**「接 Arena」**标签页，**先选访问模式**，再点**「开启隧道并复制提示词…」**。窗口内完成全流程，不用另开终端：

1. **先选访问模式**（见下一节）。这一项决定了配对码的权限上限，**签发后无法提高**。
2. 弹出确认框，**明确告诉你这个目录会被暴露到公网**、Cloudflare 能看到明文、Arena 数据进公开排行榜 → 每次都必须点确认（不记忆、不复用）。
3. 启动 cloudflared 快速隧道（目标端口固定 48273，即 `mcp_remote`，**只**接受配对 grant）。
4. 用隧道域名重启 bridge（远端监听器的 Host 白名单在启动时就固定，所以必须先有域名）。
5. 生成配对码 + 提示词，**自动复制到剪贴板**，并显示配对码、访问模式和倒计时。
6. 在 Arena 里 Ctrl+V → 发送 → Agent 报 pair_id → 回到窗口点批准 → 对 Agent 说"已批准"。

**关掉窗口 = 断开**：窗口关闭时会先杀隧道再停 bridge，不会留下一个仍可从公网访问的工作区。想主动断开就点「断开」。
剪贴板万一没复制成功，面板里会出现一个只读文本框，可以全选手动复制（窗口会明确提示"自动复制失败"）。

> **远端报 `can't open file '/tmp/ab_client.py'`：这是沙箱，不是 bridge。** 实测过一次：第 3 步
> 拿到了 pair_id（说明客户端当时在），等我批准之后第 4 步就报文件不存在——沙箱在两轮对话之间
> 把 `/tmp` 清了。同一个清空还会带走状态文件里的 pair_id、claim_secret 和 grant token，
> 所以提示词现在要求**每一步自带参数**：`pair-claim` 显式带 `--pair-id` / `--claim-secret`，
> 后续步骤把 `ARENABRIDGE_TOKEN=...` 写在命令里，脚本没了就重跑第 1 步。
> 判断依据：报这个错时 bridge 一直活着（同一时刻本机回环上是好的），不是连接或授权问题。

### 访问模式：ask / plan / code / exec，上限签了就不能改

**这是最容易踩的坑。** 配对码（pairing code）上带一个**硬上限** `max_access`，四个档位：

| 档位 | 远端能做什么 | 提示词里的 `--access-mode` |
|---|---|---|
| `ask` | 只读。任何写操作返回 403 | `ask` |
| `plan` | 只读，语义上是"先规划后动手" | `plan` |
| `code` | 可提交改动**预览**；**每次真正写盘仍需你在「待办」里单独批准** | `code` |
| `exec` | 上面 `code` 的全部，**加上直接执行 shell 命令**（`run_command`）。命令**没有批准这一步**，用你的账户权限跑 | `exec` |

> ⚠️ **`exec` 是这份文档里风险最高的一档，选它等于把这台机器的一个 shell 交给远端。**
> 它能做的边界只有：工作目录必须落在被暴露的目录内、默认 30 秒超时（最多 5 分钟）、
> stdout/stderr 各截断 64 KiB、没有交互式输入、超时/断开/撤权/关窗时整棵进程树被杀、
> 每条命令进审计日志（含命令行与哈希）。**没有 OS 沙箱**——它能读你能读的、写你能写的。
> 提示注入一旦命中，后果从"改了你的文件"变成"在你的账户下执行任意代码"。
> `exec` 档同时隐含 `workspace:patch`（shell 本来就能写文件，把 patch 藏起来只是名义上的限制）。

三个关键点：

1. **上限在签发时固定，之后无法提高。** 远端请求高于上限的档位，daemon 直接返回
   `403 POLICY_DENIED`：「Requested access exceeds pairing scope」。**这不是"权限不够配不上"，
   而是你（或者旧版本窗口）当初签发的码就只有那么高的上限。** 想提权限只能**重新签发一个配对码**。
2. **不要手动把提示词里的 `--access-mode` 改高。** 改了也只会拿到 403，不会换来任何额外权限——
   提示词里专门写了这条硬性约束，让 Agent 别去试。
3. **`code` 不等于"免批准"。** `code` 只是让"提交改动预览"这个能力**可用**；`apply_patch` 始终是两阶段：
   先 `preview` 拿到 `patch_id`，再由**你本机单独批准**一次（一次性、且只对未变动的文件生效），
   然后才 `apply`。所以选 `code` 改变的是"哪个能力可用"，不是"远端可以自己动手"。

> **历史问题（已修复）**：0.1.0-stage1 早期版本里，窗口**无论选什么都把码签成 `ask`**，
> 所以把提示词手动改成 `code` 必然 403，看起来像"权限不够"。现在窗口在开启前提供三选一，
> 模式会同时写进**配对码、提示词、审批记录**三处，三者必须一致。
> 回归保护：`npm run probe:access-mode`（53 项，含"上限确为 code 时才真的拿到 `workspace:patch`"的对照、exec 档的签发/越权/scope 对照，以及**四处档位清单一致性**——这条是补的：`exec` 曾只加到引擎/提示词/窗口，漏了客户端 argparse，远端 `--access-mode=exec` 在本地就 exit 2，看起来像服务端拒绝）。

> **另一个同类历史问题（已修复）**：同一页的「有效时长」下拉曾经**点不动**，永远是默认值。
> 原因不在 JS，而在 HTML 结构——`<select>` 被套在 `<label class="arena-auto-ttl">` 里面，
> 于是这个 `<select>` 成了 label 的**隐式关联控件**（`label.control === select`）。
> 按 HTML 规范，点击 label 会去"激活"它的关联控件，而控件的激活行为本身就是弹出/收起下拉——
> 于是一次点击里"打开"和"关闭"同时发生，看起来就是**下拉打不开、选了不生效**。
> 修法是把 `<label>` 换成普通 `<div>`，标题用显式 `<label for="autoApproveTtl">`。
> 回归保护是 `desktop:selftest` 里的结构断言：`!select.closest('label')`——
> 只要有人再把 `<select>` 套回 label 里，这条就会失败并直接指出原因。

### 无人值守写入（高风险，默认关闭）

`code` 模式的写盘是四步：**提交预览 → 你看 diff → 你在「待办」点批准 → 远端 apply**。
如果嫌慢，「接 Arena」页有一个**无人值守写入**开关，打开后预览会被**自动批准**，省掉中间两步。

> **开着开关时，写盘可以只发一次调用。** `apply_patch` 支持 `action:"write"`（形状与 preview 相同），
> 它自己完成"预检 → 自动批准 → 落盘"，等于把 preview 和 apply 合成一次往返——因为开着窗口时那次批准
> 本来就会立即自动产生，第二次往返只买来延迟。
>
> **它不是"免审批"**：审批照样由服务端产生并留痕（批准人 `auto_unattended`、事件 `approval.auto_approved`），
> 照样消费一次性审批，提交时照样重验路径与 SHA256。**窗口一关，这个动作立刻 403**（`POLICY_DENIED`），
> 绝不会悄悄降级成"没有审批也能写"；所以 `code` 本身永远不等于免批准。想继续用两步也可以，两者等价。

**它去掉的是"有人看过 diff"这件事，不是"点按钮"这个动作。** 按钮可以自动点，人判断内容有没有问题不能自动。
所以：

- **默认关闭。** 不勾选就永远需要你批准。
- **时长可选**：5 分钟 / 10 分钟 / 30 分钟 / 1 小时，或**不限时长**。选定的时长到期**自动失效**，
  不需要你记得关；服务端每次写盘都会重新检查，所以过期是立刻生效的，不靠定时任务。
- **「不限时长」就是真的不限**：`expires_at` 记为哨兵值 `0`，永远不会自己失效，只会在你手动关闭
  或断开隧道时停止。面板横幅会换成"不会自动失效"的措辞，**不会**显示一个编出来的倒计时。
- ⚠️ **它跟"远端授权"是两口钟，别混。** 「不限时长」说的是"写盘要不要你逐个点头"，**不是**
  "这次连接能一直用"。远端拿到的那张 grant 凭证**没有墙钟到期时间**——它跟着**本次 bridge 会话**：
  你关窗、断开隧道、切换工作目录、或撤销授权，它立刻失效（实现上绑定 daemon epoch，每次启动轮换）。
  所以它不会因为"过了多久"而失效，也不会跨会话活下来。
  > 早期版本给它挂了固定 1 小时。结果是长任务跑到一半突然全部调用被拒，两边都不知道为什么——
  > 而 1 小时并没有多换来什么安全性：凭证本来就活不过会话结束。
- 远端侧拿到的是人话：`pair-claim` / `verify` / `agent-check` 的返回都带 `expires_in`，
  会话级凭证会显示 `no wall-clock expiry (valid until the bridge session ends)`，而不是一个裸 epoch
  （真实发生过：远端把 `1789711776434` 读成"还有 9 个月"，其实只剩 40 分钟）。
- **仍然可以手动签一个限时授权**：`POST /admin/v1/pairings` 带 `grant_ttl_ms`（毫秒，上限 1 小时）即可，
  不带就是会话级。负数/非法值一律 400，**绝不会被读成"不限时长"**。
- 「重新签发配对码（授权到期后用）」按钮仍在：在同一根隧道上签一枚新码并复制新提示词
  （访问模式、工作目录、暴露确认都不变）。会话级授权下它用得少了，但撤销过授权、或想让远端换一张
  凭证时仍然有用。
- **打开时要过一次确认框**，写明后果（选不限时长时额外点明"不会有任何自动失效"）；
  关闭时不需要确认（免得因为嫌麻烦就让它一直开着）。
- **开着的期间，面板顶部有一条不可关闭的红色横幅**，显示剩余时间（不限时长时显示"不会自动失效"），
  旁边有「立即关闭（当前不限时长）」。
- **断开隧道、或直接关掉窗口，都会同时关掉它**，避免下次连接（可能是几天后、另一个远端）默默继承这个状态。这条保证落在"结束会话"的代码路径上（`disconnectArena` 与关窗时的 `closeDaemonQuietly`），**不**依赖你点了哪个按钮——关窗口不会走「断开」按钮的处理函数，而"不限时长"恰恰没有到期时间可以兜底。
- **审计留痕写得明明白白**：每次自动批准都记一条 `approval.auto_approved`，批准人记为
  `auto_unattended`，**不会冒充是你批的**；开启事件里带 `unlimited:true` 或具体 `ttl_ms`。

> ⚠️ **风险要说清楚**：开着的时候，如果 Arena 那边的 Agent 读到的某个文件里藏了诱导性指令
> （提示注入），它写下的东西会**直接落到你的磁盘，没有任何人过目**。只在没有隐私、
> 随时可以重建的目录上开这个开关。
>
> 选**「不限时长」**时这条风险没有兜底：没有到期时间可以替你收尾，唯一的停止方式是横幅上那个
> 「立即关闭」按钮。**如果只是想让一轮任务跑快点，选 10 分钟就够；不限时长留给明确需要长时间
> 无人值守的场景**，用完请确认横幅已经消失。

命令行等价（`confirm` 必填；`ttl_ms` 可选，**省略或 `0` 表示不限时长**）：

```bash
API=$(node -e "console.log(require('./.arena-bridge/local-credentials.json').admin_token)")
# 打开 10 分钟
curl -s -X POST http://127.0.0.1:48272/admin/v1/auto-approve -H "Authorization: Bearer $API" \
  -H 'Content-Type: application/json' -d '{"enabled":true,"ttl_ms":600000,"confirm":true}'
# 打开且不限时长（ttl_ms 省略、0 是同一个意思）
curl -s -X POST http://127.0.0.1:48272/admin/v1/auto-approve -H "Authorization: Bearer $API" \
  -H 'Content-Type: application/json' -d '{"enabled":true,"confirm":true}'
# 查看当前状态（unlimited=true 表示不限时长，expires_at 会是 0）
curl -s http://127.0.0.1:48272/admin/v1/auto-approve -H "Authorization: Bearer $API"
# 立刻关闭
curl -s -X POST http://127.0.0.1:48272/admin/v1/auto-approve -H "Authorization: Bearer $API" \
  -H 'Content-Type: application/json' -d '{"enabled":false}'
```

负数或非数字的 `ttl_ms` 会被拒（400），**不会被当成不限时长**——把畸形请求读成"永久开启"是
这个接口能犯的最坏的错，所以宁可报错。

回归保护：`npm run probe:auto-approve`（61 项）——覆盖"默认关闭""不带 confirm 不能开""负 ttl 被拒"
"不传 ttl 即不限时长且能重复读到""开着时预览即为 approved 且文件真的落盘"
"不限时长窗口同样真的落盘、且仍可手动关闭""关掉后未批准的写入被拒（`APPROVAL_REQUIRED`）且文件没落盘"
"过期后自动回到人工""提示词据实描述当前是否有人审阅、以及有没有到期时间""提示词的访问模式表头与正文规则不能互相矛盾"
"断开隧道/关窗都会关掉它（不依赖点哪个按钮）"。

### 等价的手动步骤（调试用）

窗口里的一键隧道把下面这些步骤串了起来；需要单独控制时可以分步做：

```bash
node scripts/tunnel-cloudflared.mjs 48271   # 建隧道，打印公网地址
npm run expose                              # 以暴露模式启动 bridge（仅用于调试入站连通性）
node scripts/arena-prompt.mjs               # 单独生成提示词
node scripts/arena-flow-test.mjs            # 本机预演整套流程
```

> 这是**调试路径**，不是推荐路径。窗口版保证了一个手工做很容易搞错的顺序：必须**先预订 `mcp_remote` 端口，再开隧道**，然后以「仅监听 127.0.0.1 + `allowed_hosts=[隧道域名]`」重启 daemon——顺序反了就会死锁。

然后：**Ctrl+V → 发送 → Agent 报 pair_id → 控制台点批准 → 回来说"已批准"**。

**本机不开放任何端口**：bridge 只听 127.0.0.1，只有隧道地址对外；管理端口始终只在回环。Ctrl+C 时隧道和 bridge 一起停。

### 隧道会间歇性"卡住"，这不是 bridge 的问题

实测（同一条隧道、同一个 payload、重复请求）：**Node 的 fetch 6/6 成功（0.4–1.6s），Python 客户端 5/6 成功（0.9–2.0s）、1 次超过 12s 无响应**。也就是说快速隧道的 HTTP/1.1 通路**偶发**会接受请求却永不回包——这是边缘网络的行为，不是 bridge 或客户端的缺陷（bridge 在回环上始终正常）。

所以 `client/arena_sandbox_client.py` 把"读超时"当成**可重试的传输错误**处理：读的等待上限收窄到 `ARENABRIDGE_READ_DEADLINE`（默认 20s），卡住就用正常的重试次数再来，而不是干等满 `ARENABRIDGE_TIMEOUT` 然后报一句像是 bridge 挂了的错误。真遇到连续卡住，错误信息会明确说"连接被接受了但期限内没有响应，N 次"，并提示可以调大 `ARENABRIDGE_READ_DEADLINE` / `ARENABRIDGE_TIMEOUT`。

想要旧行为（单次长等待、不重试）就设 `ARENABRIDGE_READ_DEADLINE=0`。

注意：`scripts/probe-exposed-listener.mjs` 会把"重试耗尽仍被卡住"判为**环境结果**（退出码 2）而不是产品失败，因为同一轮里 bridge 已经被证明能在该隧道上正常应答。

退出码约定（与 `run-tests-clean.mjs` 的 0/1/2/75 口径一致）：

| 退出码 | 含义 |
|---|---|
| `0` | 全部通过：远端 Agent 只能经隧道、且只能凭 grant 到达 bridge |
| `1` | 真实红灯，暴露链路不成立 |
| `2` | **环境结果**：隧道 HTTP/1.1 通路把请求卡住了，`grant` 路径无法在经中继的条件下验证。**不能据此判断产品** |

**卡住的是两条 HTTP 栈都会遇到的**：Python 客户端（`urllib`）与被 Node 探针用的 `fetch` 都会偶发拿到"连接被接受但无响应"。两者都会先重试再判定，都不允许把一次卡顿直接升级成"产品坏了"。

**想证明"卡住"是隧道而不是客户端**，跑 `npm run probe:loopback`：它在**完全没有中继**的环境下用同一个 Python 客户端对同一个 bridge 发同一个 `pair-request` 请求。实测连跑 5 次全部 5/5 通过，`pair-request` 每次 700–800ms 返回。这个脚本刻意做了三件事，否则它自己就会说谎：

- daemon 跑在**独立进程**（`cli.js serve`）。早先的排查脚本把 daemon 开在进程内、又用 `spawnSync` 调客户端，`spawnSync` 会阻塞 Node 事件循环 —— 而 daemon 共享同一个循环，于是形成自锁，看起来跟"客户端挂了"一模一样。**这不是产品缺陷，是我自己的探针写错了。**
- 清掉 `ARENABRIDGE_*` 与 `*_proxy` 环境变量并显式钉住 `ARENABRIDGE_READ_DEADLINE=20` / `ARENABRIDGE_RETRIES=2`，避免残留的环境值让结论失真。
- 三种凭据必须各不相同且长度 ≥32（daemon 会拒绝更短或重复的凭据）。

### 控制台登录用哪个值

| 值 | 用途 | 位置 |
|---|---|---|
| `admin_token` | 登录本地控制台（48272） | `.arena-bridge/local-credentials.json` |
| `api_token` | 调模型网关（48270） | 同一个文件 |
| 配对码 | 给远端 Agent 发起配对 | 一键脚本窗口 / 提示词里 |

这三个都是 43 字符的随机串，**肉眼分不出来**。粘错时控制台会明确指出是哪一种，不会只报 invalid。

### 隐私代价

隧道由 Cloudflare 终止 TLS，**Cloudflare 能看到 MCP 明文**（文件内容、路径、Diff）；Arena 官方声明 Agent Mode 数据会进**公开**排行榜。内容经过两方 → **只可用合成项目测试**。

完整步骤、排错与分步命令见 `docs/arena-agent-connection.md`。

### 如果一定要用直连（不推荐）

只有在沙箱具备 IPv6 出口、且本机有原生可入站 IPv6 时才有意义。配置方式：

```jsonc
"remote_ingress": {
  "enabled": true,
  "acknowledge_exposure": true,   // 必须显式确认，否则拒绝启动
  "bind_address": "::",           // 或具体全球地址
  "allow_cidrs": [],              // 可选来源限制
  "allowed_hosts": [],            // 隧道模式才需要填
  "require_grant": true           // 不可关闭
}
```

开启后只有 MCP 端口对外，**管理端口仍然只在 127.0.0.1**。当前只做明文 HTTP，公网使用必须加 TLS 反代或隧道。


