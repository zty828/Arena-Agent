# WorkBuddy / TRAE 接入：两条互不相干的路径

版本：ArenaBridge `0.1.0-stage1`，文档复核日期 2026-09-17。

## 0. 先分清两条路径（最容易搞混的地方）

| | 路径 A：MCP 工具 | 路径 B：模型网关 |
|---|---|---|
| 谁在推理 | **宿主自己的模型** | 桥接背后的 provider |
| 桥接提供什么 | 工作区工具（读/写/审批） | `/v1/chat/completions` |
| 宿主里配什么 | MCP 服务器地址 + 短时 grant | 自定义模型：base URL + api_token |
| 需要选内置模型吗 | **必须选，而且选什么很重要** | 模型名必须等于桥接 `/v1/models` 返回的别名 |
| 当前可用性 | 本机与远端均已实测跑通 | 仅有 Mock；配真实 provider 才可用 |

**接 MCP 时不要动模型设置。** 桥接只是工具提供方，永远看不到你选了哪个模型；模型决定的是"它会不会正确调用工具"。

## 1. 路径 B（模型网关）当前实际状态

实测（`node scripts/gateway-report.mjs`）：

```
/v1/models          200
data[0].id          mock-agent-local      owned_by: arenabridge-mock
/v1/chat/completions 200 → "[MOCK; no model inference] hi"
gateway.enabled     true
chat_completions    implemented_bounded_client_tools_alpha
```

**当前配置的是 Mock 后端**（`outputs/run-local.config.json` 里 `gateway.type = "mock"`），它不做任何推理，只是确定性 fixture。**不要把 ArenaBridge 配成主模型并期待它推理。**

要用真实模型，把配置改成 `approved_openai_api`：

```jsonc
"gateway": {
  "type": "approved_openai_api",
  "endpoint": "https://<你有权使用的 OpenAI 兼容服务>/v1",
  "api_key_env": "<存放密钥的环境变量名>",
  "alias": "<真实模型名>",
  "authorization_reference": "<你的授权依据>",
  "data_egress_approved": true
}
```

指向 `arena.ai` / `lmarena.ai` 会被直接拒绝——那是另一条路径（见 `docs/arena-agent-connection.md`），不是模型网关。

### WorkBuddy 配置（路径 B）

[官方配置文档](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model)：设置 → 模型 → 自定义/Custom。

- 模型名必须是 `/v1/models` 里实际返回的健康别名。
- API Key 用本机签发的 **API client** 凭据（`api_token`），不是 admin token、不是 MCP grant。
- 基础地址 `http://127.0.0.1:48270/v1`；开启"自定义协议"时用完整 `http://127.0.0.1:48270/v1/chat/completions`。
- 实测支持范围：`tools` / `tool_choice` / `parallel_tool_calls` / `response_format` 均为 **emulated**（桥接侧模拟，不是原生透传）；`strict`、`json_schema`、`n>1`、`logprobs`、`seed`、附件返回 422，不静默丢弃。

### TRAE 配置（路径 B）

[官方配置文档](https://docs.trae.cn/ide_models)：设置 → 模型 → 添加模型 → 自定义模型。

- API 格式选 OpenAI Chat Completions。Anthropic Messages adapter **未实现**，不要选。
- 模型 ID 用真实可用值；Mock 别名不能标成特定厂商/版本。

## 2. 路径 A（MCP 工具）——已实测

本机 CLI：`dist/apps/daemon/src/cli.js mcp stdio --endpoint http://127.0.0.1:48271/mcp`，需要进程环境中的**短期已配对** `ARENABRIDGE_MCP_TOKEN`。

**远端 Agent 已实测跑通**（Arena Agent 经 Cloudflare 隧道，见 `docs/arena-agent-connection.md`）：配对 → 批准 → claim → challenge → tools → 读真实工作区文件，bridge 审计日志逐条可查。

工具面（实测 9 个）：

| 工具 | 权限 |
|---|---|
| `bridge_health`, `list_directory`, `find_files`, `search_files`, `read_files` | 只读 |
| `set_todos`, `report_progress` | 进度写入（grant 的 `progress:write` scope） |
| `lsp`, `get_diagnostics` | **`capability_unavailable`**——列出但不实现，调用会失败 |

工作区文件写入需要 `code` 权限的 grant，且逐次经本机审批。

### 宿主要做的事

新增 MCP 服务器后仍需在宿主 UI 里**信任/启用**。宿主若不能安全传递短期凭据，先停止接入，不要把管理密钥塞进配置或聊天。

## 3. 仍未验收的部分

| 客户端 | 状态 |
|---|---|
| WorkBuddy 桌面真实工具调用循环 | **NOT_TESTED**——未在真实宿主跑过 |
| TRAE/TraeCode 桌面 | **NOT_TESTED** |
| 网页/云端宿主 | NOT_TESTED（网页端的 localhost 是云沙箱，不是本机） |
| Arena Agent | **已实测成功**（2026-09-17，合成项目，只读） |
| 自有 HTTP/stdio 测试客户端 | 通过 |

「Key 检查通过」「问候正常」「自有 SDK 测试通过」都**不算**宿主验收。真实验收必须包含：请求 tools → tool_calls → 宿主批准/执行 → `role=tool` 回传 → 模型继续 → 补丁/测试/汇报，并保存脱敏网络事件、真实 Diff 和退出码。

## 4. 任务工具路径尚未实现

规划中的 `submit_task/get_task/cancel_task/read_artifact` 是独立新增的 MCP 任务工具。控制面的 `/bridge/v1/runs` 仅是手工记录/查询/取消，不是 Orchestrator，也没有推理。

即便将来宿主成功调用任务工具，也不代表 WorkBuddy/TRAE 的主模型已经被 Arena 替换。

## 5. 排错

| 现象 | 检查 |
|---|---|
| HTTP 401 | 密钥是否属于此端口；不能混用 admin/API/grant |
| HTTP 403 | Host/Origin、grant TTL/epoch、challenge、Ask/Plan/Code、是否撤权/终止run |
| legacy 404 session | 用新grant/正确identity重新initialize；不能带旧session绕过撤权 |
| modern -32602/-32020/-32022 | 每请求meta、头体对应、版本；别见4xx就盲目降级 |
| `APPROVAL_REQUIRED` | 本地批准是否仍有效、params hash/审批类型/grant/run是否相同、是否已消费 |
| `VERSION_CONFLICT` | 文件被用户改动；重新读hash和预览，不覆盖 |
| `CAPABILITY_UNAVAILABLE` | 没有真实LSP/PTY/模型后端；不是“重试就行” |
| `/readyz` 503、模型列表空 | Stage1没有推理adapter，属预期诚实拒绝 |
| daemon.lock 存在 | 先查是否有进程使用；崩溃锁不自动清除，先备份再本地处理 |
| 测试 `SAFE_DELETE_BULK_CONFIRM_REQUIRED` | 宿主按 agent 工具调用计数的删除预算（阈值 50）被耗尽，属环境现象。不绕过、不清空 fixture；用 `node scripts/run-tests-clean.mjs --no-budget`（或 `npm run verify`，它按文件隔离预算）重跑。判定只看有没有跑到 `# tests`/`# fail` 终值，没跑到则任何项数都不算数 |

## 6. 后续真实验收登记

记录实际 OS/宿主构建、协议版本、认证方式、主模型/工具路径、tools schema、执行归属、审批人、文件前后hash/真实diff/测试退出码、断流/取消/重试边界。凭据和源码默认脱敏。Arena 专项必须额外记录用途许可、账号范围、非敏感合成项目、批准频率、数据协议；缺项即 BLOCKED。
