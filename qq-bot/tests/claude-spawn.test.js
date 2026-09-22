import { test } from "node:test";
import assert from "node:assert/strict";
import { buildClaudeArgs, FORBIDDEN_ARGS_FOR_USER } from "../src/claude.js";

const BASE = {
  prompt: "你好",
  mcpConfigPath: "D:\\QQBOT\\qq-bot\\mcp-config.json",
  allowedTools: "Read,Glob,Grep",
  sessionId: "abc123",
};

test("admin 参数：包含 MCP 配置与 bypass 权限（现状）", () => {
  const args = buildClaudeArgs(BASE);
  assert.ok(args.includes("--mcp-config"), "应包含 --mcp-config");
  assert.ok(args.includes("--dangerously-skip-permissions"), "应包含 bypass");
  assert.ok(args.includes("--allowedTools"), "应包含 --allowedTools");
});

test("user 参数：绝不包含任何危险 flag（安全回归红线）", () => {
  const args = buildClaudeArgs({ ...BASE, role: "user" });
  for (const flag of FORBIDDEN_ARGS_FOR_USER) {
    assert.ok(!args.includes(flag), `user 参数不应包含 ${flag}`);
  }
});

test("user 参数：走 default 权限模式 + 附带纯聊天提示词", () => {
  const args = buildClaudeArgs({ ...BASE, role: "user" });
  const modeIdx = args.indexOf("--permission-mode");
  assert.ok(modeIdx !== -1, "应包含 --permission-mode");
  assert.equal(args[modeIdx + 1], "default", "权限模式必须是 default（不是 acceptEdits/bypass）");
  const promptIdx = args.indexOf("--append-system-prompt");
  assert.ok(promptIdx !== -1, "应包含 --append-system-prompt");
  assert.match(args[promptIdx + 1], /没有任何工具权限/, "提示词应声明无权限");
});

test("user 参数：会话 resume 照常保留", () => {
  const args = buildClaudeArgs({ ...BASE, role: "user" });
  assert.ok(args.includes("--resume"), "user 会话也应支持 resume");
  assert.equal(args[args.indexOf("--resume") + 1], "abc123");
});

test("user 参数：合法时运行时不抛错", () => {
  assert.doesNotThrow(() => buildClaudeArgs({ ...BASE, role: "user" }));
});

test("防呆清单：FORBIDDEN_ARGS_FOR_USER 完整覆盖已知泄漏面", () => {
  // user 会话唯一的注入路径是 buildClaudeArgs；这份清单是运行时兜底，
  // 覆盖所有会把 admin 全权限带进受限会话的参数。
  for (const flag of [
    "--dangerously-skip-permissions",
    "--mcp-config",
    "--strict-mcp-config",
    "--allowedTools",
  ]) {
    assert.ok(FORBIDDEN_ARGS_FOR_USER.includes(flag), `清单缺少 ${flag}`);
  }
  // user 分支合法构造时约束生效、不抛错（回归红线）
  assert.doesNotThrow(() => buildClaudeArgs({ ...BASE, role: "user" }));
});

// ---------- robot 角色 ----------

// 关键回归：role 是**白名单式**判断（user/robot 各一条分支），不是
// `role !== "admin"`。后者会让任何新角色默默掉进 admin 分支拿到 bypass 全权限，
// 这几条测试就是拦这个的。
test("robot 参数：绝不包含任何危险 flag（安全回归红线）", () => {
  const args = buildClaudeArgs({ ...BASE, role: "robot" });
  for (const flag of FORBIDDEN_ARGS_FOR_USER) {
    assert.ok(!args.includes(flag), `robot 参数不应包含 ${flag}`);
  }
});

test("robot 参数：走 default 权限模式，不带 MCP", () => {
  const args = buildClaudeArgs({ ...BASE, role: "robot" });
  const modeIdx = args.indexOf("--permission-mode");
  assert.ok(modeIdx !== -1, "应包含 --permission-mode");
  assert.equal(args[modeIdx + 1], "default", "权限模式必须是 default（不是 acceptEdits/bypass）");
  assert.ok(!args.includes("--mcp-config"), "robot 会话不给 MCP");
  assert.ok(!args.includes("--allowedTools"), "robot 会话不挂白名单");
});

test("robot 参数：附带机器人提示词（含收尾哨兵说明）", () => {
  const args = buildClaudeArgs({ ...BASE, role: "robot" });
  const promptIdx = args.indexOf("--append-system-prompt");
  assert.ok(promptIdx !== -1, "应包含 --append-system-prompt");
  const prompt = args[promptIdx + 1];
  assert.match(prompt, /自动化程序/, "提示词应说明对方是机器人");
  assert.ok(prompt.includes("<<END>>"), "提示词应给出收尾标记的写法");
  assert.ok(prompt.includes("<<KEEP>>"), "提示词应给出「这次不收尾」的写法");
  assert.match(prompt, /没有任何工具权限/, "提示词应声明无权限");
});

test("robot 参数：提示词与 user 的纯聊天提示词不是同一份", () => {
  const robot = buildClaudeArgs({ ...BASE, role: "robot" });
  const user = buildClaudeArgs({ ...BASE, role: "user" });
  assert.notEqual(
    robot[robot.indexOf("--append-system-prompt") + 1],
    user[user.indexOf("--append-system-prompt") + 1],
  );
});

test("robot 参数：会话 resume 照常保留", () => {
  const args = buildClaudeArgs({ ...BASE, role: "robot" });
  assert.ok(args.includes("--resume"), "robot 会话也应支持 resume");
  assert.equal(args[args.indexOf("--resume") + 1], "abc123");
});

test("未知 role 落到 admin 分支（新增角色必须显式加分支）", () => {
  // 记录的是**当前**行为：未知角色走 admin 分支拿到全权限。这是个危险的
  // 默认值，特意断言它是为了让"将来新增角色"这件事必须被显式面对——
  // 这条测试提醒你去 buildClaudeArgs 加一条分支，而不是让新角色默默拿到 bypass。
  //
  // 示例值刻意用不存在的 "superuser"：曾经这里写的是 "moderator"，而 moderator
  // 已经成了一条真实分支（有工具、无 bypass），拿它当"未知角色"会让这条测试
  // 与真实行为脱节。换个不存在的名字，测的才是"未知"这个条件本身。
  const args = buildClaudeArgs({ ...BASE, role: "superuser" });
  assert.ok(args.includes("--dangerously-skip-permissions"));
});

// ---------- moderator：群管会话 ----------
//
// 群管是唯一"有工具但不是 admin"的角色，所以它的参数是双向敏感的：
// 少了白名单/MCP 就什么都做不了，多了 bypass 就等于把 admin 权限发出去。

test("moderator 参数：绝不包含 bypass（安全回归红线）", () => {
  const args = buildClaudeArgs({ ...BASE, role: "moderator" });
  assert.ok(
    !args.includes("--dangerously-skip-permissions"),
    "群管绝不能 bypass——bypass 会完全绕过 --allowedTools",
  );
});

test("moderator 参数：走 default 权限模式（白名单只在 default 下生效）", () => {
  const args = buildClaudeArgs({ ...BASE, role: "moderator" });
  const modeIdx = args.indexOf("--permission-mode");
  assert.ok(modeIdx !== -1, "应包含 --permission-mode");
  assert.equal(args[modeIdx + 1], "default");
});

test("moderator 参数：带 MCP 配置与白名单（否则群管没有工具可用）", () => {
  const args = buildClaudeArgs({
    ...BASE,
    role: "moderator",
    allowedTools: "mcp__onebot-http__set_group_ban",
  });
  assert.ok(args.includes("--mcp-config"), "应包含 --mcp-config");
  assert.ok(args.includes("--strict-mcp-config"), "应包含 --strict-mcp-config");
  const i = args.indexOf("--allowedTools");
  assert.ok(i !== -1, "应包含 --allowedTools");
  assert.equal(args[i + 1], "mcp__onebot-http__set_group_ban");
});

test("moderator 参数：附带群管提示词（不是 user/robot 那两份）", () => {
  const promptOf = (args) => args[args.indexOf("--append-system-prompt") + 1];
  const mod = buildClaudeArgs({ ...BASE, role: "moderator" });
  assert.notEqual(promptOf(mod), promptOf(buildClaudeArgs({ ...BASE, role: "user" })));
  assert.notEqual(promptOf(mod), promptOf(buildClaudeArgs({ ...BASE, role: "robot" })));
});

test("moderator 参数：缺白名单时抛错（不静默降级成无工具会话）", () => {
  assert.throws(
    () => buildClaudeArgs({ ...BASE, role: "moderator", allowedTools: undefined }),
    /--allowedTools/,
  );
});

// ---------- --model 透传 ----------
//
// 模型由 cc-switch 按槽位路由，传的必须是别名（haiku/sonnet/opus）。
// 不传 model 时必须**完全不出现在参数里**，否则会改变上游模型选择。

test("--model：未配置时不出现（保持原有行为）", () => {
  for (const role of ["admin", "user"]) {
    const args = buildClaudeArgs({ ...BASE, role });
    assert.ok(!args.includes("--model"), `${role} 未配 model 时不应出现 --model`);
  }
});

test("--model：配置后 admin 与 user 都带上", () => {
  for (const role of ["admin", "user"]) {
    const args = buildClaudeArgs({ ...BASE, role, model: "haiku" });
    const i = args.indexOf("--model");
    assert.ok(i !== -1, `${role} 应包含 --model`);
    assert.equal(args[i + 1], "haiku");
  }
});

test("--model：不影响 user 会话的权限约束", () => {
  const args = buildClaudeArgs({ ...BASE, role: "user", model: "haiku" });
  for (const flag of FORBIDDEN_ARGS_FOR_USER) {
    assert.ok(!args.includes(flag), `user 参数不应因 model 而包含 ${flag}`);
  }
  const modeIdx = args.indexOf("--permission-mode");
  assert.equal(args[modeIdx + 1], "default", "权限模式仍须是 default");
});