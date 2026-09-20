export function extractText(message) {
  if (typeof message === "string") {
    return message
      .replace(/\[CQ:at,[^\]]+\]/g, "")
      .replace(/\[CQ:[^\]]+\]/g, "")
      .trim();
  }
  // 数组格式：只取 text 段，@ 段天然被忽略
  if (Array.isArray(message)) {
    return message
      .filter((seg) => seg?.type === "text")
      .map((seg) => seg.data?.text || "")
      .join("")
      .trim();
  }
  return "";
}

// 对话隔离键。群聊必须按「群 + 人」区分，否则同一群里所有人共用
// 一个 Claude 会话，A 的对话会作为上下文出现在 B 的回复里。
export function conversationKey(event) {
  if (event.message_type === "group") {
    return `${event.group_id}:${event.user_id}`;
  }
  return `private:${event.user_id}`;
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

export function shouldHandle(event, config) {
  if (!event || typeof event !== "object") return false;
  if (event.post_type !== "message") return false;

  const userId = Number(event.user_id);
  if (!Number.isSafeInteger(userId) || userId <= 0) return false;
  if (userId === config.selfId) return false;
  if (event.self_id !== undefined && Number(event.self_id) !== config.selfId) return false;

  if (event.message_type === "private") {
    if (config.allowedSenders.length && !config.allowedSenders.includes(userId)) {
      return false;
    }
    return true;
  }

  if (event.message_type === "group") {
    if (!config.enableGroups) return false;
    const groupId = Number(event.group_id);
    if (!Number.isSafeInteger(groupId) || groupId <= 0) return false;
    if (config.allowedGroups.length && !config.allowedGroups.includes(groupId)) {
      return false;
    }
    // 私有部署下，群里按发送人白名单控制，避免任何群成员都能驱动机器人
    if (config.allowedSenders.length && !config.allowedSenders.includes(userId)) {
      return false;
    }
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
