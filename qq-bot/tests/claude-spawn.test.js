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