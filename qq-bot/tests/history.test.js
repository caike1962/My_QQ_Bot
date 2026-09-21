import { test } from "node:test";
import assert from "node:assert/strict";
import { formatHistoryLine, formatHistory, historyBody } from "../src/history.js";

const T = (h, m) => new Date(2026, 8, 21, h, m, 0).getTime() / 1000;

// ---------- formatHistoryLine ----------

test("formatHistoryLine: 时间补零，格式 [HH:MM]", () => {
  const line = formatHistoryLine(
    { time: T(9, 5), user_id: 1, sender: { card: "张总" }, message: [{ type: "text", data: { text: "早" } }] },
    { selfId: 999 },
  );
  assert.equal(line, "[09:05] 张总: 早");
});

test("formatHistoryLine: 优先用群名片 card，没有才用 nickname", () => {
  const card = formatHistoryLine(
    { time: T(10, 0), user_id: 1, sender: { card: "钟总", nickname: "Zz" }, message: [{ type: "text", data: { text: "x" } }] },
    { selfId: 999 },
  );
  assert.match(card, /钟总/, "有 card 时应该用 card");
  assert.ok(!card.includes("Zz"));

  const nick = formatHistoryLine(
    { time: T(10, 0), user_id: 1, sender: { nickname: "Zz" }, message: [{ type: "text", data: { text: "x" } }] },
    { selfId: 999 },
  );
  assert.match(nick, /Zz/);
});

test("formatHistoryLine: 姓名里的方括号与换行被清掉（会破坏标签结构）", () => {
  const line = formatHistoryLine(
    {
      time: T(10, 0),
      user_id: 1,
      sender: { card: "坏[名]\n字" },
      message: [{ type: "text", data: { text: "x" } }],
    },
    { selfId: 999 },
  );
  assert.ok(!line.includes("\n"), "名字里的换行应被清掉");
  // 关键：整个行只能有一对方括号（就是那个时间戳），
  // 否则名字里的 [ ] 会伪造出第二个标签，模型会以为那是另一条消息
  assert.equal((line.match(/\[/g) || []).length, 1, "只应有时间戳那一对方括号");
  assert.match(line, /^\[\d{2}:\d{2}\] [^:]+: x$/, "标签结构应保持完整");
});

test("formatHistoryLine: 缺 card/nickname 时退回 QQ 号", () => {
  const line = formatHistoryLine(
    { time: T(10, 0), user_id: 12345, sender: {}, message: [{ type: "text", data: { text: "x" } }] },
    { selfId: 999 },
  );
  assert.match(line, /12345/);
});

test("formatHistoryLine: 非文本段用占位符，不产生空行", () => {
  const line = formatHistoryLine(
    {
      time: T(10, 0),
      user_id: 1,
      sender: { card: "张总" },
      message: [
        { type: "text", data: { text: "看这个" } },
        { type: "image", data: {} },
        { type: "file", data: {} },
        { type: "face", data: {} },
      ],
    },
    { selfId: 999 },
  );
  assert.match(line, /看这个/);
  assert.match(line, /\[图片\]/);
  assert.match(line, /\[文件\]/);
  assert.match(line, /\[表情\]/);
});

test("formatHistoryLine: 转发段只用占位符，**不展开内嵌子消息**", () => {
  // 实测：一条转发段的 data.content 里嵌着完整的历史消息数组，
  // 直接 JSON 化会让体积从 12KB 涨到几十 KB。必须只留标记。
  const line = formatHistoryLine(
    {
      time: T(10, 0),
      user_id: 1,
      sender: { card: "成总" },
      message: [
        {
          type: "forward",
          data: { id: "123", content: [{ message: "大量内嵌内容".repeat(500) }] },
        },
      ],
    },
    { selfId: 999 },
  );
  assert.match(line, /\[转发的聊天记录\]/);
  assert.ok(!line.includes("内嵌内容"), "内嵌子消息不该被展开");
  assert.ok(line.length < 60, `转发行应很短，实际 ${line.length}`);
});

test("formatHistoryLine: at 段渲染成 @QQ号（让人知道这话是在对谁讲）", () => {
  const line = formatHistoryLine(
    {
      time: T(10, 0),
      user_id: 1,
      sender: { card: "张总" },
      message: [
        { type: "at", data: { qq: "1765116032" } },
        { type: "text", data: { text: "你看下" } },
      ],
    },
    { selfId: 999 },
  );
  assert.match(line, /@1765116032/);
  assert.match(line, /你看下/);
});

test("formatHistoryLine: 多行文本压成一行（否则会破坏每行一条的结构）", () => {
  const line = formatHistoryLine(
    {
      time: T(10, 0),
      user_id: 1,
      sender: { card: "张总" },
      message: [{ type: "text", data: { text: "第一行\n第二行\n\n第三行" } }],
    },
    { selfId: 999 },
  );
  assert.ok(!line.includes("\n"), "不该含换行");
});

test("formatHistoryLine: 纯非文本消息也能产出一行（不是空）", () => {
  const line = formatHistoryLine(
    { time: T(10, 0), user_id: 1, sender: { card: "张总" }, message: [{ type: "image", data: {} }] },
    { selfId: 999 },
  );
  assert.equal(line, "[10:00] 张总: [图片]");
});

test("formatHistoryLine: 位图/语音等其他段也有占位符，不静默吞掉", () => {
  for (const [type, want] of [
    ["record", "语音"],
    ["video", "视频"],
    ["json", "卡片"],
    ["mface", "表情"],
  ]) {
    const line = formatHistoryLine(
      { time: T(10, 0), user_id: 1, sender: { card: "甲" }, message: [{ type, data: {} }] },
      { selfId: 999 },
    );
    assert.match(line, new RegExp(`\\[${want}\\]`), `${type} 段应有占位符`);
  }
});

// ---------- formatHistory ----------

test("formatHistory: 过滤掉机器人自己的发言", () => {
  const msgs = [
    { time: T(10, 0), user_id: 999, sender: { card: "机器人" }, message: [{ type: "text", data: { text: "收到，正在处理…" } }] },
    { time: T(10, 1), user_id: 1, sender: { card: "张总" }, message: [{ type: "text", data: { text: "你好" } }] },
    { time: T(10, 2), user_id: 999, sender: { card: "机器人" }, message: [{ type: "text", data: { text: "回「继续」我就重新执行" } }] },
  ];
  const out = formatHistory(msgs, { selfId: 999 });
  assert.equal(out.length, 1, "应只剩 1 条（用户那条）");
  assert.match(out[0], /你好/);
  assert.ok(!out.join("").includes("正在处理"), "机器人回执不该出现");
});

test("formatHistory: 接收字符串形式的 userId 也能过滤（QQ 号有时是字符串）", () => {
  const msgs = [
    { time: T(10, 0), user_id: "999", sender: { card: "机器人" }, message: [{ type: "text", data: { text: "噪音" } }] },
    { time: T(10, 1), user_id: "1", sender: { card: "张总" }, message: [{ type: "text", data: { text: "正文" } }] },
  ];
  const out = formatHistory(msgs, { selfId: 999 });
  assert.equal(out.length, 1);
  assert.match(out[0], /正文/);
});

test("formatHistory: 过滤后仍按时间从早到晚排列", () => {
  const msgs = [
    { time: T(10, 0), user_id: 1, sender: { card: "甲" }, message: [{ type: "text", data: { text: "第一" } }] },
    { time: T(10, 5), user_id: 2, sender: { card: "乙" }, message: [{ type: "text", data: { text: "第二" } }] },
    { time: T(10, 9), user_id: 1, sender: { card: "甲" }, message: [{ type: "text", data: { text: "第三" } }] },
  ];
  const out = formatHistory(msgs, { selfId: 999 });
  assert.equal(out.length, 3);
  assert.match(out[0], /第一/);
  assert.match(out[2], /第三/);
});

test("formatHistory: 全无可用内容时返回空数组（调用方据此不发空块）", () => {
  assert.deepEqual(formatHistory([], { selfId: 999 }), []);
  assert.deepEqual(formatHistory(null, { selfId: 999 }), []);
  // 只有机器人自己发言 → 过滤完就空了
  assert.deepEqual(
    formatHistory(
      [{ time: T(10, 0), user_id: 999, sender: { card: "机器人" }, message: [{ type: "text", data: { text: "x" } }] }],
      { selfId: 999 },
    ),
    [],
  );
});

test("formatHistory: 损坏的条目被跳过，不影响其他条目", () => {
  const msgs = [
    null,
    { time: T(10, 0), user_id: 1, sender: { card: "甲" }, message: [{ type: "text", data: { text: "好" } }] },
    { sender: { card: "乙" } }, // 缺 time / message
    { time: T(10, 2), user_id: 2, sender: { card: "丙" }, message: "不是数组" },
  ];
  const out = formatHistory(msgs, { selfId: 999 });
  assert.ok(out.some((l) => /好/.test(l)), "合法条目应保留");
});

// ---------- historyBody ----------

test("historyBody: 包成一段带说明的文字，并标明是最近的记录", () => {
  const body = historyBody(["[21:13] 张总: 这电脑放了几个月"], {});
  assert.match(body, /张总/);
  assert.match(body, /最近/);
  // 必须说清这是"补充上下文"而不是用户本次的要求，
  // 否则模型会把历史里的某句话当成新指令执行
  assert.match(body, /补充|背景|上下文/);
});

test("historyBody: 空数组返回空串，调用方不该拼出空块", () => {
  assert.equal(historyBody([], {}), "");
  assert.equal(historyBody(null, {}), "");
});

test("historyBody: 明确声明这是只读背景，不是要执行的任务", () => {
  const body = historyBody(["[21:13] 张总: 把张三移出用户"], {});
  // 历史里可能含看起来像指令的话（别人说过"把X移出"），
  // 若不声明，模型可能真的去执行它
  assert.match(body, /不要|无需|仅供|背景|不是/, "应声明这是背景而非待执行指令");
});
