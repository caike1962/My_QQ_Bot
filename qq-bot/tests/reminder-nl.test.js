import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReminderSentinel, REMIND_MARK, REMIND_NONE } from "../src/reminder-nl.js";

// 哨兵解析本身是纯函数，全在离线可测范围内。
//
// 三种返回值必须严格区分，因为调用方的回执文案不同：
//   { text }       正常翻译结果
//   { none: true } 模型明确说"这不是提醒请求"
//   null           没找到哨兵（格式坏了）
// 混成一种会让用户不知道该怎么改写。

test("标准哨兵：取出内层文本", () => {
  const r = parseReminderSentinel(`${REMIND_MARK} 这周四 下午4点 @张总 去占位置 >>`);
  assert.equal(r.text, "这周四 下午4点 @张总 去占位置");
});

test("哨兵独占一行：前后可以有空行和别的话", () => {
  const raw = `好的，我理解成这样：\n\n${REMIND_MARK} 明天 21:00 去吃饭 >>\n\n`;
  assert.equal(parseReminderSentinel(raw).text, "明天 21:00 去吃饭");
});

test("行首行尾允许空白", () => {
  assert.equal(parseReminderSentinel(`   ${REMIND_MARK} 明天 21:00 开会 >>  `).text, "明天 21:00 开会");
});

test("正文中间提到哨兵不触发（模型在解释机制时会这么写）", () => {
  const raw = `我会输出 ${REMIND_MARK} 时间 内容 >> 这样的东西，但我这次没输出。`;
  assert.equal(parseReminderSentinel(raw), null);
});

test("独占一行但后面还有别的字 → 不认", () => {
  assert.equal(parseReminderSentinel(`${REMIND_MARK} 明天 21:00 开会 >> 好的`), null);
});

test("空的哨兵视为没找到（没有可解析的内容）", () => {
  assert.equal(parseReminderSentinel(`${REMIND_MARK} >>`), null);
  assert.equal(parseReminderSentinel(`${REMIND_MARK}   >>`), null);
});

test("明确的回绝：<<无提醒>>", () => {
  assert.deepEqual(parseReminderSentinel(REMIND_NONE), { none: true });
});

test("回绝也要求独占一行", () => {
  assert.equal(parseReminderSentinel(`这句里提到了 ${REMIND_NONE} 这个标记`), null);
});

test("回绝优先于哨兵（模型两个都写了时以回绝为准）", () => {
  const raw = `${REMIND_MARK} 明天 21:00 开会 >>\n${REMIND_NONE}`;
  assert.deepEqual(parseReminderSentinel(raw), { none: true });
});

test("完全没有哨兵 → null", () => {
  assert.equal(parseReminderSentinel("好的，我记下了。"), null);
});

test("空输入 / null / undefined 不抛错", () => {
  assert.equal(parseReminderSentinel(""), null);
  assert.equal(parseReminderSentinel(null), null);
  assert.equal(parseReminderSentinel(undefined), null);
});

test("内层可以含 @ 和中文标点（交给 parseReminder 去挑剔）", () => {
  const r = parseReminderSentinel(`${REMIND_MARK} 明天 晚上九点 @张三 去吃饭（记得带伞） >>`);
  assert.equal(r.text, "明天 晚上九点 @张三 去吃饭（记得带伞）");
});

// 端到端：哨兵里抽出来的文本喂给 parseReminder 能通。
// 这是两个模块之间的真实契约，值得在这里钉住。
test("端到端：哨兵 → parseReminder 能解析出任务", async () => {
  const { parseReminder } = await import("../src/reminders.js");
  const raw = `${REMIND_MARK} 这周四 下午4点 @张总 去占位置 >>`;
  const { text } = parseReminderSentinel(raw);
  const parsed = parseReminder(`/提醒 ${text}`, { now: new Date(2026, 8, 22, 10, 0, 0) });
  assert.ok(parsed.job, `应当解析成功，实际: ${parsed.error}`);
  assert.equal(parsed.job.time, "16:00");
  assert.equal(parsed.job.date, "2026-09-24"); // 周二 → 本周四
  assert.deepEqual(parsed.job.attendee, { qq: null, name: "张总" });
  assert.equal(parsed.job.text, "去占位置");
});
