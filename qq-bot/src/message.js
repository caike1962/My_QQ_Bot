export function extractText(message) {
  if (typeof message === "string") {
    return message
      .replace(/\[CQ:at,[^\]]+\]/g, " ")
      .replace(/\[CQ:[^\]]+\]/g, " ")
      .trim();
  }
  // 数组格式：只取 text 段，@ 段天然被忽略。
  // at 段用**空格**占位而不是丢弃：两个 text 段被 at 隔开时，直接拼接会让
  // 前后文本粘连（「将 」「添加为用户」之间少了分隔就成了「将添加为用户」）。
  // 代价是多出连续空格，所以下游的正则一律用 \s* 而非 \s+ 来容忍。
  if (Array.isArray(message)) {
    return message
      .map((seg) => (seg?.type === "text" ? seg.data?.text || "" : " "))
      .join("")
      .trim();
  }
  return "";
}

// 提取消息里的文件段。
//
// 字段名以 NapCat 实测为准（2026-09-21，私聊转发一个 pdf）：
//   {"type":"file","data":{"file":"图片转pdf_20260706_214225.pdf",
//                          "file_id":"80883569f95b09df4de35ea1c783c368_bf73...",
//                          "file_size":"946642"}}
// 注意三点：
//   1. 文件名在 `file` 字段，不是 `name`
//   2. 大小在 `file_size`，且是**字符串**，用时要转数字
//   3. 拿文件内容必须靠 `file_id` 调 get_private_file_url，不能存 URL——
//      实测同一个 file_id 两次解析得到的 URL 不同（rkey 会变），存 URL 会失效
export function extractFiles(message) {
  if (!Array.isArray(message)) return [];
  const out = [];
  for (const seg of message) {
    if (seg?.type !== "file") continue;
    const d = seg.data || {};
    if (!d.file_id) continue; // 没有 file_id 就取不到内容，收了也没用
    const size = Number(d.file_size);
    out.push({
      fileId: String(d.file_id),
      name: String(d.file || "未命名文件"),
      size: Number.isFinite(size) ? size : null,
    });
  }
  return out;
}

// 对话隔离键。
//
// 群聊默认按**群**共享（groupShared=true）：所有人共用一条 Claude 会话，
// A 问了一半的问题 B 能接着问，机器人也看得见彼此的上下文。
// 代价由调用方承担：同一 key 串行执行（会话文件不能被两个进程同时追加），
// 且上下文对全群可见——信任边界是角色名单，不是单个用户。
//
// groupShared=false 退回按「群 + 人」隔离（旧行为）：适合群里成员互不相干、
// 需要一个会话只服务一个成员的场景。
export function conversationKey(event, { groupShared = true } = {}) {
  if (event.message_type === "group") {
    return groupShared ? `group:${event.group_id}` : `${event.group_id}:${event.user_id}`;
  }
  return `private:${event.user_id}`;
}

// 提取消息里所有 @ 段的 { qq, name }。
//
// name 是昵称的**唯一可靠来源**：QQ 把 @ 转成纯文本时只留「@昵称」，
// QQ 号彻底消失，而机器人按名字查人（如「将钟总添加为用户」）需要它。
// 实测 NapCat 的 at 段只给 qq，没有 name —— 所以 name 常为 null，
// 调用方要准备好回退到群成员列表去反查。
export function extractAts(message) {
  const out = [];
  if (Array.isArray(message)) {
    for (const seg of message) {
      if (seg?.type === "at" && seg.data?.qq !== undefined) {
        out.push({ qq: seg.data.qq, name: seg.data.name || seg.data.nickname || null });
      }
    }
    return out;
  }
  if (typeof message === "string") {
    for (const m of message.matchAll(/\[CQ:at,([^\]]+)\]/g)) {
      const params = {};
      for (const kv of m[1].split(",")) {
        const eq = kv.indexOf("=");
        if (eq > 0) params[kv.slice(0, eq)] = kv.slice(eq + 1);
      }
      if (params.qq !== undefined) out.push({ qq: params.qq, name: params.name || null });
    }
  }
  return out;
}

// 找出文本开头匹配的 @ 前缀（"@昵称" 或裸昵称），没有则返回 null。
function findMentionPrefix(text, names) {
  for (const name of names) {
    if (!name) continue;
    for (const prefix of ["@" + name, name]) {
      if (!text.startsWith(prefix)) continue;
      const rest = text.slice(prefix.length);
      // 前缀后不能紧跟英数字，避免 "Firstable" 这类词被误判为 "@First"
      if (!rest || !/^[A-Za-z0-9]/.test(rest)) return prefix;
    }
  }
  return null;
}

// 群聊里 @ 机器人后，QQ 通常在文本前留一个空格；去掉以免污染提示词。
export function stripLeadingMention(text, names) {
  const out = text.trim();
  const prefix = findMentionPrefix(out, names);
  return prefix ? out.slice(prefix.length).trim() : out;
}

// 判断群消息是否真的 @ 了机器人。两道信号：
// 1) 结构性的 at 段 / CQ 码，qq 等于机器人账号（最可靠）；
// 2) QQ 把 @ 转成文本时，文本以配置的群昵称开头（"First" / "@First"）。
export function isBotMentioned(message, { selfId, names = [] } = {}) {
  if (Array.isArray(message)) {
    for (const seg of message) {
      if (seg?.type === "at") {
        if (String(seg.data?.qq) === String(selfId)) return true;
      } else if (seg?.type === "text") {
        if (findMentionPrefix((seg.data?.text || "").trim(), names)) return true;
      }
    }
    return false;
  }
  if (typeof message === "string") {
    if (new RegExp(`\\[CQ:at,qq=${selfId}(?:,[^\\]]*)?\\]`).test(message)) return true;
    const text = message.replace(/\[CQ:[^\]]+\]/g, "").trim();
    return Boolean(findMentionPrefix(text, names));
  }
  return false;
}

// 发送者标签。共享会话后模型看到的是一串无署名的 user 消息，
// 分不清「帮我查下 X」是谁说的，也分不清该把结果给谁，所以每条都带上。
//
// 昵称原样来自 QQ（群名片/昵称），可能含换行或方括号，会破坏标签格式
// 甚至伪造出第二个标签——统一把结构字符换成空格，并截断长度。
export function senderLabel(event) {
  const id = Number(event?.user_id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const raw = event?.sender?.card || event?.sender?.nickname || "";
  const name = String(raw)
    .replace(/[\[\]\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24);
  return `[${name || "群成员"}(${id})]`;
}

// 给 prompt 加上发送者标签（群聊用）。私聊不需要——会话里只有一个用户。
export function withSenderPrefix(text, event) {
  const label = senderLabel(event);
  return label ? `${label} ${text}` : text;
}

// 管理员重置当前会话上下文：群里清掉整个群的共享会话，私聊清掉自己的。
// 走代码路径而不是模型路径——删除会话映射必须确定性执行，
// 不能交给一个在工具被拒时会"编造执行结果"的模型去转述。
const RESET_RE = /^\/(?:reset|清空|重置)$/;
const STATUS_RE = /^\/(?:status|状态)$/;
const DIAGNOSTIC_RE = /^\/诊断$/;

export function parseResetCommand(text) {
  return RESET_RE.test((text || "").trim());
}

export function parseStatusCommand(text) {
  return STATUS_RE.test((text || "").trim());
}

// /诊断：只认精确的「/诊断」，不认「/诊断 xxx」——
// 诊断是只看不改的操作，任何带后缀的写法都说明用户想的是别的事，放给模型处理。
export function parseDiagnosticCommand(text) {
  return DIAGNOSTIC_RE.test((text || "").trim());
}

// 发送者角色：admin（QQ_ALLOWED_SENDERS，现状语义不变）、user（roles.json 名单）、null（陌生人）。
// 兼容遗留语义：allowedSenders 为空（= 不限制）时一律按 admin 处理。
export function senderRole(userId, config, roles = {}) {
  const id = Number(userId);
  if (config.allowedSenders.length) {
    if (config.allowedSenders.includes(id)) return "admin";
    return roles.isUser?.(id) ? "user" : null;
  }
  return "admin";
}

// Admin 专属的权限管理指令。走代码路径而非模型路径：
// 该模型在工具被拒时可能"编造"执行结果，加人这种权限操作必须确定性执行。
//
// 支持两种写法：直接给 QQ 号，或给一个**带 @ 前缀**的名字。
//
// 为什么名字形式必须带 @ —— 这是防止误匹配的唯一可靠信号：
// QQ 会把 @ 转成纯文本，被 extractText 剥掉 at 段后，文本恰好以 "@" 开头
// （「将 @钟总 添加为用户」→「将@钟总 添加为用户」）。
// 若允许裸名字，像「将 abc 添加为用户」这种被截断的句子会被当成"把 abc 加为
// 用户"——而模型恰好就在那条路径上，本意是来问清楚，结果却真的写进了名单。
// 加了 @ 前缀约束后，这类误判结构上不可能发生。
//
// 空白一律用 \s* 而非 \s+ —— 名字形式里 at 段被剥掉后是「将@钟总」，
// 「将」和「@」之间**没有**空格，用 \s+ 会把它判死。数字形式则两处都容得下。
const ADD_USER_RE = /^将\s*(\d{5,12})\s*添加为\s*用户$/;
const REMOVE_USER_RE = /^将\s*(\d{5,12})\s*移出\s*用户$/;
const ADD_USER_NAME_RE = /^将\s*@([^@\s]{1,24}?)\s*添加为\s*用户$/;
const REMOVE_USER_NAME_RE = /^将\s*@([^@\s]{1,24}?)\s*移出\s*用户$/;

export function parseRoleCommand(text) {
  const t = (text || "").trim();
  let m = t.match(ADD_USER_RE);
  if (m) return { action: "add", qq: Number(m[1]), name: null };
  m = t.match(REMOVE_USER_RE);
  if (m) return { action: "remove", qq: Number(m[1]), name: null };
  m = t.match(ADD_USER_NAME_RE);
  if (m) return { action: "add", qq: null, name: m[1] };
  m = t.match(REMOVE_USER_NAME_RE);
  if (m) return { action: "remove", qq: null, name: m[1] };
  return null;
}

// 解析角色管理指令要操作的目标。
//
// 用「以将开头 + 以添加为/移出用户结尾」判意图，而不是拿 parseRoleCommand
// 当闸门：消息被 at 段切开时文本会残缺（「将 @钟总 添加为用户」→
// 「将   添加为用户」），没有哪个名字正则能匹配这种输入，但它确实是合法指令。
//
// 机器人的号码必须排除掉：群里发「@机器人 将 @钟总 添加为用户」时，
// at 段里既有机器人也有目标，不排除就会把机器人自己当成目标。
//
// 按可靠性从高到低取第一个可用值：
//   1. 文本里直接写的号码        —— 用户意图最明确
//   2. 非机器人的 at 段          —— QQ 自带的真实号码，权威
//   3. 名字（去群成员列表反查）  —— @ 被转成纯文本、号码丢失时的兜底
export function resolveRoleTarget({ text, mentionAts = [], selfId }) {
  const t = (text || "").trim();
  if (!/^将/.test(t)) return null;
  let action;
  if (/添加为\s*用户$/.test(t)) action = "add";
  else if (/移出\s*用户$/.test(t)) action = "remove";
  else return null;

  const number = (v) => {
    const n = Number(v);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  };

  // 1. 文本里直接写的号码（「将 2998981505 添加为用户」）
  const explicit = t.match(/^将\s*(\d{5,12})\b/);
  if (explicit) return { action, qq: number(explicit[1]), name: null };

  // 2. 非机器人的 at 段（@某人 时号码就在手里，不必按名字查）
  const others = mentionAts.filter((a) => {
    const n = number(a?.qq);
    return n !== null && n !== Number(selfId);
  });
  if (others.length) return { action, qq: number(others.at(-1).qq), name: null };

  // 3. 名字兜底：真的 @ 过对方时号码已在 at 段（第 2 步就返回了），
  //    走到这里说明手上只剩一个名字。带不带 @ 符号都按名字去查成员列表——
  //    「将钟总添加为用户」是多数人的自然写法，卡着 @ 不放只会把人推给模型，
  //    白白多烧一轮上下文换一句「请补个 @」。
  const named = t.match(/^将\s*@?([^@\s]{1,24}?)\s*(?:添加为|移出)\s*用户$/);
  if (named) return { action, qq: null, name: named[1] };

  // 意图成立但既没有号码也没有可查的名字（例如「将  添加为用户」），
  // 交给调用方退回模型路径去问清楚。
  return { action, qq: null, name: null };
}

export function shouldHandle(event, config, roles = {}) {
  if (!event || typeof event !== "object") return false;
  if (event.post_type !== "message") return false;

  const userId = Number(event.user_id);
  if (!Number.isSafeInteger(userId) || userId <= 0) return false;
  if (userId === config.selfId) return false;
  if (event.self_id !== undefined && Number(event.self_id) !== config.selfId) return false;

  if (event.message_type === "private") {
    if (!senderRole(userId, config, roles)) return false;
    return true;
  }

  if (event.message_type === "group") {
    if (!config.enableGroups) return false;
    const groupId = Number(event.group_id);
    if (!Number.isSafeInteger(groupId) || groupId <= 0) return false;
    if (config.allowedGroups.length && !config.allowedGroups.includes(groupId)) {
      return false;
    }
    // 私有部署下，群里按发送人角色控制，避免任何群成员都能驱动机器人
    if (!senderRole(userId, config, roles)) return false;
    // 群聊只在真的 @ 了机器人时才响应（at 段 / CQ 码，或文本开头的群昵称）
    if (
      !isBotMentioned(event.message, {
        selfId: config.selfId,
        names: config.groupMentionNames || [],
      })
    ) {
      return false;
    }
    return true;
  }

  return false;
}
