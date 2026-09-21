// 定时提醒的自然语法解析。
//
// 为什么走代码路径而不是交给模型：写 jobs.json 是状态变更，
// 与项目里「加人/移出用户」同理——必须确定性执行，不能依赖一个
// 可能在工具被拒时编造结果的模型。模型负责理解意图，落到具体的时间字段
// 这一步由代码做，两边各司其职。
//
// 支持的写法（时间在前，内容在后）：
//   每天 08:00 起床
//   工作日 09:00 开站会
//   周一,周三 20:00 健身
//   2026-09-22 15:30 交材料
//   明天 08:00 买早饭
//   今天 22:30 吃药
//   08:00 喝水            ← 省略时间描述 = 每天
//
// 时间一律 24 小时制 HH:MM。因为日期前缀形式（2026-09-22 15:30）里
// 同时出现两组数字，解析顺序必须是「先认日期、再认时间」，
// 否则 09-22 会被误读成 9 点 22 分。

const WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const pad = (n) => String(n).padStart(2, "0");
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function parseClock(token) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(token || "");
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${pad(h)}:${pad(min)}`;
}

// 返回 { job } 或 { error }。error 是给用户看的中文说明。
export function parseReminder(text, { now = new Date() } = {}) {
  const raw = (text || "").trim().replace(/^\/提醒\s*/, "").trim();
  if (!raw) return { error: "要提醒什么？格式：/提醒 每天 08:00 内容" };

  const parts = raw.split(/\s+/);
  let cursor = 0;
  let date = null; // 指定日期 = 一次性
  let weekdays = null; // 指定星期 = 每周重复

  const first = parts[cursor];

  // 1) 绝对日期 YYYY-MM-DD
  const dm = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(first || "");
  if (dm) {
    const [, y, mo, d] = dm;
    const probe = new Date(Number(y), Number(mo) - 1, Number(d));
    if (probe.getMonth() !== Number(mo) - 1 || probe.getDate() !== Number(d)) {
      return { error: `日期不存在：${first}` };
    }
    date = `${y}-${pad(Number(mo))}-${pad(Number(d))}`;
    cursor++;
  } else if (first === "今天" || first === "明天" || first === "后天") {
    const offset = first === "今天" ? 0 : first === "明天" ? 1 : 2;
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    date = dateKey(d);
    cursor++;
  } else if (first === "每天") {
    cursor++;
  } else if (first === "工作日" || first === "周一至周五") {
    weekdays = [1, 2, 3, 4, 5];
    cursor++;
  } else if (/^周[一二三四五六日天]([,，]周?[一二三四五六日天])*$/.test(first || "")) {
    // 周一 / 周一,周三 / 周一，周三
    const names = first.split(/[,，]/);
    const days = [];
    for (const n of names) {
      const name = n.startsWith("周") ? n : `周${n}`;
      const idx = WEEKDAY_NAMES.indexOf(name === "周天" ? "周日" : name);
      if (idx === -1) return { error: `星期写法不认识：${n}` };
      days.push(idx);
    }
    weekdays = [...new Set(days)].sort();
    cursor++;
  }

  // 2) 时间 HH:MM
  let time = parseClock(parts[cursor]);
  if (time) {
    cursor++;
  } else if (cursor === 0) {
    // 第一个词既不是日期也不是时间
    return { error: `没看懂时间。格式：/提醒 每天 08:00 内容（支持的写法：每天/工作日/周一/明天/今天/2026-09-22）` };
  } else if (/^\d/.test(parts[cursor] || "")) {
    // 位置上有东西、且以数字开头，说明用户写了时间但格式不对（如 25:00、08:70）。
    // 单独报这一句，比笼统说"缺少时间"更容易定位。
    return { error: `时间写法不对：${parts[cursor]}。要用 24 小时制的 HH:MM，例如 08:30` };
  } else {
    return { error: "缺少时间，例如：/提醒 明天 08:00 内容" };
  }

  const body = parts.slice(cursor).join(" ").trim();
  if (!body) return { error: "缺少提醒内容，例如：/提醒 每天 08:00 起床" };

  // 指定了具体日期但时间已过：直接提示，避免建一个永远不触发的任务
  if (date) {
    const target = new Date(`${date}T${time}:00`);
    if (target.getTime() <= now.getTime()) {
      return { error: `${date} ${time} 已经过去了，换个时间吧` };
    }
  }

  return { job: { time, date, weekdays, text: body } };
}
