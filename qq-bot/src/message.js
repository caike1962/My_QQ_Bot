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

// 该不该给这条消息贴「处理中」表情。返回要贴的 message_id，不贴则 null。
//
// 判据全是"贴了会出错或没意义"的硬条件，**不判当前忙不忙**——排队中的消息
// 恰恰最需要这个反馈，那正是调用点（enqueue）要它的原因。
//
// 放在 message.js 而不是 index.js：它是个纯判据，而 index.js 一 import 就会
// 连 NapCat，放那里就没法在不启动守护进程的前提下测。
export function reactionEmojiFor(event) {
  // 非群聊直接排除：贴表情是群聊专属形式（onebot-mcp 里那个工具就叫
  // set_group_reaction），私聊的示意是文字回执。
  if (event?.message_type !== "group") return null;

  // 表情挂在原消息上，没有 id 就无处可贴。message_id 是 OneBot 11 对群消息
  // 的标准字段，NapCat 实测为数字（且与 message_seq / real_id 同值）。
  // 用 undefined/null 判缺失而不是 falsy——0 也是合法 id。
  if (event.message_id === undefined || event.message_id === null) return null;

  const raw = String(event.raw_message ?? "").trim();
  // 空消息（纯图片、纯文件）没有"处理中"可言，贴了反而把它标记成一条
  // 等待回答的提问。
  if (!raw) return null;
  // 纯表情消息不该再贴一个——那本身就是表情，等于刷屏。
  //
  // 判据是把 CQ 码整个剥掉之后**还有没有真实文字**，而不是"含不含 face"：
  // 「[CQ:face,id=14] 这个怎么弄」里那句提问才是主体，按包含判断会把它
  // 一起漏掉，而那正是最需要示意的消息。同理「[CQ:image,...] 看下这个」
  // 也该贴。
  const textOnly = raw.replace(/\[CQ:[^\]]*\]/g, "").trim();
  if (!textOnly) return null;

  return String(event.message_id);
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

// 发送者角色：admin（QQ_ALLOWED_SENDERS，现状语义不变）、user（roles.json 的 users 名单）、
// robot（roles.json 的 robots 名单——对方也是个机器人，走受限会话 + 收尾即静默）、null（陌生人）。
// 兼容遗留语义：allowedSenders 为空（= 不限制）时一律按 admin 处理。
//
// 不传 roles.isRobot 的调用点（测试夹具就是这种）会自然退回 user 行为，不会误判成机器人。
export function senderRole(userId, config, roles = {}) {
  const id = Number(userId);
  if (config.allowedSenders.length) {
    if (config.allowedSenders.includes(id)) return "admin";
    if (roles.isRobot?.(id)) return "robot";
    return roles.isUser?.(id) ? "user" : null;
  }
  return "admin";
}

// ---- 收尾哨兵（<<END>> / <<KEEP>>）----
//
// 机器人角色专用。对方是另一个机器人时，典型的坑是它被设成"必须提问/必须回复"，
// 于是两边一问一答永远停不下来。判据交给模型（关键词命中太容易误判），
// 但模型得有一条能传给代码的信号通道——就是在回复末尾原样写出这个哨兵。
//
// 哨兵必须满足两点：模型不会自然地写出它（所以用带尖括号的 ASCII 串，
// 而不是「再见」这类词），以及出现在**末尾**才算数（正文中间提到哨兵本身
// ——比如两个机器人在讨论本机制——不该触发收尾）。
//
// 两个方向各一个标记：END=该收尾了，KEEP=还有实质内容、继续聊。
// KEEP 的存在是为了让"收到含标记的历史消息"这种边界有确定行为：
// 模型引用某个标记时能顺手声明"这只是引用"，而不是靠代码去猜它的意图。
//
// 用 `<<END>>` 而不是 HTML 注释：它更短、令牌更省，且回复走 HTML 文件
// 那一路时不会在渲染层被注释掉。

// ---- 收尾哨兵（<<END>> / <<KEEP>>）----
//
// 机器人角色专用。对方是另一个机器人时，典型的坑是它被设成"必须提问/必须回复"，
// 于是两边一问一答永远停不下来。判据交给模型（关键词命中太容易误判），
// 但模型得有一条能传给代码的信号通道——就是在回复末尾原样写出这个哨兵。
//
// 哨兵必须满足两点：模型不会自然地写出它（所以用带尖括号的 ASCII 串，
// 而不是「再见」这类词），以及出现在**末尾**才算数（正文中间提到哨兵本身
// ——比如两个机器人在讨论本机制——不该触发收尾）。
//
// 两个方向各一个标记：END=该收尾了，KEEP=还有实质内容、继续聊。
// KEEP 的存在是为了让"收到含标记的历史消息"这种边界有确定行为：
// 模型引用某个标记时能顺手声明"这只是引用"，而不是靠代码去猜它的意图。
//
// 用 `<<END>>` 而不是 HTML 注释：它更短、令牌更省，且回复走 HTML 文件
// 那一路时不会在渲染层被注释掉。
export const SILENT_END_MARK = "<<END>>";
export const SILENT_KEEP_MARK = "<<KEEP>>";

// 标记必须在行尾。模型写进一行中间时（引用、代码块里演示），
// 那多半是在谈论机制而不是执行机制，锚定到行尾能挡掉这类误判。
function markerAtEnd(raw, mark) {
  const literal = mark.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${literal}[ \\t]*\\s*$`).test(raw);
}

// 给模型看的说明在 claude.js，这里只管判据，两边共用一个常量避免写岔。
//
// 剥除是全局的（标记写在哪里都拿掉），触发判定是锚定的：
// 若模型把标记写在开头又写了正文，那是它没听懂，此时**不该**停机——
// 停机的代价是"以后再不理对方"，宁可漏判一次让它多聊一轮。
// 同理，末尾是 KEEP 时一律不停（覆盖"中间提过 END、末尾声明继续"的写法）。
//
// 刻意**不导出**：调用方只需知道"这轮要不要收尾"+"干净正文是什么"，
// 把两个标记暴露出去只会诱使别处各写一份判据。
export function parseSilentEnd(text) {
  const raw = String(text ?? "");
  const end = markerAtEnd(raw, SILENT_END_MARK) && !markerAtEnd(raw, SILENT_KEEP_MARK);
  return { end, text: stripSilentEnd(raw) };
}

// 剥掉全部标记及其独占的空白行。历史渲染、以及发给用户的正文都要过这一道：
// 哨兵绝不该出现在任何给人看、给模型读的文本里。
//
// 先按行处理去掉"整行只有标记"的行，再对行内残留做兜底剥离——
// 后者只在模型没按格式写时才会命中，兜底掉比把它原样发给对方好。
export function stripSilentEnd(text) {
  return String(text ?? "")
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return t !== SILENT_END_MARK && t !== SILENT_KEEP_MARK;
    })
    .join("\n")
    .replace(/<<END>>|<<KEEP>>/g, "")
    .trim();
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

// ---- 机器人名单管理指令 ----
//
// 两种写法，对应两个真实需求：
//
//   1. 声明式「将 <目标> 添加为机器人」——人在群里、手上有号码或 at 段，
//      与「将 X 添加为用户」保持一致的语法，不让人记第二套。这种交给
//      index.js 复用 resolveMentionedQq 的三级解析（号码 → at 段 → 名字）。
//   2. 表单式「/机器人 列表 | 添加 123 | 暂停 123 | 恢复 123」——管理的是
//      状态而不是成员，手上有号码时写成一行最短。
//
// 两条都不带号码目标时（如「/机器人 暂停」）返回 null 交给模型去问清楚：
// 返回一个 qq=null 的 pause 让下游去猜要暂停谁，比多烧一轮上下文危险得多。
//
// 为什么另开 /解除 而不是只给「/机器人 恢复」：机器人被静默后可能在任何会话里
// 继续发消息，admin 未必记得号码。不带参数的 /解除 扫当前会话，把里面所有暂停
// 的机器人都放出来——这是"救回来"这个动作最短的路径，也是收尾提示里给对方的写法。
const ROBOT_ADD_VERBOSE_RE = /^将\s*(?:(\d{5,12})\b|@?([^@\s]{1,24}?))\s*添加为\s*机器人$/;
const ROBOT_DEL_VERBOSE_RE = /^将\s*(?:(\d{5,12})\b|@?([^@\s]{1,24}?))\s*移出\s*机器人$/;

// `/解除`、`/解除 123456` 都认。
const UNPAUSE_RE = /^\/解除(?:\s+(\d{5,12}))?$/;

export function resolveRobotCommand({ text } = {}) {
  const t = (text || "").trim();
  if (!t) return null;

  const unpause = t.match(UNPAUSE_RE);
  if (unpause) return { form: "verbose", action: "unpause", qq: unpause[1] ? Number(unpause[1]) : null };

  const form = t.match(/^\/机器人\s*(.*)$/);
  if (form === null) {
    // 声明式：与「将 X 添加为用户」同款，号码与名字两种写法。
    // 路由走 target 表（由 index.js 复用 resolveMentionedQq 按名字反查号码），
    // 与 /机器人 添加 <号> 这种手上有号码的表单式分开。
    let m = t.match(ROBOT_ADD_VERBOSE_RE);
    if (m) return { form: "target", action: "add", qq: m[1] ? Number(m[1]) : null, name: m[2] || null };
    m = t.match(ROBOT_DEL_VERBOSE_RE);
    if (m) return { form: "target", action: "remove", qq: m[1] ? Number(m[1]) : null, name: m[2] || null };
    return null;
  }

  const body = form[1].trim();
  if (body === "" || body === "列表") return { form: "list", action: "list", qq: null };

  const verb = body.match(/^(暂停|恢复|添加|移出)(?:机器人)?\s+(\d{5,12})$/);
  if (verb) {
    const map = { 暂停: "pause", 恢复: "resume", 添加: "add", 移出: "remove" };
    return { form: "verbose", action: map[verb[1]], qq: Number(verb[2]) };
  }

  // 「/机器人 暂停」这种漏了号码的写法不认——交给模型去问清楚，
  // 比返回一个 qq=null 的 pause 让它去猜要安全。
  return null;
}

// 已暂停的机器人还允许走完的消息：/解除（唯一的救回手段）与 /status（"现在
// 到底怎么了"——机器人被静默了总得能问一句）。两者各自的 admin 闸门都在
// 更下游，放它们过来不会绕过权限。
export function isPausedBypassCommand(text) {
  const t = (text || "").trim();
  return UNPAUSE_RE.test(t) || /^\/(?:status|状态)$/.test(t);
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
