import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripImages, truncate, sessionCompleted, readSessionDelta, pendingSummary, lastRecordType } from "../src/session.js";

const BIG = "A".repeat(50_000); // 模拟 base64 图片

function withTempFile(records, fn) {
  const dir = mkdtempSync(join(tmpdir(), "qqbot-test-"));
  const file = join(dir, "s.jsonl");
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  try {
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readBack(file) {
  return readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

test("stripImages: 替换 tool_result 里的图片 base64", () => {
  const rec = {
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: BIG } }],
        },
      ],
    },
  };
  withTempFile([rec], (file) => {
    const r = stripImages(file);
    assert.equal(r.replaced, 1);
    const [out] = readBack(file);
    const inner = out.message.content[0].content[0];
    assert.notEqual(inner.source.data, BIG, "base64 应被替换");
    assert.ok(inner.source.data.length < 200, "占位图应很小");
    assert.equal(inner.source.type, "base64", "source.type 必须保留，CLI 依赖它");
  });
});

test("stripImages: 两份副本都要替换（content 和 toolUseResult）", () => {
  const rec = {
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: [{ type: "image", source: { type: "base64", data: BIG } }],
        },
      ],
    },
    toolUseResult: { type: "image", file: { base64: BIG, type: "image/png" } },
  };
  withTempFile([rec], (file) => {
    const r = stripImages(file);
    assert.equal(r.replaced, 2, "同一张图存了两份，都要处理");
    const [out] = readBack(file);
    assert.notEqual(out.message.content[0].content[0].source.data, BIG);
    assert.notEqual(out.toolUseResult.file.base64, BIG);
    assert.equal(out.toolUseResult.file.type, "image/png", "其他字段不能动");
  });
});

test("stripImages: 纯文字记录原样保留", () => {
  const rec = { type: "assistant", message: { content: [{ type: "text", text: "你好" }] } };
  withTempFile([rec], (file) => {
    const r = stripImages(file);
    assert.equal(r.replaced, 0);
    const [out] = readBack(file);
    assert.equal(out.message.content[0].text, "你好");
  });
});

test("stripImages: 没有图片时体积不变", () => {
  const recs = [
    { type: "user", message: { content: "纯字符串内容" } },
    { type: "assistant", message: { content: [{ type: "text", text: "回复" }] } },
  ];
  withTempFile(recs, (file) => {
    const before = statSync(file).size;
    const r = stripImages(file);
    assert.equal(r.replaced, 0);
    assert.equal(statSync(file).size, before, "无图时不应重写");
  });
});

test("stripImages: 真实体积显著下降", () => {
  const recs = Array.from({ length: 5 }, (_, i) => ({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: `call_${i}`,
          content: [{ type: "image", source: { type: "base64", data: BIG } }],
        },
      ],
    },
    toolUseResult: { file: { base64: BIG } },
  }));
  withTempFile(recs, (file) => {
    const r = stripImages(file);
    assert.equal(r.replaced, 10);
    assert.ok(r.afterMb < r.beforeMb / 10, `应大幅缩小: ${r.beforeMb} -> ${r.afterMb}`);
  });
});

test("stripImages: 损坏的 JSON 行原样保留（不丢数据）", () => {
  const dir = mkdtempSync(join(tmpdir(), "qqbot-test-"));
  const file = join(dir, "s.jsonl");
  const good = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
  const broken = "{这不是合法 JSON";
  writeFileSync(file, good + "\n" + broken + "\n");
  try {
    stripImages(file);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, 2, "行数不能变");
    assert.equal(lines[0], good);
    assert.equal(lines[1], broken, "损坏行必须原样保留");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stripImages: 文件不存在返回 null", () => {
  assert.equal(stripImages("C:\\definitely\\not\\here\\x.jsonl"), null);
});

test("stripImages: 缺少 source.data 的记录不报错", () => {
  const rec = {
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "c", content: [{ type: "text", text: "纯文本结果" }] },
      ],
    },
  };
  withTempFile([rec], (file) => {
    const r = stripImages(file);
    assert.equal(r.replaced, 0);
  });
});

// ---------- truncate ----------
//
// 日志里打印用户消息 / 模型回复时截断。直接 slice 会把 emoji 的代理对切一半，
// 落盘后那个字符变成 U+FFFD（�）——不抛错，但日志出现乱码会干扰排查。

test("truncate: 短于上限时原样返回，不加省略号", () => {
  assert.equal(truncate("你好", 10), "你好");
  assert.equal(truncate("正好十个字啊啊啊", 8), "正好十个字啊啊啊");
});

test("truncate: 超长时截断并加省略号", () => {
  assert.equal(truncate("abcdefghij", 5), "abcde…");
});

test("truncate: 不在 emoji 中间切断（关键）", () => {
  // "a".repeat(4) + "😀" -> 代理对占 2 个 code unit，刚好横跨第 5、6 位
  const s = "aaaa" + "😀" + "bbbb";
  const out = truncate(s, 5);
  // 第 5 位（index 4）是高位代理，必须回退，否则产生半个字符
  assert.equal(out, "aaaa…");
  assert.ok(!out.includes("�"), "不应产生替换字符");
  // 验证落盘后不会被损坏
  const dir = mkdtempSync(join(tmpdir(), "qqbot-trunc-"));
  const f = join(dir, "t.txt");
  writeFileSync(f, out, "utf8");
  assert.ok(!readFileSync(f, "utf8").includes("�"), "落盘后不应出现 �");
  rmSync(dir, { recursive: true, force: true });
});

test("truncate: 上限落在 emoji 之后时正常截断", () => {
  const s = "aaaa" + "😀" + "bbbb";
  // 上限 7：末位 index 6 是 'b'（完整字符），不需要回退
  assert.equal(truncate(s, 7), "aaaa😀b…");
});

test("truncate: 全 emoji 串不损坏", () => {
  const s = "😀😀😀😀😀";
  for (let n = 1; n <= 10; n++) {
    const out = truncate(s, n);
    assert.ok(!out.includes("�"), `上限 ${n} 产生了替换字符: ${JSON.stringify(out)}`);
    // 不能出现孤立代理
    for (let i = 0; i < out.length; i++) {
      const c = out.charCodeAt(i);
      const isLow = c >= 0xdc00 && c <= 0xdfff;
      if (isLow) {
        const prev = out.charCodeAt(i - 1);
        assert.ok(prev >= 0xd800 && prev <= 0xdbff, `上限 ${n} 出现孤立低位代理`);
      }
    }
  }
});

test("truncate: null/undefined 不抛错", () => {
  assert.equal(truncate(null, 5), "");
  assert.equal(truncate(undefined, 5), "");
});

test("truncate: 恰好等于上限时不加省略号", () => {
  assert.equal(truncate("abcde", 5), "abcde");
});

// ---------- sessionCompleted ----------
//
// 判据：最后一个 assistant 记录里有没有正式回复文本。
// 这决定重启时要不要告诉用户「回继续」——误报会让用户无视这句话。

const asst = (blocks) => ({ type: "assistant", message: { content: blocks } });
const text = (t) => ({ type: "text", text: t });
const thinking = (t) => ({ type: "thinking", thinking: t });
const toolUse = (name) => ({ type: "tool_use", id: "c1", name, input: {} });
const toolResult = (id = "c1") => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id }] } });

test("sessionCompleted: 末尾是正式回复 → 已完成", () => {
  withTempFile([asst([toolUse("Read")]), toolResult(), asst([text("查好了")])], (f) => {
    assert.equal(sessionCompleted(f), true);
  });
});

test("sessionCompleted: 末尾停在工具调用 → 未完成", () => {
  withTempFile([asst([text("我看看")]), asst([toolUse("Bash")]), toolResult()], (f) => {
    assert.equal(sessionCompleted(f), false);
  });
});

test("sessionCompleted: 工具调用没有结果（被强杀）→ 未完成", () => {
  withTempFile([asst([toolUse("Bash")])], (f) => {
    assert.equal(sessionCompleted(f), false);
  });
});

test("sessionCompleted: 只有思考、没有正式回复 → 未完成", () => {
  withTempFile([asst([thinking("让我想想")])], (f) => {
    assert.equal(sessionCompleted(f), false);
  });
});

test("sessionCompleted: 空文本块不算正式回复", () => {
  withTempFile([asst([text("   ")])], (f) => {
    assert.equal(sessionCompleted(f), false);
  });
});

test("sessionCompleted: 回复后续的非 assistant 记录不影响判断", () => {
  // 实测会话末尾是 cost-state / atis-latch 这类记录，不能因为它们在最后就判成未完成
  withTempFile(
    [asst([text("说完了")]), { type: "cost-state" }, { type: "atis-latch" }],
    (f) => assert.equal(sessionCompleted(f), true),
  );
});

test("sessionCompleted: 一条 assistant 记录都没有 → 未完成", () => {
  withTempFile([{ type: "user", message: { content: "你好" } }], (f) => {
    assert.equal(sessionCompleted(f), false);
  });
});

test("sessionCompleted: 只看最后一条 assistant，中间的不算数", () => {
  withTempFile([asst([text("上一轮说完了")]), toolResult(), asst([toolUse("Bash")])], (f) => {
    assert.equal(sessionCompleted(f), false);
  });
});

test("sessionCompleted: 文件不存在返回 null（交调用方决定）", () => {
  assert.equal(sessionCompleted("D:/definitely/not/here.jsonl"), null);
});

test("sessionCompleted: 损坏的行跳过，不影响正常判断", () => {
  const dir = mkdtempSync(join(tmpdir(), "qqbot-test-"));
  const file = join(dir, "s.jsonl");
  writeFileSync(file, [JSON.stringify(asst([text("好了")])), "{坏行", ""].join("\n"));
  try {
    assert.equal(sessionCompleted(file), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sessionCompleted: 内容不是数组时不抛错", () => {
  withTempFile([{ type: "assistant", message: { content: "纯字符串" } }], (f) => {
    assert.equal(sessionCompleted(f), false);
  });
});

// ---------- readSessionDelta ----------
//
// 事后查账：这轮都调了什么、断在哪一步。
// 配对必须按 tool_use_id 精确匹配——实测 use 和 result 之间会夹其他记录。

const use = (id, name, input = {}) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
const resultOf = (id) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id }] } });

test("readSessionDelta: 配对成功的调用标记为 done", () => {
  withTempFile([use("c1", "Read", { file_path: "a.txt" }), resultOf("c1")], (f) => {
    const d = readSessionDelta(f);
    assert.equal(d.calls.length, 1);
    assert.equal(d.calls[0].name, "Read");
    assert.equal(d.calls[0].done, true);
    assert.deepEqual(d.dangling, []);
  });
});

test("readSessionDelta: 有调用没结果 → dangling（被强杀的信号）", () => {
  withTempFile([use("c1", "Read"), resultOf("c1"), use("c2", "Bash")], (f) => {
    const d = readSessionDelta(f);
    assert.equal(d.calls.length, 2);
    assert.equal(d.calls[1].done, false);
    assert.deepEqual(d.dangling, ["c2"]);
  });
});

test("readSessionDelta: use 和 result 中间夹其他记录也能配上（关键）", () => {
  // 实测会话里两者之间夹着 last-prompt / mode / atis-latch
  withTempFile(
    [
      use("c1", "Bash", { command: "npm install" }),
      { type: "last-prompt" },
      { type: "mode" },
      { type: "atis-latch" },
      resultOf("c1"),
    ],
    (f) => {
      const d = readSessionDelta(f);
      assert.equal(d.calls[0].done, true);
      assert.deepEqual(d.dangling, []);
    },
  );
});

test("readSessionDelta: 游标之后才算增量，之前的调用不重复返回", () => {
  withTempFile([use("c1", "Read"), resultOf("c1"), use("c2", "Bash"), resultOf("c2")], (f) => {
    const first = readSessionDelta(f, 0);
    assert.equal(first.calls.length, 2);

    // 从第 2 行接着读：只剩 c2
    const second = readSessionDelta(f, 2);
    assert.equal(second.calls.length, 1);
    assert.equal(second.calls[0].id, "c2");

    // 返回的 lines 可以直接当下次游标用，再读一次应该没有新调用
    const third = readSessionDelta(f, second.lines);
    assert.equal(third.calls.length, 0);
  });
});

test("readSessionDelta: 游标超过文件长度时夹到末尾，不越界报错", () => {
  withTempFile([use("c1", "Read")], (f) => {
    // 游标 9999 > 文件 1 行 → 夹到 1（末尾），没有新增可读，返回空而不是抛错
    const d = readSessionDelta(f, 9999);
    assert.deepEqual(d.calls, []);
    assert.deepEqual(d.dangling, []);
    assert.equal(d.lines, 1);
  });
});

test("readSessionDelta: 空文件不抛错", () => {
  const dir = mkdtempSync(join(tmpdir(), "qqbot-test-"));
  const file = join(dir, "empty.jsonl");
  writeFileSync(file, "");
  try {
    const d = readSessionDelta(file);
    assert.deepEqual(d.calls, []);
    assert.deepEqual(d.dangling, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readSessionDelta: 工具输入超长时预览被截断，但 name/id 完整", () => {
  const huge = { command: "x".repeat(5000) };
  withTempFile([use("c1", "Bash", huge)], (f) => {
    const d = readSessionDelta(f);
    assert.ok(d.calls[0].preview.length < 200, "预览应被截断");
    assert.equal(d.calls[0].name, "Bash");
    assert.equal(d.calls[0].id, "c1");
  });
});

test("readSessionDelta: 调用数超过 limit 时截断，但 dangling 仍完整", () => {
  const recs = [];
  for (let i = 0; i < 10; i++) recs.push(use(`c${i}`, "Read"), resultOf(`c${i}`));
  recs.push(use("dangling1", "Bash")); // 最后的悬空调用
  withTempFile(recs, (f) => {
    const d = readSessionDelta(f, 0, { limit: 3 });
    assert.equal(d.calls.length, 3, "展示被限制");
    assert.equal(d.truncated, true);
    assert.equal(d.calls[2].id, "dangling1", "保留的是最近的调用");
    assert.deepEqual(d.dangling, ["dangling1"], "dangling 不受 limit 影响");
  });
});

test("readSessionDelta: 没有触发截断时 truncated 为 false", () => {
  withTempFile([use("c1", "Read")], (f) => {
    assert.equal(readSessionDelta(f).truncated, false);
  });
});

test("readSessionDelta: 文件不存在返回 null", () => {
  assert.equal(readSessionDelta("D:/definitely/not/here.jsonl"), null);
});

test("readSessionDelta: 损坏的行跳过，不影响其他调用", () => {
  const dir = mkdtempSync(join(tmpdir(), "qqbot-test-"));
  const file = join(dir, "s.jsonl");
  writeFileSync(file, [JSON.stringify(use("c1", "Read")), "{坏行", JSON.stringify(resultOf("c1"))].join("\n"));
  try {
    const d = readSessionDelta(file);
    assert.equal(d.calls.length, 1);
    assert.equal(d.calls[0].done, true, "坏行不该阻断配对");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readSessionDelta: 非数组 content 的记录被跳过", () => {
  withTempFile(
    [{ type: "user", message: { content: "纯字符串" } }, use("c1", "Read"), resultOf("c1")],
    (f) => {
      assert.equal(readSessionDelta(f).calls.length, 1);
    },
  );
});

test("readSessionDelta: 保持调用顺序", () => {
  withTempFile([use("c1", "Read"), use("c2", "Bash"), use("c3", "Grep")], (f) => {
    assert.deepEqual(readSessionDelta(f).calls.map((c) => c.name), ["Read", "Bash", "Grep"]);
  });
});

test("readSessionDelta: 缺 id 的调用被忽略，不产生垃圾条目", () => {
  withTempFile(
    [{ type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } }, use("c1", "Bash")],
    (f) => {
      const d = readSessionDelta(f);
      assert.equal(d.calls.length, 1);
      assert.equal(d.calls[0].name, "Bash");
      assert.deepEqual(d.dangling, ["c1"]);
    },
  );
});

// ---------- pendingSummary ----------
//
// 只显示最后一个悬空工具之后的调用：更早的属于已经正常结束的轮次。

test("pendingSummary: 有悬空时只列确定的步骤，悬空的不显示", () => {
  // 悬空的 Bash 结果可能就写在后面那个 Read 的输出里，"✓ Read" 会是假象
  const delta = {
    calls: [
      { id: "c1", name: "Read", done: true },
      { id: "c2", name: "Bash", done: false },
      { id: "c3", name: "Read", done: true },
    ],
    dangling: ["c2"],
  };
  const out = pendingSummary(delta);
  assert.match(out, /已跑完的步骤/);
  assert.match(out, /✓ Read/);
  assert.ok(!out.includes("Bash"), "悬空的调用不该出现在已跑完的列表里");
});

test("pendingSummary: 最后一步悬空时明说没拿到结果", () => {
  const delta = {
    calls: [
      { id: "c1", name: "Read", done: true },
      { id: "c2", name: "Bash", done: false },
    ],
    dangling: ["c2"],
  };
  const out = pendingSummary(delta);
  assert.match(out, /最后一步没有执行完/);
  assert.ok(!out.includes("✓"), "没有可确认的步骤时不该列✓");
});

test("pendingSummary: 全部完成时列出步骤", () => {
  const delta = {
    calls: [
      { id: "c1", name: "Read", done: true },
      { id: "c2", name: "Bash", done: true },
    ],
    dangling: [],
  };
  const out = pendingSummary(delta);
  assert.match(out, /已跑完的步骤/);
  assert.match(out, /✓ Read/);
  assert.match(out, /✓ Bash/);
});

test("pendingSummary: max 限制的是列出的步骤数", () => {
  const calls = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, name: "Read", done: true }));
  const out = pendingSummary({ calls, dangling: [] }, 3);
  assert.equal(out.split("\n").length, 5, "空行 1 + 标题 1 + 3 条");
  assert.equal((out.match(/✓/g) || []).length, 3, "只列 3 步");
});

test("pendingSummary: 空或 null 返回空串，不抛错", () => {
  assert.equal(pendingSummary(null), "");
  assert.equal(pendingSummary({ calls: [], dangling: [] }), "");
});

// ---------- lastRecordType ----------
//
// 判据：跑过 claude 的那轮，收尾一定会写 cost-state。
// 用来把「通知误报」和「真丢了任务」分开。

test("lastRecordType: 正常跑完的会话末条是 cost-state", () => {
  withTempFile(
    [asst([text("说完了")]), { type: "last-prompt" }, { type: "cost-state" }],
    (f) => assert.equal(lastRecordType(f), "cost-state"),
  );
});

test("lastRecordType: 压根没执行过的会话末条不是 cost-state", () => {
  // 实测：某条真丢任务的会话末尾是 attachment
  withTempFile([asst([toolUse("Bash")]), { type: "attachment" }], (f) => {
    assert.notEqual(lastRecordType(f), "cost-state");
    assert.equal(lastRecordType(f), "attachment");
  });
});

test("lastRecordType: 损坏行被跳过，取最后一个可解析的", () => {
  const dir = mkdtempSync(join(tmpdir(), "qqbot-test-"));
  const file = join(dir, "s.jsonl");
  writeFileSync(file, [JSON.stringify({ type: "cost-state" }), "{坏行"].join("\n"));
  try {
    assert.equal(lastRecordType(file), "cost-state");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lastRecordType: 文件不存在返回 null", () => {
  assert.equal(lastRecordType("D:/definitely/not/here.jsonl"), null);
});

test("lastRecordType: 空文件返回 null", () => {
  const dir = mkdtempSync(join(tmpdir(), "qqbot-test-"));
  const file = join(dir, "empty.jsonl");
  writeFileSync(file, "");
  try {
    assert.equal(lastRecordType(file), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
