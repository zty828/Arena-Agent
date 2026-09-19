# ArenaBridge

**让远端模型用上你本机的文件与命令——但每一次执行都留在你的机器上，由你批准、可审计、随时可撤。**

ArenaBridge 是一个本地 MCP Bridge。远端 Agent（Arena Agent、WorkBuddy、TRAE，或任何能跑 MCP 客户端的沙箱）通过一条隧道连过来之后，可以读你的工作区、提交补丁、在你显式选定的档位下执行命令；而**执行始终发生在你的机器上、由你的策略引擎裁决**。你不需要把代码上传到任何地方，也不需要给远端一个 shell。

> **`0.1.0-stage1`：这是可运行的核心，不是完整产品。**
> 已实现：受限文件工具、配对审批、撤权、SQLite 审计账本、双时代 MCP HTTP（modern `2026-07-28` 与 legacy `2025-11-25` 严格分离）、stdio relay、Electron 桌面窗口、Cloudflare 隧道、无人值守写入。
> **未实现**：PTY 与交互式输入、LSP/IDE 扩展、模型推理后端、任务邮箱、第三方 MCP 聚合（federation）、OS keyring、安装包与代码签名。
> 请先读「安全边界」和「当前验收结论」，不要把它当作生产就绪的远程执行服务。

---

## 为什么不是"给远端一个 shell"

把 shell 交给远端模型，等于把"它读到什么"和"它写什么"之间的所有检查都删掉。ArenaBridge 保留这些检查，靠的是四条硬约束：

- **执行归属按 run 固定。** 每个 run 的 `execution_owner` 只能是 `remote_workspace` / `client` / `bridge` 之一，绝不双执行。`ask` 与 `plan` 档强制只读。
- **补丁两阶段。** 远端提交的是 `preview`，拿到 `patch_id`；**必须由你本机独立批准**，才允许 `apply`。落盘时重新校验路径与 SHA256，一次性审批只消费一次。`code` 档**不是免批准**——它只决定 `workspace:patch` 这个 scope 要不要下发。
- **凭据分离且不可升级。** 配对码带硬上限，**签发后无法提高**；审批高于请求也会被拒。三个端口三种凭据互不通用。
- **审计以本机账本为准。** 结论只看 bridge 自己的 `event_log`，不采信远端自述。

## 获取与运行

### 方式一：自包含发布包（推荐，零依赖）

到 **[Releases](https://github.com/zty828/Arena-Agent/releases)** 下载 `arena-bridge-<version>-win-x64.zip`，解压到任意目录，**双击 `desktop.cmd`**。

> 当前发布的是 **pre-release**（`0.1.0-stage1`）：能跑、但**不是生产就绪**，请先读下面的「安全边界」与「当前验收结论」。

压缩包内含 Node 22 运行时、Electron、cloudflared 和全部 npm 依赖，因此：

- **不需要联网**，不需要 `npm install`，不需要机器上装过 Node；
- **移动到任何目录、拷到 U 盘、拿到另一台 Windows 机器上**都能直接跑；
- 不受本机已装 Node 版本影响（`runtime/node.exe` 固定为验证过的 22.22.2）。

### 方式二：克隆源码

```bash
git clone https://github.com/zty828/Arena-Agent.git
cd Arena-Agent
npm install
```

`node_modules/` 与 `runtime/` **不进 git**（那是几百 MB 的二进制，进仓库就没法 clone 了），所以源码检出需要自己装依赖。装完之后同样双击 `desktop.cmd`——它会自己按需编译。

要求：**Windows x64** + **Node 22**（`engines` 已声明）。发布包方式下这两条都不用关心。

> 早期版本有 `arena.cmd` / `start.cmd` / `test.cmd` / `cb.cmd` / `cb-intl.cmd` / `preview.cmd` 六个入口脚本，**已全部删除**。现在只有 `desktop.cmd` 一个入口：它同时覆盖"本机使用"和"接远端"两种模式，不再需要用户选对脚本。

## 桌面窗口

`desktop.cmd` 打开的是一个**原生 Electron 窗口**，不是浏览器标签页。窗口里自带 daemon：**关窗口 = 停 bridge**，没有后台残留进程，也没有端口或令牌需要你复制。

三栏布局：左栏工作区与目录树，中栏标签页（待办 / 活动 / 文件 / 授权 / 原始事件），右栏上下文检查器。

**首次使用**：点「选择工作目录」，选中要让远端 Agent 操作的**项目根目录**。选择写进 `outputs/desktop/workspace.json`，下次自动恢复，之后可在窗口内随时切换。

> 切换工作目录是**换一个 daemon**，不是改一条记录：工作区与 run 的绑定是不可变的（`runs` 表有触发器拒绝改 `workspace_id`）。窗口只在新 daemon 真正绑定成功后才写偏好文件，避免窗口显示一个其实没在服务的目录。

### 接远端：窗口内一键隧道

在窗口里选访问模式 → **显式确认暴露** → 窗口完成：预订 `mcp_remote` 端口 → 建 Cloudflare 隧道 → 以「仅监听回环 + `allowed_hosts=[隧道域名]`」重启 daemon → 生成一次性配对码 → 生成提示词并复制到剪贴板（**读回逐字比对**，不一致时给你手动复制框）。

**关窗口即断隧道**，隧道与 bridge 一起停。

## 访问档位

| 档位 | 远端能做什么 | 说明 |
|---|---|---|
| `ask` | 只读：列目录、读文件、搜索 | 强制只读 |
| `plan` | 只读 + 提交补丁**预览**（不落盘） | 强制只读 |
| `code` | 只读 + 两阶段补丁：预览 → 本机批准 → 落盘 | 仍然逐次批准 |
| `exec` | 上面全部 + `run_command` | **无逐条批准**，见下 |

档位必须同时到达**配对码 / 提示词 / 审批**三处；配对码上的 `max_access` 是硬上限，**签发后无法提高**，只能重签一枚码。

> **`exec` 档没有 OS 沙箱，等于把 shell 交给远端。** 它只做了这些边界：cwd 走同一套路径策略（只能在工作区内）、超时 30s（上限 300s）、stdout/stderr 各截 64 KiB、stdin 关闭（无 PTY）、超时/断连/撤权/取消/关停时杀掉整棵进程树、逐条审计；子进程环境会剔除所有 `ARENABRIDGE_*` 变量，避免一条 `echo` 就把工作区授权升级成本机 admin。**取舍理由见 `docs/architecture-and-security.md` 的 ADR-005。**

## 技能（Agent Skills）

按 **[agentskills.io](https://agentskills.io/specification)** 规范读取 `SKILL.md`——这是跨工具的事实标准（Claude Code / Codex / Cursor / Gemini CLI / Goose 等读同一份目录），所以这里实现的是一份规范，不是每个工具一个适配层。

技能放在**程序目录下的 `skills/`**，与工作区解耦：安装好的技能跟着程序走，正好和"整个文件夹拷走就能跑"一致。也可以在配置里加额外只读根（例如把别的工具已装的技能直接挂进来，不必拷贝）。

> `skills/` **不进版本库，也不进发布包**。技能是操作者的数据——它是"agent 会照着做的指令"，由运行这份程序的人自己选。把目录纳入跟踪会把维护者自己的技能随仓库公开，也会让 `git pull` 有机会悄悄改掉 agent 正在遵循的指令。

远端通过两个工具使用，按规范的三段式**渐进披露**：

| 工具 | 返回什么 | 对应阶段 |
|---|---|---|
| `list_skills` | **只有 `name` + `description`** 等元数据 | 第 1 段（~100 token/个），用来决定打开哪个 |
| `read_skill` | 正文 + 打包文件清单；带 `file` 参数则读单个资源 | 第 2、3 段 |

> `list_skills` **不返回正文**——这是规范的核心机制，不是省事。一个把正文一起吐出来的列表会静默毁掉渐进披露，而且调用方看不出来。所以正文不是那个类型能承载的字段。

三条边界，都是有意为之：

- **技能是只读的。** `scripts/` 只是一个文件目录。技能可以*描述*一条命令，但要跑还得用 `run_command` 并持有 `exec` 档——**技能不授予任何执行权**，`capabilities` 里显式写着 `skills_can_execute: false`。
- **`allowed-tools` 只作信息展示，绝不作为授权。** 规范自己把这个字段标为 experimental，它表示"预先批准的工具"。照着做等于让一个第三方技能目录替你预先批准执行——那正是 `T27` 禁止的绕过。鉴权模块**根本不认识这个字段**（有结构断言 + 变异测试守着）。
- **不跟随链接。** 技能目录是不可信输入，指向目录外的链接会被跳过而不是解析；文件读取同时有解析后包含性检查和清单检查两道。

规范之外的字段（真实技能会用 `agent_created`、`version`）**保留而不是拒绝**——拒绝它们等于拒绝别的工具装好的、能用的技能，与"适配生态"正好相反。

**安装走窗口里的「技能」标签页**：选一个包含 `SKILL.md` 的目录即可。安装前会按规范校验，不合格的直接拒绝**且什么都不写**；技能里若含符号链接也会拒绝而不是悄悄丢掉（丢掉了就不是同一个技能了）；重名不覆盖；拷贝先落到同目录的临时名再改名，所以扫描永远看不到半个技能。

> 从别的工具搬技能：把它的 skills 目录（如 `~/.workbuddy-ai/skills/xxx`）用窗口选进来即可，也可以直接把它加进配置的 `skills.roots` 只读挂载，不必拷贝。
>
> 暂不支持从 URL/zip 安装（要处理下载信任与 zip-slip），也没做技能版本与依赖解析。

## 安全边界（必读）

- **三个端口，仅回环**：API `127.0.0.1:48270`、MCP `127.0.0.1:48271/mcp`、管理 `127.0.0.1:48272`。三种凭据互不通用——模型 API Key 访问 MCP 端口会 401，管理密钥访问模型端口也会 401。**本机不开放任何端口**，只有隧道地址对外，管理端口始终只在回环。
- **隧道只指向 `mcp_remote` 端口，只接受配对 grant**，所以本机的 `mcp_token` 不可能从公网使用。
- **隐私代价**：隧道由 Cloudflare 终止 TLS，**Cloudflare 能看到 MCP 明文**。另外 Arena 官方声明 Agent Mode 的数据会进公开排行榜。**只拿合成项目测试**，不要用私有源码。
- **无人值守写入**是唯一会移除"执行受本机监督"这一核心性质的开关：默认关闭、显式开启（需 `confirm:true`）、可撤销、留痕（批准人记 `auto_unattended`，绝不冒充操作者），并且**关窗/断开时一定关掉它**。
- 本仓库不含任何预置密钥。`.arena-bridge/`（回环开发凭据 + 本地账本）与 `outputs/`（运行产物）都在 `.gitignore` 里。

## 当前验收结论

以 `outputs/verification.json` 为准（`scripts/verify.mjs` 每次运行都会重写它）；README 里任何与它不一致的段落都视为过期。

最近一次（**2026-09-19T10:42:09Z**，Node v22.22.2 / win32 x64）：

- 统一回归：**`status: passed`，111 项中 111 通过、0 失败、0 跳过**，**23/23 阶段 `exit 0`**。
- 阶段构成：编译 → **9 个专项探针**（导入路径、桌面隧道接线、配对批准、客户端信封、访问模式、无人值守写入、授权有效期、命令执行与编辑/搜索、**技能规范与只读边界**）→ 桌面窗口自检 → **10 个测试套件**（`arena-flow`、`cli`、`console`、`daemon-gateway`、`gateway-http`、`gateway`、`local-mcp`、`protocol`、`security`、`workspace`）→ 合成演示 → SBOM。
- 证据：`outputs/verification.json`、`outputs/tests.log`、`outputs/demo-evidence.json`。
- 技能探针另配**变异测试**：把「名称必须等于目录名」「保留规范外字段」「不跟随链接」「文件读取的包含性检查」「`skills_can_execute`」「鉴权模块不认识 `allowed-tools`」这六个决定逐个破坏，探针必须全部失败——否则断言是摆设。

判定只看**有没有跑到终值**（`# tests` / `# fail`）；没跑到终值时任何项数都不算数。退出码 `0` = PASS、`1` = 真实回归、`2` = 未出终值、`75` = 被环境掐断。

范围与未验收项（这些不是"通过"，是**没测**）：全部是**自有合成工程上的本地自动化**，不是 Arena、不是 WorkBuddy/TRAE 宿主循环、不是生产环境、不是真实人工审批端到端。仍未验收：真实 Arena 用途与数据授权、WorkBuddy/TRAE 真实工具循环、第三方 MCP 聚合、生产隧道、安装包。

## 构建、测试与打包

```bash
npm run build            # tsc + 把 preload 与渲染页复制进 dist
npm test                 # 单元/集成测试
npm run verify           # 完整回归：编译 → 探针 → 桌面自检 → 测试 → 演示 → SBOM
npm run package:release  # 生成自包含发布包到 outputs/release/
npm run local            # 只启动 bridge（仅回环），控制台开在浏览器里
npm run expose           # 只启动 bridge，MCP 端口绑到通配地址（调试入站连通性）
```

几个容易踩的点：

- **渲染器不在 tsc 产物里。** `apps/desktop/src/renderer/*`（html/css/js）由 `scripts/build-desktop.mjs` 复制进 `dist`。只改 `src` 而不重跑这一步，窗口加载的还是旧文件。`desktop.cmd` 会自己检测并按需重建。
- **构建不依赖你的 PATH。** 重建走 `process.execPath` + 绝对路径直接调 tsc 与 build-desktop，不经过 shell、不需要 `node_modules/.bin` 在 PATH 上（`scripts/probe-desktop-tunnel-wiring.mjs` 会剥掉 PATH 实测这一点）。
- **`.test-data/` 里的删除是宿主沙箱的现象，不是代码回归。** 如果出现 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`，说明环境的删除预算耗尽（按 agent 工具调用计数）。**不要关掉保护、不要清空 `.test-data`、不要改保护脚本**；换一个 `CODEBUDDY_CONVERSATION_REQUEST_ID` 重跑即可。
- 单跑某一套件：先 `npm run build`，再 `node --test dist/tests/<name>.test.js`。
- **两个本地状态文件是按需生成的，不在仓库里。** `outputs/run-local.config.json`（记录绝对路径）和 `.arena-bridge/local-credentials.json`（回环开发凭据，含密钥）都无法入库，所以克隆下来必然不存在。`npm install` 会生成配置；凭据在第一次需要时生成。**已有的文件绝不覆盖**——删掉它们等于轮换。默认挂载合成夹具 `outputs/synthetic-workspace`、网关为 `mock`、远程入口关闭；要换成自己的项目或真实模型，改配置文件即可。`npm run local` / `serve` / `smoke` / `workbuddy` 都会按需生成这两者；少数诊断脚本（`gateway:report`、`mcp:local-check`、`verify:*`、`arena:*`、隧道诊断）假定它们已存在，所以**先跑一次 `npm run local`** 再跑这些。

## 工程结构

```text
desktop.cmd              唯一入口：启动 Electron 窗口（内含 daemon）
apps/daemon/src/
  cli.ts                 初始化、启动、状态和本地控制 CLI
  server.ts              三端口、鉴权边界、应用 API
  state-lease.ts         状态目录独占与崩溃留锁
  stdio.ts               有界 stdio → 本机 MCP 转发
  tools.ts               工具 schema、统一结果与策略入口
  console.ts             浏览器控制台（单文件，无构建）
apps/desktop/src/
  main.ts                Electron 主进程：启动 daemon、隧道、IPC
  prompt.ts              生成给远端粘贴的提示词
  tunnel-mode.ts         隧道/暴露状态判定
  renderer/              窗口页面（html/css/js，不走 tsc）
packages/
  contracts/src/         错误、身份、固定归属、状态与事件
  storage/src/           SQLite、审计 allowlist、幂等账本
  policy-engine/src/     配对/挑战/TTL/审批/撤权
  mcp-transport/src/     modern/legacy 独立协议路径
  workspace-tools/src/   受限读查、精确补丁、命令执行、备份日志与恢复
  provider-gateway/src/  客户端工具模式的模型网关
client/                  Arena 沙箱里跑的 MCP 客户端（Python 3 标准库，零依赖）
scripts/                 构建、探针、验收、打包、诊断
tests/                   文件、协议、安全、CLI、网关、合成演示
runtime/                 内置 node.exe 与 cloudflared.exe（不进 git）
outputs/                 运行产物与证据；只跟踪 synthetic-workspace 夹具
```

当前是目录分层的 TypeScript 单编译单元，**不是已拆好的独立 package/build graph**。

## 文档

- `docs/how-to-run.md`：本地运行、控制台、WorkBuddy/TRAE 模型接入、MCP 配对审批、测试命令。
- `docs/scripts-index.md`：**`scripts/` 里每个脚本干什么**，按用途分组，含 `npm run` 没有的直连命令。
- `docs/architecture-and-security.md`：ADR、数据流、权限/威胁模型、事故恢复。
- `docs/arena-agent-connection.md`：接 Arena 的完整步骤、隧道方案、为什么不能直连、隐私代价。
- `docs/lmarena-access-review.md`：Arena 官方文档核查与结论修正。
- `docs/facts-and-assumptions.md`：事实、来源、假设、授权门槛。
- `docs/gateway.md`：模型网关的配置、能力边界、运行与测试。
- `docs/client-integrations.md`：WorkBuddy/TRAE 主模型与 MCP 两条路径的区别。
- `docs/requirements-traceability.md`：全部 B/N/O/X 与 T01–T38 的状态、证据与限制。
- `docs/self-hosted-harness-plan.md`：桌面 Harness 前端的方案与边界。

## 许可证

[MIT](LICENSE)。

发布包会额外带上 `THIRD_PARTY_NOTICES.md`，列出随包分发的第三方组件及其许可证——它由 `scripts/package-release.mjs` 在打包时**从实际安装的依赖生成**，不手写，以免依赖一升级就变成错的。Electron 自带的 `LICENSE` 与 `LICENSES.chromium.html`（覆盖 Chromium 及链接进运行时的第三方代码）在 `node_modules/electron/dist/` 内随包分发。
