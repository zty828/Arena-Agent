/**
 * The paste-into-Arena prompt, built as a pure function.
 *
 * Kept free of any process, filesystem or Electron state on purpose: it is the one piece of
 * this flow whose wording matters to a third party (the remote model), so it must be
 * unit-testable rather than only observable by running the whole window.
 *
 * The steps below are the pairing handshake the daemon actually implements, in the order the
 * client script expects: request → local approval → claim → challenge → real tool call. The
 * earlier one-click script ended with a hard-coded fixture filename (`sum.mjs`), which is a
 * false step against any workspace that does not happen to contain it; this version asks the
 * agent to report what it finds instead, so no step can be silently wrong.
 */

export interface PromptInput {
  /** Public HTTPS base URL of the tunnel, e.g. https://calm-river-1234.trycloudflare.com */
  publicUrl: string;
  /** One-time pairing code, base64url (may start with '-'). */
  pairingCode: string;
  /** The directory being exposed. Shown so the operator sees what they are handing over. */
  workspaceRoot: string;
  /** Human label recorded in the pairing, so the approval prompt names this session. */
  recipient: string;
  /** The ceiling carried by the pairing code. The remote cannot ask for more than this. */
  accessMode: AccessMode;
  /**
   * Whether unattended writes are on for this session.
   *
   * This has to reach the prompt, because the remote is otherwise told to stop and wait for
   * approval after every preview. With the switch on there is nothing to wait for: it would stall
   * on a step that never comes. Stating the real posture is also the honest thing to do — the
   * agent should know whether a human is reading its diffs.
   */
  autoApproveWrites?: boolean;
  /** When unattended writes end, as an epoch ms. Only meaningful with autoApproveWrites. */
  autoApproveExpiresAt?: number;
  /**
   * The window has no expiry. Must be explicit: without it, a window that never ends would be
   * described as though a timer were going to stop it, and the agent (and the operator reading
   * this prompt) would both believe there is a safety net that is not there.
   */
  autoApproveUnlimited?: boolean;
  /**
   * How long the grant the remote is about to receive will last, in milliseconds.
   *
   * Three cases, and they must not be collapsed:
   *  - `0`   — session-scoped: no wall-clock expiry, valid until this bridge session ends.
   *  - `> 0` — a real deadline, counted from the moment the remote claims it.
   *  - absent — unknown; the prompt points at the field that carries it instead of guessing.
   *
   * This is a different clock from `autoApproveUnlimited`, and conflating the two cost a real
   * run: the prompt said the unattended window "has no expiry", the remote read that as "this
   * session has no expiry", and only noticed from a raw `expires_at` in the claim response that
   * its grant died an hour later — about 40 minutes before it did. Whichever case applies, the
   * prompt has to say it in those terms.
   */
  grantTtlMs?: number;
}

/**
 * The three access modes the daemon understands, ranked.
 *
 * The pairing code carries a ceiling (`max_access`). A request above it is refused with 403
 * "Requested access exceeds pairing scope", and the ceiling cannot be raised afterwards — the
 * operator has to mint a new code. So the prompt must state the mode that actually applies,
 * otherwise the agent (or a hand-editor) ends up asking for something that can only fail.
 */
export type AccessMode = 'ask' | 'plan' | 'code' | 'exec';

export const ACCESS_MODE_LABELS: Record<AccessMode, string> = {
  ask: '只读（ask）',
  plan: '只读并给出计划（plan）',
  code: '可写（code，每次写盘仍需本机单独批准）',
  exec: '可写 + 可执行命令（exec，写盘仍需本机单独批准，命令直接执行）',
};

/**
 * The same labels for a session where unattended writes are on.
 *
 * The header used to print `ACCESS_MODE_LABELS.code` verbatim, which states that every write
 * still needs a local approval — while a few lines below, in the very same prompt, the
 * unattended paragraph says nobody will read the diff. A remote told both things has to pick
 * one, and the header is the first thing it reads. The mode itself has not changed, so the
 * label has to be derived from the posture actually in force rather than from the mode alone.
 */
export const ACCESS_MODE_LABELS_UNATTENDED: Record<AccessMode, string> = {
  ask: '只读（ask）',
  plan: '只读并给出计划（plan）',
  code: '可写（code，无人值守：写盘自动放行，不需要我逐个批准）',
  exec: '可写 + 可执行命令（exec，无人值守：写盘自动放行，命令直接执行）',
};

/** The label for the mode as it applies right now, i.e. with unattended writes taken into account. */
export function accessModeLabel(mode: AccessMode, unattended: boolean): string {
  return unattended ? ACCESS_MODE_LABELS_UNATTENDED[mode] : ACCESS_MODE_LABELS[mode];
}

/** base64url values can start with '-', so the `--flag=value` form is mandatory everywhere. */
export function buildArenaPrompt(input: PromptInput): string {
  const url = input.publicUrl.replace(/\/+$/, '');
  const mode = input.accessMode;
  // Two independent facts, composed rather than branched four ways: whether the caller may write
  // (code and exec), and whether it may also run commands (exec only). `exec` implies the write
  // scope because a shell can write files anyway, so describing it as "commands only" would be a
  // limit in name only.
  const canWrite = mode === 'code' || mode === 'exec';
  const unattended = canWrite && input.autoApproveWrites === true;
  // The grant is always time-limited, whatever the unattended switch says. Saying so up front
  // is what stops an expiry from being read as "the bridge broke": a real remote only found out
  // from a bare `expires_at` in the claim response, minutes before its calls would have started
  // failing. The exact deadline is only knowable at claim time, so when the TTL is known it is
  // stated, and when it is not the prompt points at the field that carries it.
  const grantMinutes = typeof input.grantTtlMs === 'number' && Number.isFinite(input.grantTtlMs) && input.grantTtlMs > 0
    ? Math.round(input.grantTtlMs / 60000)
    : null;
  const grantNote = input.grantTtlMs === 0
    // 0 is the explicit "session-scoped" value the window mints with. It has to be described as
    // exactly that — not as "never expires", which would be wrong in the one case that matters
    // (the session ends) and would send the agent into a retry loop against a dead bridge.
    ? `没有墙钟到期时间：这张凭证一直有效，直到这次 bridge 会话结束——我关窗口、断开隧道、切换工作目录、
  或撤销授权时，它立刻失效。所以它不会因为"过了多久"而失效。反过来说，如果调用突然被拒（401/403），
  那是会话已经结束或我已经撤权：把错误原样告诉我，不要反复重试，也不要以为要重新配对。
  这跟"无人值守写入窗口"是两件事：窗口说的是"写盘要不要我逐个点头"，授权说的是"这张凭证还能不能用"。`
    : grantMinutes
    ? `约 ${grantMinutes} 分钟，从第 4 步领取成功那一刻开始算（第 4 步会返回 expires_at 和一个可读的 expires_in）。
  到期后所有调用都会失败——那不是 bridge 坏了，需要我重新签发配对码、你从第 1 步重走一遍。
  这跟"无人值守写入窗口"是两件事：窗口说的是"写盘要不要我逐个点头"，授权说的是"这张凭证还能用多久"。`
    : `由我签发时设定，具体数值见第 4 步返回的 expires_at / expires_in（这张凭证不是永久有效）。`;
  const writeNote = !canWrite
    ? `当前是 ${mode} 模式，只读：任何写操作都会被拒绝（这是配对码本身限定的上限，不是临时故障）。
  不要尝试写文件，也不要尝试执行命令（命令需要 exec 档，这一档没有）；如果你认为必须写入或执行，
  请停下并告诉我需要我用更高的档位重新签发配对码。`
    : `${unattended
    ? `当前是 ${mode} 模式，且我已开启「无人值守写入」：你提交的改动预览会被自动放行并直接落盘，
  **不需要、也不会有人先看 diff**。所以：
  - 不要提交你没有把握的改动，写盘后我不会先审一遍再让它生效；
  - **写盘一步就行**：apply_patch 用 action:"write" 加 changes（形状与 preview 完全相同），
  它会自己完成"预检 → 自动批准 → 落盘"。这个动作只在无人值守窗口开着时可用（关着会 403），
  所以别把它当默认写法用在别处。想分两步（preview → apply）也完全可以，两者等价；
  - 如果你用两步：preview 拿到的那次批准本身有有效期（默认 5 分钟，且不超过本次授权的到期时间），
  隔太久再 apply 会被拒绝，那时重新 preview 一次即可，不要反复重试同一个 apply；
  - 我会看写盘记录（「活动」页里每次自动批准都会留痕），但那是事后审计，不是事前把关；
  - 只改我有权让你改的东西。${input.autoApproveUnlimited
      ? '这个**无人值守窗口**没有到期时间：它只会在我在本机关掉它、或断开隧道时停止，所以不要指望它会自己失效。（注意这只说"写盘要不要我点头"这一件事——授权本身仍然会到期，见上面那行。）'
      : input.autoApproveExpiresAt ? '这个**无人值守窗口**超时后会自动失效，届时写盘会重新需要我批准。' : ''}`
    : `当前是 ${mode} 模式：你可以提交改动预览，但每一次真正写盘都需要我在本机单独批准，
  你要提交预览、然后停下来等我批准，不要以为提交了就写进去了。`}${
    mode === 'exec'
      ? `

  另外，exec 档允许你**直接执行 shell 命令**（run_command），而且**没有人工批准这一步**：
  - 命令会立刻在这个工作区里跑，用的就是我本机账户的权限。工作目录只能落在被暴露的目录内，
    默认 30 秒超时（最多 5 分钟）；超时、我断开隧道、或我撤销授权时，整棵进程树会被杀掉；
  - stdout / stderr 各截断 64 KiB（超出会标 truncated），没有交互式输入（没有 PTY，
    需要输入的命令会立刻失败，别写等待输入的脚本）；
  - 命令本身会进我的审计日志（含命令行与哈希），所以不要在里面写口令、token 之类的秘密；
  - 只用它做真正需要的事（构建、测试、查看状态），不要跑破坏性命令，不要试图访问工作区之外的东西。`
      : ''}`;
  return `我要通过 MCP 连接我自己机器上的一个工作区桥接服务。请严格按顺序执行，不要跳步，不要假设成功。

端点：${url}   （HTTPS，公网可达；沙箱里的 http_proxy 不要用于这个地址）
本机被暴露的目录：${input.workspaceRoot}
本次授权的访问模式：${accessModeLabel(mode, unattended)}   （--access-mode=${mode}）
本次授权的有效期：${grantNote}

⚠️ 你的沙箱**可能**不会在两轮对话之间保留 /tmp：实测有一次第 3 步成功后，第 4 步
/tmp/ab_client.py 就不见了（也有整轮全程都在的情况，清空更像是沙箱重启/回收触发的）。
所以每一步都要自带它需要的全部东西：脚本没了就重跑第 1 步；pair_id、claim_secret、
token、challenge 一律从上一步的输出里复制成显式参数，不要指望上一个步骤留在 /tmp 里的任何文件。

第 1 步：下载客户端。零依赖 Python 3 脚本；用 Python 而不是 curl，因为沙箱里的
http_proxy 变量会让 curl 无法直连（脚本内部已显式关掉代理）。**这一步在后面任何一步
报 "can't open file '/tmp/ab_client.py'" 时都要重跑一次。**
  python3 - <<'PY'
import urllib.request, os
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
data = opener.open('${url}/client.py', timeout=60).read()
open('/tmp/ab_client.py','wb').write(data)
print('client bytes:', os.path.getsize('/tmp/ab_client.py'))
PY
  python3 --version

第 2 步：配置（每条命令都要带上；它们不会跨轮次保留）
  export ARENABRIDGE_URL='${url}'
  export ARENABRIDGE_STATE='/tmp/ab_state.json'
  export ARENABRIDGE_TIMEOUT='60'

第 3 步：请求配对（注意 --code= 用等号，值是 base64url，可能以 - 开头）
  python3 /tmp/ab_client.py pair-request --code='${input.pairingCode}' --label='${input.recipient}' --access-mode=${mode}

  这一步会输出 pair_id **和 claim_secret**。两个都要记下来（claim_secret 只出现这一次，
  /tmp 被清空后就拿不回来了）。把 pair_id 告诉我，然后停下来等我批准。
  我会在我自己的电脑上看到这条请求并点批准（它显示在「接 Arena」页，就在配对面板上）。
  在我说"已批准"之前不要继续。

  如果我在几分钟内没有回复，就把 pair_id 再报一次，然后继续等——
  不要重复发请求，也不要以为它失败了。

第 4 步：我批准后，领取授权。**显式带上第 3 步的两个值**，别依赖状态文件：
  python3 /tmp/ab_client.py pair-claim --pair-id='<第 3 步的 pair_id>' --claim-secret='<第 3 步的 claim_secret>'

  记下输出里的 token 和 challenge 两个值（token 现在会直接打印出来；同时记下 expires_in，
  它告诉你这张凭证还剩多久）。

第 5 步：完成握手校验（token 显式带在命令里）
  ARENABRIDGE_TOKEN='<第 4 步的 token>' python3 /tmp/ab_client.py verify --challenge='<第 4 步的 challenge>'

第 6 步：一次调用确认整条读路径（自己完成握手、列出工具、列目录，并给出一批可读的文本文件）
  ARENABRIDGE_TOKEN='<第 4 步的 token>' python3 /tmp/ab_client.py agent-check

  它会自己用第 4 步拿到的 challenge 完成握手，所以你不需要先单独跑一次 verify；
  输出里 first_text_files 是"你现在真的能读的文件"，directory_names 是根目录下的子目录名。
  **file_count: 0 不等于工作区是空的**——文件常常都在子目录里，agent-check 已经帮你往下找了一层；
  如果 first_text_files 是空的，用 list_directory 顺着 directory_names 继续往下看。

第 7 步：用 agent-check 里 first_text_files 的第一个路径真正读一个文件
  ARENABRIDGE_TOKEN='<第 4 步的 token>' python3 /tmp/ab_client.py call read_files '{"files":[{"path":"<上一步给出的路径>"}]}'

  如果 first_text_files 是空的：先 list_directory 看 directory_names 里的子目录，找到文件再读；
  **不要**因为根目录没有文件就报告"工作区是空的"——那只是你还没往下看。

  读完之后，先用一段话告诉我你看到了什么，再停下来等我给下一步指令。

硬性约束：
- 所有参数都用 --flag=value 形式。
- 改文件只走 apply_patch，形状是 changes=[{"path":…, "patch":…, "expected_hash":…}]：
  patch 是标准 unified diff；**新建**文件用 expected_hash:null 且 diff 从 "--- /dev/null" 起，
  **修改**文件必须给 expected_hash（= 你读到的 version_hash），不匹配会被拒绝（这是防覆盖的乐观锁）。
  一批最多 10 个文件；**不支持删除、移动、重命名**。
- 只通过这个 MCP 端点访问工作区。不要假设沙箱里有同名项目，也不要试图在沙箱里复现它。
- ${writeNote}
- 不要自己把 --access-mode 改成更高的档位：配对码上的上限是固定的，改高只会得到 403，
  不会获得更多权限。需要更高权限就告诉我，由我重新签发配对码。
- 如果任何一步失败，原样报告错误信息并停止。不要编造"已连接"或"已完成"。
- 唯一的例外：报 "can't open file '/tmp/ab_client.py'" 说明沙箱把 /tmp 清了，
  重跑第 1 步再重试这一步即可（参数照旧带上），这不是连接或授权问题，不用停下来问我。
- 不要把这个端点地址或任何返回内容发到别处。
`;
}
