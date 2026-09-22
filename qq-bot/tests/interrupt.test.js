import { test } from "node:test";
import assert from "node:assert/strict";
import { canMerge, sessionUntouched, mergePrompt, shouldInterrupt } from "../src/interrupt.js";

const base = {
  enabled: true,
  messageType: "private",
  role: "admin",
  windowMs: 5000,
  startedAt: 1000,
  now: 3000,
  baselineLines: 26,
  currentLines: 26,
  mergedLength: 100,
  maxPromptChars: 4000,
};

test("canMerge: 私聊放行已知角色；群聊仅同一发送者", () => {
  assert.equal(canMerge({ messageType: "private", role: "admin" }), true);
  // user 会话本来就没有工具，重跑零副作用，所以一并放行
  assert.equal(canMerge({ messageType: "private", role: "user" }), true);
  // 角色未知（陌生人/将来新增的角色）一律不合并
  assert.equal(canMerge({ messageType: "private", role: null }), false);
  assert.equal(canMerge({ messageType: "private", role: "moderator" }), false);
  assert.equal(canMerge({ messageType: "private", role: "admin", enabled: false }), false);

  // 群聊：同一个人补一句才合并——被打断的是他自己那次执行，语义同私聊
  assert.equal(
    canMerge({ messageType: "group", role: "admin", prevUserId: 7, userId: 7 }),
    true,
  );
  assert.equal(
    canMerge({ messageType: "group", role: "user", prevUserId: 7, userId: 7 }),
    true,
  );
  // 别人发言不该被我的第二条消息杀掉重跑
  assert.equal(
    canMerge({ messageType: "group", role: "admin", prevUserId: 7, userId: 8 }),
    false,
  );
  // 身份拿不到（恢复任务没有原始事件、事件缺 user_id）→ 保守拒绝
  assert.equal(canMerge({ messageType: "group", role: "admin" }), false);
  assert.equal(
    canMerge({ messageType: "group", role: "admin", prevUserId: NaN, userId: 7 }),
    false,
  );
  assert.equal(
    canMerge({ messageType: "group", role: "admin", prevUserId: 7, userId: NaN }),
    false,
  );
  // 其他 message_type（如 discuss）不放行
  assert.equal(
    canMerge({ messageType: "discuss", role: "admin", prevUserId: 7, userId: 7 }),
    false,
  );
});

test("sessionUntouched: 文件没变化才算没动过工具", () => {
  assert.equal(sessionUntouched({ baselineLines: 26, currentLines: 26 }), true);
  assert.equal(sessionUntouched({ baselineLines: 26, currentLines: 27 }), false);
  // 锚点未建立（claude 启动 ~0.6s 内还没写文件）时按"没动过"处理
  assert.equal(sessionUntouched({ baselineLines: null, currentLines: 26 }), true);
  assert.equal(sessionUntouched({ baselineLines: undefined, currentLines: 30 }), true);
  // 读不到文件 → 保守拒绝，宁可排队也不要截断可能的工具调用
  assert.equal(sessionUntouched({ baselineLines: 26, currentLines: NaN }), false);
});

test("mergePrompt: 说明两条要一起处理，并保留两条原文", () => {
  const out = mergePrompt("把文件转成 pdf", "要横向的");
  assert.match(out, /一起处理/);
  assert.ok(out.includes("把文件转成 pdf"));
  assert.ok(out.includes("要横向的"));
  // 第一条必须在前：合并语义是"第二条补充第一条"，顺序反了含义就变了
  assert.ok(out.indexOf("把文件转成 pdf") < out.indexOf("要横向的"));
});

test("shouldInterrupt: 全部条件满足才打断", () => {
  assert.equal(shouldInterrupt(base), true);
});

test("shouldInterrupt: 超出窗口不打断", () => {
  assert.equal(shouldInterrupt({ ...base, now: 1000 + 5001 }), false);
  // 边界：正好等于窗口仍算在窗口内
  assert.equal(shouldInterrupt({ ...base, now: 1000 + 5000 }), true);
});

test("shouldInterrupt: 已动过工具不打断", () => {
  assert.equal(shouldInterrupt({ ...base, currentLines: 30 }), false);
});

test("shouldInterrupt: 合并后超长不打断（否则会撞 maxPromptChars 直接失败）", () => {
  assert.equal(shouldInterrupt({ ...base, mergedLength: 4001 }), false);
  assert.equal(shouldInterrupt({ ...base, mergedLength: 4000 }), true);
});

test("shouldInterrupt: 角色未知一律不打断；群聊要求同一发送者", () => {
  // 陌生人 / 将来新增的角色：保守拒绝
  assert.equal(shouldInterrupt({ ...base, role: null }), false);
  assert.equal(shouldInterrupt({ ...base, role: "moderator" }), false);
  assert.equal(shouldInterrupt({ ...base, enabled: false }), false);
  // user 档私聊放行（会话无工具，重跑零副作用）
  assert.equal(shouldInterrupt({ ...base, role: "user" }), true);
  // 群聊缺发送者身份时保守拒绝（宁可排队，也不误杀别人的执行）
  assert.equal(shouldInterrupt({ ...base, messageType: "group" }), false);
  assert.equal(
    shouldInterrupt({ ...base, messageType: "group", prevUserId: 7, userId: 7 }),
    true,
  );
  assert.equal(
    shouldInterrupt({ ...base, messageType: "group", prevUserId: 7, userId: 8 }),
    false,
  );
});

test("shouldInterrupt: startedAt 非法时不打断", () => {
  assert.equal(shouldInterrupt({ ...base, startedAt: NaN }), false);
  assert.equal(shouldInterrupt({ ...base, startedAt: undefined }), false);
});
