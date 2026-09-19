# 模型网关（client-tools 模式）

状态：`0.1.0-stage1` 增量，**实验性 alpha**。它只实现四种运行模式中的 **B / provider_gateway_client_tools**，且工具执行者始终是客户端。

## 它做什么，不做什么

| 做 | 不做 |
|---|---|
| 接收 OpenAI 兼容 `POST /v1/chat/completions`（含 `stream=true`） | 不执行任何工具；没有文件、终端或 MCP 执行器依赖 |
| 校验消息角色、`tool_calls`/`tool_call_id` 配对、工具 schema 与参数 | 不逆向 Arena 私有接口，不抓网页 |
| 返回文本或**工具提议**（`finish_reason=tool_calls`），由 WorkBuddy/TRAE 自己审批并执行 | 不把已执行动作再作为待执行 `tool_calls` 发回 |
| 逐参数判定 native / emulated / unsupported，未知参数返回 422 | 不静默丢弃参数后声称兼容 |
| 四类 deadline、队列上限、断流取消、按身份与幂等键去重 | 不承诺 exactly-once 客户端副作用，不自动重试有副作用动作 |
| 明确标注 `native` 或 `buffered_emulated` 流式 | 不把缓冲分块冒充上游原生 token 流 |
| 缺 usage 时省略该字段 | 不以 0 冒充免费或无消耗 |

`/v1/responses` 与 `/v1/messages` 返回 `unsupported_protocol`。`/v1/models` 只列出通过健康检查的别名；未配置或未通过时为空数组，`/readyz` 返回 503。

## 后端配置

`config.json` 的 `gateway` 字段三选一：

```jsonc
// 1. 默认：不配置任何后端（安全默认）
{ "type": "disabled" }

// 2. 自有 Mock：确定性夹具，不是模型，仅用于本地协议验证
{ "type": "mock", "acknowledge_mock": true, "alias": "mock-agent-local",
  "scenario": "echo" }

// 3. 已获准的正式 API：需要用途授权与数据出站确认
{ "type": "approved_openai_api",
  "alias": "my-approved-model",
  "model": "供应商实际模型 ID",
  "base_url": "https://供应商地址/v1",
  "api_key_env": "MY_PROVIDER_API_KEY",
  "authorization_reference": "内部审批单号或授权依据",
  "data_egress_approved": true,
  "allow_loopback_http": false,
  "native_parameters": ["tools", "tool_choice", "parallel_tool_calls",
                        "temperature", "top_p", "max_tokens", "stop"] }
```

约束：

- `api_key_env` 是**环境变量名**，不是密钥本身。密钥只从进程环境读取，不写入 config、日志或仓库。
- `base_url` 必须是 HTTPS，或显式 `allow_loopback_http: true` 的 `127.0.0.1`。
- 指向 `arena.ai` / `lmarena.ai` 会被直接拒绝：**没有可核验的 Arena 生产推理授权**。
- `native_parameters` 只列供应商文档确实原生支持的参数；未列入的一律 422。
- `strict`（严格生成）当前拒绝：参数校验通过不等于模型生成受约束。

## 能力与限制（必须一起阅读）

- 工具流是 `buffered_validated`：参数在完整接收、JSON 解析、schema 校验之后才对外可见，不逐字转发上游 `tool_calls` 增量。
- Mock 后端文本是 `buffered_emulated`。
- `n>1`、`logprobs`、`seed`、附件、`json_schema` 版 `response_format` 均不支持。
- `response_format: {"type":"json_object"}` 仅在后端声明原生支持时可用，否则 422。
- 上下文窗口不猜测；未知时报告 `null`，不写 200K/1M。
- 幂等只保证"同一身份 + 同一 key + 同一 body"返回已登记结果；无 key 时相同正文视为两次独立请求。
- 网关不读取 `system`/`developer`/`tool` 之外的历史，也不复用隐藏会话：每次请求都提交客户端给出的完整 `messages`。

## 测试证据（当前版本）

| 套件 | 数量 | 结果 | 覆盖 |
|---|---|---|---|
| `tests/gateway.test.ts` | 21 | 通过 | 参数判定、角色/tool_call_id、schema 校验、多 tool index 聚合、约束违例、幂等、四类 deadline、队列上限、背压与取消、JSON 模式、无泄漏 |
| `tests/gateway-http.test.ts` | 6 | 通过 | 真实 loopback HTTP 非流式/流式 SSE、工具往返、401 边界、客户端中断、usage 不补零 |
| `tests/daemon-gateway.test.ts` | 2 | 通过 | 真实 daemon API 端口、能力页、禁用态 503、跨端口凭据隔离 |

**未验证**：真实模型质量、真实供应商限流、WorkBuddy/TRAE 宿主端到端、`bridge-tools` 模式、第三方 MCP。29 项通过不等于整套产品验收通过。

## 如何运行

```bash
# 1. 编译
"<node22>" node_modules/typescript/bin/tsc -p tsconfig.json

# 2. 准备配置（把 gateway 改成 mock 或 approved_openai_api）
"<node22>" dist/apps/daemon/src/cli.js init \
  --workspace "<你的项目目录>" \
  --config "<新配置路径>.json" \
  --state "<私有状态目录>"

# 3. 启动（--ephemeral-keys 会一次性打印本地凭据，不要录屏或转发）
ARENABRIDGE_ADMIN_TOKEN=<32+ 字符> ARENABRIDGE_API_TOKEN=<另一个 32+ 字符> \
  "<node22>" dist/apps/daemon/src/cli.js serve --config "<配置路径>.json"

# 4. 冒烟
curl -s http://127.0.0.1:48270/v1/models -H "Authorization: Bearer <API_TOKEN>"
curl -s http://127.0.0.1:48270/v1/chat/completions \
  -H "Authorization: Bearer <API_TOKEN>" -H "Content-Type: application/json" \
  -d '{"model":"mock-agent-local","messages":[{"role":"user","content":"你好"}]}'
```

管理面（配对、审批、撤权、能力页）用 `ARENABRIDGE_ADMIN_TOKEN` 访问 48272；MCP 面用短期配对 grant 访问 48271。三个端口凭据互不通用。

## 如何测试

```bash
# 只跑网关三套（不涉及文件删除，可在本机直接运行）
"<node22>" --test --test-concurrency=1 --test-timeout=20000 \
  dist/tests/gateway.test.js dist/tests/gateway-http.test.js dist/tests/daemon-gateway.test.js
```

完整回归 `scripts/verify.mjs` 包含工作区事务测试。它已改为**每个测试文件一个子进程、各自持有独立删除预算**，因此在批量删除保护（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`）存在的环境下也能跑完：最新一次为 **87/87 通过、0 失败、0 取消**（`outputs/verification.json`）。不要关闭该保护或清空 `.test-data`。

## 接入 WorkBuddy / TRAE（当前状态）

网关已可被配置，但**尚未在真实宿主验证**。配置要点：URL 用 `http://127.0.0.1:48270/v1`（若宿主自动补全路径）或完整 `http://127.0.0.1:48270/v1/chat/completions`；模型名用 `/v1/models` 实际返回的别名；API Key 用 **API client** 凭据，不是管理密钥或 Arena cookie。详见 `docs/client-integrations.md`。
