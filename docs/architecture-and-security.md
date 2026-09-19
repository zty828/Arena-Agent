# ArenaBridge 阶段 0/1：ADR、威胁模型与权限边界

状态：开发构建，不是生产发布。协议与文件核心已经实现；最终整套验收未通过，详见 `outputs/verification.json` 和 `outputs/tests.log`。

## ADR-001：方向与执行归属

选择独立 TypeScript daemon，而非重做 Code-OSS 或嵌入网页自动化。`remote_workspace` 由上游 Agent 决定下一步，本地执行经策略确认的工具；API 客户端工具模式固定归客户端，内置工作流/任务服务固定归桥接端。模式 B/C/D 暂未实现，不能通过消息正文或填入 API Key 获得工作区执行权。

数据库 trigger 固定 run 的 `workspace_id / principal_id / mode / execution_owner`。远端工作区 principal、API client、admin、worker 是不同身份；身份由本地签发、存储与校验，不采用模型自报名称。

## ADR-002：三端口，暂不外放

```
获准远端/本地 MCP 客户端
  -> 配对申请 /pair/request
  -> 本地管理员独立确认接收方与风险
  -> 一次性 /pair/claim -> 会话级 grant + challenge（绑定 daemon epoch；可显式签成限时）
  -> 127.0.0.1:48271/mcp
  -> MCP era 适配 -> PolicyEngine -> ToolHost -> WorkspaceFiles / PatchEngine

本地管理员 -> 127.0.0.1:48272/admin/v1/* 或 /bridge/v1/*
模型客户端 -> 127.0.0.1:48270/v1/* （当前无模型，推理请求拒绝）
```

所有普通入口需要高熵 bearer；配对入口仅接受短时随机 code/claim secret，不以匿名身份获得文件访问。Host 精确匹配实际监听端口；当前 CLI-only 构建拒绝任何 Origin，不开放 CORS。没有网页控制台、公共代理或任意 URL fetch。

将来隧道只代理受限 MCP/worker 端口；Quick Tunnel 只允许经测的短 JSON 子集，不允许 SSE/长流。当前无 tunnel 进程、无公网域名、无 OAuth 服务，不应手工把开发构建直接外放。

## ADR-003：官方 SDK 双时代，不复用协议会话

选择 `@modelcontextprotocol/server/client/core 2.0.0`，以实际发布包类型签名为准。

- **modern 2026-07-28**：官方 `createMcpHandler` 严格入口；每请求元数据、镜像头、`server/discover`、`resultType`、默认 `ttlMs=0/cacheScope=private` 由已测 SDK 路径处理。不初始化、不生成 MCP session。JSON 与请求作用域 SSE 分别实测。未声明订阅/MRTR/sampling/resources/prompts。
- **legacy 2025-11-25**：独立 `WebStandardStreamableHTTPServerTransport` 会话；要求 initialize→initialized；每个 session 绑定 grant；过期/删除后旧 session 失效。只实现该版本，2025-06-18/03-26 未验收。
- era 分类使用官方 `isLegacyRequest`；现代错误不会自动转入旧会话。无副作用探测使用 discovery，真实 SDK auto-negotiation 夹具已经运行。
- stdio 入口是**受限 loopback 协议转发**，不是第二个执行宿主。只允许 `http://127.0.0.1:<port>/mcp`，需要已配对 grant；stdout 仅 JSON-RPC，错误走 stderr。它固定连接时代、支持 JSON/SSE 解帧，不声称通用外部 MCP federation。
- modern `response_mode=json` 不传递中途协议通知；应用 progress 仍保存到本地状态。此限制明确披露，不能把 `report_progress` 与 MCP `notifications/progress` 混同。

## ADR-004：预览、审批、字节版本与恢复

补丁工具只接受 create/update 的**精确 unified diff**，拒绝 fuzzy 位置匹配、删除、移动和目录删除。最多 10 个文件；先验证全部 hunk，再产生私有预览与备份，不更改项目。实际 Diff 由 before/after 字节文本生成而不是原样信任请求。

审批关联 `approval_id / approver / run / grant / action / params_hash / expiry / consumed`。执行时重新验证所有路径及 SHA256；同步消费一次性审批；同进程固定顺序路径锁 + 同 state-directory 的跨进程锁；写前日志、备份、同目录临时文件和 rename。当前普通 project 写入没有经过 OS 沙箱，只在明确本地可信开发模式中启用。

`apply_patch` 有三个动作：`preview` / `apply`（两阶段，默认路径）与 `write`（单发）。`write` 把"预检 → 审批 → 落盘"合并在一次调用里，**仅在无人值守写入窗口打开时被接受**；窗口关闭时直接 `403 POLICY_DENIED`，绝不降级成"无审批写入"。它没有绕过任何检查：审批仍由 `requestApproval` 产生并记录（批准人 `auto_unattended`、事件 `approval.auto_approved`），仍消费一次性审批，仍在提交时重验路径与 SHA256。存在的理由是：窗口打开时预览本来就会被立即自动批准，第二次往返只买来延迟，不买来任何人工判断。窗口在两次检查之间失效时，该动作返回普通 preview 结果（`waiting_for_approval`，未写盘），不等人也不丢弃补丁。

失败时只恢复仍与事务预期字节版本吻合的文件；人工编辑导致不确定时停止为 `unknown`，不覆盖其内容。进程退出场景有真实子进程故障夹具。**预检不等于多文件崩溃原子性；Windows 目录 fsync、断电/磁盘故障与恶意本机竞态仍是限制。**

当前 `recover` 是本地管理员确认的恢复接口，只处理 committing 日志，不能把 applied 状态任意回滚成旧版本；完整 UI 接受/拒绝/基于快照的用户回滚仍未实现。

## ADR-005：拒绝伪能力（2026-09-18 修订：命令执行已按操作者要求实现）

- `lsp/get_diagnostics` 明确返回 `CAPABILITY_UNAVAILABLE`，绝不把搜索结果冒充定义/引用/未保存诊断。
- **修订**：原条目为「没有 `run_command`」。操作者明确要求增加命令执行、且**不要逐条批准**，因此
  现已实现 `run_command`，作为第 4 档访问模式 `exec`。这是一次**有意的风险反转**，如实记录在此而不是
  悄悄删掉原条目：启用 `exec` 后，本项目不再阻止远端在本机执行任意代码，剩下的只有
  **操作者在签发配对码时选定的档位、审计日志、以及会话边界**（撤权/断开/重启会杀掉进程树）。
  仍然没有 PTY 与交互式输入（`send_command_input` 不存在，需要 stdin 的命令会立刻失败），
  仍然没有 OS 沙箱：`exec` 的边界是工作目录、超时、输出上限与可杀性，不是隔离。
- 没有 provider、mailbox、ToolCallEnvelope/federation 实现；`/v1/models` 为空，`/v1/chat/completions` 返回 503；Responses/Anthropic 返回 unsupported_protocol。
- HTTP 健康：控制面 alive ≠ 模型 ready ≠ 公网 reachable ≠ 实际网页 ready。
- 无长期共享密钥或秘密 URL 路径。OS keyring 未实现；只有用户明确选择时在本地终端展示临时凭据一次，不保存到 config。此方式不适合生产。

## 威胁与缓解

| 威胁 | 已有缓解 | 验收/残余 |
|---|---|---|
| 恶意网页/重绑定访问本地端口 | 精确 Host、拒绝 Origin、独立 bearer、体积/并发限制 | HTTP 夹具分组通过；当前全量回归被文件保护阻塞 |
| worker/client 冒充工具执行者 | principal kind + grant kind + run owner 校验、数据库 immutable trigger | 伪造 scopes 夹具不执行文件 |
| 配对重放、批准后换参 | code/claim 一次性、短 TTL、challenge、摘要绑定、审批消费 | 过期/重放/错 grant/换 hash 夹具 |
| grant 撤销后仍执行新动作 | 每个请求/工具入口再次认证；epoch 轮换、旧 session 清理 | 撤权不保证已提交写或正在运行进程被撤销；当前无 PTY |
| 凭证长期有效被窃 | 会话级 grant 绑定 daemon epoch（每次启动轮换），关窗/断开/换工作目录/撤销即失效；可显式签成限时（≤1h） | 没有 OS keyring；会话存续期内 token 一旦泄露即可用，直到会话结束或撤权。默认不是墙钟限时（操作者明确要求），需要更紧的窗口时用 `grant_ttl_ms` |
| 路径穿越、链接、Windows ADS | 规范相对路径、保留名/控制符/尾点空格、每层 lstat/realpath、root identity、hardlink 拒绝 | 不能消除本机恶意进程 TOCTOU；生产需更强 OS 层方案 |
| 敏感内容出站 | 隐藏/拒绝 `.env`、密钥、系统凭据、元数据、state 目录；配对接收方/数据类别告知 | 接收方平台留存/公开规则不由本项目控制；仍需数据审批 |
| prompt/tool JSON 注入 | 文件内容始终是数据，不解析为执行请求；模型不能批准自己 | 不构建网页 envelope parser，不运行 Skills 脚本 |
| 远端经 `run_command` 执行任意代码 | 默认档位不含 exec；命令 cwd 锁在工作区内、超时上限 5 分钟、输出截断、进程树可杀、子进程环境剔除 daemon 凭据、逐条审计 | **没有隔离**：exec 档下提示注入 = 在本机账户下执行代码。这是操作者明确接受的取舍（见 ADR-005 修订） |
| 同目录运行两个 daemon | 独占 `daemon.lock`；崩溃遗留锁不自动破除 | 用户需检查进程后处理 stale lock；无静默重跑 |
| 修改/恢复覆盖用户内容 | SHA256 重查、全量预检、WAL/backup、unknown 停止 | 外部真实副作用恰好一次不保证；当前不提供外部写工具 |
| 日志泄露 | 事件字段 allowlist、摘要/hash、不记录文件正文与 token | todo/progress/patch 备份为本地状态，未加密，应限权/保留期管理；诊断导出尚未实现 |
| 供应链执行脚本 | 固定包版本、完整性、安装禁用 scripts、SBOM/许可证清单 | 未完成源代码→包可重复性、生产 CVE 全审计 |

## 权限矩阵

| 能力 | admin 控制凭据 | API client key | workspace Ask/Plan | workspace Code | worker |
|---|---|---|---|---|---|
| 管理配对/批准/撤权 | 是，仅控制端口 | 否 | 否 | 否 | 否 |
| 模型 health/capabilities/models | 否（不同凭据） | 是；无推理模型 | 否 | 否 | 否 |
| discovery/tools list | 不直接使用管理密钥 | 否 | 配对后 | 配对后 | 不给工作区目录 |
| read/find/search | 否（不暴露直接执行接口） | 否 | challenge 后 | challenge 后 | 否 |
| patch preview | 否（只审阅） | 否 | 否 | 是 | 否 |
| patch apply | 只批准，不执行工具请求 | 否 | 否 | 需单次本地批准 | 否 |
| shell（`run_command`） | 否 | 否 | 否 | 否（需 exec 档） | 否 |
| LSP/federation/worker jobs | 未实现 | 未实现 | 未实现 | 未实现 | 未实现 |

## 状态、恢复与事故处理

应用 run、协议 request、MCP session、patch transaction 为独立概念。run 状态转换检查实现于 contracts；不会根据“工具调用没有抛错”自动把整个 run 标完成。`complete` 只能由本地管理员报告完成，其 reason 明示非独立验证。

- 撤权：控制端口 `POST /admin/v1/revoke-all`，body `{"confirm":true}`。
- 停任务：`POST /bridge/v1/runs/{id}/cancel`，阻止新动作；不能撤销已发生副作用。
- daemon 重启：授权 epoch 变更，未终态 run→unknown，pending 幂等账本→unknown，不重放副作用。
- 补丁事故：先保留 state/backup，检查 `journal.json` 与当前文件；经本地确认 `POST /admin/v1/recover`，仅恢复已知提交中的版本。
- 强制杀进程/系统崩溃：daemon.lock 故意留在原位；切勿自动删除。确认对应 PID 不活跃、备份状态目录后由本地操作员处理。
- 本机文件保护导致运行中断（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`）：保留 `.test-data`，不要清空或关闭保护强跑。`scripts/verify.mjs` 已改为**每个测试文件一个子进程**并各自持有独立删除预算，正常交互终端下等效，因此该错误不再中断回归。判定只看**有没有跑到终值**（`# tests` / `# fail`），没跑到则任何项数都不算数。

## 生产门槛

OS 凭证库/ACL与数据保留、真实桌面审批、控制与远程容器隔离、原生 PTY/Job Object、IDE 扩展、隧道端到端网络验证、完整幂等故障矩阵、Windows10/11安装升级/卸载、供应链审计、WorkBuddy/TRAE真实工具循环、Arena用途/数据授权均未完成。当前不创建“生产就绪”状态开关。
