# ArenaBridge：事实、假设与授权门槛

核验日期：2026-09-15。交付基线：`0.1.0-stage1`。本文件不是平台许可或法律意见。

## 1. 已检查的环境与实现边界

- 工作区最初为空，未发现已有 Git 仓库；没有覆盖用户既有工程、修改 WorkBuddy/TRAE 设置或安装第三方桌面应用。
- 实际执行环境：Windows x64、托管 Node.js **22.22.2**；`node:sqlite` 可用，SQLite **3.51.2**。Node 对该模块仍发出 experimental warning，属于生产评估项。
- 已编译 TypeScript，并使用真实 HTTP、stdio、文件系统、SQLite 与子进程做本地合成测试。测试结果以 `outputs/verification.json` 为准，不以本文预测数值。
- 本轮不提供真实 Arena 模型、不接触登录 cookie、不抓取网页私有 API，不启动任何公网 tunnel。没有任何获准生产模型密钥、签名材料或目标客户端构建号。
- 本地服务只监听 `127.0.0.1`：模型占位入口 48270、MCP 48271、管理控制 48272。端口 0 仅在测试中分配实际可用端口；普通端口冲突明确失败，不静默暴露其他地址。

## 2. 两条方向、四种模式

**反向 MCP 工作区桥接**：远端 Agent 是工作流主循环；ArenaBridge 是工具服务端，在本机执行经授权的文件动作。模型不自行拥有本机网络或文件权限。

**正向模型 API 网关**：客户端发送模型协议请求，ArenaBridge 调用获准推理后端并返回文本/工具提议。它不等于把 Arena 隐藏网页接口转为 API。

| 模式 | 固定 execution_owner | 主循环/动作归属 | 本轮状态 |
|---|---|---|---|
| remote_workspace | remote_workspace | 网页/远端宿主决定下一步，本地 ToolHost 执行已审批工作区工具 | 已实测 loopback 自有客户端；公网与真实网页未测 |
| provider_gateway_client_tools | client | WorkBuddy/TRAE 审批、执行工具；网关不得执行 | 未实现；Chat Completions 明确拒绝，无模型列表 |
| provider_gateway_bridge_tools | bridge | 本地 Orchestrator 审批并执行，再继续推理 | 未实现 |
| mcp_task_service | bridge | 宿主调用任务工具，不替换主模型 | 未实现；管理端手工 run 记录不是任务 Orchestrator |

run 的工作区、principal、mode、execution_owner 使用 SQLite trigger 固定。worker 类型身份即使被测试夹具赋予伪造的文件 scope，也不能通过 ToolHost 执行文件动作。

## 3. 来源复核与限制

| 来源 | 2026-09-15 复核结果 | 不能推出的结论 |
|---|---|---|
| [S01 仓库](https://github.com/ZS520L/shuncode)、S02 tree/release | 当前环境 `gh api` 因没有 GitHub 身份退出 4，记 **not_reverified**；保留用户给定“主分支仅 README、无公开实现许可、v0.7.2 发布于 2026-09-05”作为提供的基准 | 不能称已核验源码、许可、tag 或 release hash；未下载商业实现 |
| [S03 Bridge 原理](https://docs.shuncode.top/docs/bridge/overview) | 官方正文确认本地工作区 MCP 经公网交给远端 Agent；todo/progress | 不等于 Bridge 内置模型推理服务 |
| [S04 网站接入](https://docs.shuncode.top/docs/bridge/clients) | 官方正文列出 Streamable HTTP、网站连接和 Arena Agent 使用方式 | 作者“已测试”不等于平台能力保证、用途许可或本项目实测 |
| [S05 启动](https://docs.shuncode.top/docs/bridge/start/) | Quick、Named、ngrok 三种通道；原产品使用前有其自身授权 | 本项目不复制原产品设备/计费授权，不绕过授权 |
| [S06 Chat MCP](https://docs.shuncode.top/docs/advanced/mcp) | Chat 是外部 MCP 客户端；Bridge 是对外服务端；Bridge 不能调用 Chat 配置的 MCP | 第三方 MCP 聚合是本项目新增，不是原功能 |
| [S07 Skills](https://docs.shuncode.top/docs/advanced/skills) | Bridge 可把 Skills 当文件目录读取，可位于工作区外 | 不意味着本项目要实现任意本机路径读取；本轮外挂载未实现 |
| [补充：安装页面](https://docs.shuncode.top/docs/install/) | 文档声明当前版本 0.7.2 | 当前页面不能证明各功能首次出现的历史版本 |
| [S11 Arena Terms](https://help.arena.ai/articles/5629909088-terms-of-use) | 正文 Last Updated 2026-02-23；包含自动化/程序化访问、自动查询与抓取限制 | personal/internal business use 不是 API 化或后台 worker 的许可，也不应泛化为一切商业用途禁止 |
| [S12 Privacy](https://help.arena.ai/articles/3765052346-privacy-policy) | 正文更新 2025-12-16；输入输出/交互数据可向第三方共享并可能公开 | 文件保留本机不代表读取片段、Diff、终端输出或秘密不会外传 |
| [S14 Quick Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/) | 官方限制：开发测试用途、无 SLA、无 SSE、最多 200 个在途请求，触限 429 | 不是 200 QPS；JSON MCP 子集不等于完整 Streamable HTTP 支持 |
| [S15 WorkBuddy 模型](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model) | 设置→模型→自定义/Custom，填写 URL/API Key/模型名；自定义协议开关仅跳过路径校验/补全 | 不等于任意协议转换；文档默认上下文不作为本项目模型容量 |
| [S17 TRAE 模型](https://docs.trae.cn/ide_models) | 设置→模型→添加模型→自定义；OpenAI Chat Completions/Anthropic Messages；支持完整 URL 开关 | 本轮未在真实 TRAE UI 测试，不能标 PASS |
| [S19 发布](https://blog.modelcontextprotocol.io/posts/2026-07-28/)、[S20 versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)、[S21 discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover)、[S22 transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http) | 官方正文确认 modern 无 initialize/initialized 和协议 session，每请求元数据、镜像头、resultType/discovery/cache hints | 不能把 legacy GET/SSE、Session DELETE、Last-Event-ID 描述为 modern 核心 |
| [SDK v2 迁移](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28.html) | 明确 opt-in serving entry；HTTP 用 createMcpHandler，legacy 有状态服务独立组合；v2 不自动让所有调用变 modern | 不能只改 protocolVersion 字符串，也不能假设新包导出旧 API |

S08–S10、S13、S16、S18、S23–S26 的用户基准在本轮没有逐页重新完成核验。实现相关上游模块前应再查当前规范，不能将这些条目伪记为已复核。S01/S02 的认证阻塞不妨碍独立本地软件研发。

## 4. 依赖决定

精确版本：`@modelcontextprotocol/client/core/server 2.0.0`、`zod 4.6.5`、`diff 9.0.0`、`picomatch 4.0.7`；开发依赖 `typescript 5.9.3`、`@types/node 22.19.15`、`@types/picomatch 4.0.3`。完整传递依赖与 npm SHA-512 在 `package-lock.json`。

通过官方 registry 核验版本/许可证/分发完整性字段；通过实际 `.d.mts` 与编译器核验 SDK imports/签名。未能独立比对 GitHub source commit 与发布 tarball 的可重复构建链。安装禁用 lifecycle scripts，依赖位于托管 runtime 隔离目录，工程只做 junction 引用；可重现方式见 README。

## 5. 假设、待授权与未测

- **可信本机假设**：无恶意同用户进程持续竞态替换目录。路径复核不是内核级 handle-relative 沙箱，不能以当前实现批准企业生产外放。
- **本轮审批是本地 API 审批**：有独立管理员身份、一次性动作摘要和 TTL；尚无桌面人机交互、OS keyring 或组织审批证明。自动化演示的管理员是合成测试角色，不伪称真实人工审批。
- **平台用途授权**：Arena API 化、常驻 worker、邮箱、有限回合自动访问均需适用许可；目前缺失，统一 BLOCKED，不改走隐藏接口。
- **数据协议**：企业源码、个人/客户数据、凭证进入平台前需组织批准、平台协议和处理安排；未取得时不允许该数据流。
- **上游能力**：Arena 新建/可靠重置会话、外网/MCP 访问、结构化约束、持续活动回合、实际账号频率均未知；不承诺任何匿名模型身份、额度或常驻可靠性。
- **目标版本**：WorkBuddy/TRAE 的本次 GUI 构建号、macOS/Linux 系统、Windows10/11 分别验收、安装升级/卸载、代码签名均 NOT_TESTED/未提供。

## 6. 最小垂直闭环及验收

1. 自有 MockAgent 请求短时配对；独立本地管理员确认接收方、Code 权限与出站风险。
2. 获得单次 claim 的 grant 与 challenge；真实 MCP discovery、challenge 回传、列目录、读 UTF-8 文件及版本 hash。
3. 提交精确 unified diff 预览；验证项目仍未修改；本地按摘要审批；重新核验路径与所有文件 hash 后提交。
4. 测试 runner 对合成 arithmetic 项目先执行失败测试（退出码 1），补丁后再次执行（退出码 0）；写入 todo/progress 事件。
5. 撤销全部 grants，旧凭证再次调用必须 403；保存脱敏事件、真实 before/after、Diff、退出码。

证据：`outputs/demo-evidence.json`、`outputs/demo.patch`。命令由 QA 自有子进程执行，**不是尚未实现的 Bridge PTY**；审批由隔离测试身份模拟，**不是桌面人工验收**。这只证明本地协议和安全逻辑，不满足最终 T31/T32/T33/T34 全链路完成定义。
