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

export function loadConfig() {
  const env = { ...parseEnvFile(CONFIG_PATH), ...process.env };

  const selfId = Number(env.QQ_BOT);
  if (!Number.isSafeInteger(selfId) || selfId <= 0) {
    throw new Error(`QQ_BOT 无效: ${env.QQ_BOT}`);
  }
  if (!env.QQ_CLAUDE_EXE) {
    throw new Error("缺少 QQ_CLAUDE_EXE（claude.exe 的完整路径）");
  }

  return {
    selfId,
    allowedSenders: parseIdList(env.QQ_ALLOWED_SENDERS),
    allowedGroups: parseIdList(env.QQ_ALLOWED_GROUPS),
    wsUrl: env.ONEBOT_WS_URL || "ws://127.0.0.1:3001",
    wsToken: env.ONEBOT_TOKEN || "",

    claudeExe: env.QQ_CLAUDE_EXE,
    claudeBaseUrl: env.QQ_CLAUDE_BASE_URL || "http://127.0.0.1:15721",
    claudeAuthToken: env.QQ_CLAUDE_AUTH_TOKEN || "PROXY_MANAGED",
    claudeHome: env.QQ_CLAUDE_HOME || "C:\\Users\\Administrator",
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

    maxTurns: Number(env.QQ_MAX_TURNS) || 15,
    timeoutMs: Number(env.QQ_TIMEOUT_MS) || 300000,
    mcpTimeoutMs: Number(env.QQ_MCP_TIMEOUT_MS) || 30000,
    maxPromptChars: Number(env.QQ_MAX_PROMPT_CHARS) || 4000,
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
  };
}
