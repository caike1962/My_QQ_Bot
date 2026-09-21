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

test("省略时间描述时默认每天", () => {
  const j = ok("/提醒 08:00 喝水");
  assert.equal(j.time, "08:00");
  assert.equal(j.text, "喝水");
  assert.equal(j.date, null);
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
