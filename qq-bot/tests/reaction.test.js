import { test } from "node:test";
import assert from "node:assert/strict";
import { reactionEmojiFor } from "../src/message.js";

// ---------- reactionEmojiFor ----------
//
// 这个判据决定「入队即贴表情」会不会贴到不该贴的消息上。纯函数放在
// message.js，所以在不启动守护进程的前提下就能验证。

const group = (over = {}) => ({
  message_type: "group",
  message_id: 12345,
  raw_message: "@bot 帮我看看",
  ...over,
});

test("reactionEmojiFor: 群聊普通消息返回 message_id（字符串）", () => {
  assert.equal(reactionEmojiFor(group()), "12345");
});

test("reactionEmojiFor: message_id 是数字时转成字符串（API 要 string）", () => {
  const id = reactionEmojiFor(group({ message_id: 987654321 }));
  assert.equal(typeof id, "string");
  assert.equal(id, "987654321");
});

test("reactionEmojiFor: 私聊返回 null——贴表情是群聊专属形式", () => {
  assert.equal(
    reactionEmojiFor({ message_type: "private", message_id: 1, raw_message: "你好" }),
    null,
  );
});

test("reactionEmojiFor: 没有 message_id 返回 null（无处可贴）", () => {
  assert.equal(reactionEmojiFor(group({ message_id: undefined })), null);
  assert.equal(reactionEmojiFor(group({ message_id: null })), null);
});

test("reactionEmojiFor: message_id 为 0 时不当作缺失", () => {
  // 0 是合法数字，用 !== undefined/null 判缺失才对。若哪天改成 falsy 判断，
  // 这条会挂——它要守住的正是这个区别。
  assert.equal(reactionEmojiFor(group({ message_id: 0 })), "0");
});

test("reactionEmojiFor: 空 raw_message 返回 null（纯图片/纯文件没有'处理中'可言）", () => {
  assert.equal(reactionEmojiFor(group({ raw_message: "" })), null);
  assert.equal(reactionEmojiFor(group({ raw_message: "   " })), null);
  assert.equal(reactionEmojiFor(group({ raw_message: undefined })), null);
});

test("reactionEmojiFor: 纯表情/纯图片消息返回 null（贴了等于刷屏）", () => {
  assert.equal(reactionEmojiFor(group({ raw_message: "[CQ:face,id=14]" })), null);
  assert.equal(reactionEmojiFor(group({ raw_message: "  [CQ:face,id=14]  " })), null);
  assert.equal(reactionEmojiFor(group({ raw_message: "[CQ:face,id=14][CQ:face,id=5]" })), null);
  assert.equal(reactionEmojiFor(group({ raw_message: "[CQ:image,file=abc.jpg]" })), null);
});

test("reactionEmojiFor: 表情/图片 + 文字仍然贴（文字才是主体）", () => {
  // 这是最容易写错的一条：按"含不含 [CQ:face]"判断会把这些真提问漏掉，
  // 而它们恰恰是最需要示意的消息。
  assert.equal(reactionEmojiFor(group({ raw_message: "[CQ:face,id=14] 这个怎么弄" })), "12345");
  assert.equal(reactionEmojiFor(group({ raw_message: "这个怎么弄 [CQ:face,id=14]" })), "12345");
  assert.equal(reactionEmojiFor(group({ raw_message: "[CQ:image,file=a.jpg] 看下这个" })), "12345");
});

test("reactionEmojiFor: 非消息事件返回 null", () => {
  assert.equal(reactionEmojiFor(null), null);
  assert.equal(reactionEmojiFor(undefined), null);
  assert.equal(reactionEmojiFor({}), null);
});
