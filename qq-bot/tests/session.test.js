import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripImages } from "../src/session.js";

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
