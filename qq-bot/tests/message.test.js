import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractText,
  extractFiles,
  extractAts,
  shouldHandle,
  stripLeadingMention,
  isBotMentioned,
  senderRole,
  parseRoleCommand,
  resolveRoleTarget,
  conversationKey,
  senderLabel,
  withSenderPrefix,
  parseResetCommand,
  parseStatusCommand,
  parseDiagnosticCommand,
} from "../src/message.js";

// ---------- extractText ----------

test("extractText: 字符串消息直接返回", () => {
  assert.equal(extractText("你好"), "你好");
});

test("extractText: 剥离 CQ 码", () => {
  assert.equal(extractText("[CQ:face,id=123]你好[CQ:at,qq=1]"), "你好");
});

test("extractText: CQ 码两侧文本不被粘连（占位成空格）", () => {
  // 「将 @钟总 添加为用户」去掉 at 后若直接拼接会变成「将添加为用户」，
  // 指令就再也匹配不上了，所以 at 段必须留一个空格占位。
  // 代价是可能出现连续空格，下游正则一律用 \s* 容忍。
  assert.equal(extractText("[CQ:at,qq=1] 将 [CQ:at,qq=2] 添加为用户"), "将   添加为用户");
  assert.match(extractText("将 [CQ:at,qq=1] 添加为用户"), /^将\s+添加为用户$/);
  assert.equal(extractText("你好[CQ:at,qq=1]世界"), "你好 世界");
});

test("extractText: 纯 CQ 码剥完为空", () => {
  assert.equal(extractText("[CQ:image,file=a.jpg]"), "");
});

test("extractText: 数组取 text 段拼接，at 段占位成空格", () => {
  const msg = [
    { type: "text", data: { text: "你好" } },
    { type: "image", data: { file: "a.jpg" } },
    { type: "text", data: { text: "世界" } },
  ];
  assert.equal(extractText(msg), "你好 世界");
});

test("extractText: 数组里连续 text 段不会互相插入空格", () => {
  const msg = [
    { type: "text", data: { text: "你好" } },
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
  assert.deepEqual(parseRoleCommand("将 12345678 添加为用户"), {
    action: "add",
    qq: 12345678,
    name: null,
  });
});

test("parseRoleCommand: 添加用户容忍多余空白", () => {
  assert.deepEqual(parseRoleCommand("  将  12345678 添加为 用户  "), {
    action: "add",
    qq: 12345678,
    name: null,
  });
});

test("parseRoleCommand: 全角空格也能解析", () => {
  assert.deepEqual(parseRoleCommand("将　12345678　添加为用户"), {
    action: "add",
    qq: 12345678,
    name: null,
  });
});

test("parseRoleCommand: 移出用户", () => {
  assert.deepEqual(parseRoleCommand("将 12345678 移出用户"), {
    action: "remove",
    qq: 12345678,
    name: null,
  });
});

// 名字形式（群里 @ 某人后 QQ 转成纯文本，号码消失）。
// 必须带 @ 前缀——这是防止把「将 abc 添加为用户」这类被截断的句子
// 误当成指令的唯一信号。

test("parseRoleCommand: @名字 形式返回 name 待解析", () => {
  assert.deepEqual(parseRoleCommand("将 @钟总 添加为用户"), {
    action: "add",
    qq: null,
    name: "钟总",
  });
});

test("parseRoleCommand: @名字 无空格也能解析", () => {
  assert.deepEqual(parseRoleCommand("将@钟总添加为用户"), {
    action: "add",
    qq: null,
    name: "钟总",
  });
});

test("parseRoleCommand: @名字 移出用户", () => {
  assert.deepEqual(parseRoleCommand("将 @钟总 移出用户"), {
    action: "remove",
    qq: null,
    name: "钟总",
  });
});

test("parseRoleCommand: 裸名字不匹配（防止把截断句当成指令）", () => {
  for (const bad of [
    "将钟总添加为用户",
    "将 abc 添加为用户",
    "将 添加为用户",
    "将 @ 添加为用户",
  ]) {
    assert.equal(parseRoleCommand(bad), null, `输入 "${bad}" 应返回 null`);
  }
});

test("parseRoleCommand: 无效输入返回 null", () => {
  for (const bad of ["", "把 123 添加为用户", "将 abc 添加为用户", "将 123 添加为管理员", "添加 12345678 为用户", "你好"]) {
    assert.equal(parseRoleCommand(bad), null, `输入 "${bad}" 应返回 null`);
  }
});

// ---------- resolveRoleTarget ----------
//
// 覆盖真实的四种消息形态。A/C 两种「文本被 at 段切开」的情况最关键：
// 文本残缺成「将   添加为用户」，任何名字正则都匹配不了，但目标号码
// 就藏在 at 段里，必须靠它救回来。

const SELF = 3126747682;
const resolve = (message, text, ats) =>
  resolveRoleTarget({ text, mentionAts: ats ?? extractAts(message), selfId: SELF });

function pipeline(message) {
  const stripped = stripLeadingMention(extractText(message), ["deepseek-v8"]);
  return { text: stripped, ats: extractAts(message) };
}

test("resolveRoleTarget: 数组 @机器人 将 @钟总 —— 从 at 段取号", () => {
  const msg = [
    { type: "at", data: { qq: 3126747682 } },
    { type: "text", data: { text: " 将 " } },
    { type: "at", data: { qq: 2998981505 } },
    { type: "text", data: { text: " 添加为用户" } },
  ];
  const { text, ats } = pipeline(msg);
  assert.deepEqual(resolve(msg, text, ats), { action: "add", qq: 2998981505, name: null });
});

test("resolveRoleTarget: 字符串 CQ 码形式同样能从 at 段取号", () => {
  const msg = "[CQ:at,qq=3126747682] 将 [CQ:at,qq=2998981505] 添加为用户";
  const { text, ats } = pipeline(msg);
  assert.deepEqual(resolve(msg, text, ats), { action: "add", qq: 2998981505, name: null });
});

test("resolveRoleTarget: at 段只有机器人时不能把机器人当目标", () => {
  const msg = [
    { type: "at", data: { qq: 3126747682 } },
    { type: "text", data: { text: " 将 添加为用户" } },
  ];
  const { text, ats } = pipeline(msg);
  assert.deepEqual(resolve(msg, text, ats), { action: "add", qq: null, name: null });
});

test("resolveRoleTarget: 纯文本 @名字 退回名字解析", () => {
  const msg = [{ type: "text", data: { text: "@deepseek-v8 将 @钟总 添加为用户" } }];
  const { text, ats } = pipeline(msg);
  assert.deepEqual(resolve(msg, text, ats), { action: "add", qq: null, name: "钟总" });
});

test("resolveRoleTarget: 名字不带 @ 也走名字解析（自然写法）", () => {
  const msg = [{ type: "text", data: { text: "@deepseek-v8 将钟总添加为用户" } }];
  const { text, ats } = pipeline(msg);
  assert.deepEqual(resolve(msg, text, ats), { action: "add", qq: null, name: "钟总" });
});

test("resolveRoleTarget: 名字两侧有空白、且是移出，同样解析得出名字", () => {
  const msg = [{ type: "text", data: { text: "@deepseek-v8 将 成总 移出用户" } }];
  const { text, ats } = pipeline(msg);
  assert.deepEqual(resolve(msg, text, ats), { action: "remove", qq: null, name: "成总" });
});

test("resolveRoleTarget: 直接写号码优先于 at 段", () => {
  const msg = [
    { type: "at", data: { qq: 3126747682 } },
    { type: "text", data: { text: " 将 2998981505 添加为用户" } },
  ];
  const { text, ats } = pipeline(msg);
  assert.deepEqual(resolve(msg, text, ats), { action: "add", qq: 2998981505, name: null });
});

test("resolveRoleTarget: 移出用户同样支持 at 段取号", () => {
  const msg = [
    { type: "at", data: { qq: 3126747682 } },
    { type: "text", data: { text: " 将 " } },
    { type: "at", data: { qq: 2998981505 } },
    { type: "text", data: { text: " 移出用户" } },
  ];
  const { text, ats } = pipeline(msg);
  assert.deepEqual(resolve(msg, text, ats), { action: "remove", qq: 2998981505, name: null });
});

test("resolveRoleTarget: 非指令文本返回 null", () => {
  for (const bad of ["你好", "把 123 添加为用户", "你好 将 123 添加为用户", "将 123 添加为管理员"]) {
    assert.equal(resolveRoleTarget({ text: bad, mentionAts: [], selfId: SELF }), null, `"${bad}"`);
  }
});

test("resolveRoleTarget: 指令残缺但意图成立时返回空目标（交给模型澄清）", () => {
  const r = resolveRoleTarget({ text: "将  添加为用户", mentionAts: [], selfId: SELF });
  assert.deepEqual(r, { action: "add", qq: null, name: null });
});

// ---------- conversationKey ----------

test("conversationKey: 群聊默认按群共享（同群不同人同一条会话）", () => {
  const a = { message_type: "group", group_id: 111, user_id: 1 };
  const b = { message_type: "group", group_id: 111, user_id: 2 };
  assert.equal(conversationKey(a), "group:111");
  assert.equal(conversationKey(b), "group:111");
  assert.equal(conversationKey(a), conversationKey(b));
});

test("conversationKey: 不同群互相隔离", () => {
  const a = { message_type: "group", group_id: 111, user_id: 1 };
  const b = { message_type: "group", group_id: 222, user_id: 1 };
  assert.notEqual(conversationKey(a), conversationKey(b));
});

test("conversationKey: 关闭共享后退回按群+人隔离", () => {
  const a = { message_type: "group", group_id: 111, user_id: 1 };
  const b = { message_type: "group", group_id: 111, user_id: 2 };
  assert.equal(conversationKey(a, { groupShared: false }), "111:1");
  assert.notEqual(
    conversationKey(a, { groupShared: false }),
    conversationKey(b, { groupShared: false }),
  );
});

test("conversationKey: 私聊始终按人隔离，不受共享开关影响", () => {
  const p = { message_type: "private", user_id: 42 };
  assert.equal(conversationKey(p), "private:42");
  assert.equal(conversationKey(p, { groupShared: false }), "private:42");
});

// ---------- senderLabel / withSenderPrefix ----------

test("senderLabel: 优先用群名片", () => {
  const e = { user_id: 12345, sender: { card: "钟总", nickname: "zhong" } };
  assert.equal(senderLabel(e), "[钟总(12345)]");
});

test("senderLabel: 无群名片回退昵称", () => {
  const e = { user_id: 12345, sender: { card: "", nickname: "钟总" } };
  assert.equal(senderLabel(e), "[钟总(12345)]");
});

test("senderLabel: 昵称缺失用占位名，号码仍在", () => {
  assert.equal(senderLabel({ user_id: 12345 }), "[群成员(12345)]");
});

test("senderLabel: 昵称里的换行和方括号被清掉（防止伪造第二个标签）", () => {
  const e = { user_id: 1, sender: { nickname: "a]\n[b" } };
  assert.equal(senderLabel(e), "[a b(1)]");
});

test("senderLabel: 昵称过长被截断", () => {
  const e = { user_id: 1, sender: { nickname: "x".repeat(50) } };
  const label = senderLabel(e);
  assert.match(label, /^\[x{24}\(1\)\]$/);
});

test("senderLabel: user_id 非法返回 null", () => {
  for (const bad of [null, undefined, {}, { user_id: 0 }, { user_id: "abc" }]) {
    assert.equal(senderLabel(bad), null, `输入 ${JSON.stringify(bad)}`);
  }
});

test("withSenderPrefix: 文本前加上标签", () => {
  const e = { user_id: 12345, sender: { nickname: "钟总" } };
  assert.equal(withSenderPrefix("帮我看下", e), "[钟总(12345)] 帮我看下");
});

test("withSenderPrefix: 拿不到标签时原样返回", () => {
  assert.equal(withSenderPrefix("帮我看下", { user_id: 0 }), "帮我看下");
});

// ---------- parseResetCommand ----------

test("parseResetCommand: 三种写法都识别，容忍空白", () => {
  for (const s of ["/reset", " /reset ", "/清空", "/重置", "\t/reset\n"]) {
    assert.equal(parseResetCommand(s), true, `"${s}" 应识别`);
  }
});

test("parseResetCommand: 带参数的/普通文本不识别", () => {
  for (const bad of ["/reset now", "reset", "/清空会话", "帮我 /reset", "", null, undefined]) {
    assert.equal(parseResetCommand(bad), false, `"${bad}" 不应识别`);
  }
});

test("parseStatusCommand: 两种写法都识别，容忍空白", () => {
  for (const s of ["/status", " /status ", "/状态", "\t/status\n"]) {
    assert.equal(parseStatusCommand(s), true, `"${s}" 应识别`);
  }
});

test("parseStatusCommand: 带参数/普通文本不识别，且不会吃掉 /reset", () => {
  for (const bad of ["/status now", "status", "/状态如何", "", null, undefined, "/reset"]) {
    assert.equal(parseStatusCommand(bad), false, `"${bad}" 不应识别`);
  }
});

test("parseDiagnosticCommand: 只认精确的 /诊断", () => {
  for (const s of ["/诊断", " /诊断 ", "\t/诊断\n"]) {
    assert.equal(parseDiagnosticCommand(s), true, `"${s}" 应识别`);
  }
});

test("parseDiagnosticCommand: 带后缀不识别（那是别的事，交给模型）", () => {
  for (const bad of [
    "/诊断 一下",
    "诊断",
    "/诊断群",
    "",
    null,
    undefined,
    "/status",
    "/提醒",
  ]) {
    assert.equal(parseDiagnosticCommand(bad), false, `"${bad}" 不应识别`);
  }
});

// ---------- extractAts ----------

test("extractAts: 数组取所有 at 段的 qq", () => {
  const msg = [
    { type: "at", data: { qq: 2998981505 } },
    { type: "text", data: { text: " 你好" } },
    { type: "at", data: { qq: "1765116032" } },
  ];
  assert.deepEqual(extractAts(msg), [
    { qq: 2998981505, name: null },
    { qq: "1765116032", name: null },
  ]);
});

test("extractAts: 段里带 name 时取 name", () => {
  const msg = [{ type: "at", data: { qq: 2998981505, name: "钟总" } }];
  assert.deepEqual(extractAts(msg), [{ qq: 2998981505, name: "钟总" }]);
});

test("extractAts: 字符串形式解析 CQ 码", () => {
  assert.deepEqual(extractAts("[CQ:at,qq=2998981505] 你好"), [
    { qq: "2998981505", name: null },
  ]);
});

test("extractAts: 字符串 CQ 码带 name", () => {
  assert.deepEqual(extractAts("[CQ:at,qq=2998981505,name=钟总] 你好"), [
    { qq: "2998981505", name: "钟总" },
  ]);
});

test("extractAts: 无 at 段返回空数组", () => {
  assert.deepEqual(extractAts([{ type: "text", data: { text: "你好" } }]), []);
  assert.deepEqual(extractAts("你好"), []);
});

test("extractAts: 异常输入返回空数组不抛错", () => {
  for (const bad of [null, undefined, 42, {}, true]) {
    assert.deepEqual(extractAts(bad), [], `输入 ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(extractAts([null, { type: "at" }, { type: "at", data: {} }]), []);
});

// ---------- extractFiles ----------
//
// 字段名以 NapCat 实测为准（2026-09-21，私聊转发一个 pdf）。
// 三条最容易被猜错的：文件名在 `file` 而非 `name`；大小在 `file_size`；
// 大小是**字符串**。
const FILE_SEG = {
  type: "file",
  data: {
    file: "图片转pdf_20260706_214225.pdf",
    file_id: "80883569f95b09df4de35ea1c783c368_bf73abfa-b5af-11f1-9ec4-49bed69c7152",
    file_size: "946642",
  },
};

test("extractFiles: 实测的 NapCat 结构能被正确解出", () => {
  const out = extractFiles([FILE_SEG]);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "图片转pdf_20260706_214225.pdf");
  assert.equal(out[0].fileId, "80883569f95b09df4de35ea1c783c368_bf73abfa-b5af-11f1-9ec4-49bed69c7152");
  assert.equal(out[0].size, 946642, "file_size 是字符串，必须转成数字");
  assert.equal(typeof out[0].size, "number");
});

test("extractFiles: 文件段与文本段共存时只取文件", () => {
  const out = extractFiles([
    { type: "text", data: { text: "把这个放桌面" } },
    FILE_SEG,
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "图片转pdf_20260706_214225.pdf");
});

test("extractFiles: 缺 file_id 的段被跳过（取不到内容，收了没用）", () => {
  assert.deepEqual(extractFiles([{ type: "file", data: { file: "a.pdf" } }]), []);
});

test("extractFiles: 缺文件名时给占位名而不是 undefined", () => {
  const out = extractFiles([{ type: "file", data: { file_id: "x", file_size: "1" } }]);
  assert.equal(out[0].name, "未命名文件");
});

test("extractFiles: 大小非法时为 null 而不是 NaN", () => {
  const out = extractFiles([{ type: "file", data: { file_id: "x", file: "a.pdf", file_size: "abc" } }]);
  assert.equal(out[0].size, null);
});

test("extractFiles: 无 file 段返回空数组", () => {
  assert.deepEqual(extractFiles([{ type: "text", data: { text: "你好" } }]), []);
  assert.deepEqual(extractFiles("你好"), []);
});

test("extractFiles: 异常输入不抛错", () => {
  for (const bad of [null, undefined, 42, {}, true]) {
    assert.deepEqual(extractFiles(bad), [], `输入 ${JSON.stringify(bad)}`);
  }
});

test("extractText 不因文件段而改变行为（职责分离，老测试不受影响）", () => {
  assert.equal(extractText([FILE_SEG]), "");
  assert.equal(extractText([FILE_SEG, { type: "text", data: { text: "放桌面" } }]), "放桌面");
});
