# 需求与验收追踪

版本 0.1.0-stage1；所有行必须结合 coverage/限制阅读。implemented 只说明列明子集已有代码，不等于整项满足。本表由 scripts/traceability.mjs 生成，全量回归结论读自 outputs/verification.json（最近一次：passed 111/111, 23 stages exit 0 (2026-09-19T10:42:09.934Z)），不写死在这个文件里。

## B/N/O/X

| ID | 来源/分类 | 状态/覆盖 | 模块 | 测试 | 证据与限制 |
|---|---|---|---|---|---|
| B01 | S03,S04 / 原理复现 | implemented / partial | apps/daemon; packages/mcp-transport | T01,T02,T03,T31 | 本地真实MCP discovery/read/patch；自有客户端分组通过；公网/真实网页Agent未测；不是完整原产品复刻 |
| B02 | S05 / 原理复现 | implemented / partial | scripts/tunnel-cloudflared.mjs; scripts/tunnel.mjs | T08 | Cloudflare Quick Tunnel 与 SSH 反向隧道均已实现；窗口内一键隧道实测跑通；Named tunnel 与 ngrok 未实现；生产级/长期隧道未验收 |
| B03 | S01,S05 / 原理复现 | implemented / partial | apps/daemon/server | T23 | 控制面健康与模型未就绪分开；公网与认证工具就绪未做完整三层UI |
| B04 | S03-S05 / 原理复现 | implemented / partial | policy-engine; cli | T24 | 短时配对、challenge、撤权、重启失效；引导提示词/复制按钮/自动恢复启动未实现 |
| B05 | S03,S04 / 原理复现 | implemented / partial | apps/desktop | T38 | Electron 桌面窗口：工作区/待办/补丁审批/隧道，窗口自检 53 项通过；无安装包与自动更新；不内置浏览器视图 |
| B06 | S03 / 原理复现 | implemented / partial | apps/daemon/tools; storage | T31 | 应用级todo/progress持久化；自定义Bridge指令编辑与UI未实现；非协议progress通知 |
| B07 | S01 / 原理复现 | implemented / partial | workspace-tools/files | T15,T18,T19 | 批量读取/目录/glob/literal搜索/字节hash/分页；正则拒绝；仅UTF-8；扫描有界；没有未保存缓冲区 |
| B08 | S01 / 原理复现 | implemented / partial | workspace-tools/patches | T16,T17,T18 | 多文件预检/锁/备份/日志/真实diff/恢复；仅create/update；无move/delete；不保证多文件断电原子性 |
| B09 | S01 / 原理复现 | not_tested / none | tools unavailable endpoints | T22 | 无适配器时明确capability_unavailable；无真实IDE/LSP，不用搜索冒充 |
| B10 | S01 / 原理复现 | implemented / partial | packages/workspace-tools/command.ts | T20,T21 | exec 档 run_command：工作区内 cwd、超时、输出上限、杀整棵进程树、逐条审计（probe:exec）；无 PTY 与交互式输入；命令无逐条批准、无 OS 沙箱 |
| B11 | S01 / 原理复现 | implemented / partial | ToolHost; PatchEngine | T12,T16 | 最多4个本地工具，固定顺序写锁；并发上限/压力测试不全；未声称8路/8账号 |
| B12 | S01,S07 / 原理复现 | implemented / partial | packages/skills; apps/daemon/tools; apps/desktop | T27 | 规范实现：发现/校验/渐进披露；工作区外只读挂载；窗口内安装/删除（先校验后写、链接拒绝、不覆盖、原子落位）；容忍规范外字段；无 URL/zip 安装；无版本与依赖解析；未做跨工具目录的自动发现（需配置） |
| B13 | S01 / 生产强化的等价用途 | implemented / partial | policy-engine | T13,T24 | Ask/Plan只读、Code补丁需本地一次性批准；仅本地控制API审批，真实UI和OS沙箱未完成 |
| B14 | S01 / 原理复现 | implemented / partial | storage; patches; state-lease | T17,T21,T37 | 冲突不覆盖/中间态恢复/unknown/取消新动作；无安全用户回滚与 PTY 恢复；窗口提供补丁审阅，不是完整 Diff UI |
| B15 | S03-S05 / 原理复现 | implemented / partial | scripts/tunnel-cloudflared.mjs | T31 | Quick Tunnel 提供非回环访问，含 Host 白名单与匿名拒绝；生产/长期隧道与跨设备会话未验收 |
| N01 | 用户新增 / 新增API网关 | implemented / partial | packages/provider-gateway | G01-G21,H01-H06,D01-D02 | 真实HTTP/SSE、工具提议校验、多轮role=tool、预算与取消、幂等、身份隔离共29项分组通过；仅client-tools；无真实模型密钥与宿主E2E；bridge-tools模型入口与Responses/Anthropic未实现；streaming可能标注为buffered_emulated |
| N02 | 用户新增 / 新增任务回传 | blocked / none | planned: agent-mailbox | T09-T14 | ；实现未开始；真实Arena用途授权与隔离机制缺失 |
| N03 | 用户新增 / 新增工具编码 | not_tested / none | planned: tool-codec | T26 | ；未实现；不从不可信文件JSON触发执行 |
| N04 | 用户新增 / 新增执行归属 | implemented / partial | contracts; storage; policy-engine | T13,T24 | run归属固定、worker/client身份拒绝执行；client/bridge真实模型工作流尚无实现 |
| N05 | 用户新增/S06反例 / 新增MCP聚合 | not_tested / none | planned: mcp-federation | T28,T34 | ；stdio relay仅到本机daemon，不是第三方聚合 |
| N06 | 用户新增 / 新增任务服务 | not_tested / none | planned: orchestrator | T35 | 仅手工run账本及本地管理查询；尚无MCP任务工具，不代表主模型替换 |
| N07 | 用户新增 / 生产增强 | implemented / partial | policy-engine; storage; state-lease | T23-T30 | 独立认证、短时grant、审批摘要、撤权、日志allowlist；OS keyring、ACL、OAuth、诊断导出、个人目录工作流未实现 |
| N08 | S15-S18/用户新增 / 新增客户端验证 | not_tested / none | docs/client-integrations | T32,T33,T35 | 已复核关键GUI文档，提供分路径说明；没有实际WorkBuddy/TRAE构建号或宿主工具循环 |
| N09 | S19-S22/用户新增 / 新增双时代兼容 | implemented / partial | mcp-transport; stdio relay | T01-T04 | 官方SDK/原始HTTP/stdio双时代分组通过；旧独立SSE/GET恢复、MRTR、订阅未实现 |
| N10 | 用户新增 / 新增合规后端 | not_tested / none | planned: provider-adapters | T05,T09 | 不伪造可用模型；没有真实推理adapter/密钥/健康检查 |
| O01 | 用户扩展 / 可选扩展 | not_tested / none | planned adapters | T07 | 未知协议返回unsupported_protocol；未实现，不做未许可页面自动化 |
| X01 | 用户明确排除 / 不实现 | out_of_scope / excluded | none | policy review | 无原产品商业代码或计费绕过；临时邮箱/多账号刷取/验证码绕过/虚假模型身份明确排除 |

## T01–T38

| ID | 内容 | 状态/覆盖 | 证据 | 限制 |
|---|---|---|---|---|
| T01 | modern discovery/meta/header/resultType | implemented / partial | tests/protocol.test.ts | JSON/SSE、缺meta、头体冲突、版本错误分组通过；名称编码极端边界仍不全 |
| T02 | legacy lifecycle/session/clients | implemented / partial | tests/protocol.test.ts; tests/cli.test.ts | 2025-11-25 initialize/initialized/session删除与隔离；其他旧版本和真实宿主未测 |
| T03 | dual-era safe negotiation | implemented / partial | tests/protocol.test.ts; tests/cli.test.ts | 官方SDK auto discovery，无工具副作用探针；完整网络错误降级矩阵未全测 |
| T04 | JSON/SSE/UTF8/OpenAI stream delta | implemented / partial | tests/protocol.test.ts; tests/gateway.test.ts; tests/gateway-http.test.ts | MCP JSON/SSE与OpenAI流式增量、多tool index、usage-only空choices、[DONE]通过；n>1未实现 |
| T05 | Chat Completions tool loop | implemented / partial | tests/gateway.test.ts; tests/gateway-http.test.ts | 真实HTTP多轮：提议→宿主执行→role=tool→继续；无真实模型或WorkBuddy/TRAE宿主E2E |
| T06 | model parameters/context/schema limits | implemented / partial | tests/gateway.test.ts | 逐参数native/unsupported判定、未知参数422、无静默丢历史；emulated与严格JSON Schema未宣称支持 |
| T07 | protocol separation | implemented / partial | tests/security.test.ts | Responses/Anthropic明确拒绝；不返回伪job成功；正向模型API未实现 |
| T08 | Quick Tunnel/production SSE | implemented / partial | scripts/tunnel-e2e.mjs; scripts/probe-exposed-listener.mjs | Quick Tunnel 实测可用：Host 白名单、未列域名拒绝、经公网完成配对到读文件的完整闭环 |
| T09 | context isolation/forks | implemented / partial | tests/gateway.test.ts | 每次请求提交完整messages，无隐藏会话复用；真实模型侧隔离与压缩/fork未测 |
| T10 | idempotency/leases/retries | implemented / partial | tests/security.test.ts | 本地手工run稳定键/冲突/无键独立；邮箱lease和宿主副作用账本未实现 |
| T11 | worker/network/captcha/manual resume | blocked / none |  | 无平台许可，worker未实现 |
| T12 | queue/deadlines/backpressure/disconnect | implemented / partial | tests/gateway.test.ts; tests/gateway-http.test.ts | 四类deadline、队列上限、背压放弃响应、断流取消均验证；真实上游限流行为未测 |
| T13 | execution ownership | implemented / partial | tests/security.test.ts | worker伪scope、Ask/Plan、immutable run拒绝；模型工作流未实现 |
| T14 | unknown side effects no retry | implemented / partial | tests/workspace.test.ts; tests/security.test.ts; tests/gateway.test.ts | 补丁人工干预unknown、重启账本unknown、上游失败不按同键重试；真实下游副作用未测 |
| T15 | file reads/search/paging/hash | implemented / partial | tests/workspace.test.ts | 实际合成文件测试通过分组；仅UTF-8和字面搜索 |
| T16 | batch patch preflight/conflicts | implemented / partial | tests/workspace.test.ts; tests/protocol.test.ts | 后半hunk失败不写、过期版本拒绝、并发锁 |
| T17 | crash/disk/permissions recovery | implemented / partial | tests/workspace.test.ts | 真实子进程退出/六个故障点/backup损坏/人工改动；磁盘满与权限注入未测 |
| T18 | CRLF/BOM/unicode/EOF | implemented / partial | tests/workspace.test.ts | 格式字节保留分组通过；最新真实Diff变更需完整再验 |
| T19 | traversal/links/ADS/race | implemented / partial | tests/workspace.test.ts | Windows junction/hardlink/ADS等拒绝；不保证对抗恶意本机竞态 |
| T20 | persistent PTY/input/output/cancel | not_tested / none |  | 无 PTY 与交互式输入；命令执行是另一件事，见 B10 与 exec 档 |
| T21 | wait vs cancel/process recovery | implemented / partial | tests/security.test.ts; tests/cli.test.ts | daemon状态恢复与强制终止留锁；没有PTY语义 |
| T22 | real LSP/unsaved diagnostics | not_tested / none | tests/security.test.ts | 只测试capability_unavailable；不存在真实语义能力 |
| T23 | auth/Origin/Host/CORS | implemented / partial | tests/security.test.ts | 角色密钥、非法Host/Origin、端口隔离分组通过 |
| T24 | grant/approval/replay/identity | implemented / partial | tests/security.test.ts; tests/protocol.test.ts | challenge、过期、重放、参数替换、消费、撤权分组通过 |
| T25 | prompt injection in untrusted data | implemented / partial | tests/security.test.ts | 文件中的指令JSON不触发动作；模型/下游返回链未实现 |
| T26 | forged tool envelope/schema replay | implemented / partial | tests/gateway.test.ts; tests/security.test.ts | 不完整/越权/未知/重放tool_call_id与schema不匹配全部拒绝且不执行；网页文本envelope未实现 |
| T27 | Skills/scripts cannot bypass approval | implemented / partial | scripts/probe-skills.mjs | skill 只读挂载、无专用执行入口；allowed-tools 只作信息展示，鉴权模块不认识该字段（有结构断言 + 变异测试覆盖） |
| T28 | federation/auth/names/stdio launch | not_tested / none |  | 外部MCP聚合未实现 |
| T29 | no secrets in diagnostics/logs | implemented / partial | tests/security.test.ts; tests/demo.ts | 事件及演示输出检查凭据不出现；完整诊断包未实现 |
| T30 | personal files safety lifecycle | not_tested / partial | tests/workspace.test.ts | 拒绝Home/标准个人目录为root；不提供删除移动，完整回收站流程未实现 |
| T31 | remote workspace end-to-end | blocked / partial | outputs/demo-evidence.json | loopback MockAgent真文件修复；无公网/真实网页/PTY/人工UI |
| T32 | WorkBuddy host tool loop | blocked / partial | tests/daemon-gateway.test.ts | 网关侧协议闭环与真实HTTP通过；无目标构建号、真实密钥与宿主执行证据 |
| T33 | TRAE host tool loop | blocked / partial | tests/daemon-gateway.test.ts | 同一网关可被TRAE配置；未在真实TRAE UI或构建上运行 |
| T34 | bridge workflow with third-party MCP | not_tested / none |  | Orchestrator与第三方MCP未实现 |
| T35 | MCP task-service flow | not_tested / none |  | 手工管理run不是MCP任务服务 |
| T36 | concurrent project binding | implemented / partial | tests/security.test.ts | 同名文件run绑定基础测试；没有桌面切窗或完整并发场景 |
| T37 | denial/manual edits/recovery report | implemented / partial | tests/workspace.test.ts; tests/security.test.ts | 拒绝审批/手改/恢复unknown夹具；完整UI断线报告未测 |
| T38 | install/upgrade/uninstall | not_tested / none | tests/cli.test.ts; scripts/package-release.mjs | 只有 CLI 初始化不覆盖配置；现有的是自包含 zip（解压即用），不是安装程序，升级/卸载与迁移未验收 |
