import { readFileSync } from "node:fs";

const CONFIG_PATH = process.env.QQBOT_CONFIG || "D:\\QQBOT\\onebot-mcp\\.env";

function parseEnvFile(path) {
  const env = {};
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return env;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function parseIdList(value) {
  return (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isSafeInteger(n) && n > 0);
}

// 路径统一在这里推导，其它模块一律不再写死。
//
// 为什么要有这一步：原来 7 处路径各自散布在 config/index/queue/roles/session
// 里，默认值全是这台机器的绝对路径。换一台机器就要改 7 个地方，漏一个的表现
// 还是"悄悄用错了目录"而不是报错。
//
// 解析顺序（**显式配置优先于根目录推导**）：
//   1. 该项自己的专用变量（如 QQ_QUEUE_PATH）——保留既有的覆盖能力，
//      已经配过的部署不受影响
//   2. 根目录 ${QQ_DATA_DIR}
//   3. 内置默认
// 先看专用变量再看根目录，是因为根目录是"一把大伞"，而专用变量是
// 精确指令；让精确的赢才符合直觉。
// 统一用反斜杠拼接 Windows 路径。
//
// 不这么做的话 QQ_DATA_DIR=E:/NewBot/data 会拼出 `E:/NewBot/data\sessions.json`
// 这种混用分隔符的路径——Windows 能认，但日志里看着别扭，比对字符串时也容易出岔。
// 正斜杠全部归一成反斜杠，末尾多余的斜杠去掉。
function normalizeDir(dir) {
  return String(dir).replace(/\//g, "\\").replace(/\\+$/, "");
}

function resolvePath(explicit, dataDir, relative, fallback) {
  if (explicit) return explicit;
  if (dataDir) return `${normalizeDir(dataDir)}\\${relative}`;
  return fallback;
}

export function loadConfig() {
  const env = { ...parseEnvFile(CONFIG_PATH), ...process.env };

  const selfId = Number(env.QQ_BOT);
  if (!Number.isSafeInteger(selfId) || selfId <= 0) {
    throw new Error(`QQ_BOT 无效: ${env.QQ_BOT}`);
  }
  if (!env.QQ_CLAUDE_EXE) {
    throw new Error("缺少 QQ_CLAUDE_EXE（claude.exe 的完整路径）");
  }

  // 数据目录：转移部署时改这一行就够，其余状态文件全部相对它推导。
  const dataDir = env.QQ_DATA_DIR || "";
  const DEFAULT = (relative) => `D:\\QQBOT\\qq-bot\\${relative}`;
  const path = (explicit, relative) => resolvePath(explicit, dataDir, relative, DEFAULT(relative));

  return {
    dataDir: normalizeDir(dataDir || "D:\\QQBOT\\qq-bot"),

    selfId,
    allowedSenders: parseIdList(env.QQ_ALLOWED_SENDERS),
    allowedGroups: parseIdList(env.QQ_ALLOWED_GROUPS),
    wsUrl: env.ONEBOT_WS_URL || "ws://127.0.0.1:3001",
    wsToken: env.ONEBOT_TOKEN || "",

    // 状态文件。queuePath 与 rolesPath 也在这里定，
    // 让"所有落盘位置"只有一个出处（那两个模块仍保留 setXxxPath 供测试注入）。
    sessionsPath: path(env.QQ_SESSIONS_PATH, "sessions.json"),
    queuePath: path(env.QQBOT_QUEUE, "queue.json"),
    rolesPath: path(env.QQBOT_ROLES, "roles.json"),

    claudeExe: env.QQ_CLAUDE_EXE,
    claudeBaseUrl: env.QQ_CLAUDE_BASE_URL || "http://127.0.0.1:15721",
    claudeAuthToken: env.QQ_CLAUDE_AUTH_TOKEN || "PROXY_MANAGED",
    claudeHome: env.QQ_CLAUDE_HOME || "C:\\Users\\Administrator",
    // 不跟随 QQ_DATA_DIR：它描述的是"本机 onebot-mcp 在哪个端口、用什么 token"，
    // 属于部署资产而非机器人产生的数据。跟着数据目录跑的话，转移后它会指向
    // 一个不存在的文件，而报错要到 spawn claude 那一刻才出现，很难定位。
    claudeMcpConfig: env.QQ_CLAUDE_MCP_CONFIG || "D:\\QQBOT\\qq-bot\\mcp-config.json",
    claudeCwd: env.QQ_CLAUDE_CWD || "C:\\Users\\Administrator",

    // 工具白名单。默认只读，逐个点名而非用 mcp__onebot-http 通配 ——
    // 那个写法会把 60 个工具全部放行，其中包含 set_group_kick、set_group_ban、
    // set_group_whole_ban、delete_friend、set_qq_avatar 等破坏性操作。
    // 机器人据此可"看"，但不能替你在群里踢人/禁言/发消息。
    allowedTools:
      env.QQ_ALLOWED_TOOLS ||
      [
        "Read",
        "Glob",
        "Grep",
        "mcp__onebot-http__get_group_list",
        "mcp__onebot-http__get_group_info",
        "mcp__onebot-http__get_group_member_list",
        "mcp__onebot-http__get_group_message_history",
        "mcp__onebot-http__get_private_message_history",
        "mcp__onebot-http__get_friend_list",
        "mcp__onebot-http__get_message",
        "mcp__onebot-http__get_group_notice",
        "mcp__onebot-http__get_essence_msg_list",
      ].join(","),

    // 群聊：默认关闭，开启后仅在 @机器人 时响应
    enableGroups: env.QQ_ENABLE_GROUPS === "true",
    groupMentionNames: (env.QQ_GROUP_MENTION_NAMES || "First")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    replyToSender: env.QQ_REPLY_TO_SENDER === "true",

    // 群聊会话是否按「群」共享（默认开）。
    //
    // 开：全群共用一条 Claude 会话，A 问的问题 B 能接着问，
    //     机器人回复时看得见彼此的上下文。代价是同一群的消息串行执行
    //     （一次 spawn 可能几十秒），且上下文对全群可见。
    // 关：退回旧的「群 + 人」隔离——每个人一条独立会话，互不干扰，
    //     但同一群里的人无法讨论同一个问题。
    groupSharedSession: env.QQ_GROUP_SHARED_SESSION !== "false",

    // 是否给群聊 prompt 加发送者前缀（默认开，如「[张三(12345)] 帮我看下」）。
    // 共享会话下模型只能靠它区分是谁在说话，关掉请自行确认模型还能分清。
    senderPrefix: env.QQ_SENDER_PREFIX !== "false",

    // 群聊被 @ 时，是否把群里的最近消息记录一并塞进 prompt（默认开）。
    //
    // 为什么需要：机器人每条消息都是**新 spawn 的进程**，上下文里没有"刚才"。
    // 群里有人说「@机器人 刚才那个怎么弄」，它只能回一句"你指的是什么"。
    // 补上这段记录就能让它看懂指代。
    //
    // 为什么**不**按关键词（"刚才/上面"）来判断要不要拉：漏判时模型
    // 根本不知道自己缺上下文，答错也毫无察觉；而多拉的代价只有约 300 token
    // （实测 20 条消息提取后约 450 字符）。宁可多带，不可漏带。
    //
    // 只在群聊生效：私聊的对话本来就是一对一连续的，没有"群里别人说的话"
    // 需要回溯。
    historyContext: env.QQ_HISTORY_CONTEXT !== "false",

    // 是否示意"已收到、正在处理"，而不是等模型跑完才说话。
    //
    // 开（默认）：提问的人立刻知道消息没丢。
    // 关：退回等结果的一次性回复（旧行为）。
    //
    // 形式按场景分（见 index.js 的 ack 分支）：群聊给那条消息**贴表情**，
    // 私聊发文字并附排队条数。
    ackMessage: env.QQ_ACK_MESSAGE !== "false",

    // 延迟（毫秒）。到点还没跑完才示意；跑完了就什么都不做——
    // 秒回的闲聊因此不会多出任何噪音，长任务照样有反馈。
    // 设 0 = 立即示意。
    ackDelayMs: Math.max(0, Number(env.QQ_ACK_DELAY_MS) || 5000),

    // 群聊示意"处理中"用的表情 id。
    //
    // 124 = QQ 内置表情「OK」。实测（get_msg 的 emoji_likes_list 复查）
    // 贴上去确实生效。改成别的数字即可换表情，id 表见 QQ 的 face 编号。
    //
    // 为什么用表情而不是发一条「收到，正在处理…」：群里几件事并发时，
    // 每个回执都是一行新消息，几条就把正常聊天冲散了；表情挂在原消息上，
    // 不进消息流、不推通知、不占版面。
    reactionEmoji: env.QQ_REACTION_EMOJI || "124",

    // ---- 合并打断：连发两条时，杀掉第一条正在跑的进程，两条合成一条重跑 ----
    //
    // 语义是**合并**不是放弃：第一条的内容原样保留在合并后的 prompt 里，
    // 第二条作为补充一起处理。实现上只能是"杀进程 + 重跑"——无头 spawn
    // 没有常驻进程可以收 ESC 信号。
    //
    // 生效范围：私聊里 admin 和 user 都算；群聊里**仅当连着的两条是同一人发的**。
    // 群聊默认不放行是因为共享会话——别人正常发言会被你的第二条杀掉重跑，
    // 两人同时打字必然互相打断。同一个人补一句没有这个问题：被打断的正是
    // 他自己那次执行，语义和私聊完全一样。
    mergeInterrupt: env.QQ_MERGE_INTERRUPT !== "false",

    // 窗口（毫秒）。超过就不打断，第二条照常排队。
    //
    // 取 5s 有两个理由：一是主场景是"转发文件后补一句要求"，都在几秒内；
    // 二是它**恰好不大于 ackDelayMs 的默认值**——合并总在「收到，正在处理…」
    // 触发之前发生，被打断的那次运行根本不会发出回执，用户不会看到
    // "正在处理"之后消息被撤掉重答的怪异现象。
    //
    // 但 5s 窗口本身不可能很大：实测单条短消息往返仅 2.3s，
    // 窗口再大就会开始误伤已经跑完的回复。
    mergeWindowMs: Math.max(0, Number(env.QQ_MERGE_WINDOW_MS) || 5000),

    // 合并发生时是否告知用户。默认开——否则用户看到的是「收到，正在处理…」
    // 之后突然换了个话题重答，像机器人失忆了。
    mergeNotice: env.QQ_MERGE_NOTICE !== "false",

    maxTurns: Number(env.QQ_MAX_TURNS) || 15,
    timeoutMs: Number(env.QQ_TIMEOUT_MS) || 300000,
    mcpTimeoutMs: Number(env.QQ_MCP_TIMEOUT_MS) || 30000,
    maxPromptChars: Number(env.QQ_MAX_PROMPT_CHARS) || 4000,

    // 回复长度上限（字符）。超长整条发会被 QQ 静默拒收，用户只看到回执、
    // 等不到结果，所以宁可截断并说明。留了标明"被截断"那行的余量。
    //
    // 注意：这是**最后兜底**，不是第一道处理。超过 reportThreshold 的回复
    // 会走 HTML 文件发送（见下面），只有文件也发不出去时才落到这个截断。
    maxReplyChars: Number(env.QQ_MAX_REPLY_CHARS) || 3500,

    // ---- 长回复改走 HTML 文件 ----
    //
    // 超过 reportFileThreshold 字的回复不截断，而是渲染成 HTML 文件发给用户。
    // 为什么是 HTML 而不是 txt：手机端 txt 附件要点开→下载→用外部应用打开，
    // 而 HTML 可以直接用浏览器打开，排版（段落、列表、深色模式）都在。
    //
    // 为什么不是 Markdown：实测 41 条长回复里 0 条用了 `#` 标题或代码块，
    // 模型输出的是纯中文散文——写一整套 Markdown 渲染不划算。详见 html-report.js。
    //
    // 关掉它就退回旧的"截断"行为。
    reportFile: env.QQ_REPORT_FILE !== "false",

    // 触发走文件的字数阈值（按码点算）。
    //
    // 取 2000 而不是沿用 maxReplyChars 的 3500：3500 是"发不出去"的物理上限，
    // 而 2000 更接近"手机上滚动看会觉得长"的界限。阈值低了风险是频繁弹文件
    // （体验变重），高了则是继续发超长消息（体验变差），2000 是二者的折中。
    reportFileThreshold: Number(env.QQ_REPORT_THRESHOLD) || 2000,

    // 传给 claude 的 --model 值。**留空则完全不传该参数**（保持原有行为）。
    //
    // 为什么用别名而不是模型名：模型由 cc-switch 代理在服务端决定，
    // 它按**槽位**（haiku/sonnet/opus）路由，而不是按模型名透传。
    // 实测（2026-09-21）：
    //   --model haiku              → 上游 deepseek-v4-flash     ← 想要便宜的就用这个
    //   不传                       → 上游 deepseek-v4-flash-max ← 默认
    //   --model deepseek-v4-flash  → 上游仍是 flash-max（模型名被当成槽位键，无效）
    //   env ANTHROPIC_DEFAULT_HAIKU_MODEL=... → 被 cc-switch 忽略，完全无效
    // 换模型请用别名，别写具体模型名。
    claudeModel: env.QQ_CLAUDE_MODEL || "",
    // claude 失败后的重试次数。0 表示不重试。
    retryCount: Number.isInteger(Number(env.QQ_RETRY_COUNT))
      ? Number(env.QQ_RETRY_COUNT)
      : 1,

    // 会话文件体积上限（MB）。超过就丢弃映射、下次开新会话。
    //
    // 存在的理由：会话历史里会永久保存工具输出，其中**图片是 base64 全量存储**——
    // 实测读一张截图就写入 531 KB。读几次截图会话就上 MB，而每次 --resume
    // 都要重新加载整个文件，直接拖慢响应甚至撑爆内存。
    // 会话文件体积上限（MB）。剥离图片后仍超过就丢弃会话、下次开新的。
    sessionMaxMb: Number(env.QQ_SESSION_MAX_MB) || 3,

    // 达到此体积（MB）时，在回复之后后台触发一次 compact。
    // 设得比 sessionMaxMb 低，让压缩有机会先介入；压缩是有损但连贯的
    // （旧历史折叠成摘要），而丢弃会话是彻底失忆。
    sessionCompactMb: Number(env.QQ_SESSION_COMPACT_MB) || 1.5,

    // compact 的超时。大会话要几分钟，给足余量，否则压缩到一半被杀。
    compactTimeoutMs: Number(env.QQ_COMPACT_TIMEOUT_MS) || 600000,

    // 定时任务的配置文件。调度器每 20s 读一次，所以改完这个文件
    // **不需要重启**（与其它配置项不同）。
    jobsPath: path(env.QQ_JOBS_PATH, "jobs.json"),

    // 长回复写的 HTML 报告、以及模型产出的其它文件都放这里。
    // 优先 QQ_WORKSPACE_DIR，其次 ${QQ_DATA_DIR}\workspace。
    workspaceDir: path(env.QQ_WORKSPACE_DIR, "workspace"),

    // ---- 后台任务 ----

    // 后台任务的落盘位置。刻意**不**复用 queue.json：那份文件的启动恢复
    // 会从事件重算 convKey，把后台任务重放进主会话，正是要避免的污染。
    bgTasksPath: path(env.QQBOT_BG_TASKS, "bg-tasks.json"),

    // 超时。不用 timeoutMs（5 分钟）——那个限制的成立理由是「有人在等」，
    // 用户就坐在 QQ 前面。后台任务没人等，该给更长的绳。
    bgTimeoutMs: Number(env.QQ_BG_TIMEOUT_MS) || 1800000,

    // 全局并发上限。每个任务是一个完整 claude.exe + 独立 MCP 会话，
    // 而机器同时还在服务实时聊天、共用同一个 cc-switch 代理。
    bgMax: Number(env.QQ_BG_MAX) || 3,

    // 结果的过期时间。比文件缓存的 5 分钟长得多——那是给「刚发的那条消息」
    // 消解代词用的；这是用户明确布置、当天很可能会回来追问的任务。
    bgResultTtlMs: Number(env.QQ_BG_RESULT_TTL_MS) || 86400000,

    // 结果注入主会话时的预览上限。必须封顶：全文可能几万字，整段塞进
    // prompt 会顶破 maxPromptChars，而那个检查在组装之后——一旦超长，
    // 该会话之后每条消息都会被拒，用户就彻底说不了话了。
    bgInjectChars: Number(env.QQ_BG_INJECT_CHARS) || 1200,

    // 后台任务 prompt 里附带最近几条会话消息的条数。
    // 任务跑在全新会话里，对「刚才聊的那些」零上下文，补上能显著提升完成质量，
    // 也补掉了自然语言触发丢掉回指能力后的缺口。
    // 比群聊回溯的 20 条小——那是消解代词，这是补背景。
    bgHistoryLimit: Number(env.QQ_BG_HISTORY_LIMIT) || 10,

    // 是否支持自然语言触发（「后台帮我查一下…」），默认开。
    // 关掉就只认 /bg 指令。误判代价极低（多跑一个无害任务），
    // 而要求用户记住指令是实打实的使用负担，所以默认开。
    bgNaturalTrigger: env.QQ_BG_NATURAL !== "false",

    // 是否把已完成的结果并入主会话上下文，默认开。
    // 关掉会退化成「只推送不注入」——用户在聊天窗口看得到结果，
    // 但接着追问细节时模型一无所知。
    bgResultInject: env.QQ_BG_INJECT !== "false",

    // claude 的会话记录目录（--resume 读的就是这里）。
    // 这个目录由 CLI 管理、位置固定，默认跟随 claudeHome。
    projectsBase: env.QQ_PROJECTS_BASE || `${env.QQ_CLAUDE_HOME || "C:\\Users\\Administrator"}\\.claude\\projects`,
  };
}
