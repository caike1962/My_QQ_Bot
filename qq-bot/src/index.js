import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, readSync, closeSync, openSync } from "node:fs";
import { loadConfig } from "./config.js";
import { OneBotWsClient } from "./onebot.js";
import { runClaude, compactSession, ClaudeError, liveProcs } from "./claude.js";
import { extractText, extractAts, extractFiles, shouldHandle, conversationKey, stripLeadingMention, isBotMentioned, senderRole, resolveRoleTarget, withSenderPrefix, parseResetCommand, parseStatusCommand, parseDiagnosticCommand, senderLabel } from "./message.js";
import { sessionPath, stripImages, truncate, sessionCompleted, readSessionDelta, pendingSummary, sessionLineCount, lastRecordType, decideRecovery } from "./session.js";
import { loadRoles, addUser, removeUser, isUser } from "./roles.js";
import { markQueued, markRunning, removePending, loadEntries, setQueueLogger, markNotified, markMerging, markMergingAborted, markBaseline } from "./queue.js";
import { shouldInterrupt, mergePrompt } from "./interrupt.js";
import { parseReminder } from "./reminders.js";
import { startScheduler, loadJobs, addJob, removeJobByIndex } from "./scheduler.js";
import { buildDiagnostic } from "./diagnostics.js";

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

// 每个会话的执行者。key → { controller, event, entryId, prompt, startedAt, baseline }
//
// 为什么不能再用 promise 链：合并打断需要**替换队首**——杀掉当前正在跑的
// 进程、把两条消息合成一条重新执行。promise 链只能追加，无法取消队首。
//
// baseline.lines 是本条消息开始执行时会话文件的行数，合并判据拿它做比对
// （相等 = 一个工具都没调过）。null 表示锚点还没建立。
const execs = new Map();
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

// ———— /诊断 的数据采集 ————
//
// 要回答的问题（「为什么没回复」「是不是卡住了」「队列里有没有残留」）
// 全都依赖只在内存里活着的东西：进程年龄、队列条目时间、最后一条消息何时到。
// 所以采集点散布在各条主路径上。真正的结论来自磁盘上的会话记录——
// 内存态只能证明"进程在跑"，证明不了"它跑到哪了"。

const BOOT_AT = Date.now();
const QUEUE_PATH = process.env.QQBOT_QUEUE || "D:\\QQBOT\\qq-bot\\queue.json";

// 本会话最后一次收到消息的时刻。容量上限防止群多时无限增长。
const recent = new Map();
const RECENT_MAX = 10;

// 自启动以来处理完的正常消息条数。命令类消息不计入——这个数的用途是
// 判断"消息整体在流动吗"，把命令混进去只会冲淡信号。
let doneSinceBoot = 0;
let lastRecvAt = null;

// 正在后台压缩的会话：key → { sessionId, startedAt }。
//
// 为什么要单独记：压缩是几分钟的后台任务，期间该会话的下一条消息会明显变慢。
// 没有这份记录的话，那几分钟里的诊断只会显示一个空白的【执行】节，
// 而用户问的恰恰是"怎么这么慢"。
const compacting = new Map();

// 正在生成的诊断。诊断要花几百毫秒（查群成员 + 读会话文件 + 探代理），
// 这个窗口内用户再发一条就会各生成一份——实测同一秒内发两次诊断，
// 群里会收到两条几乎一样的报告，看起来像机器人失控。
let diagnosing = false;

function noteRecv(key, text) {
  lastRecvAt = Date.now();
  recent.set(key, { key, text, at: lastRecvAt });
  if (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value);
}

// 每次 /诊断 要查一遍群人数（「是不是别人把队列占住了」的第一反应），
// 但说话多的人会连着问好几次，所以按 60s 缓存。
const groupSizeCache = new Map();
const GROUP_SIZE_TTL_MS = 60_000;

// 会话文件尾部存着最近的真实活动。只读末尾 64 KB：诊断是即时命令，
// 而会话文件可能几 MB，不值得整个读一遍。读到的第一行可能是被切开的
// 半截 JSON，parse 失败会被跳过——这正是能接受的，尾部记录才是我们要的。
//
// 顺带把 statSync 拿到的体积返回出去：调用方要显示会话大小，
// 再单独 statSync 一次就是白扔的 syscall（实测每会话能省一次 open+stat）。
function readTailRecords(path, bytes = 65536, max = 40) {
  let fd;
  try {
    const size = statSync(path).size;
    if (!size) return null;
    const start = Math.max(0, size - bytes);
    fd = openSync(path, "r");
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const out = [];
    for (const line of buf.toString("utf8").split("\n")) {
      try {
        out.push(JSON.parse(line));
      } catch {
        /* 被切开的半截行 */
      }
    }
    const records = out.filter((r) => r && typeof r === "object").slice(-max);
    // sizeMb 挂在数组上而不是包一层对象：调用方大半只关心记录本身，
    // 多一层解构会让每个使用点都变啰嗦。
    records.sizeMb = size / 1048576;
    return records;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* 关不上也不该让诊断失败 */
      }
    }
  }
}

// 从会话记录里挑出最后一次真实对话。
//
// 过滤规则都是实测踩出来的：tool_result 也以 type:"user" 落盘、本地命令
// 落盘时整段包在 <command-name> 里、系统注入的提示以 < 开头。
// 把这些当"用户最后说的话"会让诊断指向错误的方向。
//
// 顺带从同一批记录里带出模型名：CLI 每一轮 assistant 都会重写 message.model，
// 所以它几乎总在尾部窗口内。这样就不必再调 sessionModel 把整个文件读一遍
// （实测 2 MB 会话全读要 7ms，而这里等于 0）。
function lastExchange(records) {
  if (!records?.length) return null;

  const textOf = (rec) => {
    const content = rec?.message?.content;
    if (typeof content === "string") return content.trim();
    if (!Array.isArray(content)) return "";
    return content
      .filter((b) => b?.type === "text")
      .map((b) => b.text || "")
      .join(" ")
      .trim();
  };

  let said = null;
  for (const rec of records) {
    if (rec?.type !== "user" || rec.isMeta || rec.toolUseResult !== undefined) continue;
    const text = textOf(rec);
    if (!text || text.startsWith("<")) continue;
    said = { text, at: Date.parse(rec.timestamp) };
  }

  let replied = null;
  let model = null;
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i];
    // 模型名和"最后一句回复"分开找：回复可能来自更早的那条 assistant，
    // 而模型名取最新的那条即可。
    if (!model && typeof rec?.message?.model === "string" && rec.message.model) {
      model = rec.message.model;
    }
    if (rec?.type !== "assistant") continue;
    if (!replied) {
      const text = textOf(rec);
      if (text) replied = { text, at: Date.parse(rec.timestamp) };
    }
    if (replied && model) break;
  }

  return said || replied || model ? { said, replied, model } : null;
}

function workspaceStatus() {
  const p = config.claudeCwd ? `${config.claudeCwd}\\workspace` : null;
  if (!p) return null;
  const fallback = "D:\\QQBOT\\qq-bot\\workspace";
  const dir = existsSync(p) ? p : fallback;
  if (!existsSync(dir)) return "不存在";
  try {
    const names = readdirSync(dir);
    return names.length ? `${names.length} 个文件` : "空";
  } catch {
    return "读取失败";
  }
}

// 子进程列表，直接就是渲染层要的形状。已跑完的记录只在「刚跑完」时才有
// 参考价值——正常时刻这一节本该是空的，跑完即摘除的进程出现在诊断里
// 只会制造噪音（"它跑过"这件事，会话文件里的记录说得更清楚）。
//
// liveProcs() 返回的已经是浅拷贝，不必再手工重列一遍字段。
function liveProcessSnapshot(now) {
  return liveProcs().filter((p) => !p.done || now - p.startedAt < 60_000);
}

async function groupMemberCount(groupId) {
  const cached = groupSizeCache.get(groupId);
  if (cached && Date.now() - cached.at < GROUP_SIZE_TTL_MS) return cached.n;
  try {
    const res = await client.action("get_group_member_list", { group_id: groupId });
    const n = Array.isArray(res?.data) ? res.data.length : null;
    groupSizeCache.set(groupId, { n, at: Date.now() });
    return n;
  } catch (error) {
    log(`诊断：查群 ${groupId} 成员数失败: ${error.message}`);
    return null;
  }
}

function fileSizeMb(path) {
  try {
    return statSync(path).size / 1048576;
  } catch {
    return null;
  }
}

// 渲染用的时间轴：会话文件里的记录时间戳是 ISO 字符串，比内存里记的
// "收到时刻"更权威（重启后内存就没了，磁盘上的还在）。
// 解析失败的记录（时间是空的）直接跳过——宁可不显示，也不显示一个 1970 年。
function atTime(t) {
  const n = Date.parse(t);
  return Number.isFinite(n) ? n : null;
}

async function collectDiagnostic(mergeWindowMs) {
  const now = Date.now();

  // 代理探测**先发出去**、最后再 await：它带 2s 超时，而下面全是同步的文件 IO。
  // 顺序执行的话这 2s 是纯叠加；并发出去之后它就躲在文件读取后面，代价归零。
  // cc-switch 不在 = 所有消息必失败，值得一次真实连接来确认。
  const proxyProbe = fetch(config.claudeBaseUrl, { signal: AbortSignal.timeout(2000) })
    .then((res) => ({ ok: true, status: res.status }))
    .catch((error) => ({ ok: false, error: error.message }));

  // 群人数：批量查一次，供会话标签与活动行共用。
  // 并发发出——串行 await 会让每个群各等一个 WS 往返，群一多诊断就明显变慢。
  // 按「群号 → 人数」存，最后再映射到各会话键上。
  const groupIds = new Set();
  for (const k of new Set([...sessions.keys(), ...recent.keys()])) {
    const m = /^group:(\d+)$/.exec(k);
    if (m) groupIds.add(Number(m[1]));
  }
  const counts = new Map();
  await Promise.all(
    [...groupIds].map(async (id) => counts.set(id, await groupMemberCount(id))),
  );
  // 关掉群共享会话时键是「群号:QQ号」，两种形态都要认
  const memberCountFor = (k) => {
    const m = /^(?:group:(\d+)|(\d+):\d+)$/.exec(k);
    return m ? (counts.get(Number(m[1] ?? m[2])) ?? null) : null;
  };

  // 每个会话只读一遍尾部：这份文件可能几 MB，而它同时要供
  // 【会话】节（体积/模型）和【最近】节（最后一次对话）使用。
  // 体积和模型名都从这一次读里带出来，不再单独 statSync / 全文件扫。
  const sessionMeta = [];
  const activity = [];
  for (const [k, sid] of sessions) {
    const path = sessionPath(PROJECT_DIR, sid);
    const tail = readTailRecords(path);
    const last = lastExchange(tail);
    const mem = recent.get(k);
    const memberCount = memberCountFor(k);

    sessionMeta.push({
      key: k,
      sessionId: sid,
      // null 表示文件不存在或读不到——渲染层会区分这两种说法
      sizeMb: tail ? tail.sizeMb : null,
      model: last?.model ?? null,
      memberCount,
    });

    activity.push({
      key: k,
      memberCount,
      // 磁盘上的记录优先；内存态只补"刚收到、还没来得及落盘"的那条
      lastRecv: atTime(last?.said?.at) ?? mem?.at ?? null,
      lastText: last?.said?.text
        ? truncate(last.said.text, 40)
        : mem?.text
          ? truncate(mem.text, 40)
          : null,
      lastReply: atTime(last?.replied?.at),
    });
  }

  const entries = loadEntries();
  const nowTs = Date.now();
  const staleFiles = [...pendingFiles.entries()].filter(
    ([, v]) => nowTs - v.at > PENDING_FILE_TTL_MS,
  ).length;

  // 执行中的会话。注意别叫 execs：外面那个同名 Map 正是这里要读的来源，
  // 同名 const 会在初始化前引用它自己（TDZ 报错）。
  const execList = [...execs.entries()].map(([k, e]) => {
    const sid = e.sessionId || sessions.get(k) || null;
    const path = sid ? sessionPath(PROJECT_DIR, sid) : null;
    // 执行者的事件里没有原文时才回退到会话文件——而文件正被这个进程写着，
    // 读到的可能是半行，所以只取小窗口且失败就当没有。
    const last = !e.prompt && path ? lastExchange(readTailRecords(path, 16384, 20)) : null;
    const what = e.prompt
      ? truncate(String(e.prompt).replace(/\s+/g, " "), 50)
      : last?.said?.text
        ? truncate(last.said.text, 50)
        : "(内容未知)";
    return {
      key: k,
      what,
      startedAt: e.startedAt,
      sessionId: sid,
      memberCount: memberCountFor(k),
    };
  });

  let jobsFile = null;
  try {
    if (existsSync(config.jobsPath)) {
      jobsFile = { count: loadJobs(config.jobsPath).length };
    }
  } catch {
    jobsFile = { count: 0 };
  }

  // 代理探测早在本函数开头就发出去了，到这里才收——中间的文件 IO
  // 已经把它那点延迟盖掉了。
  const proxy = await proxyProbe;

  return {
    now,
    pid: process.pid,
    ws: !client?.ws ? "未建立" : client.ws.readyState === 1 ? "已连接" : "未连接（重连中）",
    startedAt: BOOT_AT,
    lastRecvAt,
    queuedSinceBoot: doneSinceBoot,
    bootRecent: now - BOOT_AT < 180_000,
    mergeWindowMs,
    processes: liveProcessSnapshot(now),
    execs: execList,
    queueEntries: entries.slice(0, 30),
    queueTotal: entries.length,
    // 压缩中的会话单列一节：它解释"为什么这条会话的下一条会慢"
    compacting: [...compacting.entries()].map(([k, v]) => ({
      key: k,
      sessionId: v.sessionId,
      startedAt: v.startedAt,
      memberCount: memberCountFor(k),
    })),
    sessionMeta,
    activity,
    deps: {
      proxy,
      claudeExe: existsSync(config.claudeExe) ? config.claudeExe : null,
    },
    files: {
      queueFile: existsSync(QUEUE_PATH) ? { sizeMb: fileSizeMb(QUEUE_PATH) } : null,
      jobsFile,
      pendingFiles: pendingFiles.size,
      staleFiles,
      pendingRetry: pendingRetry.size,
      workspace: workspaceStatus(),
    },
    sessions: {
      compactMb: config.sessionCompactMb,
      maxMb: config.sessionMaxMb,
    },
  };
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

// 该会话上**还没开始执行**的消息条数。
//
// 三种状态要分清，否则「后面还有 N 条排队」会算错：
//   running  正在跑，不算排队
//   merging  已被合并进正在跑的那条，内容已保留，不算排队
//   queued   真的在等，算
//
// excludeId 用来排除"调用方自己那条"。命令类消息（/status 等）是在
// 入队之后、markRunning 之前执行的，此刻它自己的条目状态还是 queued，
// 不排除就会被算成"后面有一条排队"——那一条其实是命令自己。
// 按 id 排除而不是让调用方减 1：条目可能已被合并/摘除，减 1 会算少。
function queueDepth(key, excludeId = null) {
  return loadEntries().filter(
    (e) =>
      e.key === key &&
      e.id !== excludeId &&
      (e.status === "queued" || e.status === "merging"),
  ).length;
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
// preset 由 enqueue 传入，携带已经定好的执行参数：
//   prompt    合并打断时要复用的是**合并后**的 prompt，不是本条消息的原文
//   sessionId 合并打断时必须复用被中断那次的会话，否则会开新会话丢上下文
//   exec      执行者对象，锚点写到这里供判据读取
async function handleMessage(event, entryId = null, abortSignal = null, preset = null) {
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
    // 通知文件消息也记进诊断活动：QQ 把文件和文字拆成两条，用户很可能
    // 紧接着就发文字，而"最后收到的是什么"正是诊断要回答的。
    noteRecv(key, `[文件] ${files.map((f) => f.name).join(", ")}`);
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

  // 「继续」不是新指令，而是用户对一条**确定内容**的待重放消息的决定——
  // 合并它会让那条内容被改写（mergePrompt 会加前缀），而用户要的是
  // 原样重跑。放前面，before 「继续」被合并判据当成普通消息吃掉。
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

  // /提醒：定时提醒的增删查（仅 admin）。
  //
  // 走代码路径而非模型路径：写 jobs.json 是状态变更，与「加人/移出用户」
  // 同理，必须确定性执行。模型这边只负责理解自然语言意图，落到具体时间字段
  // 由 reminders.js 的解析器做。
  //
  // 为什么把「解析 + 落盘」都放在代码里：定时任务一旦写错时间，用户是
  // 在错过提醒之后才发现，而那时已经没法补救。宁可解析器拒绝并要求改写，
  // 也不要模型"猜一个差不多的时间"。
  if (/^\/提醒/.test(text.trim())) {
    if (role !== "admin") {
      await reply("只有管理员能设置定时提醒。").catch((e) => log("发送权限提示失败: " + e.message));
      done();
      return;
    }

    const body = text.trim().replace(/^\/提醒\s*/, "").trim();

    // 列表
    if (body === "列表" || body === "") {
      const jobs = loadJobs(config.jobsPath);
      if (!jobs.length) {
        await reply("当前没有定时任务。\n添加：/提醒 每天 08:00 起床").catch((e) => log("发送失败: " + e.message));
        done();
        return;
      }
      const lines = jobs.map((j, i) => {
        const when = j.date ? `${j.date} ${j.time}` : j.time;
        const repeat = j.weekdays?.length
          ? `周${j.weekdays.map((d) => "日一二三四五六"[d]).join("、")}`
          : j.date
            ? "一次性"
            : "每天";
        const where = j.target?.type === "group" ? `群${j.target.id}` : "私聊";
        const what = String(j.text ?? j.prompt ?? "").slice(0, 20);
        return `${i + 1}. ${when}（${repeat}，${where}）${what}`;
      });
      await reply(`共 ${jobs.length} 条定时任务：\n${lines.join("\n")}\n\n删除：/提醒删除 序号`).catch(
        (e) => log("发送失败: " + e.message),
      );
      done();
      return;
    }

    // 删除
    const del = /^(?:删除|取消)\s*(\d+)$/.exec(body);
    if (del) {
      const removed = removeJobByIndex(config.jobsPath, Number(del[1]));
      await reply(
        removed
          ? `已删除提醒：${removed.time} ${String(removed.text ?? "").slice(0, 20)}`
          : `没有第 ${del[1]} 条，发「/提醒 列表」看看现有任务。`,
      ).catch((e) => log("发送失败: " + e.message));
      done();
      return;
    }

    // 新增
    const parsed = parseReminder(text);
    if (parsed.error) {
      await reply(`${parsed.error}\n\n写法示例：\n/提醒 每天 08:00 起床\n/提醒 工作日 09:30 开站会\n/提醒 明天 15:00 开会\n/提醒 2026-10-01 08:00 出发`).catch(
        (e) => log("发送失败: " + e.message),
      );
      done();
      return;
    }

    const job = {
      // name 用时间戳而非用户输入：中文内容不适合做键名，
      // 而且同名任务会被 addJob 去重覆盖——用户想要的通常是"再加一条"。
      name: `r${Date.now()}`,
      time: parsed.job.time,
      text: parsed.job.text,
      // 触发地 = 当前会话所在地：在哪问的就在哪推。
      target: isGroup ? { type: "group", id: Number(event.group_id) } : { type: "private", id: userId },
    };
    if (parsed.job.date) job.date = parsed.job.date;
    if (parsed.job.weekdays) job.weekdays = parsed.job.weekdays;

    try {
      addJob(config.jobsPath, job);
      const repeat = job.weekdays
        ? `每周${job.weekdays.map((d) => "日一二三四五六"[d]).join("、")}`
        : job.date
          ? `${job.date} 仅一次`
          : "每天";
      log(`新增定时提醒 ${job.name}: ${job.time} ${job.text}`);
      await reply(`好的，${repeat} ${job.time} 提醒你：${job.text}\n（发「/提醒 列表」可查看，发「/提醒删除 序号」可取消）`).catch(
        (e) => log("发送确认失败: " + e.message),
      );
    } catch (error) {
      log(`写入定时任务失败: ${error.message}`);
      await reply(`设置提醒失败：${String(error.message).slice(0, 120)}`).catch((e) => log("发送失败: " + e.message));
    }
    done();
    return;
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
    const cur = running.get(key);    // 要排除本条自己：这条消息在入队时已落盘（状态 queued），而
    // markRunning 在本函数更靠后的位置才执行——此刻它自己还挂在队列里。
    // 不排除的话，用户只发一条 /status 也会被告知「后面还有 1 条排队」，
    // 那 1 条就是这条命令本身。
    //
    // 按 entryId 排除而不是 queueDepth - 1：合并打断会让队列里出现
    // 状态为 merging 的条目，减 1 在那种情况下会少算。
    const depth = queueDepth(key, entryId);
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

  // /诊断：一次性查看「现在到底卡在哪」。仅 admin。
  //
  // 和 /status 一样必须走代码路径：问的正是"为什么没反应"，
  // 走模型就得排在同一条串行队列后面，而队列被占满时正是它该回答问题的时候。
  //
  // /status 是它的轻量版（只管本会话的排队情况）；诊断是全局的，
  // 覆盖进程、队列、会话体积、最后活动与依赖。两者都一毫秒返回。
  if (parseDiagnosticCommand(text)) {
    if (role !== "admin") {
      await reply("诊断只在管理员私聊/群里可用。").catch((e) => log("发送权限提示失败: " + e.message));
      done();
      return;
    }
    if (diagnosing) {
      await reply("正在生成上一份诊断，稍等一下。").catch(() => {});
      done();
      return;
    }
    diagnosing = true;
    try {
      const report = await collectDiagnostic(config.mergeWindowMs);
      const sent = await reply(buildDiagnostic(report));
      if (sent?.status !== "ok") log(`诊断发送失败: ${JSON.stringify(sent)}`);
      else log("诊断报告已发送");
    } catch (error) {
      log(`诊断失败: ${error.stack || error.message}`);
      await reply(`诊断失败：${String(error.message).slice(0, 120)}`).catch(() => {});
    } finally {
      diagnosing = false;
    }
    done();
    return;
  }

  // 带上刚才缓存的文件。放在 preset 之后：preset 是合并打断已经定好的 prompt，
  // 里面早就含了当时的文件信息，不能再拼一次。
  //
  // 超长检查必须在 takeFiles **之前**做：takeFiles 是用掉即清，
  // 检查失败时再想放回去就得重新拿，容易写出清空缓存的 bug。
  let effectiveText = text;
  if (!preset) {
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
  const prompt = preset?.prompt ?? (isGroup && config.senderPrefix ? withSenderPrefix(effectiveText, event) : effectiveText);

  log(`收到 ${key}: ${truncate(prompt, 80)}`);
  noteRecv(key, prompt);

  // 标记为执行中。此后进程若被强杀，这条会被启动恢复记入 pendingRetry
  // （不自动重放——可能已执行了一部分，交给用户回「继续」决定）。
  if (entryId) markRunning(entryId);

  // 先记崩溃恢复的账（markRunning），再对用户宣称"在跑"。
  running.set(key, { what: prompt, started: Date.now() });

  // 恢复判据的锚点：本条开始执行时会话文件的行数。
  //
  // 同步取，且此刻 claude 还没 spawn——CLI 一启动就会写约 4 行记账记录，
  // 那时取就分不清"记账"和"模型真的动了工具"。
  //
  // 取不到会话 ID 时写 null：恢复时按"不安全"处理，绝不猜。
  // 宁可多问用户一次，也不能对着已经踢过人的任务重放。
  if (entryId) {
    const anchorSid = preset?.sessionId ?? sessions.get(key) ?? null;
    markBaseline(
      entryId,
      anchorSid ? sessionLineCount(sessionPath(PROJECT_DIR, anchorSid)) : null,
    );
  }

  // 合并判据的锚点：本条开始执行时会话文件的行数。null = 还没建立
  // （claude 启动约 0.6s 后才写完记账记录），此时判据退化为"有没有超过
  // spawn 时的行数"——同样安全，因为那一刻模型必然还没动过工具。
  //
  // 不能 spawn 后立刻取：启动时会先写约 4 行记账记录，早取会误判成"调了工具"。
  //
  // baseline 对象是引用共享的：enqueue 建 exec 时就放进去，这里回填值，
  // 判据那边读到的就是最新值。
  const baseline = preset?.exec?.baseline ?? { lines: null };
  const wireBaseline = (sessionId) => {
    if (!sessionId) return;
    const p = sessionPath(PROJECT_DIR, sessionId);
    const atSpawn = sessionLineCount(p);
    const poll = setInterval(() => {
      const now = sessionLineCount(p);
      if (now === null || now === atSpawn) return;
      baseline.lines = now;
      clearInterval(poll);
    }, 150);
    poll.unref?.();
    setTimeout(() => clearInterval(poll), 2000).unref?.();
  };


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
      abortSignal,
      // 诊断里显示"谁在哪问的什么"，比一整段合并前缀好读得多
      label: `${key} ${truncate(text.replace(/\s+/g, " "), 30)}`,
    });

  let result;
  const started = Date.now();
  let attempt = 0;
  const maxAttempts = 1 + Math.max(0, config.retryCount);
  let compactPlan = null;

  while (attempt < maxAttempts && !result) {
    attempt += 1;
    // 合并打断时 sessionId 由 enqueue 复用了被中断那次的，必须优先用它。
    const resolved = preset?.sessionId
      ? { sessionId: preset.sessionId, compactPlan: null }
      : resolveSession(key);
    const sessionId = resolved.sessionId;
    if (resolved.compactPlan) compactPlan = resolved.compactPlan;
    // 锚点只在第一次尝试时绑：后续重试是同一个会话文件，重绑会覆盖掉
    // 已经被打断逻辑读到的值。
    if (attempt === 1) wireBaseline(sessionId);

    try {
      result = await invoke(sessionId);
    } catch (error) {
      // 合并打断 → 静默退出。这条消息的内容已经并入新的一条 prompt，
      // 既不能报错（用户没出错）、也不能重试（重试等于连同合并后的内容
      // 一起跑第二遍）。
      //
      // 条目仍要摘除：它已被 markMerging 标成终态、内容也保留在合并后的
      // prompt 里，留着只会永久残留并撑大 queueDepth。
      if (error instanceof ClaudeError && error.aborted) {
        log(`${key} 本条被合并打断，内容已并入新消息`);
        done();
        return;
      }

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

  // 被合并打断：内容已并入新的一条，本轮不发回复，但收尾要做干净
  // （停回执、摘条目），否则条目残留会把 queueDepth 一直撑大。
  if (abortSignal?.aborted) {
    log(`${key} 执行被打断，内容已并入新消息`);
    running.delete(key);
    await settle();
    done();
    return;
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
  } else {
    doneSinceBoot += 1; // 只有真正把结果发出去才算一条消息走完
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
  // 登记在案：压缩要跑好几分钟，期间该会话的下一条消息会明显变慢。
  // 用户来问"怎么这么慢"时，诊断必须能说出"有一条压缩正在跑"，
  // 否则只能看到一个空白的【执行】节。
  compacting.set(key, { sessionId, startedAt: Date.now() });
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
    })
    .finally(() => {
      compacting.delete(key);
    });
}

// 合并打断的执行体：杀掉当前进程 → 两条消息合成一条 prompt → 重新入队。
//
// 语义是**合并而非放弃**：前一条的内容原样保留在合并后的 prompt 里。
// 之所以只能"杀掉重跑"而不能真发一个 ESC：无头 spawn 的 claude.exe 跑完
// 就退出，没有一个活着的进程可以收信号。
//
// 返回 true 表示已成功接管，调用方不应再入队；false 表示中途失败，
// 调用方必须把这条消息按常规入队，否则它会凭空消失。
async function interruptForMerge(key, newEvent) {
  const exec = execs.get(key);
  if (!exec) return false;

  const prevEvent = exec.event;
  if (!prevEvent) return false; // 恢复任务没有原始事件，无法合并

  const first = exec.prompt;
  const second = extractText(newEvent.message);
  const merged = mergePrompt(first, second);
  if (merged.length > config.maxPromptChars) {
    log(`合并后 ${merged.length} 字超过上限，放弃合并`);
    return false;
  }

  // 已合并掉的那条**不在这里摘除**：它的原始事件还挂在 exec 上，
  // 由被中断的 handleMessage 在收尾时摘掉（那条路径会读到这里的新状态）。
  markMerging(exec.entryId);
  exec.controller.abort(); // 立即杀死进程树；被中断的 handleMessage 静默收尾

  const newEntryId = markQueued(key, newEvent);

  // 复用 sessionId：被中断的那次从未把 id 写回 map，若这里当空处理，
  // 重跑就会开一条全新会话，把之前的上下文全丢掉。
  const sessionId = sessions.get(key) || null;

  log(`合并打断 ${key}: 「${truncate(first, 40)}」+「${truncate(second, 40)}」`);
  if (config.mergeNotice) {
    await replyTo(newEvent, "收到，结合你上一条一起处理。").catch((e) =>
      log("发送合并提示失败: " + e.message),
    );
  }

  // 等被中断的那次真正收尾再起新的一条：同一会话文件不能被两个 claude
  // 进程同时追加。exec.done 在 handleMessage 静默退出前 resolve。
  const prevDone = exec.done;
  const settleBeforeStart = prevDone.catch(() => {});
  void settleBeforeStart.then(() => {
    // sessionId 重新取一次：等待期间可能有别的路径改过它
    const sid = sessions.get(key) || sessionId;
    startExec(key, newEvent, newEntryId, merged, sid);
  });

  return true;
}

// 会话文件当前行数。读不到返回 null —— 判据那边会保守拒绝合并。
function currentLineCount(key) {
  const p = sessionPathFor(key);
  return p ? sessionLineCount(p) : null;
}

// 不带 senderPrefix 的回复助手，供 enqueue 层（没有 role/prompt 上下文）使用。
function replyTo(event, message) {
  const isGroup = event.message_type === "group";
  const userId = Number(event.user_id);
  return isGroup
    ? client.action("send_group_msg", {
        group_id: Number(event.group_id),
        message: config.replyToSender ? `[CQ:at,qq=${userId}] ${message}` : message,
      })
    : client.action("send_private_msg", { user_id: userId, message });
}

// 某条消息最终会送给模型的文本（用于合并打断的长度预判）。
// 必须和 handleMessage 里的拼装保持一致，否则合并长度算少了，
// 超长时会在检查处直接失败、白打断一次。
function promptTextFor(key, event) {
  const text = extractText(event.message);
  if (!text) return "";
  const entry = pendingFiles.get(key);
  const fresh = entry && Date.now() - entry.at <= PENDING_FILE_TTL_MS ? entry.files : [];
  return fresh.length ? withFiles(text, fresh) : text;
}

// 必须**立即**执行的命令，绝不能当普通消息处理。
//
// /诊断 和 /status 的存在意义就是"现在到底怎么了"——它们要是也被排进
// 串行队列、或者被合并打断吃掉，就等于在用户最需要它们的时候失灵。
// 实测踩到过：任务卡住时发 /诊断，它被合并进卡住的那条一起重跑，
// 跑完才执行，而且执行了两次（原条 + 重跑条各一次，两次都命中命令分支）。
//
// 角色管理指令（加人/移出）同样必须确定性执行，不能等队列。
function isDirectCommand(text) {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (parseDiagnosticCommand(t) || parseStatusCommand(t) || parseResetCommand(t)) return true;
  if (/^\/提醒/.test(t)) return true;
  return resolveRoleTarget({ text: t, mentionAts: [], selfId: config.selfId }) !== null;
}

// 正在跑的时候又来一条命令：直接摘掉条目独立执行。
//
// 不能让它走下面的队列轮询——那个轮询要等前面那条跑完才轮到，
// 而"前面那条跑不完"正是用户要问的事。
function runNow(event, entryId) {
  if (entryId) removePending(entryId);
  handleMessage(event, null, null, null).catch((error) =>
    log(`处理异常: ${error.stack || error.message}`),
  );
}

function startExec(key, event, entryId, prompt, sessionId) {
  // 命令类消息在"已有任务在跑"时也要立刻执行，不走队列轮询。
  //
  // 对 /诊断 和 /status 这是必须的：它们回答"为什么还没回复"，
  // 排队等前面跑完就正好错过了它们该回答的那一刻。
  // 对加人/移出、/提醒 这类状态变更，即刻执行与 handleMessage 的语义一致
  // （它们本来就是代码路径，不 spawn 模型）。
  if (entryId && isDirectCommand(extractText(event.message))) {
    runNow(event, entryId);
    return;
  }

  const controller = new AbortController();
  let resolveDone;
  const exec = {
    controller,
    event,
    entryId,
    prompt,
    sessionId,
    startedAt: Date.now(),
    baseline: { lines: null },
    done: new Promise((r) => (resolveDone = r)),
  };
  exec._resolveDone = resolveDone;
  execs.set(key, exec);

  handleMessage(event, entryId, controller.signal, { prompt, sessionId, exec })
    .catch((error) => log(`处理异常: ${error.stack || error.message}`))
    .finally(() => {
      if (execs.get(key) === exec) execs.delete(key);
      exec._resolveDone();
    });
}

// 按**条目**（id）而非按 key 追踪：同一会话可能积压多条（用户连发），
// 同一时刻只有队首在执行；按 key 标记会把整批都标成执行中，
// 让从未执行过的后续消息在恢复时被误判为「状态未知」而不能自动重放。
// replayId：重放**已经落盘**的条目时，把它自己的 id 传进来接手后续状态流转
// （markRunning / removePending 都认这个 id）。传 null 就会彻底脱管——
// 条目永远停在 queued，每次启动都被重放一遍，并把 queueDepth 永久撑大。
// 「继续」路径传 null 是对的：那条是 notified 终态，本就不该再计数。
function enqueue(event, { fromRetry = false, replayId = null } = {}) {
  const key = convKey(event);

  // 入队即落盘：pm2 用 taskkill /F 强杀（不发信号），这一步是「消息已收到」
  // 唯一的持久化机会。重放不再落新条目（markQueued），否则会反复堆积。
  const entryId = fromRetry ? replayId : markQueued(key, event);

  // 先试合并打断：只有在窗口内、且当前这条一个工具都没调过时才成立。
  // 判据在 interrupt.js，这里只负责取现场数据。
  //
  // 命令类消息（/诊断、/status 等）**不参与合并**：把它们并进正在跑的任务
  // 一起重跑，等于让"查看现状"和"改变现状"绑在同一次执行上——实测表现为
  // 诊断被吃掉、跑完才回答、而且回答两遍。命令应该立刻走自己的路径。
  //
  // 「继续」也不必在这里挡：handleRetry 早在 handleMessage 开头就把这种消息
  // 消费掉了，能走到这里的「继续」只可能是没有待重放条目的普通闲聊词。
  if (!fromRetry && config.mergeInterrupt && !isDirectCommand(text)) {
    const exec = execs.get(key);
    if (exec && shouldInterrupt({
      enabled: config.mergeInterrupt,
      messageType: event.message_type,
      role: senderRole(Number(event.user_id), config, roles),
      windowMs: config.mergeWindowMs,
      startedAt: exec.startedAt,
      now: Date.now(),
      baselineLines: exec.baseline.lines,
      currentLines: currentLineCount(key),
      mergedLength: mergePrompt(exec.prompt, promptTextFor(key, event)).length,
      maxPromptChars: config.maxPromptChars,
    })) {
      // 异步执行，但先同步返回——决定已经定了，调用方不必等。
      // 失败（interruptForMerge 返回 false）说明合并没做成，退回常规入队。
      void interruptForMerge(key, event).then((ok) => {
        if (!ok) {
          log(`合并打断失败，改为排队: ${key}`);
          startExec(key, event, entryId, extractText(event.message), sessions.get(key) || null);
        }
      });
      return;
    }
  }

  // 已有任务在跑 → 排队等它结束。
  //
  // 用轮询而不是 await 某个 exec 的 done：合并打断会把**当前执行者整个换掉**，
  // 若排队的消息都挂在旧 exec 的 done 上，它们会在旧 exec 收尾的同一瞬间
  // 一起起跑——同一会话文件被多个 claude 进程同时追加，正是本行注释要禁止的。
  // 轮询问的是"现在还有没有人在跑"，换执行者不影响判断。
  const cur = execs.get(key);
  if (cur) {
    const poll = setInterval(() => {
      if (execs.has(key)) return;
      clearInterval(poll);
      // 轮询期间可能已被处理（如合并打断时这条已并入 merged），
      // 条目不在队列里就说明不必再跑，否则会重复执行。
      const still = loadEntries().some((e) => e.id === entryId);
      if (entryId && !still) return;
      startExec(key, event, entryId, extractText(event.message), sessions.get(key) || null);
    }, 200);
    poll.unref?.();
    return;
  }

  startExec(key, event, entryId, extractText(event.message), sessions.get(key) || null);
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

  // 先清 merging：这些条目的内容已经并入同会话的合并 prompt，而合并 prompt
  // 自己要么还在这份队列里（queued），要么已经跑完并摘除了。留着它只会永久
  // 残留、撑大 queueDepth。
  //
  // 但**只有当同会话存在活跃条目时才清**：合并打断可能死在最坏的一瞬——
  // interruptForMerge 刚要起新执行者时被强杀，于是「旧条目已标 merging、
  // 新条目还没 markQueued」。此时若把 merging 当垃圾清掉，那条消息的内容
  // 就真的没了。宁可留下一个会撑大计数的僵尸，也不能丢消息。
  const merged = entries.filter((e) => e.status === "merging");
  for (const e of merged) {
    const alive = entries.some(
      (o) => o.key === e.key && o.id !== e.id && (o.status === "queued" || o.status === "running"),
    );
    if (alive) {
      log(`清除已被合并的条目 ${e.key}: ${truncate(extractText(e.event.message), 40)}`);
      removePending(e.id);
    } else {
      log(`合并条目 ${e.key} 内容无着落，退回待重放`);
      markMergingAborted(e.id);
    }
  }

  const queued = entries.filter((e) => e.status === "queued");
  const interrupted = entries.filter((e) => e.status === "running");
  // notified：已经告知过用户，等他回「继续」。
  //
  // 但这个状态有两种来源，含义完全相反，必须分开处理：
  //   a) 通知本身是**误报** —— 任务早已跑完（命令类消息压根不写会话，
  //      或结果发完了只是没来得及摘除）。这类会永久堆积，要清掉。
  //   b) 任务**确实**没跑完 —— 用户还没决定要不要重放。替他做决定
  //      （无论是重放还是丢弃）都是错的，只能保持不动。
  //
  // 区分依据：通读会话的最后一条记录。真正跑过 claude 的那轮，
  // 末尾一定会留下 cost-state（实测 6 条会话里 5 条以它结尾，唯一
  // 例外正是"结果已发出、CLI 在写它之前被杀"的那种）；而误报的那些
  // 会话末尾停在更早以前，说明这轮根本没执行过。
  const awaiting = entries.filter((e) => e.status !== "queued" && e.status !== "running");
  let cleanedNotified = 0;
  let keptNotified = 0;

  for (const e of awaiting) {
    // 条目的事件只活这一次恢复：若不重建映射，用户回「继续」时
    // handleRetry 查 pendingRetry 会落空，「继续」被当成普通聊天词吞掉。
    // 之前这些条目只是"被跳过"，所以这个漏洞一直没暴露。
    pendingRetry.set(e.key, e.event);

    const sid = sessions.get(e.key);
    const last = sid ? lastRecordType(sessionPath(PROJECT_DIR, sid)) : null;
    if (last === "cost-state") {
      log(`丢弃 ${e.key} 的误报条目：会话里这轮已完整跑完（末条=${last}）`);
      removePending(e.id);
      cleanedNotified++;
      continue;
    }
    keptNotified++;
  }

  if (cleanedNotified || keptNotified) {
    log(`通知队列：清理 ${cleanedNotified} 条误报，保留 ${keptNotified} 条待用户决定`);
  }

  for (const e of queued) {
    log(`恢复未处理消息 ${e.key}: ${truncate(extractText(e.event.message), 60)}`);
    // 带上 e.id：这条条目已经在磁盘上了，必须由它自己走到终态。
    // 不传的话 entryId 为 null，done() 摘不掉它——它会永远停在 queued，
    // 每轮启动重放一次、每次都把「后面还有 N 条排队」撑大（实测就是这样）。
    enqueue(e.event, { fromRetry: true, replayId: e.id });
  }

  for (const e of interrupted) {
    // 先确认这轮**真的**没跑完。status=running 只说明"没来得及从队列摘除"，
    // 而进程被强杀时，绝大多数任务其实已经在会话文件里跑完了（结果都发出去了）。
    // 无脑通知会让每次重启都误报一次，用户很快就不看了，真正的丢消息反被淹没。
    const sid = sessions.get(e.key);
    const path = sid ? sessionPath(PROJECT_DIR, sid) : null;
    const last = path ? lastRecordType(path) : null;
    // 末条是 cost-state = 完整跑完；或旧判据（末尾有正式回复文本）也认。
    // 两个判据都只看"有没有跑完"，任一成立即可静默清理。
    const completed = last === "cost-state" || (path && sessionCompleted(path) === true);
    if (completed) {
      log(`丢弃 ${e.key} 的残留条目：会话里这轮已经跑完（结果早已发出）`);
      removePending(e.id);
      continue;
    }

    // 跑过、但确实没跑完（没到 cost-state）。到这里只剩两种可能，
    // 而它们的代价差着数量级，必须分开：
    //
    //   没动过工具（会话文件相对 baseline 没长）→ 重放零副作用，**自动恢复**
    //   动过了                                 → 可能踢了人、卸了软件 → 交给用户
    //
    // 自动恢复这条同时补上了一个老缺口：命令类消息（/提醒、/status）
    // 压根不写会话，末尾永远不是 cost-state，所以上面那条静默清理覆盖不到它，
    // 每次重启都会被当成"没跑完"通知一遍。现在它们会被自动重放，不再唠叨。
    const anchor = sessions.get(e.key);
    const anchorPath = anchor ? sessionPath(PROJECT_DIR, anchor) : null;
    const decision = decideRecovery({
      baseline: e.baseline,
      currentLines: anchorPath ? sessionLineCount(anchorPath) : null,
    });
    if (decision.resume) {
      log(`自动恢复 ${e.key}：会话未增长，这轮没动过工具，重放零副作用`);
      enqueue(e.event, { fromRetry: true, replayId: e.id });
      continue;
    }

    // 到这里才是真的"可能做了一半"，交给用户决定。
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

// 定时推送。放在 connect 之后：调度器发送时要经 client，虽然它自带
// 未连接重试，但启动即触发的那次检查等连上更稳妥。
startScheduler({ client, config, log });

function shutdown(signal) {
  log(`收到 ${signal}，退出中`);
  client.close();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
