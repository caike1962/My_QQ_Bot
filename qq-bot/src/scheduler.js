import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { runClaude } from "./claude.js";

// 定时推送调度器。
//
// 为什么放在 qq-bot 进程内，而不是 pm2 cron 或 Windows 计划任务：
//   1. 复用已有的 OneBot WS 长连接，不必另起进程重新握手
//   2. 任务、日志、错误都在同一处，pm2 logs 一眼看全
//   3. 改完 jobs.json 重启即可生效，不涉及系统级配置
//
// 为什么不引 node-cron：qq-bot 目前是零依赖的。为了"每分钟比对一次时间"
// 引入一个包不划算，而且它的表达式语法对"每天 8 点提醒我"这种需求是负担。

const TICK_MS = 20_000; // 20s 一次。必须 < 60s，否则会漏掉整分钟。

const pad = (n) => String(n).padStart(2, "0");
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeKey = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
// 截断到分钟的时间戳，作为"这一分钟是否已触发过"的幂等键。
const minuteStamp = (d) => Math.floor(d.getTime() / 60_000) * 60_000;

function loadJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

// ——任务文件的读写。给指令路径用，与调度器共用同一份文件。——

export function loadJobs(path) {
  const raw = loadJson(path, null);
  if (!raw) return [];
  return Array.isArray(raw) ? raw : raw.jobs || [];
}

export function saveJobs(path, jobs) {
  saveJson(path, { jobs });
}

// 同一分钟内同名任务只保留一条：重复添加通常是用户连点了两下，
// 或者对同一条提醒换了措辞重发，留两条会变成双倍轰炸。
export function addJob(path, job) {
  const jobs = loadJobs(path).filter((j) => j.name !== job.name);
  jobs.push(job);
  saveJobs(path, jobs);
  return jobs;
}

export function removeJobByIndex(path, index) {
  const jobs = loadJobs(path);
  if (!Number.isInteger(index) || index < 1 || index > jobs.length) return null;
  const [removed] = jobs.splice(index - 1, 1);
  saveJobs(path, jobs);
  return removed;
}

// 按 name 删除。刻意重新读一次文件，而不是复用调用方手里那份数组：
// fire() 发送是异步的，这期间「/提醒」可能刚加了一条，拿旧数组整体覆盖会把它抹掉。
export function removeJob(path, name) {
  const jobs = loadJobs(path);
  const next = jobs.filter((j) => j.name !== name);
  if (next.length === jobs.length) return null; // 已经不在了，重复执行安全
  saveJobs(path, next);
  return jobs.length - next.length;
}

function saveJson(path, data) {
  // 先写临时文件再改名：直接覆盖时若进程被杀，会留下半截 JSON，
  // 下次启动读不出来就静默丢任务。
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, path);
  } catch {
    // 状态写不进去不该让调度器停摆：最坏结果是重启后可能重发一次
  }
}

// 停机期间跨过去的一次性任务不会再被 matches() 命中，启动时顺手清掉，
// 否则用户会在列表里看到一条永远不触发的任务。
//
// 判定不能只看「日期已过」：当天已过点、但停机期间根本没发出去的（比如
// 22:00 的任务在 23:30 才重启）日期仍是今天，按 > 比较会留住它。反过来，
// 时间已过就无脑删又会把这种「其实还没发」的提醒弄丢。两者的分界正好就是
// state 里的幂等键——它非空，说明这一次确实发过了，可以安全清；空着则
// 保留，当天还有机会补发。日期已过的不看 state：任务已经彻底过期。
function scheduledStamp(job) {
  const [y, m, d] = job.date.split("-").map(Number);
  const stamp = new Date(y, m - 1, d, Number(job.time.slice(0, 2)), Number(job.time.slice(3, 5)));
  return Number.isNaN(stamp.getTime()) ? null : stamp.getTime();
}

export function isExpiredOnce(job, state, now) {
  if (!job?.date || !job.time) return false;
  const at = scheduledStamp(job);
  if (at === null) return false;
  if (at >= minuteStamp(now)) return false; // 这一次还没到点
  return at === state[job.name];
}

function matches(job, now) {
  if (job.enabled === false) return false;
  if (!job.time || timeKey(now) !== job.time) return false;
  // date 指定了就只在那一天触发（一次性提醒）
  if (job.date && job.date !== dateKey(now)) return false;
  // weekdays: 0=周日 … 6=周六。不填则每天都触发。
  if (Array.isArray(job.weekdays) && job.weekdays.length && !job.weekdays.includes(now.getDay())) {
    return false;
  }
  return true;
}

// WS 可能正在重连，此时直接 action 会抛"未连接"。启动后前几秒尤其常见，
// 而定时任务错过这一分钟就要等到明天，所以值得重试。
async function sendWithRetry(client, action, params, { tries = 20, gapMs = 250 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      return await client.action(action, params);
    } catch (error) {
      if (!/未连接/.test(error.message) || i === tries - 1) throw error;
      await new Promise((r) => setTimeout(r, gapMs));
    }
  }
}

export function startScheduler({ client, config, log = console.error, jobsPath, statePath }) {
  const JOBS = jobsPath || config.jobsPath;
  const STATE = statePath || `${JOBS}.state`;

  // name -> 已触发的分钟时间戳。持久化是为了扛住 pm2 重启：
  // 若重启恰好发生在触发后的同一分钟内，内存态会丢失并重发一遍。
  const state = loadJson(STATE, {});
  const running = new Set();

  async function generate(job) {
    // 定时任务用**独立会话**（不传 sessionId）。
    // 复用聊天会话会把推送内容混进正常对话上下文，污染用户正在进行的聊天；
    // 反过来，用户聊到一半的内容也会渗进推送里。
    const result = await runClaude({
      exePath: config.claudeExe,
      baseUrl: config.claudeBaseUrl,
      authToken: config.claudeAuthToken,
      homeDir: config.claudeHome,
      cwd: config.claudeCwd,
      mcpConfigPath: config.claudeMcpConfig,
      prompt: job.prompt,
      sessionId: null,
      allowedTools: config.allowedTools,
      timeoutMs: config.timeoutMs,
      mcpTimeoutMs: config.mcpTimeoutMs,
      role: job.role || "admin",
      model: job.model || config.claudeModel,
    });
    return (result.text || "").trim();
  }

  async function fire(job, now) {
    if (running.has(job.name)) {
      log(`[定时] ${job.name} 上一轮还没跑完，跳过本次`);
      return;
    }
    running.add(job.name);
    state[job.name] = minuteStamp(now);
    saveJson(STATE, state);

    const started = Date.now();
    try {
      const text = job.text != null ? String(job.text) : await generate(job);
      if (!text) {
        log(`[定时] ${job.name} 生成了空内容，放弃发送`);
        return;
      }
      const limit = config.maxReplyChars || 3500;
      const body =
        text.length > limit
          ? `${text.slice(0, limit)}\n（内容过长，已截断）`
          : text;

      const isGroup = job.target?.type === "group";
      // 有 attendee 时发真正的 @（消息段数组），不是文本「@张三」——后者在
      // QQ 里只是普通文字，不会给对方任何提醒。只有群聊能 @ 人，私聊保持纯文本。
      const message =
        isGroup && job.attendee?.qq
          ? [
              { type: "at", data: { qq: String(job.attendee.qq) } },
              { type: "text", data: { text: " " + body } },
            ]
          : body;
      const params = isGroup
        ? { group_id: Number(job.target.id), message }
        : { user_id: Number(job.target?.id), message };

      const sent = await sendWithRetry(
        client,
        isGroup ? "send_group_msg" : "send_private_msg",
        params,
      );
      const ms = Date.now() - started;
      if (sent?.status === "ok") {
        log(`[定时] ${job.name} 已推送给 ${job.target?.type}:${job.target?.id}（${ms}ms）`);
        // 发完即删只针对一次性任务（带 date）：它此后再也不会被 matches() 命中，
        // 留着只会在 /提醒 列表里显示成一条永久过期的任务。
        // 每天重复/按星期重复的任务不带 date，原样保留。
        // 顺序上必须晚于上面 state 的落盘：进程若在删除落盘后被强杀，重启时
        // state 还在，不会重发；反过来则可能「既没发也没了」。
        if (job.date) {
          try {
            removeJob(JOBS, job.name);
          } catch (error) {
            // 清理失败不能把一次成功的发送降级成失败，任务留在文件里等下轮兜底
            log(`[定时] ${job.name} 已发送但清理失败: ${error.message}`);
          }
        }
      } else {
        log(`[定时] ${job.name} 发送失败: ${JSON.stringify(sent)}`);
      }
    } catch (error) {
      log(`[定时] ${job.name} 执行失败: ${error.message}`);
    } finally {
      running.delete(job.name);
    }
  }

  function tick() {
    const raw = loadJson(JOBS, null);
    if (!raw) return; // 文件缺失/损坏：安静跳过，下次 tick 再试
    const jobs = Array.isArray(raw) ? raw : raw.jobs || [];
    const now = new Date();
    for (const job of jobs) {
      if (!job?.name || !matches(job, now)) continue;
      if (state[job.name] === minuteStamp(now)) continue; // 这一分钟已发过
      fire(job, now);
    }
  }

  if (!existsSync(JOBS)) {
    log(`[定时] 未找到 ${JOBS}，调度器空转（建好文件后重启生效）`);
  }

  try {
    const now = new Date();
    const alive = [];
    let dropped = 0;
    for (const job of loadJobs(JOBS)) {
      if (isExpiredOnce(job, state, now)) {
        dropped++;
        continue;
      }
      alive.push(job);
    }
    if (dropped) {
      saveJobs(JOBS, alive);
      // 删掉的 job 名生成的 state 键再也不会被引用，一并清掉，否则只增不减
      const names = new Set(alive.map((j) => j.name));
      for (const key of Object.keys(state)) {
        if (!names.has(key)) delete state[key];
      }
      saveJson(STATE, state);
      log(`[定时] 清理了 ${dropped} 条已过期的一次性任务`);
    }
  } catch (error) {
    log(`[定时] 启动清理失败: ${error.message}`);
  }

  const timer = setInterval(tick, TICK_MS);
  timer.unref?.(); // 不因为这个定时器阻止进程退出
  tick(); // 启动时立刻检查一次：正好卡在目标分钟启动也能触发

  return { stop: () => clearInterval(timer), tick };
}
