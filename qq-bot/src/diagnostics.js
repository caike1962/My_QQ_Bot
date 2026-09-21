// /诊断 的报告渲染。
//
// 为什么走代码路径而不是问模型：要回答的正是「模型没反应 / 卡住了」这类问题，
// 把诊断交给模型等于排在同一条串行队列后面才轮得到——而队列被占满的时候，
// 恰恰是最需要诊断的时候。
//
// 为什么单独一个文件：这里全是纯函数（输入采集到的快照，输出文本），
// 不碰网络也不碰进程，边界情况（空队列、刚启动、会话文件读不到）都能用单测钉死。
// 数据采集在 index.js —— 那里才拿得到运行中的内存态。
//
// 输出原则：**只说当下**。配置项不列（配置错了重启后症状恒定，看启动日志更直接），
// 只列需要等一等才看得出来、或者靠人眼读日志读不出来的东西——已运行时长、
// 子进程年龄、队列里有没有滞留条目、会话文件多大。

import { truncate } from "./session.js";

const pad = (n) => String(n).padStart(2, "0");
const hhmmss = (t) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

export function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}分${s % 60}秒` : `${m}分`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}时${m % 60}分` : `${h}时`;
  return `${Math.floor(h / 24)}天${h % 24}时`;
}

export function fmtMb(mb) {
  return Number.isFinite(mb) ? `${mb.toFixed(2)} MB` : "读取失败";
}

export function fmtClock(t) {
  if (!Number.isFinite(t)) return "?";
  const d = new Date(t);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hhmmss(t)}`;
}

const short = (id) => String(id || "?").slice(0, 8);

// 截断一律走 session.js 的 truncate：它保证不切开代理对。
// 报告里会出现用户发的中文和 emoji，用裸 slice 会落盘成 �。
const cut = (text, max = 40) => truncate(String(text ?? "").replace(/\s+/g, " ").trim(), max);

// 会话键的可读形式。
//
// 关掉群共享会话时 key 是「群号:QQ号」，直接显示会看得人发懵——那两个数字
// 看着就像任意 ID。标上 g=/u= 之后一眼能认出这是"某人在某群里的独立会话"。
export function keyLabel(key, memberCount) {
  const s = String(key);
  const shared = /^group:(\d+)$/.exec(s);
  if (shared) {
    return memberCount ? `群${shared[1]}(${memberCount}人)` : `群${shared[1]}`;
  }
  const perUser = /^(\d+):(\d+)$/.exec(s);
  if (perUser) return `群${perUser[1]}·用户${perUser[2]}`;
  const priv = /^private:(\d+)$/.exec(s);
  if (priv) return `私聊${priv[1]}`;
  return s;
}

// 每行都带时间戳。日志里没有时间戳是这台机器排查时的老毛病，诊断输出不重复它。
const line = (t, text) => `  ${hhmmss(t)} ${text}`;

// —— 各节 ——
//
// 返回 null 和返回空数组含义不同：
//   null    = 这一节无事可报，连标题都不显示
//   空数组  = 显示标题但下面没有行（用于明确宣告"这条链路是通的"，如空队列）

function sectionRuntime(s, now) {
  const recv =
    s.lastRecvAt == null
      ? "本次启动还没收到过消息"
      : `最后收到消息于 ${fmtDur(now - s.lastRecvAt)}前`;
  const lines = [
    `  pid=${s.pid}｜WebSocket ${s.ws}`,
    `  已运行 ${fmtDur(now - s.startedAt)}｜${recv}`,
  ];
  if (s.queuedSinceBoot) lines.push(`  自启动已回复 ${s.queuedSinceBoot} 条消息（命令不计入）`);
  return lines;
}

// 子进程。这一节专门回答「机器人还在跑吗、跑多久了」——
// 历史盲区：claude 子进程卡死时，外面只能靠任务管理器人工比对进程年龄。
// 正常时刻本就该是空的（跑完即摘除），空着本身就是「没有卡住的进程」。
//
// 注意 done=true 时**不能**说"正在收尾"——记录里没有 close 的时刻，
// 说正在收尾是编的。它只意味着"已经 close 了"，进程大概率早没了。
function sectionProcesses(procs, now) {
  if (!procs.length) return null;
  return procs.map(
    (p) =>
      `  pid=${p.pid} 已运行 ${fmtDur(now - p.startedAt)}` +
      `${p.done ? "（已结束）" : ""}｜${cut(p.label || "会话未知", 32)}`,
  );
}

function sectionExec(execList, now, mergeWindowMs) {
  if (!execList.length) return null;
  // 这里只给"谁、跑了多久、用哪条会话"——正在做什么交给【任务】节，
  // 两节都打一遍 prompt 会让行超长，而且真正需要看内容的时候
  // 【任务】那一行紧跟子进程 pid，信息更完整。
  return execList.map((e) => {
    const age = now - e.startedAt;
    // 超过合并窗口 = 已不可能被合并打断；再久就是「这条为什么还不回」的答案
    const flag = age > mergeWindowMs ? "（已超出合并窗口，不会被合并打断）" : "";
    return line(
      e.startedAt,
      `${keyLabel(e.key, e.memberCount)} 运行 ${fmtDur(age)}${flag}` +
        `｜会话 ${e.sessionId ? short(e.sessionId) : "未建立"}`,
    );
  });
}

// 后台压缩。它解释的是"为什么这条会话的下一条消息会很慢"——
// 没有这一节，那几分钟里的诊断看起来就是"什么都没在跑"。
function sectionCompacting(list, now) {
  if (!list.length) return null;
  return list.map((c) =>
    line(
      c.startedAt,
      `${keyLabel(c.key, c.memberCount)} 正在压缩会话 ${short(c.sessionId)}（已 ${fmtDur(now - c.startedAt)}）` +
        `——这条会话的下一条会明显变慢`,
    ),
  );
}

function sectionQueue(entries, now, mergeWindowMs) {
  if (!entries.length) return []; // 空队列要显示出来，它是"链路通畅"的证据

  const byKey = new Map();
  for (const e of entries) {
    const list = byKey.get(e.key) || [];
    list.push(e);
    byKey.set(e.key, list);
  }

  const rows = [];
  for (const [key, list] of byKey) {
    const count = (status) => list.filter((e) => e.status === status).length;
    const queued = count("queued");
    const merging = count("merging");
    const pending = count("notified");
    const oldest = Math.min(...list.map((e) => e.at).filter(Number.isFinite));

    const bits = [];
    if (queued) bits.push(`${queued} 排队`);
    if (merging) bits.push(`${merging} 已并入`);
    if (pending) bits.push(`${pending} 待回「继续」`);

    const age = now - oldest;
    // 排队超过合并窗口还没轮到，说明前面那条跑得比预期久——这是
    // 「我发的消息怎么还没回」在队列层面的直接答案，不必再翻日志。
    const stuck = queued && age > mergeWindowMs;
    rows.push(
      line(
        oldest,
        `${keyLabel(key)}｜${bits.join("，")}｜最久 ${fmtDur(age)}${stuck ? " ⚠ 排队超过合并窗口" : ""}`,
      ),
    );
  }
  return rows;
}

function sectionSessions(sessionMeta, compactMb, maxMb) {
  if (!sessionMeta.length) return null;
  return sessionMeta.map((s) => {
    const head = `  ${keyLabel(s.key, s.memberCount)}｜会话 ${short(s.sessionId)}｜`;
    if (s.sizeMb === null) return `${head}文件不存在（下条会开新会话）`;
    if (!Number.isFinite(s.sizeMb)) return `${head}读取失败`;
    const flag =
      s.sizeMb >= maxMb
        ? ` ⚠ 超过上限 ${maxMb} MB，下条将开新会话`
        : s.sizeMb >= compactMb
          ? ` ⚠ 达到压缩阈值 ${compactMb} MB`
          : "";
    return `${head}${fmtMb(s.sizeMb)}${flag}`;
  });
}

function sectionActivity(activity, now) {
  if (!activity.length) return null;

  const withTime = activity.filter((a) => Number.isFinite(a.lastRecv));
  // 全部会话都还没收到消息时，逐条列出来只是 N 行一模一样的话。
  // 压成一行汇总——它仍然有用：说明"消息链路还没被走通过"，
  // 而这恰恰是刚启动或链路有问题时最该确认的事。
  if (!withTime.length) {
    return [`  跟踪 ${activity.length} 个会话，本次启动都还没收到过消息`];
  }

  const rows = [];
  for (const a of withTime) {
    const label = keyLabel(a.key, a.memberCount);
    rows.push(line(a.lastRecv, `${label} 最后收到：${cut(a.lastText)}`));
    if (Number.isFinite(a.lastReply)) {
      rows.push(line(a.lastReply, `  ↳ 回复耗时 ${fmtDur(a.lastReply - a.lastRecv)}`));
    }
  }
  return rows;
}

function sectionDeps(deps) {
  const rows = [];
  if (deps?.proxy) {
    rows.push(
      deps.proxy.ok
        ? "  cc-switch 代理可连接"
        : `  ⚠ cc-switch 代理连不上（${cut(deps.proxy.error, 40)}）——所有消息都会失败`,
    );
  }
  rows.push(deps?.claudeExe ? "  claude.exe 存在" : "  ⚠ 找不到 claude.exe（检查 QQ_CLAUDE_EXE）");
  return rows;
}

function sectionFiles(files) {
  const rows = [];
  if (files?.queueFile === null) {
    rows.push("  queue.json 不存在（还没入队过任何消息）");
  } else if (Number.isFinite(files?.queueFile?.sizeMb)) {
    const mb = files.queueFile.sizeMb;
    rows.push(
      mb > 0.2
        ? `  ⚠ queue.json ${fmtMb(mb)}（正常是个位数条目，涨到 1MB 会整体丢弃）`
        : `  queue.json ${fmtMb(mb)}`,
    );
  }
  if (files?.jobsFile) rows.push(`  定时任务 ${files.jobsFile.count} 条`);
  if (files?.pendingFiles) {
    rows.push(
      `  待处理文件缓存 ${files.pendingFiles} 个会话（TTL 5 分钟）` +
        (files.staleFiles ? `，其中 ${files.staleFiles} 个已过期` : ""),
    );
  }
  if (files?.pendingRetry) rows.push(`  待重放条目 ${files.pendingRetry} 条（等用户回「继续」）`);
  if (files?.bgPending) rows.push(`  待注入的后台结果 ${files.bgPending} 条`);
  if (files?.workspace) rows.push(`  工作目录 workspace：${files.workspace}`);
  return rows;
}

// 后台任务。与【执行】分开：后台任务**不占用会话**，混在一起会让人
// 以为聊天被堵住了，而它恰恰不堵。
function sectionBackground(tasks, now) {
  if (!tasks?.length) return null;
  const rows = [];
  for (const t of tasks) {
    const conv = String(t.conv || "").replace("private:", "私聊").replace("group:", "群");
    if (t.status === "running") {
      const secs = Math.round((now - (t.startedAt || now)) / 1000);
      rows.push(`  ${conv} ${fmtDur(secs * 1000)}｜${truncate(t.prompt, 30)}`);
    } else if (t.status === "done" && !t.injected) {
      rows.push(`  ${conv} 已完成待注入｜${truncate(t.prompt, 30)}`);
    }
  }
  return rows.length ? rows : null;
}

// 各节按显示顺序排列。cuttable 的节在报告超长时会被整节砍掉。
//
// 【运行】和【依赖】永远不砍——代理不通、进程没在跑，是诊断最该
// 先说出口的两件事，砍掉它们等于报告白出。
const SECTIONS = [
  ["运行", (s, now) => sectionRuntime(s, now), false],
  ["依赖", (s) => sectionDeps(s.deps), false],
  ["任务", (s, now) => sectionProcesses(s.processes ?? [], now), true],
  ["执行", (s, now) => sectionExec(s.execs ?? [], now, s.mergeWindowMs), true],
  ["后台", (s, now) => sectionBackground(s.background ?? [], now), true],
  ["压缩", (s, now) => sectionCompacting(s.compacting ?? [], now), true],
  ["队列", (s, now) => sectionQueue(s.queueEntries ?? [], now, s.mergeWindowMs), true],
  ["会话", (s) => sectionSessions(s.sessionMeta ?? [], s.sessions?.compactMb, s.sessions?.maxMb), true],
  ["最近", (s, now) => sectionActivity(s.activity ?? [], now), true],
  ["文件", (s) => sectionFiles(s.files), true],
];

// 砍的顺序**与显示顺序无关**，按"损失最小"排：先砍最长的、最不影响判断的。
//
// 【最近】排第一不只是因为它最长（每个会话两行），也因为它最可能误导：
// 会话文件里的记录时间是"用户说的那一刻"，跨重启仍然显示，
// 而用户真正想知道的是"现在为什么没回复"。
//
// 【后台】排在【压缩】之前砍：它回答的是"这个进程现在在干什么"，
// 而诊断存在的意义正在于此，所以该晚点砍。
const CUT_ORDER = ["最近", "会话", "队列", "文件", "压缩", "后台", "任务", "执行"];

function compose(rows, startedAt, total) {
  const lines = [`诊断（${fmtClock(startedAt)}）`];
  for (const [title, rows_] of rows) {
    if (rows_ === null) continue;
    lines.push(`【${title}】`, ...rows_);
  }
  if (total) lines.push(total);
  return lines.join("\n");
}

export function buildDiagnostic(state) {
  const now = Number.isFinite(state?.now) ? state.now : Date.now();
  let built = SECTIONS.map(([title, fn, cuttable]) => [title, fn(state, now), cuttable]);

  // 刚启动时最有用的不是任何一项数值，而是"现在连不上属正常"这个结论——
  // 开机后 NapCat 要 40~60 秒才监听 3001，这期间日志里全是重连，
  // 不知道这件事的话每次都会误判成故障。
  if (state?.bootRecent) {
    built.splice(1, 0, [
      "提示",
      ["  刚启动不足 3 分钟：这段时间连不上 3001 属正常，约 40~60 秒后稳定"],
      false,
    ]);
  }

  const total =
    state.queueTotal > (state.queueEntries ?? []).length
      ? `（队列共 ${state.queueTotal} 条，上面只列了前 ${state.queueEntries.length} 条）`
      : null;

  let shown = built;
  let text = compose(shown, now, total);

  // 每砍一节都要**重新组装再判断**：砍掉低优先级的一节可能还不够，
  // 得接着砍下一节。只砍一次就返回的话，超长内容会原样发出去被 QQ 拒收。
  const omitted = [];
  for (const title of CUT_ORDER) {
    if (text.length <= 3200) break;
    if (!shown.some(([t]) => t === title)) continue;
    shown = shown.filter(([t]) => t !== title);
    omitted.push(title);
    text =
      compose(shown, now, total) +
      `\n（内容过长，已省略：${omitted.map((t) => `「${t}」`).join("、")}）`;
  }
  return text;
}
