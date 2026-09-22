import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReminder } from "../src/reminders.js";

// 固定"现在"，否则测试在跨日/跨年时会飘。
const NOW = new Date(2026, 8, 21, 10, 0, 0); // 2026-09-21 周一 10:00

const ok = (text) => {
  const r = parseReminder(text, { now: NOW });
  assert.ok(r.job, `期望解析成功，实际: ${r.error}`);
  return r.job;
};
const err = (text) => {
  const r = parseReminder(text, { now: NOW });
  assert.ok(r.error, `期望解析失败，实际解析出: ${JSON.stringify(r.job)}`);
  return r.error;
};

test("每天 HH:MM", () => {
  const j = ok("/提醒 每天 08:00 起床");
  assert.equal(j.time, "08:00");
  assert.equal(j.text, "起床");
  assert.equal(j.date, null);
  assert.equal(j.weekdays, null);
});

test("省略重复描述时默认只提醒一次（最近的那个时间点）", () => {
  // NOW 是 10:00，08:00 已经过了 —— 落到明天，而不是"每天 08:00"。
  const j = ok("/提醒 08:00 喝水");
  assert.equal(j.time, "08:00");
  assert.equal(j.text, "喝水");
  assert.equal(j.date, "2026-09-22");
  assert.equal(j.weekdays, null);
});

test("省略重复描述但时间还没到：就落在今天", () => {
  const j = ok("/提醒 22:00 吃药");
  assert.equal(j.date, "2026-09-21");
});

test("显式写「每天」时不推断日期", () => {
  const j = ok("/提醒 每天 08:00 喝水");
  assert.equal(j.date, null);
  assert.equal(j.weekdays, null);
});

// dateHint 只喂回执文案：用户怎么说的就怎么复述，别回显他没用过的日期写法。
test("dateHint：复述用户的原话，不换算成日期", () => {
  assert.equal(ok("/提醒 明天 21:00 开会").dateHint, "明天");
  assert.equal(ok("/提醒 今天 22:00 吃药").dateHint, "今天");
  assert.equal(ok("/提醒 21:00 喝水").dateHint, "今天"); // 10:00 设的，还没到
  assert.equal(ok("/提醒 08:00 喝水").dateHint, "明天"); // 已经过了，落到明天
  assert.equal(ok("/提醒 每天 08:00 喝水").dateHint, null);
  assert.equal(ok("/提醒 2026-10-01 08:00 出发").dateHint, null);
  assert.equal(ok("/提醒 周三 20:00 健身").dateHint, null);
});

test("工作日展开为周一到周五", () => {
  const j = ok("/提醒 工作日 09:30 开站会");
  assert.deepEqual(j.weekdays, [1, 2, 3, 4, 5]);
  assert.equal(j.time, "09:30");
  assert.equal(j.text, "开站会");
});

test("单个星期几", () => {
  const j = ok("/提醒 周三 20:00 健身");
  assert.deepEqual(j.weekdays, [3]);
});

test("多个星期几：逗号与中文逗号都支持，且去重排序", () => {
  assert.deepEqual(ok("/提醒 周三,周一 20:00 健身").weekdays, [1, 3]);
  assert.deepEqual(ok("/提醒 周三，周一 20:00 健身").weekdays, [1, 3]);
  assert.deepEqual(ok("/提醒 周一,周一 20:00 健身").weekdays, [1]);
});

test("周日与周天等价", () => {
  assert.deepEqual(ok("/提醒 周天 20:00 休息").weekdays, [0]);
  assert.deepEqual(ok("/提醒 周日 20:00 休息").weekdays, [0]);
});

test("绝对日期：解析为一次性任务", () => {
  const j = ok("/提醒 2026-10-01 08:00 出发");
  assert.equal(j.date, "2026-10-01");
  assert.equal(j.time, "08:00");
  assert.equal(j.text, "出发");
});

test("日期补零：2027-1-5 归一化成 2027-01-05", () => {
  assert.equal(ok("/提醒 2027-1-5 08:00 交材料").date, "2027-01-05");
});

test("今天/明天/后天按本地日期推算", () => {
  assert.equal(ok("/提醒 今天 22:30 吃药").date, "2026-09-21");
  assert.equal(ok("/提醒 明天 08:00 买早饭").date, "2026-09-22");
  assert.equal(ok("/提醒 后天 08:00 报销").date, "2026-09-23");
});

// —— 相对星期：这周四 / 下周四 ——
//
// 与裸写的「周四」（= 每周四）语义不同：这些指**某一天**，所以落成 date 而不是
// weekdays，自然继承「发完即删」的一次性行为。

test("这周四：本周的那一天，落成一次性 date", () => {
  const j = ok("/提醒 这周四 下午4点 @张总 去占位置");
  assert.equal(j.date, "2026-09-24"); // NOW 是 2026-09-22 周二
  assert.equal(j.weekdays, null);
  assert.equal(j.time, "16:00");
});

test("本周四 / 这个周四 与「这周四」等价", () => {
  assert.equal(ok("/提醒 本周四 16:00 开会").date, "2026-09-24");
  assert.equal(ok("/提醒 这个周四 16:00 开会").date, "2026-09-24");
});

test("下周四：下周的那一天", () => {
  assert.equal(ok("/提醒 下周四 16:00 开会").date, "2026-10-01");
});

test("「这X」已过则顺延到下周", () => {
  // 单独给一个周二，才能构造出"这周一"已经过去的情况——NOW 本身是周一，
  // 从周一看本周任何一天都还没过。
  const tue = new Date(2026, 8, 22, 10, 0, 0); // 2026-09-22 周二
  const at = (text) => parseReminder(text, { now: tue }).job;
  assert.equal(at("/提醒 这周一 16:00 开会").date, "2026-09-28");
  // 顺延之后回执不能照抄"这周一"——那天已经是下周了，说错日期比说得不自然糟
  assert.equal(at("/提醒 这周一 16:00 开会").dateHint, "下周一");
  assert.equal(at("/提醒 这周二 16:00 开会").date, "2026-09-22"); // 当天
  assert.equal(at("/提醒 这周二 16:00 开会").dateHint, "今天");
});

test("「这X」就是今天或明天时按字面走", () => {
  assert.equal(ok("/提醒 这周一 16:00 开会").date, "2026-09-21"); // 今天
  assert.equal(ok("/提醒 这周二 16:00 开会").date, "2026-09-22"); // 明天
});

test("周天与周日等价", () => {
  assert.equal(ok("/提醒 这周天 16:00 开会").date, "2026-09-27");
  assert.equal(ok("/提醒 这周日 16:00 开会").date, "2026-09-27");
});

test("回归：裸写「周四」仍是每周重复（weekdays，不是 date）", () => {
  const j = ok("/提醒 周四 16:00 开会");
  assert.equal(j.date, null);
  assert.deepEqual(j.weekdays, [4]);
});

// 「每周四」是显式的每周重复。自然语言那条路径上用户会这么说，而模型照原话
// 翻译过来必须能解析——不收的话就正好在本功能最不该失败的地方失败。
test("每周四 / 每个周四：显式每周重复，与裸写「周四」等价", () => {
  for (const text of ["/提醒 每周四 16:00 开会", "/提醒 每个周四 16:00 开会"]) {
    const j = ok(text);
    assert.equal(j.date, null, `${text} 不该落成一次性`);
    assert.deepEqual(j.weekdays, [4]);
  }
});

test("每周四 + 口语时间 + @对象：完整自然语言提醒的翻译结果", () => {
  const j = ok("/提醒 每周四 下午4点钟 @张总 去占位置");
  assert.deepEqual(j.weekdays, [4]);
  assert.equal(j.time, "16:00");
  assert.deepEqual(j.attendee, { qq: null, name: "张总" });
  assert.equal(j.text, "去占位置");
});

test("每周天 与 每周日 等价", () => {
  assert.deepEqual(ok("/提醒 每周天 16:00 开会").weekdays, [0]);
});

// dateHint 在相对星期上不能照抄原话：周二说「这周一」实际已顺延到下周，
// 照抄就是错的。所以按换算结果重新措辞——说错日期比说得不自然糟得多。
// （顺延那一条在上面的「这X 已过则顺延」用例里，它需要另一个"现在"。）
test("相对星期的 dateHint 按换算结果措辞，不照抄原话", () => {
  assert.equal(ok("/提醒 这周四 16:00 开会").dateHint, "这周四");
  assert.equal(ok("/提醒 下周四 16:00 开会").dateHint, "下周四");
  assert.equal(ok("/提醒 这周一 16:00 开会").dateHint, "今天"); // NOW 就是周一
  assert.equal(ok("/提醒 这周二 16:00 开会").dateHint, "明天");
});

test("跨月推算正确", () => {
  const end = new Date(2026, 8, 30, 10, 0, 0); // 9-30
  const r = parseReminder("/提醒 明天 08:00 交表", { now: end });
  assert.equal(r.job.date, "2026-10-01");
});

test("内容含空格时完整保留", () => {
  assert.equal(ok("/提醒 每天 08:00 记得 买 牛奶").text, "记得 买 牛奶");
});

test("时间补零：8:05 归一化成 08:05", () => {
  assert.equal(ok("/提醒 每天 8:05 跑步").time, "08:05");
});

// —— 以下为拒绝路径。宁可让用户改写，也不要建出一个永远不会响的任务。——

test("拒绝：不存在的日期", () => {
  assert.match(err("/提醒 2026-02-30 08:00 假的"), /日期不存在/);
});

test("拒绝：过去的时间点", () => {
  assert.match(err("/提醒 2026-09-01 08:00 早过了"), /已经过去/);
});

test("拒绝：今天但时间已过", () => {
  assert.match(err("/提醒 今天 08:00 已经过了"), /已经过去/);
});

test("拒绝：非法时刻", () => {
  // 报错文案分两种：位置上有数字但格式不对 → 时间写法不对；
  // 位置上是别的东西 → 没看懂时间。两条都不能放过。
  assert.match(err("/提醒 每天 25:00 不存在"), /时间写法不对|没看懂时间/);
  assert.match(err("/提醒 每天 08:70 不存在"), /时间写法不对|没看懂时间/);
});

test("拒绝：缺少提醒内容", () => {
  assert.match(err("/提醒 每天 08:00"), /缺少提醒内容/);
});

test("拒绝：只有日期没时间", () => {
  assert.match(err("/提醒 明天 开会"), /缺少时间/);
});

test("拒绝：空内容", () => {
  assert.match(err("/提醒"), /要提醒什么/);
});

test("拒绝：星期写法不认识", () => {
  assert.match(err("/提醒 周八 08:00 不存在"), /没看懂时间|星期写法/);
});

// —— 口语时间 ——

test("口语：晚上九点 → 21:00", () => {
  const j = ok("/提醒 明天 晚上九点 去吃饭");
  assert.equal(j.time, "21:00");
  assert.equal(j.text, "去吃饭");
  assert.equal(j.date, "2026-09-22");
});

test("口语：时段词决定上午还是下午", () => {
  assert.equal(ok("/提醒 每天 早上七点 跑步").time, "07:00");
  assert.equal(ok("/提醒 每天 上午8点 开会").time, "08:00");
  assert.equal(ok("/提醒 每天 中午1点 吃饭").time, "13:00");
  assert.equal(ok("/提醒 每天 下午三点 开会").time, "15:00");
  assert.equal(ok("/提醒 每天 傍晚六点 下班").time, "18:00");
  assert.equal(ok("/提醒 每天 晚上8点 吃饭").time, "20:00");
  assert.equal(ok("/提醒 每天 凌晨1点 睡觉").time, "01:00");
});

test("口语边界：中午12点 = 12:00，晚上12点 = 00:00，凌晨12点 = 00:00", () => {
  assert.equal(ok("/提醒 每天 中午12点 吃饭").time, "12:00");
  assert.equal(ok("/提醒 每天 晚上12点 睡觉").time, "00:00");
  assert.equal(ok("/提醒 每天 凌晨12点 睡觉").time, "00:00");
  assert.equal(ok("/提醒 每天 下午12点 吃饭").time, "12:00");
});

test("口语：没有时段词时按字面小时", () => {
  assert.equal(ok("/提醒 每天 九点 干活").time, "09:00");
  assert.equal(ok("/提醒 每天 21点 干活").time, "21:00");
});

test("口语：X点半 / X点Y分 / X点Y", () => {
  assert.equal(ok("/提醒 每天 九点半 出门").time, "09:30");
  assert.equal(ok("/提醒 每天 晚上九点半 出门").time, "21:30");
  assert.equal(ok("/提醒 每天 九点四十五分 开会").time, "09:45");
  assert.equal(ok("/提醒 每天 九点45分 开会").time, "09:45");
  assert.equal(ok("/提醒 每天 九点30 开会").time, "09:30");
});

test("口语：十位中文数字", () => {
  assert.equal(ok("/提醒 每天 十二点 吃饭").time, "12:00");
  assert.equal(ok("/提醒 每天 晚上十一点 睡觉").time, "23:00");
  assert.equal(ok("/提醒 每天 晚上十点半 睡觉").time, "22:30");
  assert.equal(ok("/提醒 每天 二十三点 睡觉").time, "23:00");
  assert.equal(ok("/提醒 每天 九点十五分 开会").time, "09:15");
});

test("口语：时间词与时段词之间可以有空格", () => {
  assert.equal(ok("/提醒 明天 晚上 九点 去吃饭").time, "21:00");
});

test("口语：非法值被拒绝（不猜一个差不多的时间）", () => {
  assert.match(err("/提醒 每天 晚上二十五点 不存在"), /时间写法不对|没看懂时间/);
  assert.match(err("/提醒 每天 九点七十分 不存在"), /时间写法不对|没看懂时间/);
});

test("口语：HH:MM 仍然优先，不被口语规则抢走", () => {
  assert.equal(ok("/提醒 每天 08:30 起床").time, "08:30");
});

// —— @ 被提醒的人 ——

test("attendee：名字写法解析出待反查的名字，且正文不含 @ 前缀", () => {
  const j = ok("/提醒 明天 21:00 @张三 去吃饭");
  assert.deepEqual(j.attendee, { qq: null, name: "张三" });
  assert.equal(j.text, "去吃饭");
});

test("attendee：号码写法直接可用（私聊里唯一可行的写法）", () => {
  const j = ok("/提醒 明天 21:00 @123456 去吃饭");
  assert.deepEqual(j.attendee, { qq: 123456, name: null });
  assert.equal(j.text, "去吃饭");
});

test("attendee：口语时间后面也能接 @", () => {
  const j = ok("/提醒 明天 晚上九点 @张三 去吃饭");
  assert.equal(j.time, "21:00");
  assert.deepEqual(j.attendee, { qq: null, name: "张三" });
});

test("attendee：不带 @ 时行为不变（null）", () => {
  assert.equal(ok("/提醒 明天 21:00 去吃饭").attendee, null);
  // 正文里恰好有人名不该被当成提醒对象
  const j = ok("/提醒 明天 21:00 提醒我 张三 还欠钱");
  assert.equal(j.attendee, null);
  assert.equal(j.text, "提醒我 张三 还欠钱");
});

test("attendee：@ 后面没写内容 → 拒绝（宁可不发也不猜对象）", () => {
  assert.match(err("/提醒 明天 21:00 @张三"), /没看懂 @ 的对象/);
});

test("attendee：@名字去吃饭 无空格切不开 → 拒绝", () => {
  assert.match(err("/提醒 明天 21:00 @张三去吃饭"), /没看懂 @ 的对象/);
});

test("attendee：内容里可以再出现 @（只认紧跟时间的那个）", () => {
  const j = ok("/提醒 明天 21:00 @张三 把 @李四 也叫上");
  assert.deepEqual(j.attendee, { qq: null, name: "张三" });
  assert.equal(j.text, "把 @李四 也叫上");
});
