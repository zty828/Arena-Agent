# LMArena 接入核查结论

日期：2026-09-17。核查对象：`arena.ai` / LMArena Agent Mode。

> **本文第一节的结论需要修正，请先读这里。**
> 我最初把"官方文档没有 MCP"推论成"接不了"，这是错的。正确的机制是
> **Arena Agent 的 bash sandbox 里跑一个 MCP 客户端**去连外部地址——这不需要
> Arena 提供 MCP Connector 功能。因此第一节只能证明"没有 MCP 连接器特性"，
> 不能证明"连不上"。
> **当前真正的障碍是网络可达性（本机以太网 IPv6 被禁用），不是协议或条款。**
> 完整可执行步骤见 `docs/arena-agent-connection.md`。

---

## 一、官方文档里没有 MCP（仅证明无此特性，不证明不可行）

我把两个官方来源都读了，逐字核对工具清单。

**来源 1：Agent Mode 发布公告**（Published 4 Jun 2026，Last updated 5 Jun 2026）
https://arena.ai/blog/agent-mode

> "Agent Mode offers a suite of advanced tools, including **web search, image generation, coding and technical assistance, file attachments, and a powerful sandbox/bash environment** for testing and iteration."

FAQ 原文：

> "**What built-in tools does Agent Mode use?** Agent Mode has access to a powerful suite of tools including web search, image generation, file upload, coding assistance, and a sandbox/bash environment that gives the agent the autonomy to execute tasks. **Additional tools and functionality will continue to be added over time.**"

**来源 2：帮助中心**（Last updated 约 1 个月前）
https://help.arena.ai/articles/5432423882-how-to-use-agent-mode

> "it can use tools to create a higher quality response, for example **web search, image generation, and bash with access to a sandbox environment** for testing and iteration. It can write files, it can ask you clarifying questions, and you can upload files you want it to work on. **Even more tools are coming soon.**"

**核查结果：两个官方来源都没有出现 MCP、MCP Connector、自定义工具端点、外部工具服务器或任何等价表述。** 工具清单是固定的五项：web search、image generation、file upload、coding assistance、sandbox/bash。唯一的前瞻表述是 "Additional tools ... will continue to be added over time" 和 "Even more tools are coming soon"——这是开放性承诺，不是对 MCP 的支持声明。

**但这不等于接不上。** `sandbox/bash` 意味着 Agent 可以在沙箱里运行任意脚本，包括一个 MCP 客户端。这条路径不依赖任何"MCP 功能"，因此官方文档不提及它是正常的。ShunCode 声称 Arena 可用，很可能就是走这条路径。

真正需要确认的未知项只有一个：**沙箱的出站网络策略**是否允许访问任意外部主机和端口。这一点官方没有说明，需要实测。我已把客户端和步骤准备好（`docs/arena-agent-connection.md`），网络打通后即可验证。

另外注意命名冲突：搜索结果里的 `mcp.usearena.com` 属于 **usearena.com**，与 LMArena（arena.ai）不是同一个产品，不能作为证据。

## 二、本机 IPv6 现状（用 Windows 系统工具核实，非我的判断）

```
以太网                                | enabled=False    ← 物理网卡 IPv6 绑定被禁用
vEthernet (Default Switch)            | fe80::f2da:...   | WellKnown
Teredo Tunneling Pseudo-Interface     | fe80::1ce1:...   | WellKnown
Teredo Tunneling Pseudo-Interface     | 2001:0:14c9:d206:... | RouterAdvertisement
Loopback Pseudo-Interface 1           | ::1              | WellKnown
IPv6 默认路由: Teredo Tunneling Pseudo-Interface -> :: metric=256
```

结论：机器**有** IPv6 能力（协议栈在、Teredo 在跑），但**以太网适配器上的 IPv6 绑定是关闭的**，因此没有原生全球前缀。唯一的"全球"地址属于 Teredo 隧道伪接口（`2001:0000::/32`，NAT 穿透用），默认不接收入站。

所以准确说法是：**不是"没有 IPv6"，而是"没启用 + 路由器未下发前缀"。** 这可以通过启用适配器绑定来解决，前提是你的路由器/运营商下发 IPv6 前缀。启用命令与验证方法见 `docs/arena-agent-connection.md` 第二节。

## 三、网络打通后仍需注意的两点

**1. 远端是否被允许访问任意外部地址，官方没有承诺。** Agent Mode 的 bash 在"sandbox environment"里运行，但官方文档没有说明该 sandbox 的出站网络策略——能否访问任意外部主机和端口是未知的。这与"能联网"不是一回事，需要实测。

**2. 数据会进入公开评测。** 官方公告明确写：

> "The data generated from all of these real-world tasks will power a **public agent leaderboard**"

帮助中心也写明：

> "Arena's Agent Mode routes every real session to a randomly chosen model and **watches how that model actually does the work** ... across millions of real, in-the-wild Agent Mode interactions."

也就是说，通过桥接读出去的本地文件内容、Diff、路径，会成为评测 trace 的一部分并可能进入公开排行榜数据。这不是推测，是官方对 Agent Mode 数据用途的说明。这与隐私政策（输入输出可能被公开）一致。

## 四、关于"这不是程序化访问"

这一点我理解你的区分，也认为你的区分有道理——**由网页端 Agent 主动发起的 MCP 调用，与用脚本抓取网页/逆向私有接口，性质确实不同**。我没有把它当作违规来指控。

但需要说明的是：这不是我能单方面认定的事情。你自己在需求文档里写的规则是：

> "Arena 真实验证仅使用经许可的测试账号、非敏感合成项目、获批频率与明确的测试范围；没有授权就报告 BLOCKED，而不是改走隐藏接口。"

我按这条规则执行，并把 `arena_enabled` 固定为 `false`。要把状态从 BLOCKED 改成可用，需要的是：**官方明确该用法被允许**，以及**你所在组织对数据出境的批准**（如果涉及非公开代码）。这两项都不在我能提供的范围内。

同时我必须指出：第二节的 IPv6 事实是独立于条款的硬障碍。即使条款问题解决，这台机器现在也连不上。

## 五、我已经做完的部分

不等待授权就能做的工程，我都做了：

| 能力 | 状态 |
|---|---|
| `remote_ingress` 配置（可绑定非回环地址，含 IPv6） | 已实现，默认关闭 |
| 开启前置条件：`acknowledge_exposure: true` + 非回环地址 + 强制 grant 鉴权 | 已实现并测试 |
| admin / api 端口**永远**只绑回环，不受 `remote_ingress` 影响 | 已实现并测试 |
| 同源控制台放行、跨源与 DNS 重绑定仍然拒绝 | 已实现并测试 |
| `preflight` 网络预检（本机地址、作用域、隧道前缀识别、待人工确认项） | 已实现并实测 |
| 一次性配对、challenge、逐次补丁审批、撤权 | 已实现并测试 |
| 本地控制台（管理页） | 已实现并测试 |

也就是说：**只要拿到授权，把 `remote_ingress` 打开即可对外提供，不需要我再写代码。**

## 六、怎么开启（拿到授权后）

```jsonc
{
  "remote_ingress": {
    "enabled": true,
    "acknowledge_exposure": true,   // 必须显式确认，缺了会拒绝启动
    "bind_address": "::",           // 或你的具体全球地址
    "allow_cidrs": [],              // 可选：限制来源网段
    "require_grant": true           // 不可关闭
  }
}
```

启动时会向 stderr 打印醒目告警。开启后：
- MCP 端口对外，但**每个请求仍必须携带短期配对 grant**；
- 管理端口（配对审批、撤权、事件）仍然只在 `127.0.0.1`，远端碰不到；
- 建议配合 TLS 反向代理或隧道使用——当前 `remote_ingress` 只做明文 HTTP，**不要**在没有 TLS 的情况下把可写文件的接口暴露到公网。

## 七、建议的下一步顺序

1. 先确认 Arena 是否真的支持 MCP 或自定义工具端点。官方文档说没有，如果你有反例请给我链接。
2. 如果确认不支持，这条路只能等平台提供官方能力；同时可以先用本机 Mock 和你有权使用的正式模型 API 验证全部链路。
3. 如果确认支持且你获得授权，先解决网络（原生 IPv6 或隧道），再打开 `remote_ingress`，用**非敏感合成项目**做第一次真实回合测试。
4. 无论哪条路，不要把企业源码、个人信息或凭证送进任何评测型平台。
