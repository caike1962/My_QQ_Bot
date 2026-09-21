import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripImages, truncate } from "../src/session.js";

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
