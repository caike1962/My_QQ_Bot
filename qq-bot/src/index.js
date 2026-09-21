import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { loadConfig } from "./config.js";
import { OneBotWsClient } from "./onebot.js";
import { runClaude, compactSession, ClaudeError } from "./claude.js";
import { extractText, extractAts, shouldHandle, conversationKey, stripLeadingMention, isBotMentioned, senderRole, resolveRoleTarget, withSenderPrefix, parseResetCommand } from "./message.js";
import { sessionPath, stripImages, truncate } from "./session.js";
import { loadRoles, addUser, removeUser, isUser } from "./roles.js";
import { markQueued, markRunning, removePending, loadEntries, setQueueLogger } from "./queue.js";

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

  if (text.length > config.maxPromptChars) {
    await reply(`消息太长了（${text.length} 字），请控制在 ${config.maxPromptChars} 字以内。`);
    done();
    return;
  }

  // 共享会话里模型只能靠前缀知道是谁在说话。只在群聊加——私聊会话只有一个人。
  const prompt = isGroup && config.senderPrefix ? withSenderPrefix(text, event) : text;

  log(`收到 ${key}: ${truncate(prompt, 80)}`);

  // 标记为执行中。此后进程若被强杀，这条会被启动恢复记入 pendingRetry
  // （不自动重放——可能已执行了一部分，交给用户回「继续」决定）。
  if (entryId) markRunning(entryId);

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
    let sessionId = sessions.get(key) || null;
    if (sessionId) {
      const prepared = prepareSession(sessionId);
      sessionId = prepared.sessionId;
      if (prepared.compact) compactPlan = { sessionId, sizeMb: prepared.sizeMb };
      if (!sessionId) {
        sessions.delete(key);
        saveSessions();
      }
    }

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

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  log(`回复 ${key}（${elapsed}s, $${result.cost.toFixed(4)}）: ${truncate(result.text, 80)}`);

  const sent = await reply(result.text);
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

  const prev = queues.get(key) || Promise.resolve();  const next = prev
    .then(() => handleMessage(event, entryId))
    .catch((error) => log(`处理异常: ${error.stack || error.message}`));
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
    ` 群聊=${config.enableGroups ? "开" : "关"}${config.enableGroups ? `(群白名单=[${config.allowedGroups.join(",") || "全部"}], 会话=${config.groupSharedSession ? "按群共享" : "按群+人隔离"})` : ""} ` +
    `工具数=${config.allowedTools.split(",").length} 超时=${config.timeoutMs / 1000}s`,
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
  const interrupted = entries.filter((e) => e.status !== "queued");

  for (const e of queued) {
    log(`恢复未处理消息 ${e.key}: ${truncate(extractText(e.event.message), 60)}`);
    enqueue(e.event, { fromRetry: true });
  }

  for (const e of interrupted) {
    pendingRetry.set(e.key, e.event);
    const isGroup = e.event.message_type === "group";
    const params = isGroup
      ? { group_id: Number(e.event.group_id), message: "刚才那条消息没处理完（我重启过），回「继续」我就重新执行它。" }
      : { user_id: Number(e.event.user_id), message: "刚才那条消息没处理完（我重启过），回「继续」我就重新执行它。" };
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
