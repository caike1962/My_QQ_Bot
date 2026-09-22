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
//   08:00 喝水                  ← 省略重复描述 = 只提醒一次（最近的那个时间点）
//   明天 晚上九点 @张三 去吃饭    ← 口语时间 + 被提醒的人
//
// 时间接受 24 小时制 HH:MM，也接受口语写法（晚上九点 / 下午三点半 / 九点四十五分），
// 后者由 parseOralClock 归一成 HH:MM。日期前缀形式（2026-09-22 15:30）里同时出现
// 两组数字，所以解析顺序必须是「先认日期、再认时间」，否则 09-22 会被误读成
// 9 点 22 分。

const WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

// 「这周四 / 本周四 / 下周四」——指某一天，与裸写的「周四」（每周四）不是一回事。
// 「这个周四」这种多一个字的说法也收，中文里很常见。
const REL_WEEKDAY_RE = /^(这|本|下|下个|这个)(周[一二三四五六日天])$/;

// 「每周四 / 每个周四」——显式的每周重复，与裸写的「周四」等价。
//
// 之所以要收：自然语言提醒那条路径上，用户会说「每周四下午4点提醒…」，
// 而「每周四」比裸写的「周四」更不容易被模型漏掉那个"每周"的意思。
// 不收的话模型照原话翻译过来就会解析失败——那正是本功能最不该发生的失败。
const EVERY_WEEKDAY_RE = /^(?:每|每个)(周[一二三四五六日天])$/;

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

// ---- 口语时间（"晚上九点" / "下午三点半"）----
//
// 只在 HH:MM 认不出来时才走这里（见 parseReminder 的调用顺序），
// 所以不必担心它抢走 08:30 这类写法。
//
// 中文数字只做到「十位 + 个位」的组合（一 → 九十九），不做万/亿那套通用解析：
// 提醒里出现的数字不会超过 59，够用且没有歧义。
const CN_DIGIT = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function cnNumber(token) {
  if (/^\d+$/.test(token)) return Number(token);
  const ten = /^([一二三四五六七八九])?十([一二三四五六七八九])?$/.exec(token);
  if (ten) return (ten[1] ? CN_DIGIT[ten[1]] : 1) * 10 + (ten[2] ? CN_DIGIT[ten[2]] : 0);
  return CN_DIGIT[token] ?? null;
}

// 时段词决定小时落在上午还是下午。两个看起来像笔误、其实是中文约定的边界：
// 「晚上12点」是 00:00，「下午12点」是 12:00。「中午」只把 1-2 点挪到下午
// （中午1点 = 13:00），再大的数字按字面——「中午3点」不是常见说法，
// 与其猜成 15:00，不如让它保持 03:00 这种可预期的结果。
function hourOf(period, hour) {
  if (!period) return hour;
  if (period === "凌晨") return hour === 12 ? 0 : hour;
  if (period === "早上" || period === "上午") return hour;
  if (period === "中午") return hour <= 2 ? hour + 12 : hour;
  if (period === "下午" || period === "傍晚") return hour === 12 ? 12 : hour + 12;
  return hour === 12 ? 0 : hour + 12; // 晚上 / 夜里 / 晚间
}

// 末尾那个"裸数字"分支（"九点30"）必须**紧贴**在「点」后面。留了空格时
// （"八点 3个人集合"）那更可能是正文的开头，不是分钟。
// 分钟那组刻意写成并列的捕获组而不是外层再套一层括号：套了之后"有没有写分钟"
// 就无从判断——外层组只要匹配成功就非空，"九点十五分"会被当成"九点半"。
//
// 「钟」是可选的尾巴：「4点钟」是极常见的口语说法，不吃掉它的话那个「钟」
// 会漏进正文（"钟 @张总 去占位置"），把后面的 @ 对象顶掉。
const ORAL_RE = new RegExp(
  "^(?:(凌晨|早上|上午|中午|下午|傍晚|晚上|夜里|晚间)\\s*)?" +
    "([0-9]{1,2}|[一二三四五六七八九十两]{1,3})\\s*[点时]钟?" +
    "(?:(半)|([0-9]{1,2})\\s*分|([一二三四五六七八九十]{1,3})\\s*分|([0-9]{1,2}))?",
);

// 返回 { time, length } 或 null。length 是匹配掉的字符数，供调用方切出正文。
function parseOralClock(text) {
  const m = ORAL_RE.exec(text);
  if (!m) return null;
  const hour = cnNumber(m[2]);
  if (hour === null) return null;
  const rawMin = m[3] !== undefined ? "30" : (m[4] ?? m[5] ?? m[6]);
  const minute = rawMin === undefined ? 0 : cnNumber(rawMin);
  if (minute === null) return null;
  const h = hourOf(m[1] || null, hour);
  if (h < 0 || h > 23 || minute < 0 || minute > 59) return null;
  return { time: `${pad(h)}:${pad(minute)}`, length: m[0].length };
}

// 返回 { job } 或 { error }。error 是给用户看的中文说明。
export function parseReminder(text, { now = new Date() } = {}) {
  const raw = (text || "").trim().replace(/^\/提醒\s*/, "").trim();
  if (!raw) return { error: "要提醒什么？格式：/提醒 每天 08:00 内容" };

  const parts = raw.split(/\s+/);
  let cursor = 0;
  let date = null; // 指定日期 = 一次性
  let weekdays = null; // 指定星期 = 每周重复
  let daily = false; // 显式写了「每天」
  let weekdayMatch = null; // 星期类正则的匹配结果（每周X / 这X）
  // 只用来写回执：用户没给日期（或给的是「明天」这种相对说法）时，回执里
  // 复述他的原话，而不是我们换算出来的那个日期。不落盘（见 index.js）。
  let dateHint = null;

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
    dateHint = first;
    cursor++;
  } else if (first === "每天") {
    daily = true;
    cursor++;
  } else if (first === "工作日" || first === "周一至周五") {
    weekdays = [1, 2, 3, 4, 5];
    cursor++;
  } else if ((weekdayMatch = EVERY_WEEKDAY_RE.exec(first || ""))) {
    // 每周四 / 每个周四 —— 与裸写的「周四」同义，显式的每周重复。
    const idx = WEEKDAY_NAMES.indexOf(weekdayMatch[1] === "周天" ? "周日" : weekdayMatch[1]);
    weekdays = [idx];
    cursor++;
  } else if ((weekdayMatch = REL_WEEKDAY_RE.exec(first || ""))) {
    // 这周四 / 本周四 / 这个周四 / 下周四 —— 指**某一天**，不是每周。
    // 与裸写的「周四」（= 每周四）语义不同，所以单独一条分支，落到 date 上
    // 自然继承「发完即删」的一次性行为。
    const idx = WEEKDAY_NAMES.indexOf(weekdayMatch[2] === "周天" ? "周日" : weekdayMatch[2]);
    if (idx === -1) return { error: `星期写法不认识：${weekdayMatch[2]}` };
    const isNext = weekdayMatch[1] === "下" || weekdayMatch[1] === "下个";
    const daysUntil = (idx - now.getDay() + 7) % 7 + (isNext ? 7 : 0);
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysUntil);
    date = dateKey(d);
    // 回执不能照抄原话：「这周一」在周二说，实际已顺延到下周，照抄就是错的。
    // 按换算结果重新措辞——说错日期比说得不自然糟得多。
    const daysToSunday = (7 - now.getDay()) % 7;
    dateHint =
      daysUntil === 0
        ? "今天"
        : daysUntil === 1
          ? "明天"
          : `${daysUntil > daysToSunday ? "下" : "这"}${WEEKDAY_NAMES[idx]}`;
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

  // 2) 时间：先认 HH:MM，认不出来再试口语写法。
  //
  // 顺序不能反：口语写法里的「点」会把 09:22 这类数字整个吃掉。
  // 口语匹配的锚点是**剩下的整串**而不是单个词，这样「晚上 九点」这种
  // 中间带空格的写法也能认，代价是正文不能以时间形状的词开头——那本来
  // 也不该出现在时间的位置上。
  const rest = parts.slice(cursor).join(" ");
  const head = parts[cursor] || "";
  let time = parseClock(head);
  let bodyText = "";
  if (time) {
    bodyText = rest.slice(head.length).trim();
  } else {
    const oral = parseOralClock(rest);
    if (oral) {
      time = oral.time;
      bodyText = rest.slice(oral.length).trim();
    }
  }

  if (!time) {
    if (cursor === 0) {
      // 第一个词既不是日期也不是时间
      return { error: `没看懂时间。格式：/提醒 每天 08:00 内容（支持的写法：每天/工作日/周一/明天/今天/2026-09-22，时间也可以写「晚上九点」）` };
    }
    if (/^\d/.test(head) || /[点时]/.test(head)) {
      // 位置上有东西、且形状像时间（以数字开头，或含「点/时」），说明用户写了
      // 时间但值不合法（25:00、08:70、晚上二十五点）。单独报这一句，
      // 比笼统说"缺少时间"更容易定位。
      return { error: `时间写法不对：${head}。要用 24 小时制的 HH:MM（例如 08:30），或口语写法（晚上九点）` };
    }
    return { error: "缺少时间，例如：/提醒 明天 08:00 内容" };
  }

  // 3) 被提醒的人（可选）：紧跟在时间后面的「@名字」或「@号码」。
  //
  // 为什么名字必须带 @ 前缀：正文里恰好出现一个人名（「提醒我 张三 还欠钱」）
  // 不该被当成"提醒张三"。号码写法是私聊里唯一的办法——私聊拿不到群成员列表，
  // 按名字查不了人。
  //
  // 名字后面必须跟空格：「@张三去吃饭」无法切分，宁可报错让用户加空格，
  // 也不要猜错对象——提醒发错人比提醒失败更糟。
  let attendee = null;
  const am = /^@(\S{1,24})(?:\s+([\s\S]*))?$/.exec(bodyText);
  if (am) {
    if (!am[2]?.trim()) {
      return { error: "没看懂 @ 的对象。写成「/提醒 明天 21:00 @张三 去吃饭」，@ 和名字之间、名字和内容之间都要有空格" };
    }
    attendee = /^\d{5,12}$/.test(am[1])
      ? { qq: Number(am[1]), name: null }
      : { qq: null, name: am[1] };
    bodyText = am[2].trim();
  }

  if (!bodyText) return { error: "缺少提醒内容，例如：/提醒 每天 08:00 起床" };

  // 4) 没写「每天」也没写星期 = 只提醒一次，取最近的那个时间点（今天还没到
  //    就今天，过了就明天）。这是「记得晚上九点提醒我」的语感，也让这条任务
  //    发完即删，不会第二天再响一遍。要重复就明写「每天」或「周一」。
  //
  //    dateHint 只用来写回执：用户没说日期，回执里就该说「今天/明天」而不是
  //    一个他自己没打过的日期。不落盘（见 index.js）。
  if (!date && !weekdays && !daily) {
    const [h, m] = time.split(":").map(Number);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
    const isToday = today.getTime() > now.getTime();
    const at = isToday ? today : new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, h, m);
    date = dateKey(at);
    dateHint = isToday ? "今天" : "明天";
  }

  // 指定了具体日期但时间已过：直接提示，避免建一个永远不触发的任务
  if (date) {
    const target = new Date(`${date}T${time}:00`);
    if (target.getTime() <= now.getTime()) {
      return { error: `${date} ${time} 已经过去了，换个时间吧` };
    }
  }

  return { job: { time, date, weekdays, text: bodyText, attendee, dateHint } };
}
