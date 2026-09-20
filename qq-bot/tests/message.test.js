import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractText,
  shouldHandle,
  stripLeadingMention,
  isBotMentioned,
  senderRole,
  parseRoleCommand,
} from "../src/message.js";

// ---------- extractText ----------

test("extractText: 字符串消息直接返回", () => {
  assert.equal(extractText("你好"), "你好");
});

test("extractText: 剥离 CQ 码", () => {
  assert.equal(extractText("[CQ:face,id=123]你好[CQ:at,qq=1]"), "你好");
});

test("extractText: 纯 CQ 码剥完为空", () => {
  assert.equal(extractText("[CQ:image,file=a.jpg]"), "");
});

test("extractText: 数组取 text 段拼接", () => {
  const msg = [
    { type: "text", data: { text: "你好" } },
    { type: "image", data: { file: "a.jpg" } },
    { type: "text", data: { text: "世界" } },
  ];
  assert.equal(extractText(msg), "你好世界");
});

test("extractText: 数组无 text 段返回空", () => {
  assert.equal(extractText([{ type: "image", data: { file: "a.jpg" } }]), "");
});

test("extractText: 段缺少 data 不抛错", () => {
  assert.equal(extractText([{ type: "text" }, { type: "text", data: { text: "ok" } }]), "ok");
});

test("extractText: 数组含 null 段不抛错", () => {
  assert.equal(extractText([null, { type: "text", data: { text: "ok" } }]), "ok");
});

test("extractText: 首尾空白被去除", () => {
  assert.equal(extractText("  \n 你好 \t "), "你好");
});

test("extractText: 非字符串非数组返回空", () => {
  for (const bad of [null, undefined, 42, {}, true]) {
    assert.equal(extractText(bad), "", `输入 ${JSON.stringify(bad)} 应返回空`);
  }
});

// ---------- shouldHandle ----------

const CONFIG = { selfId: 3126747682, allowedSenders: [1765116032] };

function msgEvent(overrides = {}) {
  return {
    post_type: "message",
    message_type: "private",
    self_id: 3126747682,
    user_id: 1765116032,
    ...overrides,
  };
}

test("shouldHandle: 白名单内的私聊消息通过", () => {
  assert.equal(shouldHandle(msgEvent(), CONFIG), true);
});

test("shouldHandle: 非 message 事件拒绝", () => {
  assert.equal(shouldHandle(msgEvent({ post_type: "meta_event" }), CONFIG), false);
});

test("shouldHandle: 群消息拒绝", () => {
  assert.equal(shouldHandle(msgEvent({ message_type: "group", group_id: 1 }), CONFIG), false);
});

test("shouldHandle: 白名单外的用户拒绝", () => {
  assert.equal(shouldHandle(msgEvent({ user_id: 999999 }), CONFIG), false);
});

test("shouldHandle: 自己发的消息拒绝（防自问自答）", () => {
  assert.equal(shouldHandle(msgEvent({ user_id: CONFIG.selfId }), CONFIG), false);
});

test("shouldHandle: self_id 不匹配（别的账号的事件）拒绝", () => {
  assert.equal(shouldHandle(msgEvent({ self_id: 123456 }), CONFIG), false);
});

test("shouldHandle: 缺少 self_id 时不因此拒绝", () => {
  const event = msgEvent();
  delete event.self_id;
  assert.equal(shouldHandle(event, CONFIG), true);
});

test("shouldHandle: 白名单为空时不限制（放行所有人）", () => {
  const openConfig = { selfId: 3126747682, allowedSenders: [] };
  assert.equal(shouldHandle(msgEvent(), openConfig), true);
  assert.equal(shouldHandle(msgEvent({ user_id: 123456 }), openConfig), true);
});

test("shouldHandle: user_id 为字符串数字时正确比较", () => {
  assert.equal(shouldHandle(msgEvent({ user_id: "1765116032" }), CONFIG), true);
});

test("shouldHandle: user_id 非法时拒绝", () => {
  for (const bad of [null, undefined, 0, -1, "abc", {}, 1.5]) {
    assert.equal(shouldHandle(msgEvent({ user_id: bad }), CONFIG), false, `user_id=${bad} 应拒绝`);
  }
});

test("shouldHandle: 事件为 null/非对象时拒绝", () => {
  for (const bad of [null, undefined, "x", 42, true]) {
    assert.equal(shouldHandle(bad, CONFIG), false, `事件 ${bad} 应拒绝`);
  }
});

test("shouldHandle: 多白名单命中任意一个即通过", () => {
  const multi = { selfId: 3126747682, allowedSenders: [1, 1765116032, 3] };
  assert.equal(shouldHandle(msgEvent(), multi), true);
  assert.equal(shouldHandle(msgEvent({ user_id: 3 }), multi), true);
  assert.equal(shouldHandle(msgEvent({ user_id: 2 }), multi), false);
});

// ---------- stripLeadingMention ----------

test("stripLeadingMention: 剥离裸昵称前缀", () => {
  assert.equal(stripLeadingMention("First 你好", ["First"]), "你好");
});

test("stripLeadingMention: 剥离 @昵称前缀", () => {
  assert.equal(stripLeadingMention("@First 你好", ["First"]), "你好");
});

test("stripLeadingMention: 前缀后无空格也剥离（中文）", () => {
  assert.equal(stripLeadingMention("First你好", ["First"]), "你好");
});

test("stripLeadingMention: 无前缀时原样返回", () => {
  assert.equal(stripLeadingMention("你好 First", ["First"]), "你好 First");
});

test("stripLeadingMention: 英文单词不误判（Firstable）", () => {
  assert.equal(stripLeadingMention("Firstable 是啥", ["First"]), "Firstable 是啥");
});

test("stripLeadingMention: 空名字列表不改变文本", () => {
  assert.equal(stripLeadingMention("First 你好", []), "First 你好");
});

// ---------- isBotMentioned ----------

const MENTION_CFG = { selfId: 3126747682, names: ["First"] };

test("isBotMentioned: at 段 qq 为数字匹配", () => {
  const msg = [
    { type: "at", data: { qq: 3126747682 } },
    { type: "text", data: { text: " 你好" } },
  ];
  assert.equal(isBotMentioned(msg, MENTION_CFG), true);
});

test("isBotMentioned: at 段 qq 为字符串也匹配", () => {
  const msg = [
    { type: "at", data: { qq: "3126747682" } },
    { type: "text", data: { text: " 你好" } },
  ];
  assert.equal(isBotMentioned(msg, MENTION_CFG), true);
});

test("isBotMentioned: at 别人不算", () => {
  const msg = [
    { type: "at", data: { qq: 999 } },
    { type: "text", data: { text: " 你好" } },
  ];
  assert.equal(isBotMentioned(msg, MENTION_CFG), false);
});

test("isBotMentioned: 无 at 段的纯文本不算", () => {
  assert.equal(isBotMentioned([{ type: "text", data: { text: "你好" } }], MENTION_CFG), false);
});

test("isBotMentioned: 文本以 @昵称 开头算（QQ 转文本场景）", () => {
  const msg = [{ type: "text", data: { text: "@First 你好" } }];
  assert.equal(isBotMentioned(msg, MENTION_CFG), true);
});

test("isBotMentioned: 文本以裸昵称开头算", () => {
  const msg = [{ type: "text", data: { text: "First 你好" } }];
  assert.equal(isBotMentioned(msg, MENTION_CFG), true);
});

test("isBotMentioned: 昵称不在开头不算", () => {
  const msg = [{ type: "text", data: { text: "大家 First 你好" } }];
  assert.equal(isBotMentioned(msg, MENTION_CFG), false);
});

test("isBotMentioned: 字符串 CQ 码 at 机器人算", () => {
  assert.equal(isBotMentioned("[CQ:at,qq=3126747682] 你好", MENTION_CFG), true);
});

test("isBotMentioned: 字符串 CQ 码 at 别人不算", () => {
  assert.equal(isBotMentioned("[CQ:at,qq=999] 你好", MENTION_CFG), false);
});

test("isBotMentioned: 字符串 @昵称 开头算", () => {
  assert.equal(isBotMentioned("@First 你好", MENTION_CFG), true);
});

test("isBotMentioned: 字符串不含 @ 不算", () => {
  assert.equal(isBotMentioned("今天天气不错", MENTION_CFG), false);
});

test("isBotMentioned: 数组含 null 段不抛错", () => {
  assert.equal(
    isBotMentioned([null, { type: "text", data: { text: "你好" } }], MENTION_CFG),
    false,
  );
});

test("isBotMentioned: 非数组非字符串返回 false", () => {
  for (const bad of [null, undefined, 42, {}]) {
    assert.equal(isBotMentioned(bad, MENTION_CFG), false, `输入 ${JSON.stringify(bad)}`);
  }
});

// ---------- shouldHandle 群聊 @ 检查 ----------

const GROUP_CFG = {
  selfId: 3126747682,
  allowedSenders: [1765116032],
  allowedGroups: [],
  enableGroups: true,
  groupMentionNames: ["First"],
};

function groupEvent(overrides = {}) {
  return msgEvent({
    message_type: "group",
    group_id: 987654321,
    message: [
      { type: "at", data: { qq: 3126747682 } },
      { type: "text", data: { text: " 你好" } },
    ],
    ...overrides,
  });
}

test("shouldHandle: 群里 @ 机器人且发送人白名单内通过", () => {
  assert.equal(shouldHandle(groupEvent(), GROUP_CFG), true);
});

test("shouldHandle: 群里未 @ 机器人拒绝", () => {
  const noMention = [{ type: "text", data: { text: "随便聊聊" } }];
  assert.equal(shouldHandle(groupEvent({ message: noMention }), GROUP_CFG), false);
});

test("shouldHandle: 群里 @ 了但发送人不在白名单拒绝", () => {
  assert.equal(shouldHandle(groupEvent({ user_id: 999999 }), GROUP_CFG), false);
});

test("shouldHandle: 群不在群白名单时拒绝", () => {
  const restricted = { ...GROUP_CFG, allowedGroups: [111] };
  assert.equal(shouldHandle(groupEvent({ group_id: 222 }), restricted), false);
  assert.equal(shouldHandle(groupEvent({ group_id: 111 }), restricted), true);
});

test("shouldHandle: 群聊未开启时拒绝", () => {
  assert.equal(shouldHandle(groupEvent(), { ...GROUP_CFG, enableGroups: false }), false);
});

test("shouldHandle: 群里文本 @昵称 开头通过", () => {
  const collapsed = [{ type: "text", data: { text: "@First 你好" } }];
  assert.equal(shouldHandle(groupEvent({ message: collapsed }), GROUP_CFG), true);
});

test("shouldHandle: 群里字符串 CQ at 通过", () => {
  assert.equal(shouldHandle(groupEvent({ message: "[CQ:at,qq=3126747682] 你好" }), GROUP_CFG), true);
});

// ---------- senderRole ----------

const ROLES = { isUser: (id) => id === 88888888 };

test("senderRole: admin 名单内为 admin", () => {
  assert.equal(senderRole(1765116032, CONFIG, ROLES), "admin");
});

test("senderRole: roles.json 名单内为 user", () => {
  assert.equal(senderRole(88888888, CONFIG, ROLES), "user");
});

test("senderRole: 两者都不在返回 null", () => {
  assert.equal(senderRole(999999, CONFIG, ROLES), null);
});

test("senderRole: 非法 user_id 返回 null", () => {
  for (const bad of [null, undefined, 0, -1, "abc", 1.5]) {
    assert.equal(senderRole(bad, CONFIG, ROLES), null, `user_id=${bad}`);
  }
});

test("senderRole: allowedSenders 为空时一律 admin（兼容遗留语义）", () => {
  const open = { allowedSenders: [] };
  assert.equal(senderRole(123456, open, ROLES), "admin");
});

test("shouldHandle: user 名单内私聊通过", () => {
  assert.equal(shouldHandle(msgEvent({ user_id: 88888888 }), CONFIG, ROLES), true);
});

test("shouldHandle: user 名单内群里 @ 通过", () => {
  assert.equal(shouldHandle(groupEvent({ user_id: 88888888 }), GROUP_CFG, ROLES), true);
});

test("shouldHandle: 陌生人（非 admin 非 user）在群里 @ 也拒绝", () => {
  assert.equal(shouldHandle(groupEvent({ user_id: 999999 }), GROUP_CFG, ROLES), false);
});

// ---------- parseRoleCommand ----------

test("parseRoleCommand: 添加用户", () => {
  assert.deepEqual(parseRoleCommand("将 12345678 添加为用户"), { action: "add", qq: 12345678 });
});

test("parseRoleCommand: 添加用户容忍多余空白", () => {
  assert.deepEqual(parseRoleCommand("  将  12345678 添加为 用户  "), {
    action: "add",
    qq: 12345678,
  });
});

test("parseRoleCommand: 全角空格也能解析", () => {
  assert.deepEqual(parseRoleCommand("将　12345678　添加为用户"), { action: "add", qq: 12345678 });
});

test("parseRoleCommand: 移出用户", () => {
  assert.deepEqual(parseRoleCommand("将 12345678 移出用户"), { action: "remove", qq: 12345678 });
});

test("parseRoleCommand: 无效输入返回 null", () => {
  for (const bad of ["", "把 123 添加为用户", "将 abc 添加为用户", "将 123 添加为管理员", "添加 12345678 为用户", "你好"]) {
    assert.equal(parseRoleCommand(bad), null, `输入 "${bad}" 应返回 null`);
  }
});
