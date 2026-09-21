import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { loadConfig } from "./config.js";
import { OneBotWsClient } from "./onebot.js";
import { runClaude, compactSession, ClaudeError } from "./claude.js";
import { extractText, extractAts, extractFiles, shouldHandle, conversationKey, stripLeadingMention, isBotMentioned, senderRole, resolveRoleTarget, withSenderPrefix, parseResetCommand, parseStatusCommand, senderLabel } from "./message.js";
import { sessionPath, stripImages, truncate, sessionCompleted, readSessionDelta, pendingSummary } from "./session.js";
import { loadRoles, addUser, removeUser, isUser } from "./roles.js";
import { markQueued, markRunning, removePending, loadEntries, setQueueLogger, markNotified } from "./queue.js";

const log = (...args) => console.error("[qq-bot]", ...args);
setQueueLogger((msg) => log(msg));
const roles = { isUser };
const config = loadConfig();

// 会话键统一在这里取，避免各处重复传配置。群聊是否按群共享见 config.groupSharedSession。
const convKey = (event) => conversationKey(event, { groupShared: config.groupSharedSession });

const SESSIONS_PATH = "D:\\QQBOT\\qq-bot\\sessions.json";

function loadSessions() {
  if (!existsSync(SESSIONS_PATH)) return new Map();
  try {
    return new Map(Object.entries(JSON.parse(readFileSync(SESSIONS_PATH, "utf8"))));
  } catch (error) {
    log("读取 sessions.json 失败，从空开始: " + error.message);
    return new Map();
  }
}

const sessions = loadSessions();

// Claude Code 按工作目录划分项目，目录名是把 cwd 的非字母数字字符替换成 "-"
const PROJECT_DIR = config.claudeCwd.replace(/[^A-Za-z0-9]/g, "-");

// 某会话当前对应的磁盘文件。null 表示还没有会话（第一条消息）。
function sessionPathFor(key) {
  const sid = sessions.get(key);
  return sid ? sessionPath(PROJECT_DIR, sid) : null;
}

// 解析本条消息该用什么 sessionId resume，顺带做体积治理。
// 合并打断重跑时要复用它，否则被中断的那次从未把 sessionId 写回 map，
// 重跑就会开一条全新会话，把之前的上下文全丢掉。
function resolveSession(key) {
  let sessionId = sessions.get(key) || null;
  let compactPlan = null;
  if (!sessionId) return { sessionId, compactPlan };

  const prepared = prepareSession(sessionId);
  sessionId = prepared.sessionId;
  if (prepared.compact) compactPlan = { sessionId, sizeMb: prepared.sizeMb };
  if (!sessionId) {
    sessions.delete(key);
    saveSessions();
  }
  return { sessionId, compactPlan };
}

// 在 --resume 之前处理会话体积，三级策略：
//
//   1. 剥离图片 —— 无损，文字上下文完整保留，只是看不到历史图片
//   2. 触发 compact —— 有损但连贯，旧历史折叠成摘要
//   3. 丢弃会话 —— 彻底失忆，最后手段
//
// 为什么需要：QQ 机器人每条消息都 spawn 新进程 + --resume，CLI 的自动压缩
// 触发不了（进程处理完就退出），历史只增不减。
//
// 关于 compact：`claude -p "/compact" --resume <id>` 实测有效，会在会话文件里
// 写入 compact_boundary 标记 + 摘要记录。之后 resume 只加载标记之后的内容
// （实测 input_tokens 从数万降到 5139），**磁盘文件不会变小**。
// 注意 --autocompact 参数在无头 spawn 下实测不生效，别用它。
function prepareSession(sessionId) {
  const path = sessionPath(PROJECT_DIR, sessionId);
  const stripped = stripImages(path);
  if (stripped?.replaced) {
    log(
      `会话 ${sessionId.slice(0, 8)} 剥离 ${stripped.replaced} 处图片: ` +
        `${stripped.beforeMb.toFixed(2)} MB → ${stripped.afterMb.toFixed(2)} MB`,
    );
  }

  let mb;
  try {
    mb = statSync(path).size / 1048576;
  } catch {
    return { sessionId, compact: false }; // 文件不存在，交给 resume 自己处理
  }

  if (mb > config.sessionMaxMb) {
    log(`会话 ${sessionId.slice(0, 8)} 仍达 ${mb.toFixed(2)} MB（上限 ${config.sessionMaxMb} MB），将开新会话`);
    return { sessionId: null, compact: false };
  }

  // 阈值设得比上限低，让压缩有机会在上限之前介入
  if (mb >= config.sessionCompactMb) {
    return { sessionId, compact: true, sizeMb: mb };
  }
  return { sessionId, compact: false };
}

function saveSessions() {
  try {
    writeFileSync(SESSIONS_PATH, JSON.stringify(Object.fromEntries(sessions), null, 2));
  } catch (error) {
    log("写入 sessions.json 失败: " + error.message);
  }
}

const queues = new Map();
let client;

// 每个会话当前在跑什么。key → { what, started }。
//
// 只在**本进程内存**里，不落盘——它的用途是回答「现在在忙什么」和「为什么
// 我的消息还没被处理」，进程一重启这个问题的答案就变成「什么都没在跑」，
// 重启前的状态另有 queue.js 的 pendingRetry 负责，两者职责不重叠。
//
// 登记时机在 markRunning **之后**：先保证崩溃恢复的账本记上了，
// 再对外宣称"在跑"。
const running = new Map();

// 刚收到的文件，等用户说要怎么处理。key → { files: [...], at }。
//
// 为什么需要缓存：QQ 把文件和处理要求拆成**两条独立消息**发（实测：先到
// {"type":"file"}，再到 {"type":"text"}）。文字到达时，文件那条早已处理完，
// 系统里没有任何状态记得它是什么——模型只能回「你说的『这个文件』我这边
// 没有对应的对象」。
//
// 存的是 file_id 而不是下载 URL：实测同一个 file_id 两次解析得到的 URL
// 不同（rkey 会变），存 URL 等到用的时候多半已经失效。
const pendingFiles = new Map();
const PENDING_FILE_TTL_MS = 5 * 60 * 1000;

function rememberFiles(key, files) {
  pendingFiles.set(key, { files, at: Date.now() });
}

// 取走该会话待处理的文件。过期的视为没有——用户隔了半小时才说要怎么处理，
// 那条文件消息早就不在对话上下文里了，默默带上反而莫名其妙。
function takeFiles(key) {
  const entry = pendingFiles.get(key);
  if (!entry) return [];
  pendingFiles.delete(key); // 用掉即清，避免影响后面的无关消息
  if (Date.now() - entry.at > PENDING_FILE_TTL_MS) return [];
  return entry.files;
}

function humanSize(bytes) {
  if (!Number.isFinite(bytes)) return "大小未知";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

// 把文件信息编进 prompt。必须给全 file_id —— 模型靠它调
// get_private_file_url 才能真正把文件取下来，光给文件名它什么也做不了。
function withFiles(text, files) {
  const lines = files.map(
    (f) => `- ${f.name}（${humanSize(f.size)}，file_id: ${f.fileId}）`,
  );
  return (
    `[用户刚发来一个文件，信息如下：\n${lines.join("\n")}\n` +
    `要取文件内容，用 get_private_file_url 传 file_id 拿下载地址，再下载。]\n${text}`
  );
}

// 该会话上还没开始执行的消息条数（不含正在跑的那条）。
//
// 读磁盘而不是内存计数：重启恢复时排队的条目也计入，而内存计数只知道
// 重启之后的事——用户恰恰是在"刚重启、消息还没跑"的时候最需要这个数字。
function queueDepth(key) {
  return loadEntries().filter((e) => e.key === key && e.status === "queued").length;
}

// 重启时留下的、状态未知的消息（key → 原始事件）。
//
// 为什么不自动重放：这些条目被标成 "running"，意味着 claude 可能已经执行了一部分
// ——这台机器上真的会卸载软件、踢人，猜错代价太高。改为让用户回「继续」自行决定。
const pendingRetry = new Map();

// 「继续」= 重放该会话上一条未完成的消息。
//
// 只在**恰好有**待重放条目时拦截。正常开机（干净启动、无 pending）时
// 「继续」就是个普通闲聊词，照常走模型，不会被这里吃掉。
const RETRY_WORDS = new Set(["继续"]);

async function handleRetry(event, text) {
  const key = convKey(event);
  const pending = pendingRetry.get(key);
  if (!pending) return false;

  // 用户可能发「继续」之外的话，那就先消费掉 pending，让消息正常走
  if (!RETRY_WORDS.has(text.trim())) return false;

  const isGroup = event.message_type === "group";
  const userId = Number(event.user_id);
  const reply = async (message) =>
    isGroup
      ? client.action("send_group_msg", {
          group_id: Number(event.group_id),
          message: config.replyToSender ? `[CQ:at,qq=${userId}] ${message}` : message,
        })
      : client.action("send_private_msg", { user_id: userId, message });

  pendingRetry.delete(key);

  // 纵深防御：能进 pendingRetry 的条目其实都已通过 handleMessage 的长度检查
  // （markRunning 在长度检查**之后**才调用，超长消息根本走不到那一步）。
  // 这里再查一次是为了防止将来有人调整检查顺序时悄声失效。
  let pendingText = extractText(pending.message);
  if (isGroup) pendingText = stripLeadingMention(pendingText, config.groupMentionNames);
  if (pendingText.length > config.maxPromptChars) {
    log(`待重放消息超长（${pendingText.length} 字），不再重放`);
    await reply(
      `刚才那条没处理完的消息太长了（${pendingText.length} 字），超过了 ${config.maxPromptChars} 字的限制，没法重放。`,
    ).catch((e) => log("发送超长提示失败: " + e.message));
    return true;
  }

  log(`收到「继续」，重放 ${key} 的未完成消息`);

  try {
    await reply("好，重新执行刚才那条。");
  } catch (error) {
    log("发送「继续」确认失败: " + error.message);
  }

  enqueue(pending, { fromRetry: true });
  return true;
}

function onEvent(event) {
  if (shouldHandle(event, config, roles)) {
    enqueue(event);
  } else if (event?.post_type === "message") {
    // 记录未处理消息的原因，便于排查"机器人为什么不理我"
    const uid = Number(event.user_id);
    if (event.message_type === "group") {
      if (!config.enableGroups) return;
      if (!senderRole(uid, config, roles)) {
        log(`忽略群消息：${uid} 不在角色名单（admin/user）`);
      } else if (
        !isBotMentioned(event.message, {
          selfId: config.selfId,
          names: config.groupMentionNames || [],
        })
      ) {
        log(`忽略群消息：${uid} 未 @ 机器人`);
      }
    } else if (!senderRole(uid, config, roles)) {
      log(`忽略私聊：${uid} 不在角色名单（admin/user）`);
    }
  }
}

// 把名字解析成 QQ 号——**兜底路径**，只在 at 段也没给出号码时才走到这里
// （QQ 把 @ 转成纯文本时号码会彻底消失，只剩昵称）。
//
// 返回 undefined 表示"没解析出来"——调用方据此静默退回模型路径，
// 不要在这里替用户做决定（加错人比不加人严重得多）。
async function resolveMentionedQq({ name, groupId }) {
  const target = String(name || "").trim();
  if (!target) return undefined;
  if (!groupId) {
    log(`无法解析「${target}」：只在群聊里能按昵称查人（私聊没有成员列表）`);
    return undefined;
  }

  let members;
  try {
    const res = await client.action("get_group_member_list", { group_id: groupId });
    members = res?.data;
  } catch (error) {
    log(`查询群成员列表失败: ${error.message}`);
    return undefined;
  }
  if (!Array.isArray(members)) {
    log(`群成员列表返回异常，无法解析「${target}」`);
    return undefined;
  }

  const want = target.toLowerCase();
  const hits = members.filter((m) =>
    [m?.card, m?.nickname].some((v) => typeof v === "string" && v.toLowerCase() === want),
  );
  if (!hits.length) {
    log(`群成员里没有叫「${target}」的人`);
    return undefined;
  }
  if (hits.length > 1) {
    log(`群成员里有 ${hits.length} 个叫「${target}」的，无法确定是哪一个`);
    return undefined;
  }
  return Number(hits[0].user_id);
}

// 精确命令的直连执行通道。返回 true 表示本条消息已被消费，不应再送给模型。
//
// 这条路径不经过模型，直接调 OneBot API。保留它的理由：
async function handleMessage(event, entryId = null) {
  const userId = Number(event.user_id);
  const isGroup = event.message_type === "group";
  const groupId = isGroup ? Number(event.group_id) : null;
  const key = convKey(event);

  let text = extractText(event.message);
  if (isGroup) text = stripLeadingMention(text, config.groupMentionNames);

  // @ 段必须从**原始消息**里取：QQ 转纯文本时昵称只存在于 at 段里，
  // 上面的 extractText + stripLeadingMention 已经把它清掉了。
  const ats = extractAts(event.message);

  // 回复目标：群里回群，私聊回个人
  // 注意：这里走的是原生 OneBot API 名，不是 MCP 工具名。
  // onebot-mcp 会把工具名映射到 API 名（例如工具 send_group_message → API send_group_msg），
  // 直连 WS 时必须用底层名，否则 NapCat 返回 retcode 1404「不支持的API」。
  const reply = async (message) =>
    isGroup
      ? client.action("send_group_msg", {
          group_id: groupId,
          message: config.replyToSender ? `[CQ:at,qq=${userId}] ${message}` : message,
        })
      : client.action("send_private_msg", { user_id: userId, message });

  // 提前返回也必须摘除条目，否则它会永久残留：
  // 每次重启都被当作 queued 重放一遍（角色指令会被重复执行），
  // 且日积月累撑到体积上限，导致整个队列被丢弃、保护彻底失效。
  // 摘除是幂等的，正常路径结尾再摘一次无害。
  const done = () => {
    if (entryId) removePending(entryId);
  };

  // 文件消息：先记住它，等用户下一条说要怎么处理。
  //
  // QQ 把文件和文字拆成两条独立消息发（实测），所以这里必须把 file_id 存下来，
  // 否则下一条文字到达时，「这个文件」在系统里没有任何对应物。存完就返回——
  // 这条消息本身没有可执行的内容。
  const files = extractFiles(event.message);
  if (files.length) {
    const total = files.reduce((s, f) => s + (f.size || 0), 0);
    log(`收到 ${key} 的文件: ${files.map((f) => f.name).join(", ")}（${humanSize(total)}）`);
    rememberFiles(key, files);
    await reply(
      files.length === 1
        ? `已收到「${files[0].name}」（${humanSize(files[0].size)}），要我怎么处理？`
        : `已收到 ${files.length} 个文件（${humanSize(total)}），要我怎么处理？`,
    ).catch((e) => log("发送文件确认失败: " + e.message));
    done();
    return;
  }

  if (!text) {
    log(`来自 ${key} 的消息无文本内容，跳过`);
    done();
    return;
  }

  // 「继续」：重放该会话上一条未完成的消息（重启前被强杀的那条）
  if (await handleRetry(event, text)) {
    done();
    return;
  }

  // 角色管理指令（仅 Admin 可执行）。拦截在模型路径之前：
  // 加人/移除这种权限操作由代码确定性执行，不能交给模型转述
  // （该模型在工具被拒时会"编造"执行结果，例如假装已写入名单）。
  const role = senderRole(userId, config, roles);
  const roleCmd = resolveRoleTarget({
    text,
    mentionAts: ats,
    selfId: config.selfId,
  });
  if (roleCmd) {
    if (role !== "admin") {
      await reply("你没有权限管理用户名单。").catch((e) => log("发送权限提示失败: " + e.message));
      done();
      return;
    }
    const qq = roleCmd.qq ?? (await resolveMentionedQq({ name: roleCmd.name, groupId }));
    if (!qq) {
      log(`无法解析「${roleCmd.name}」的 QQ 号，转交模型处理`);
    } else {
      if (qq === userId || qq === config.selfId) {
        await reply(`${qq} 不需要也不应该进入用户名单。`).catch((e) => log("发送提示失败: " + e.message));
        done();
        return;
      }
      try {
        if (roleCmd.action === "add") {
          const added = addUser(qq);
          await reply(
            added
              ? `已将 ${qq} 添加为用户，ta 现在可以私聊或在群里 @ 我聊天了。`
              : `${qq} 已在用户名单中。`,
          );
        } else {
          const removed = removeUser(qq);
          await reply(removed ? `已将 ${qq} 移出用户名单。` : `${qq} 不在用户名单中。`);
        }
      } catch (error) {
        log(`修改用户名单失败: ${error.message}`);
        await reply(`修改用户名单失败：${String(error.message).slice(0, 120)}`);
      }
      done();
      return;
    }
  }

  // /reset：清空当前会话上下文（仅 admin）。
  //
  // 走代码路径而不是模型路径：共享会话后上下文是全群可见的，重置必须
  // 确定性执行——交给模型转述，它可能只是回一句"已清空"而实际什么都没做。
  //
  // 只删除本地的会话映射，不动会话文件（文件里还有历史，留着不影响：
  // 下一次消息不再 --resume，就是全新上下文）。不删除映射的话，
  // 压缩队列等后台任务仍按旧 sessionId 操作，删映射是最小且可逆的做法。
  if (parseResetCommand(text)) {
    if (role !== "admin") {
      await reply("只有管理员能重置会话上下文。").catch((e) => log("发送权限提示失败: " + e.message));
      done();
      return;
    }
    const had = sessions.delete(key);
    if (had) saveSessions();
    log(`重置会话上下文 ${key}（${had ? "已清除" : "本就没有"}）`);
    await reply(
      had
        ? isGroup
          ? "已清空本群的对话上下文，下一条消息从空白开始。"
          : "已清空对话上下文，下一条消息从空白开始。"
        : "当前没有进行中的会话，本来就是空的。",
    ).catch((e) => log("发送重置提示失败: " + e.message));
    done();
    return;
  }

  // /status：这个会话现在在忙什么、后面排了几条。
  //
  // 也是代码路径。走模型的话，得排在同一条串行队列后面才轮得到它——
  // 而用户问「怎么还没好」的时候，正是队列被占满的时候，等于永远问不出答案。
  //
  // 不限角色：不泄露任何内容，只是排队信息，谁问都一样。
  if (parseStatusCommand(text)) {
    const cur = running.get(key);
    const depth = queueDepth(key);
    const lines = [];
    if (cur) {
      const secs = Math.round((Date.now() - cur.started) / 1000);
      lines.push(`正在执行：${truncate(cur.what, 40)}`);
      lines.push(`已运行 ${secs} 秒${secs > config.timeoutMs / 1000 ? "（已超时，即将被中止）" : ""}`);
    } else {
      lines.push("当前没有正在执行的任务。");
    }
    if (depth) lines.push(`后面还有 ${depth} 条排队。`);
    await reply(lines.join("\n")).catch((e) => log("发送状态失败: " + e.message));
    done();
    return;
  }

  // 带上刚才缓存的文件（用户先转发文件、再说要求时用）。
  //
  // 超长检查必须在 takeFiles **之前**做：takeFiles 是用掉即清，
  // 检查失败时再想放回去就得重新拿，容易写出清空缓存的 bug。
  let effectiveText = text;
  {
    const entry = pendingFiles.get(key);
    const fresh = entry && Date.now() - entry.at <= PENDING_FILE_TTL_MS ? entry.files : [];
    if (fresh.length) {
      effectiveText = withFiles(text, fresh);
      if (effectiveText.length > config.maxPromptChars) {
        // 文件留在缓存里不动——用户下一条大概率仍然指代"这个文件"，
        // 只是这条要求本身太长了。
        await reply(
          `消息太长了（${effectiveText.length} 字，含文件信息），请控制在 ${config.maxPromptChars} 字以内。`,
        );
        done();
        return;
      }
      takeFiles(key); // 长度没问题，正式消费掉
      log(`本条带上 ${fresh.length} 个待处理文件: ${fresh.map((f) => f.name).join(", ")}`);
    }
  }

  if (text.length > config.maxPromptChars) {
    await reply(`消息太长了（${text.length} 字），请控制在 ${config.maxPromptChars} 字以内。`);
    done();
    return;
  }

  // 共享会话里模型只能靠前缀知道是谁在说话。只在群聊加——私聊会话只有一个人。
  const prompt = isGroup && config.senderPrefix ? withSenderPrefix(effectiveText, event) : effectiveText;

  log(`收到 ${key}: ${truncate(prompt, 80)}`);

  // 标记为执行中。此后进程若被强杀，这条会被启动恢复记入 pendingRetry
  // （不自动重放——可能已执行了一部分，交给用户回「继续」决定）。
  if (entryId) markRunning(entryId);

  // 先记崩溃恢复的账（markRunning），再对用户宣称"在跑"。
  running.set(key, { what: prompt, started: Date.now() });


  // 立即回执：声明收到。"防止重复执行"这个承诺是安全的——从此刻起这条消息
  // 就在内存里了，进程不死它就一定会被执行（要么成功要么报错）。
  // 回执：到点还没跑完才发。跑完了就不发——秒回的闲聊因此不会多出一句
  // 啰嗦的「收到」。
  //
  // depth 要减 1：排队命令在上一轮末才发起，任务跑得快时它很可能还没返回，
  // 队列里仍有本条自己，不减就会把"自己"算成"正在排队"。
  let ackTimer = null;
  let ackSent = null; // 回执发送的 Promise，收尾时要等它落地
  if (config.ackMessage) {
    const who = senderLabel(event);
    ackTimer = setTimeout(() => {
      const depth = Math.max(0, queueDepth(key) - 1);
      const text = isGroup
        ? `收到${who ? `，${who}` : ""}，正在处理…${depth ? `（后面还有 ${depth} 条排队）` : ""}`
        : `收到，正在处理…${depth ? `（后面还有 ${depth} 条排队）` : ""}`;
      ackSent = reply(text)
        .then((sent) => {
          if (sent?.status !== "ok") log(`发送回执失败: ${JSON.stringify(sent)}`);
        })
        .catch((e) => log("发送回执失败: " + e.message));
    }, config.ackDelayMs);
  }

  // 任务收尾：停掉还没触发的回执，并等已发出的那条落地。
  //
  // 只 clearTimeout 不够——定时器可能刚触发、回执还在发送途中，不等它就发结果，
  // 「正在处理」会落在结果之后，看起来像机器人失忆了。（等它的代价很小：
  // 结果是本地的 WS 调用，通常几毫秒。）
  //
  // 结果消息**不再**附「（回 X）」——群里回复本来就用 @ 指明了对象
  // （replyToSender），再加一句只是重复。
  const settle = async () => {
    if (ackTimer) clearTimeout(ackTimer);
    ackTimer = null;
    if (ackSent) await ackSent;
  };

  const invoke = (sessionId) =>
    runClaude({
      exePath: config.claudeExe,
      baseUrl: config.claudeBaseUrl,
      authToken: config.claudeAuthToken,
      homeDir: config.claudeHome,
      cwd: config.claudeCwd,
      mcpConfigPath: config.claudeMcpConfig,
      prompt,
      sessionId,
      allowedTools: config.allowedTools,
      timeoutMs: config.timeoutMs,
      mcpTimeoutMs: config.mcpTimeoutMs,
      role,
      model: config.claudeModel,
    });

  let result;
  const started = Date.now();
  let attempt = 0;
  const maxAttempts = 1 + Math.max(0, config.retryCount);
  let compactPlan = null;

  while (attempt < maxAttempts && !result) {
    attempt += 1;
    const resolved = resolveSession(key);
    const sessionId = resolved.sessionId;
    if (resolved.compactPlan) compactPlan = resolved.compactPlan;

    try {
      result = await invoke(sessionId);
    } catch (error) {
      const detail = error instanceof ClaudeError ? error.message : String(error);
      log(`第 ${attempt}/${maxAttempts} 次尝试失败: ${detail}`);
      if (error instanceof ClaudeError && error.raw) {
        log(`原始输出: ${error.raw}`);
      }

      // 会话损坏时清掉映射，下次走全新会话，避免反复撞同一堵墙
      const isSessionFailure =
        sessions.has(key) && /session|resume|corrupt|invalid/i.test(detail);
      if (isSessionFailure) {
        log(`会话 ${sessions.get(key)} 疑似失效，已清除`);
        sessions.delete(key);
        saveSessions();
      }

      if (attempt >= maxAttempts) {
        log(`处理失败: ${detail}`);
        running.delete(key);
        await settle();
        await reply(`抱歉，处理出错了：${detail.slice(0, 120)}`).catch((e) =>
          log("发送错误提示失败: " + e.message),
        );
        done();
        return;
      }
    }
  }

  if (result.sessionId) {
    sessions.set(key, result.sessionId);
    saveSessions();
  }

  // 处理完成，从磁盘队列摘除。放在发送**之前**是有意的：
  // 若发送成功但摘除失败，重启后这条仍是 running → 进 pendingRetry，
  // 最多让用户回一次「继续」重放；反过来则会重复发送。
  done();
  running.delete(key);

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  await settle();
  log(`回复 ${key}（${elapsed}s, $${result.cost.toFixed(4)}）: ${truncate(result.text, 80)}`);

  // 超长回复不能整条发出去：QQ 侧会被静默拒收（retcode 会报 10062 之类的
  // 参数错误），用户只看到一句回执、等不到结果。这里明确降级并告知。
  //
  // 用 Array.from 按码点算长度：模型爱用 emoji，而 QQ 的长度限制也按字符算。
  const len = Array.from(result.text).length;
  const sent = await reply(
    len > config.maxReplyChars
      ? Array.from(result.text).slice(0, config.maxReplyChars).join("") +
          `\n\n（回复太长被截断，共 ${len} 字）`
      : result.text,
  );
  if (sent?.status !== "ok") {
    log(`发送失败: ${JSON.stringify(sent)}`);
  }

  // 压缩放到回复之后，且不 await —— 大会话要几分钟，不能让用户干等。
  // 先告诉用户下一条会慢，否则看起来就像卡住了。
  if (compactPlan) {
    log(`会话 ${compactPlan.sessionId.slice(0, 8)} 达 ${compactPlan.sizeMb.toFixed(2)} MB，后台开始压缩`);
    await reply(
      "（本轮上下文较大，正在后台整理历史，**下一条回复可能会明显变慢**，请耐心等一下）",
    ).catch((e) => log("发送压缩提示失败: " + e.message));

    runCompaction(key, compactPlan.sessionId);
  }
}

function runCompaction(key, sessionId) {
  compactSession({
    exePath: config.claudeExe,
    baseUrl: config.claudeBaseUrl,
    authToken: config.claudeAuthToken,
    homeDir: config.claudeHome,
    cwd: config.claudeCwd,
    sessionId,
    timeoutMs: config.compactTimeoutMs,
    model: config.claudeModel,
  })
    .then((r) => {
      log(
        `会话 ${sessionId.slice(0, 8)} 压缩完成（${(r.durationMs / 1000).toFixed(0)}s, $${r.cost.toFixed(4)}）`,
      );
    })
    .catch((error) => {
      // 压缩失败不影响对话本身，下一轮还会再次尝试，所以只记日志
      log(`会话 ${sessionId.slice(0, 8)} 压缩失败: ${error.message}`);
    });
}

function enqueue(event, { fromRetry = false } = {}) {
  const key = convKey(event);

  // 入队即落盘：pm2 用 taskkill /F 强杀（不发信号），这一步是「消息已收到」
  // 唯一的持久化机会。重放不计入队列，否则「继续」会让条目反复堆积。
  //
  // 必须按**条目**（id）而非按 key 追踪：同一会话可能积压多条（用户连发），
  // 同一时刻只有队首在执行；按 key 标记会把整批都标成执行中，
  // 让从未执行过的后续消息在恢复时被误判为「状态未知」而不能自动重放。
  const entryId = fromRetry ? null : markQueued(key, event);

  const prev = queues.get(key) || Promise.resolve();
  const next = prev
    .then(() => handleMessage(event, entryId))
    .catch((error) => log());
  queues.set(key, next);
  next.finally(() => {
    if (queues.get(key) === next) queues.delete(key);
  });
}

client = new OneBotWsClient({
  url: config.wsUrl,
  token: config.wsToken,
  onLog: log,
  onEvent,
});

log(
  `启动: bot=${config.selfId} 角色管理=开` +
    ` admin=[${config.allowedSenders.join(",") || "无(全部按 admin)"}]` +
    ` user=[${loadRoles().users.join(",") || "无"}]` +
    ` 群聊=${config.enableGroups ? "开" : "关"}${config.enableGroups ? `(群白名单=[${config.allowedGroups.join(",") || "全部"}], 会话=${config.groupSharedSession ? "按群共享" : "按群+人隔离"})` : " "}` +
    ` 回执=${config.ackMessage ? `开(延迟${config.ackDelayMs / 1000}s)` : "关"}` +
    ` 工具数=${config.allowedTools.split(",").length} 超时=${config.timeoutMs / 1000}s`,
);

// 恢复上次进程留下的队列。
//
//   queued  → 进程在标 running 之前就死了，确定没执行过，直接重放
//   running → 可能已执行一部分，不自动重放；告知用户可回「继续」自行决定
//
// 通知回复要在 ws 连上之后才能发，所以这里先收集，等连接就绪再发。
// 等 ws 连上再发。启动几毫秒内连接未必就绪，而恢复通知只在启动时发一次，
// 错过了就永远不发了。
async function sendWhenConnected(action, params, tries = 20, gapMs = 250) {
  for (let i = 0; i < tries; i++) {
    try {
      return await client.action(action, params);
    } catch (error) {
      if (!/未连接/.test(error.message) || i === tries - 1) throw error;
      await new Promise((r) => setTimeout(r, gapMs));
    }
  }
}

async function restoreQueue() {
  const entries = loadEntries();
  if (!entries.length) return;

  const queued = entries.filter((e) => e.status === "queued");
  const interrupted = entries.filter((e) => e.status === "running");
  // "notified" 是终态：用户已经被告知过，还没回「继续」。不再重复通知——
  // 否则每次重启都对着同一批消息唠叨一遍（实测被烦了两次才发现）。
  const waiting = entries.filter((e) => e.status !== "queued" && e.status !== "running");
  if (waiting.length) {
    log(`${waiting.length} 条消息在等用户回「继续」，不再重复通知`);
  }

  for (const e of queued) {
    log(`恢复未处理消息 ${e.key}: ${truncate(extractText(e.event.message), 60)}`);
    enqueue(e.event, { fromRetry: true });
  }

  for (const e of interrupted) {
    // 先确认这轮**真的**没跑完。status=running 只说明"没来得及从队列摘除"，
    // 而进程被强杀时，绝大多数任务其实已经在会话文件里跑完了（结果都发出去了）。
    // 无脑通知会让每次重启都误报一次，用户很快就不看了，真正的丢消息反被淹没。
    const sid = sessions.get(e.key);
    const completed = sid
      ? sessionCompleted(sessionPath(PROJECT_DIR, sid))
      : null;
    if (completed === true) {
      log(`丢弃 ${e.key} 的残留条目：会话里这轮已经跑完（结果早已发出）`);
      removePending(e.id);
      continue;
    }

    pendingRetry.set(e.key, e.event);

    // 断在哪一步：会话里悬空的工具调用。光说"没处理完"用户没法判断
    // 该不该回「继续」，列出最后几步它才有依据——尤其那种"改到一半停下"的任务。
    const detail = sid
      ? pendingSummary(readSessionDelta(sessionPath(PROJECT_DIR, sid)))
      : "";

    const isGroup = e.event.message_type === "group";
    const message = `刚才那条消息没处理完（我重启过）${detail}\n回「继续」我就重新执行它。`;
    const params = isGroup
      ? { group_id: Number(e.event.group_id), message }
      : { user_id: Number(e.event.user_id), message };
    // 先标记再发送：反过来的话，卡在两者之间被强杀，下次启动还会再通知一遍
    markNotified(e.id);
    try {
      const sent = await sendWhenConnected(isGroup ? "send_group_msg" : "send_private_msg", params);
      if (sent?.status !== "ok") log(`发送恢复提示失败: ${JSON.stringify(sent)}`);
      else log(`已告知 ${e.key} 可回「继续」重放`);
    } catch (error) {
      log(`发送恢复提示失败: ${error.message}`);
    }
  }
}

client.connect();
restoreQueue().catch((error) => log(`队列恢复失败: ${error.message}`));

function shutdown(signal) {
  log(`收到 ${signal}，退出中`);
  client.close();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
