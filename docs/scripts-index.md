# `scripts/` 索引

`npm run` 里已经有的常用命令见 README 的「构建、测试与打包」。这里按用途把每个脚本列全——
**`npm run` 里没有对应命令的，直接 `node scripts/<名字>.mjs` 即可**。

## 两个本地状态文件是按需生成的

`.arena-bridge/local-credentials.json`（回环开发凭据，含密钥）和 `outputs/run-local.config.json`
（含绝对路径）**都不能入库**，所以克隆下来必然不存在。它们由脚本在需要时生成，**已有的文件绝不覆盖**：

- `gen-credentials.mjs` → 凭据（`npm run credentials`；`npm run local`、`serve`、`smoke`、`workbuddy` 也会按需触发）
- `ensure-local-config.mjs` → 配置（同上；`postinstall` 也会跑一次）

删掉它们等于轮换/重置，下次运行会重新生成——**不要把"文件不存在"当成故障**。

## 交付校验链有顺序

`check-delivery.mjs` 是链条最后一环，它读的是前几步产出的文件，必须按这个顺序跑：

```
contracts.mjs  →  verify.mjs  →  traceability.mjs  →  check-delivery.mjs
```

原因：`traceability.mjs` 与 `check-delivery.mjs` 都要读 `outputs/verification.json`，而那个文件是
`verify.mjs` **跑完之后**才写的。缺前置文件时 `check-delivery.mjs` 会明确告诉你该先跑哪一步，而不是抛一个裸 ENOENT。


## 入口与本地运行

| 脚本 | 作用 |
| --- | --- |
| `desktop.mjs` | 桌面窗口启动器，`desktop.cmd` 调它。解析 Node/Electron、按需重建、spawn Electron |
| `ensure-build.mjs` | 源码比 `dist` 新时按需重建（被 `desktop.mjs` 调用，不依赖 PATH） |
| `build-desktop.mjs` | 把 `preload.cjs` 与渲染页拷进 `dist`（tsc 不产出这些） |
| `electron-binary.mjs` | 定位 Electron 二进制，并把"缺失"分成三类原因、各给修法 |
| `ensure-local-config.mjs` | 按需生成 `outputs/run-local.config.json`，绝不覆盖已有文件 |
| `bootstrap-local.mjs` | `npm run local` / `npm run expose`：编译 → 凭据 → 前台跑 daemon → 开控制台 |
| `run-with-credentials.mjs` | `npm run serve`：用已存凭据前台跑 daemon |
| `serve-local.mjs` / `stop-local.mjs` | 后台起 / 按 PID 停 daemon（PID 文件在 `outputs/local-run`） |
| `gen-credentials.mjs` | `npm run credentials`：本地回环开发凭据的**唯一生产者**，同时导出 `ensureLocalCredentials()` 供其他脚本按需调用（绝不轮换已有令牌） |
| `console-preview.mjs` | `npm run console:preview`：造一个真实的待批补丁，用来预览控制台 |
| `smoke-local.mjs` | `npm run smoke`：对真实 daemon 进程的端到端冒烟 |
| `register-workbuddy.mjs` | `npm run workbuddy`：把本机 MCP 端点注册进 `~/.workbuddy-ai/mcp.json` |
| `trust-cli-folder.mjs` | `npm run cli:trust`：管理 CodeBuddy CLI 的目录信任列表 |
| `arena-oneclick.mjs` | `npm run arena`：一键建隧道 + 起 bridge + 生成配对码与提示词 |
| `arena-prompt.mjs` | `npm run arena:prompt`：单独生成给远端粘贴的提示词 |
| `arena-flow-test.mjs` | `npm run arena:rehearse`：按提示词逐步预演整套远端流程 |

## 验收与探针

`npm run verify` 会跑其中大部分；单独跑用下表的名字。

| 脚本 | 作用 |
| --- | --- |
| `verify.mjs` | `npm run verify`：完整回归（编译 → 探针 → 桌面自检 → 测试 → 演示 → SBOM） |
| `verify-run.mjs` | `npm run verify:run`：用 bridge 自己的审计日志独立核验一次远端 run |
| `verify-workbuddy.mjs` | `npm run verify:workbuddy`：核验 WorkBuddy 实际配到的是什么 |
| `run-tests-clean.mjs` | `npm run test:clean`：在删除不受限的环境里跑回归（隔离每个子进程的删除预算） |
| `desktop-selftest.mjs` | `npm run desktop:selftest`：驱动窗口自检（固定合成夹具，不写用户偏好） |
| `desktop-e2e.mjs` | 窗口端到端测试（自己持有 Electron 进程生命周期） |
| `sandbox-client-e2e.mjs` | 沙箱 MCP 客户端对真实 daemon 的端到端测试 |
| `sandbox-client-loopback.mjs` | `npm run probe:loopback`：客户端自身在无中继时是否健康 |
| `ingress-e2e.mjs` | 在**非回环**地址上跑通远端入站全链路（只绑 MCP 端口，admin/api 留回环） |
| `write-cycle-e2e.mjs` | 完整写盘闭环（真 daemon + 真客户端），含 exec 档与子目录下钻 |
| `probe-import-paths.mjs` | `npm run probe:imports`：编译后代码运行期会 import 的路径必须存在 |
| `probe-desktop-tunnel-wiring.mjs` | `npm run probe:wiring`：窗口的隧道接线在运行期能否解析（含剥掉 PATH 后仍能重建） |
| `probe-pairing-approval.mjs` | `npm run probe:pairing`：窗口能否看到并批准一条配对请求 |
| `probe-client-envelope.mjs` | `npm run probe:client`：沙箱客户端能否正确读出工具结果 |
| `probe-access-mode.mjs` | `npm run probe:access-mode`：档位可选、且选择真的保持住 |
| `probe-auto-approve.mjs` | `npm run probe:auto-approve`：无人值守写入的开关与各道闸门 |
| `probe-grant-lifetime.mjs` | `npm run probe:grant-lifetime`：授权默认随会话、限时真的会过期 |
| `probe-exec.mjs` | `npm run probe:exec`：命令执行、edit 助手与真正则搜索 |
| `probe-skills.mjs` | Agent Skills 的规范符合性（名称规则、目录名一致、字段上限）、渐进披露（**列表不含正文**）、只读边界、路径穿越与链接不跟随 |
| `mutation-skills.mjs` | `probe-skills.mjs` 的变异测试：逐个破坏它声称守护的 6 个决定，探针必须全部失败。**手工运行，不进 `verify`**——它要改写 `dist` 与一处源码，跑完会自行还原 |
| `probe-exposed-listener.mjs` | `npm run probe:exposed`：在窗口提供该选项之前，先证明暴露路径可用 |
| `probe-pinned-remote-port.mjs` | `npm run probe:pinned`：暴露的 daemon 是否真的绑在隧道要转发的那个端口上 |
| `probe-stale-lease.mjs` | `npm run probe:lease`：被杀掉的 daemon 留下的旧租约能否与活着的区分开 |
| `probe-switch-recovery.mjs` | `npm run probe:switch`：切换工作目录失败时是否如实上报、且不留下没有 bridge 的窗口 |
| `probe-workspace-rebind.mjs` | `npm run probe:rebind`：本机 MCP 身份能否绑定到多个工作区 |
| `probe-workspace-view.mjs` | `npm run probe:view`：窗口依赖的两个只读工作区端点（且敏感路径仍被拒） |
| `probe-connect-click-path.mjs` | `npm run probe:click`：点「接远端」这条点击路径，跑在真实编译产物上 |
| `probe-litter-location.mjs` | 证明工作区套件的失败来自宿主删除沙箱、而不是补丁引擎 |
| `rebind-against-state.mjs` | 按窗口的方式，对同一个 state 目录依次绑定多个工作区 |
| `clipboard-probe.mjs` | 用 UTF-8 文件中转读剪贴板，避开控制台代码页 |
| `local-mcp-diag.mjs` | `npm run mcp:local-check`：探令牌 × 端口的组合，确认哪个凭据在哪个端口有效 |
| `gateway-report.mjs` | `npm run gateway:report`：报告模型网关当前实际提供什么 |

## 隧道与网络

| 脚本 | 作用 |
| --- | --- |
| `tunnel-cloudflared.mjs` | 隧道提供者：Cloudflare Quick Tunnel（用内置 `runtime/cloudflared.exe`） |
| `tunnel.mjs` | `npm run tunnel`：零安装的 SSH 反向隧道 |
| `tunnel-e2e.mjs` | `npm run tunnel:verify`：端到端验证隧道，含隧道呈现的 Host 头 |
| `tunnel-external-check.mjs` | `npm run tunnel:external`：确认隧道对外部客户端确实可用 |
| `tunnel-diag.mjs` | 区分隧道 URL 的两种失败：隧道本身没起来 vs 拿到了 URL 但不可达 |
| `tunnel-probe.mjs` | 本机实际可用的零安装隧道方案有哪些 |
| `tunnel-reachability.mjs` | 本机能连上哪些免费 SSH 隧道端点 |
| `tunnel-client-probe.mjs` | 本机能否下载隧道客户端（只发 HEAD/GET，不落盘） |
| `net-diagnose.mjs` | `npm run net:diagnose`：远端入站所需的 IPv6 就绪度诊断 |
| `ipv4-diagnose.mjs` | `npm run net:ipv4`：IPv4 出网现实检查 |

## 契约、交付物与打包

| 脚本 | 作用 |
| --- | --- |
| `contracts.mjs` | 从代码导出契约：`outputs/openapi.json`、`outputs/mcp-tools.schema.json` |
| `traceability.mjs` | 生成需求追踪表（B/N/O/X 与 T01–T38 的状态、证据与限制） |
| `sbom.mjs` | `npm run sbom`：生成 SBOM（`outputs/sbom.cdx.json`） |
| `check-delivery.mjs` | 交付门禁：校验契约 / 追踪表 / 证据 / SBOM 互相一致。**必须按上面的顺序最后跑**；缺前置文件时会告诉你先跑哪一步 |
| `lock-integrity.mjs` | 校验 `package-lock.json` 与 manifest 一致（只比对包名与版本） |
| `package-release.mjs` | `npm run package:release`：生成自包含 Windows 发布包 |
