# Arena → WorkBuddy 调度：可行性、架构与风险

日期：2026-09-17。回答的问题：**能不能让 Arena 的模型驱动 WorkBuddy 干活，而不是只用那 9 个基础文件工具？**

结论：**能。** 而且比之前做的方向更贴近你的真实目标。但有三个必须你拍板的前提。

---

## 1. 关键发现：WorkBuddy 自带完整无头 CLI

之前我以为 WorkBuddy 只能通过 MCP 提供工具，方向搞反了。实际查证——**两个版本都带 CLI**：

| | 中国版（优先） | 国际版 |
|---|---|---|
| 安装目录 | `E:\Programs\WorkBuddy` | `E:\Programs\workbuddyin\WorkBuddyAI` |
| CLI 入口 | `resources\app.asar.unpacked\cli\bin\codebuddy` | 同结构 |
| 实测版本 | **2.137.1** | 2.137.1 |
| 凭据文件 | `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info` | `...\workbuddy-desktop-ai.info` |
| 额外部署配置 | `product.cloudhosted/internal/ioa/selfhosted.json` | `product.json` |

```
<安装目录>\resources\app.asar.unpacked\cli\
  package.json  →  "@genie/agent-cli"
  bin/codebuddy →  带 shebang 的 Node 脚本，不在 PATH 里
  bin/cbc-prewarm
  bin/windows-child-process-containment.cjs   （仅中国版）
```

**它是完整的 Agent CLI，不是只读工具集。** 两个版本参数完全一致，实测可用：

| 参数 | 作用 |
|---|---|
| `-p, --print` | 非交互，输出后退出 |
| `--output-format text\|json\|stream-json` | 结构化输出，可实时流式 |
| `--input-format stream-json` | 流式输入 |
| `--acp` | **Agent Client Protocol**，stdio 或 streamable-http |
| `--acp-transport streamable-http` | ACP over HTTP |
| `--serve` | HTTP 服务（REST API + Web UI + ACP over SSE） |
| `--permission-mode acceptEdits\|bypassPermissions\|default\|plan\|dontAsk\|auto` | 权限模式 |
| `--tools ""` / `--allowedTools` / `--disallowedTools` | 工具白名单/黑名单 |
| `--session-id` / `-r` / `-c` | 会话复用 |
| `--mcp-config` / `--strict-mcp-config` | MCP 配置控制 |
| `--model fast-model\|balanced-model\|primary-model\|deep-model` | 模型选择 |

依赖里含 `@agentclientprotocol/sdk` 与 `@anthropic-ai/sandbox-runtime`——**ACP 是一等公民**，这正是"程序化驱动一个 Agent"的标准接口。

### 怎么调用

CLI 不在 PATH 里，用它的绝对路径直接调用即可（把 `<CLI>` 换成你机器上的实际路径）。中国版与国际版装在**不同目录**，凭据文件也不通用：

```cmd
<CLI> --version
<CLI> -p --tools "" "回复：收到"
```

> 早期有 `cb.cmd` / `cb-intl.cmd` 两个纯 ASCII 包装器替你解析这个路径，**已删除**：它们硬编码了某一台机器的安装目录，对别人没有意义，留着只会让人以为项目依赖那两个路径。

### 实测限制

CLI 能启动，但报：

```
Authentication required. Please use /login command to sign in to your account
```

我的执行沙箱挡住了它的凭据路径，所以**没能跑通一次真实推理**。这一步需要你在自己终端确认：CLI 是否需要单独 `/login`，还是能复用桌面端的登录态。中国版和国际版的凭据文件不同，**登录态不通用**，需要分别确认。

## 2. DSH（DeepSeek Harness）——更开放的替代

你说的 DSH 我查了：DeepSeek 官方开源的 Agent Harness，**模型、工具、Skills、会话、沙箱、存储、Agent Loop、界面全部以插件提供**，社区插件 3,300+，`npx @deepseek-ai/dsh web` 启动。

对比：

| | WorkBuddy CLI | DSH |
|---|---|---|
| 无头/程序化 | `-p`、`--acp`、`--serve` | `dsh web` + 插件体系 |
| 扩展方式 | MCP 服务器 + 权限参数 | **写插件**（更彻底，连 Agent Loop 都能换） |
| 是否需登录 | 需要（账号） | 自带 Provider 或自定义 Base URL |
| 成熟度 | 5.5.2，商业产品 | 0.1.5-rc，早期但开放 |
| 你的工作区 | 已经是它的工作区 | 需要单独配 |

**如果你想"写一个插件"而不是"包一层 CLI"，DSH 是对的选择。** 两者都支持 ACP，所以桥接层可以复用。

## 3. 目标架构

现在的实现（方向不对）：

```
Arena Agent → 隧道 → ArenaBridge → 9 个基础文件工具（读/列/搜/进度）
```

你要的：

```
Arena Agent
  │  MCP 工具调用：dispatch_task(task, constraints)
  ▼
ArenaBridge（本机，回环）
  │  ACP 客户端（新增组件）
  ▼
WorkBuddy CLI --acp   或   DSH
  │  完整工具链：文件编辑、搜索、子代理、MCP 连接器、Skills
  ▼
真实工作成果 → 沿原路回传
```

**关键点：Arena 不再自己读文件，它只提交任务。** 真正的执行者是 WorkBuddy/DSH，Arena 退化为"对话前端 + 任务发起方"。

### 两条实现路径

**路径 A：一次性调度（简单）**

```bash
codebuddy -p --output-format stream-json \
  --tools "Read,Edit,Glob,Grep" \
  --permission-mode default \
  --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
  "<来自 Arena 的任务描述>"
```

每次任务起一个进程，流式把结果回传。适合"一问一答"。

**路径 B：持久 ACP 会话（正确）**

桥接层作为 ACP **client**，与 `codebuddy --acp` 建立长连接，支持多轮、流式、中途取消、权限请求回调。

**这条路才对得上"同步对话"的诉求**——Arena 的每一轮可以映射到同一个 WorkBuddy 会话。

## 4. 必须你拍板的三个前提

### 前提一：递归调用（必须先解决）

**WorkBuddy 的 MCP 配置里已经注册了 `arenabridge`。** 如果 WorkBuddy 被桥接调度，而它又回头调用桥接——就成环了：

```
Arena → bridge → WorkBuddy → bridge → （WorkBuddy 又可以被调度）→ ...
```

**必须先做**：调度出来的 WorkBuddy 会话必须禁用 `arenabridge`（`--strict-mcp-config` 配空 MCP，或 `--tools` 排除）。这个不加，上线就是死循环。

### 前提二：信任升级

现在是 `ask` 只读，Arena 顶多读文件。**调度意味着远端可以让本机 Agent 执行任意操作**——改文件、跑命令、装依赖。

必须有的门禁（缺一不可）：
- 每个任务**逐次本机审批**，不能一次授权长期有效
- 调度会话用**受限工具白名单**（默认只给读，写要单独批）
- `--permission-mode` 不能用 `bypassPermissions`
- 工作区限定在合成项目，不能指真实代码库
- 任务描述里禁止出现凭据、密钥

### 前提三：执行归属要重定义

当前规范是"绝不双执行"，`execution_owner` 只有 `remote_workspace` / `client` / `bridge`。

调度模式下 **WorkBuddy 是真正的执行者**，需要新增归属值，并明确：
- Arena **不得**同时自己执行同一任务
- WorkBuddy 的每一次工具调用也要进桥接审计
- 一个任务对应一个 run，取消要能穿透到子进程

## 5. 其它代价

| 项 | 说明 |
|---|---|
| **数据出站** | Arena 官方声明 Agent Mode 数据进**公开**排行榜。任务描述、WorkBuddy 的回复、读到的文件内容都会成为评测 trace。 |
| **配额** | 每次调度消耗 WorkBuddy 模型额度。ACP 长会话比一次性调度更省。 |
| **延迟** | Arena → Cloudflare → 本机 → WorkBuddy → 模型，链路长。 |
| **平台合规** | Arena 条款限制程序化/自动化访问。由网页端 Agent 主动调用 MCP 与脚本抓取性质不同，但"远端持续驱动本机 Agent"更接近自动化，风险比现在高。这一条我不替你判断。 |

## 6. 我的建议顺序

1. **先确认中国版 CLI 登录**：在自己终端跑

   ```cmd
   <CLI> --version
   <CLI> -p --tools "" "回复：收到"
   ```

   不通就先解决登录（不带参数进交互界面用 `/login`）。中国版登录态与国际版不通用，别假设能互相复用。

2. **再验证一次性调度**：用路径 A 跑通一次"Arena 提交任务 → WorkBuddy 执行 → 结果回传"，全程只给读权限、合成项目。

3. **然后才是 ACP 长会话**：只有"多轮同步对话"确实需要时才做。

4. **DSH 作为并行选项**：如果你更想要"写插件"而不是"包 CLI"，先花半小时把 DSH 跑起来，对比一下再决定。

**第 1 步之前我不会动手写调度代码**——因为如果 CLI 登录不通，架构再对也是空的；而如果通了，信任升级那三条门禁必须先落地。

### 中国版优先的理由与注意点

- 你的实际使用环境是中国版，调度层必须针对它验证，国际版只作对比。
- 中国版多了 `product.cloudhosted/internal/ioa/selfhosted.json` 四种部署配置——**不同部署可能连不同后端**，登录方式和可用模型会不一样。跑通后要记录你用的是哪一种。
- 中国版多了 `windows-child-process-containment.cjs`（Windows 子进程隔离），这对我们做调度是好事：它自带一层进程约束，可以用来加固。

---

## 附：需要你回答的问题

1. 中国版 CLI 登录能通吗？（`<CLI> -p --tools "" "回复：收到"`）
2. 要"一问一答"还是"多轮同步对话"？前者用路径 A，后者才需要 ACP。
3. 走 WorkBuddy 中国版还是 DSH？或者两个都要（ACP 层可复用）？
4. 愿意接受"远端可触发本机 Agent 执行"这个信任级别吗？如果不愿意，我们只做只读调度（WorkBuddy 只读 + 只回报分析），风险低很多。
