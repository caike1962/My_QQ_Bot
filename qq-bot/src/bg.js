import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from "node:fs";
import { runClaude } from "./claude.js";

// 后台任务：布置后立刻回执，任务在独立会话里跑，用户可以继续聊天。
//
// 为什么独立会话（sessionId: null，同 scheduler.js 的定时任务）：同一个会话
// 文件绝不能被两个 claude 进程同时追加（见 index.js 合并打断处的等待），
// 而「继续聊天」正是本功能的核心承诺，所以任务必须另起一条会话。
//
// 为什么不复用 queue.json / execs：queue.json 的恢复逻辑从事件重算 convKey，
// 重启后会把后台任务重放进**主会话**，正是要避免的污染；execs 是会话锁，
// 占用它会让该会话后续所有消息排队——恰好毁掉本功能。所以后台任务自成一个文件。

// —— 触发识别 ——

// 第一层：显式指令。\s|$ 是必须的，否则 /bgx 会被当成 /bg。
export const BG_PREFIX_RE = /^\/(?:bg|后台)(?:\s|$)/;

// 第二层：自然语言触发。
//
// 为什么支持自然语言而不是只认 /bg：要求用户记住指令本身就是使用负担。
// 中文里「后台」作「异步执行」解时指向性很强，而误判代价极低——这台机器
// 当前在跑的就是「统计磁盘占用」这类查询整理任务，判错最多多跑一个无害
// 任务，而漏判会让用户白等。所以宁可宽判。
const BG_WORD = /后台/;
const ACTION_NEAR = /帮我|替我|把|跑|执行|处理|弄|搞|查|统计|整理|做|算/;

// 「后台」与动作词之间允许的最大间隔。太远了不像同一个短语。
const NEAR_WINDOW = 12;

export function parseNaturalTrigger(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  // 显式指令走 parseBgCommand 那条路，不在这里重复处理
  if (BG_PREFIX_RE.test(raw)) return null;

  const idx = raw.indexOf("后台");
  if (idx === -1) return null;

  // 问句不触发：「会有后台任务吗」「后台是什么意思」
  if (/[？?]$/.test(raw)) return null;

  const afterWord = raw.slice(idx + 2);
  // 「后台任务」是名词，用户说的是一个概念而不是在下指令；
  // /bg 列表 才是查询入口，不该被 /bg 关键词抢走
  if (/^任务/.test(afterWord)) return null;

  // 动作词必须落在「后台」附近才算指令。「重要文件都放在后台目录」
  // 这种句子里没有动作词，自然落空。
  const near = raw.slice(Math.max(0, idx - NEAR_WINDOW), idx + 2 + NEAR_WINDOW);
  if (!ACTION_NEAR.test(near)) return null;

  // 剥掉触发前缀，剩下的才是任务描述。保留「帮我」这类客套词会让
  // 任务 prompt 显得含糊，而后面的会话历史会补上指代上下文。
  let rest = afterWord
    .replace(/^[，,、:：\s]*/, "")
    .replace(/^(?:帮我|替我|给我)\s*/, "")
    .trim();

  if (!rest) return null;
  return { prompt: rest };
}

// 显式指令解析。返回 { action, prompt?, index? } 或 null（不是本指令）。
export function parseBgCommand(text) {
  const raw = String(text ?? "").trim();
  if (!BG_PREFIX_RE.test(raw)) return null;

  const rest = raw.replace(BG_PREFIX_RE, "").trim();
  if (!rest) return { action: "help" };
  if (rest === "帮助" || rest === "help") return { action: "help" };
  if (rest === "列表" || rest === "list") return { action: "list" };

  const cancel = /^(?:取消|cancel)\s*(\d+)?$/.exec(rest);
  if (cancel) {
    const index = Number(cancel[1]);
    if (!Number.isInteger(index) || index < 1) return { action: "help" };
    return { action: "cancel", index };
  }

  return { action: "run", prompt: rest };
}

// —— 落盘 ——

let bgPath = process.env.QQBOT_BG_TASKS || "D:\\QQBOT\\qq-bot\\bg-tasks.json";
let warn = (msg) => console.error("[qq-bot]", msg);

export function setBgPath(p) {
  bgPath = p;
}

export function setBgLogger(fn) {
  warn = fn;
}

function readAll() {
  if (!existsSync(bgPath)) return [];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(bgPath, "utf8"));
  } catch (error) {
    // 同 queue.js：解析失败必须告警，不能静默当空
    warn(`后台任务文件损坏，已丢弃: ${error.message}`);
    return [];
  }
  const tasks = Array.isArray(parsed) ? parsed : parsed?.tasks;
  if (!Array.isArray(tasks)) {
    warn("后台任务文件格式异常，已丢弃");
    return [];
  }
  return tasks.filter((t) => t && typeof t === "object" && typeof t.id === "string");
}

function writeAll(tasks) {
  const tmp = bgPath + ".tmp";
  try {
    writeFileSync(tmp, JSON.stringify({ tasks }, null, 2));
    renameSync(tmp, bgPath);
  } catch (error) {
    warn(`后台任务写入失败: ${error.message}`);
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* 清理失败不影响主流程 */
    }
  }
}

let seq = 0;
const nextId = () => `t${Date.now()}-${seq++}`;

export function loadTasks(path = bgPath) {
  return readAll();
}

export function addTask(task) {
  const tasks = readAll();
  const entry = {
    id: nextId(),
    conv: task.conv,
    prompt: task.prompt,
    startedAt: Date.now(),
    status: "running",
    result: null,
    delivered: false,
    injected: false,
  };
  tasks.push(entry);
  writeAll(tasks);
  return entry;
}

export function updateTask(id, patch) {
  const tasks = readAll();
  const entry = tasks.find((t) => t.id === id);
  if (!entry) return null;
  Object.assign(entry, patch);
  writeAll(tasks);
  return entry;
}

// 一个会话的最近一条「待注入」结果。
//
// peek 与 consume 分开是刻意的：注入前要先做长度检查，若检查不过
// 就不能消费，否则这条结果会被白白吃掉（同 index.js 文件缓存的教训）。
// 过期条目在这里顺手清掉——读取是最自然的清理时机，不必另开定时器。
export function peekResults(conv, { ttlMs, now = Date.now() } = {}) {
  const tasks = readAll();
  const fresh = [];
  let dropped = 0;
  for (const t of tasks) {
    const expired = t.status === "done" && !t.injected && t.result?.at && now - t.result.at > ttlMs;
    if (expired) dropped++;
    else fresh.push(t);
  }
  if (dropped) {
    writeAll(fresh);
    warn(`丢弃 ${dropped} 条过期的后台任务结果（超过 ${Math.round(ttlMs / 3600000)} 小时未追回）`);
  }

  const hit = fresh
    .filter((t) => t.conv === conv && t.status === "done" && !t.injected && t.result)
    .sort((a, b) => (b.result.at || 0) - (a.result.at || 0))[0];
  return hit || null;
}

export function consumeResult(id) {
  const tasks = readAll();
  const left = tasks.filter((t) => t.id !== id);
  if (left.length !== tasks.length) writeAll(left);
}

export function markDelivered(id) {
  return updateTask(id, { delivered: true });
}

// 启动时把「跑着跑着进程没了」的任务收尾。
//
// 与消息队列不同，后台任务**不自动重放**：重跑一条 /bg 只是重打一行字，
// 而队列那套 baseline 恢复机制是为了判断「到底执行过没有」——后台任务
// 的 prompt 是用户新写的指令，重跑一次可能把破坏性操作又做一遍，
// 交给用户决定更安全，也更省事。
export function sweepInterrupted() {
  const tasks = readAll();
  const swept = [];
  for (const t of tasks) {
    if (t.status !== "running") continue;
    t.status = "done";
    t.result = {
      ok: false,
      text: "这条后台任务在运行途中被重启打断了，需要的话再发一次。",
      file: null,
      at: Date.now(),
      cost: 0,
      interrupted: true,
    };
    swept.push(t);
  }
  if (swept.length) writeAll(tasks);
  return swept;
}

// 闸门：每会话 1 个、全局 N 个。纯计算，便于单测边界。
export function admit({ conv, max }) {
  const tasks = readAll();
  const running = tasks.filter((t) => t.status === "running");
  const mine = running.filter((t) => t.conv === conv);
  if (mine.length) return { ok: false, reason: "conv", task: mine[0] };
  if (running.length >= max) return { ok: false, reason: "global", running: running.length };
  return { ok: true };
}

export function counts(conv) {
  const tasks = readAll();
  return {
    running: tasks.filter((t) => t.status === "running" && (!conv || t.conv === conv)),
    done: tasks.filter((t) => t.status === "done" && (!conv || t.conv === conv)),
    pendingInject: tasks.filter((t) => t.status === "done" && !t.injected && t.result && (!conv || t.conv === conv)),
  };
}

// —— 注入块 ——

// 结果注入主会话时随下一条消息一起送上。
//
// 为什么必须封顶：结果全文可能几万字，整段塞进去会顶破 maxPromptChars，
// 而那个检查在 prompt 组装之后——一旦超长，该会话**之后每条消息都会
// 被拒**，用户就彻底说不了话了。所以只带预览，全文用文件路径交给模型
// 自己去 Read（admin 有 Read 工具）。
export function formatResultBlock({ task, previewChars }) {
  const when = new Date(task.result?.at || Date.now());
  const hhmm = `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
  const text = String(task.result?.text ?? "");
  const preview = text.length > previewChars ? text.slice(0, previewChars) + "…" : text;

  const lines = [
    `[后台任务结果] 你之前布置的「${task.prompt}」已在 ${hhmm} 完成。`,
    preview,
  ];
  if (task.result?.file) {
    lines.push(`（完整内容已存为文件：${task.result.file}，长度超过预览上限的话可以用 Read 打开看全文）`);
  } else if (text.length > previewChars) {
    lines.push("（内容较长，上面只是开头部分）");
  }
  return lines.join("\n");
}

// —— 执行 ——

// 只返回全文，**不投递也不截断**——投递分级（HTML 文件 / 截断 / 直发）
// 由 index.js 复用现有的那套。scheduler.js 在 maxReplyChars 处直接截断、
// 永久丢掉尾部，后台任务不能重蹈这个覆辙。
//
// runClaude 可注入：这是本项目让「要 spawn 进程的代码」可测的既有做法
// （scheduler.js 的 startScheduler 同理由调用方传入 client）。
export async function runBackgroundTask({ task, config, log, abortSignal, history, runClaude: claude = runClaude }) {
  const prompt = history ? `${history}\n\n[当前任务] ${task.prompt}` : task.prompt;

  const result = await claude({
    exePath: config.claudeExe,
    baseUrl: config.claudeBaseUrl,
    authToken: config.claudeAuthToken,
    homeDir: config.claudeHome,
    cwd: config.claudeCwd,
    mcpConfigPath: config.claudeMcpConfig,
    prompt,
    sessionId: null, // 独立会话，见文件头
    allowedTools: config.allowedTools,
    maxTurns: config.maxTurns,
    timeoutMs: config.bgTimeoutMs,
    mcpTimeoutMs: config.mcpTimeoutMs,
    role: "admin", // 仅 admin 能布置，见 index.js 的角色检查
    model: config.claudeModel,
    abortSignal,
    label: `bg:${task.id}`,
  });

  return { text: String(result.text || "").trim(), cost: result.cost || 0, sessionId: result.sessionId || null };
}
