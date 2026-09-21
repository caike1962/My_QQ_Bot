import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BG_PREFIX_RE,
  parseBgCommand,
  parseNaturalTrigger,
  setBgPath,
  setBgLogger,
  loadTasks,
  addTask,
  updateTask,
  peekResults,
  consumeResult,
  markDelivered,
  sweepInterrupted,
  admit,
  counts,
  formatResultBlock,
  runBackgroundTask,
} from "../src/bg.js";

const tmp = mkdtempSync(join(tmpdir(), "bg-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
const freshPath = () => join(tmp, `bg-${seq++}.json`);

// 每个用例换一个干净的文件，模块级路径靠 setBgPath 注入。
function useFile() {
  const p = freshPath();
  setBgPath(p);
  return p;
}

function silence() {
  setBgLogger(() => {});
}

// —— 显式指令解析 ——

test("parseBgCommand: /bg 后跟内容 = 布置任务", () => {
  assert.deepEqual(parseBgCommand("/bg 查一下 D 盘占用"), {
    action: "run",
    prompt: "查一下 D 盘占用",
  });
  assert.deepEqual(parseBgCommand("/后台 整理待办"), { action: "run", prompt: "整理待办" });
});

test("parseBgCommand: 裸 /bg 与「帮助」都是帮助，不会把「帮助」当任务跑", () => {
  assert.deepEqual(parseBgCommand("/bg"), { action: "help" });
  assert.deepEqual(parseBgCommand("/bg 帮助"), { action: "help" });
  assert.deepEqual(parseBgCommand("/后台   "), { action: "help" });
});

test("parseBgCommand: 列表与取消", () => {
  assert.deepEqual(parseBgCommand("/bg 列表"), { action: "list" });
  assert.deepEqual(parseBgCommand("/bg 取消 2"), { action: "cancel", index: 2 });
  assert.deepEqual(parseBgCommand("/bg 取消"), { action: "help" });
  assert.deepEqual(parseBgCommand("/bg 取消 0"), { action: "help" });
});

test("parseBgCommand: 前缀后紧跟别的字不算指令", () => {
  // /bgx 不是 /bg —— 少了这个界定，任何以 /bg 开头的词都会被吞掉
  assert.equal(parseBgCommand("/bgx 查磁盘"), null);
  assert.equal(parseBgCommand("/后台任务"), null);
  assert.equal(parseBgCommand("随便聊聊"), null);
  // 「列表x」是任务描述而不是列表指令，只认精确匹配
  assert.deepEqual(parseBgCommand("/bg 列表x"), { action: "run", prompt: "列表x" });
});

test("BG_PREFIX_RE 与 parseBgCommand 的边界一致（防漂移）", () => {
  // isDirectCommand 用正则、dispatch 用解析器，两者对不上会出现
  // 「命令被截胡但没人处理」的静默失败
  for (const t of ["/bg", "/bg 查磁盘", "/后台 整理", "/bg 列表", "/bg 取消 1"]) {
    assert.equal(BG_PREFIX_RE.test(t), parseBgCommand(t) !== null, `不一致: ${t}`);
  }
  assert.equal(BG_PREFIX_RE.test("/bgx"), false);
});

// —— 自然语言触发 ——

test("parseNaturalTrigger: 常见说法都能认出来，并剥掉客套词", () => {
  assert.deepEqual(parseNaturalTrigger("后台帮我查一下 D 盘"), { prompt: "查一下 D 盘" });
  assert.deepEqual(parseNaturalTrigger("在后台把日志整理一下"), { prompt: "把日志整理一下" });
  assert.deepEqual(parseNaturalTrigger("后台跑一下构建"), { prompt: "跑一下构建" });
  assert.deepEqual(parseNaturalTrigger("后台统计一下这周的提交"), { prompt: "统计一下这周的提交" });
});

test("parseNaturalTrigger: 问句不触发", () => {
  assert.equal(parseNaturalTrigger("你支持后台任务吗？"), null);
  assert.equal(parseNaturalTrigger("后台是什么意思"), null);
});

test("parseNaturalTrigger: 「后台任务」是名词，不是指令", () => {
  // 用户说的可能是一个概念，或想查列表——那有 /bg 列表 这个明确入口
  assert.equal(parseNaturalTrigger("后台任务列表"), null);
});

test("parseNaturalTrigger: 没有动作词就不触发", () => {
  assert.equal(parseNaturalTrigger("重要文件都放在后台目录"), null);
  assert.equal(parseNaturalTrigger("后台"), null);
  assert.equal(parseNaturalTrigger(""), null);
});

test("parseNaturalTrigger: 剥完前缀为空则不触发（纯客套话）", () => {
  assert.equal(parseNaturalTrigger("后台帮我"), null);
});

test("parseNaturalTrigger: 显式指令不在这里重复处理", () => {
  assert.equal(parseNaturalTrigger("/bg 查磁盘"), null);
});

// —— 落盘 ——

test("loadTasks: 文件不存在返回空数组", () => {
  useFile();
  assert.deepEqual(loadTasks(), []);
});

test("loadTasks: 损坏的 JSON 返回空数组且不抛错", () => {
  const p = useFile();
  writeFileSync(p, "{ 这不是 json");
  let warned = "";
  setBgLogger((m) => (warned = m));
  assert.deepEqual(loadTasks(), []);
  assert.match(warned, /损坏/);
});

test("addTask / updateTask: 落盘可读回，且是合法 JSON", () => {
  const p = useFile();
  silence();
  const t = addTask({ conv: "private:1", prompt: "查磁盘" });
  assert.equal(t.status, "running");
  assert.equal(t.delivered, false);
  assert.equal(t.injected, false);

  const reread = loadTasks();
  assert.equal(reread.length, 1);
  assert.equal(reread[0].prompt, "查磁盘");

  updateTask(t.id, { status: "done" });
  assert.equal(loadTasks()[0].status, "done");
  // 原子写的证明：文件能被完整解析
  assert.doesNotThrow(() => JSON.parse(readFileSync(p, "utf8")));
});

test("updateTask: 不存在的 id 返回 null 而不是抛错", () => {
  useFile();
  silence();
  assert.equal(updateTask("nope", { status: "done" }), null);
});

// —— 闸门 ——

test("admit: 同会话已有在跑的 → 拒绝（reason=conv）", () => {
  useFile();
  silence();
  addTask({ conv: "private:1", prompt: "第一个" });
  const gate = admit({ conv: "private:1", max: 3 });
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, "conv");
  assert.equal(gate.task.prompt, "第一个");
});

test("admit: 别的会话不受影响", () => {
  useFile();
  silence();
  addTask({ conv: "private:1", prompt: "第一个" });
  assert.equal(admit({ conv: "private:2", max: 3 }).ok, true);
});

test("admit: 全局满则拒绝（reason=global）", () => {
  useFile();
  silence();
  addTask({ conv: "private:1", prompt: "a" });
  addTask({ conv: "private:2", prompt: "b" });
  const gate = admit({ conv: "private:3", max: 2 });
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, "global");
  assert.equal(gate.running, 2);
});

test("admit: 已结束的任务不占用名额", () => {
  useFile();
  silence();
  const t = addTask({ conv: "private:1", prompt: "a" });
  updateTask(t.id, { status: "done" });
  assert.equal(admit({ conv: "private:1", max: 1 }).ok, true);
});

// —— 重启打断 ——

test("sweepInterrupted: running 条目被收尾，done 的不动", () => {
  useFile();
  silence();
  const a = addTask({ conv: "private:1", prompt: "跑着的" });
  const b = addTask({ conv: "private:1", prompt: "已完成的" });
  updateTask(b.id, { status: "done", result: { ok: true, text: "好了", at: Date.now() } });

  const swept = sweepInterrupted();
  assert.equal(swept.length, 1);
  assert.equal(swept[0].id, a.id);
  assert.equal(swept[0].result.interrupted, true);
  assert.match(swept[0].result.text, /重启/);

  const after = loadTasks();
  assert.equal(after.find((t) => t.id === a.id).status, "done");
  assert.equal(after.find((t) => t.id === b.id).result.text, "好了");
});

test("sweepInterrupted: 幂等，第二次跑什么都不做", () => {
  useFile();
  silence();
  addTask({ conv: "private:1", prompt: "跑着的" });
  assert.equal(sweepInterrupted().length, 1);
  assert.equal(sweepInterrupted().length, 0);
});

// —— 结果读取与消费 ——

test("peekResults: 不消费——连查两次都拿得到", () => {
  useFile();
  silence();
  const t = addTask({ conv: "private:1", prompt: "查磁盘" });
  updateTask(t.id, {
    status: "done",
    result: { ok: true, text: "结果在这", file: null, at: Date.now() },
  });

  const first = peekResults("private:1", { ttlMs: 86400000 });
  assert.equal(first.result.text, "结果在这");
  const second = peekResults("private:1", { ttlMs: 86400000 });
  assert.equal(second.result.text, "结果在这", "没消费就不该消失");
});

test("peekResults: 只取本会话的", () => {
  useFile();
  silence();
  const t = addTask({ conv: "private:9", prompt: "别人的" });
  updateTask(t.id, { status: "done", result: { ok: true, text: "x", at: Date.now() } });
  assert.equal(peekResults("private:1", { ttlMs: 86400000 }), null);
});

test("peekResults: 已注入过的不再返回", () => {
  useFile();
  silence();
  const t = addTask({ conv: "private:1", prompt: "查磁盘" });
  updateTask(t.id, { status: "done", injected: true, result: { ok: true, text: "x", at: Date.now() } });
  assert.equal(peekResults("private:1", { ttlMs: 86400000 }), null);
});

test("peekResults: 过期的被丢弃并告警", () => {
  useFile();
  silence();
  const t = addTask({ conv: "private:1", prompt: "老结果" });
  updateTask(t.id, {
    status: "done",
    result: { ok: true, text: "x", at: Date.now() - 90000000 },
  });

  let warned = "";
  setBgLogger((m) => (warned = m));
  assert.equal(peekResults("private:1", { ttlMs: 86400000 }), null);
  assert.match(warned, /过期/);
  assert.equal(loadTasks().length, 0, "过期的条目该被清掉");
});

test("consumeResult: 恰好删掉一条", () => {
  useFile();
  silence();
  const a = addTask({ conv: "private:1", prompt: "a" });
  const b = addTask({ conv: "private:1", prompt: "b" });
  consumeResult(a.id);
  const left = loadTasks();
  assert.equal(left.length, 1);
  assert.equal(left[0].id, b.id);
});

test("markDelivered: 只改标记，条目还在（等注入）", () => {
  useFile();
  silence();
  const t = addTask({ conv: "private:1", prompt: "a" });
  updateTask(t.id, { status: "done", result: { ok: true, text: "x", at: Date.now() } });
  markDelivered(t.id);
  const after = loadTasks()[0];
  assert.equal(after.delivered, true);
  assert.equal(after.injected, false);
});

test("counts: 分别统计运行中与待注入", () => {
  useFile();
  silence();
  addTask({ conv: "private:1", prompt: "跑着" });
  const t = addTask({ conv: "private:2", prompt: "好了" });
  updateTask(t.id, { status: "done", result: { ok: true, text: "x", at: Date.now() } });

  const all = counts();
  assert.equal(all.running.length, 1);
  assert.equal(all.pendingInject.length, 1);
  assert.equal(counts("private:1").running.length, 1);
  assert.equal(counts("private:1").pendingInject.length, 0);
});

// —— 注入块 ——

test("formatResultBlock: 含任务描述、预览与文件路径", () => {
  const block = formatResultBlock({
    task: {
      prompt: "查磁盘",
      result: { text: "C 盘占了 80%", file: "D:\\ws\\report-1.html", at: Date.now() },
    },
    previewChars: 1200,
  });
  assert.match(block, /查磁盘/);
  assert.match(block, /C 盘占了 80%/);
  assert.match(block, /report-1\.html/);
});

test("formatResultBlock: 超长时只带预览，并说明怎么拿全文", () => {
  const long = "甲".repeat(5000);
  const block = formatResultBlock({
    task: { prompt: "长任务", result: { text: long, file: null, at: Date.now() } },
    previewChars: 1200,
  });
  // 这是防 maxPromptChars 回归的关键：块长必须被压住，
  // 否则注入后 prompt 超长会让该会话之后每条消息都被拒
  assert.ok(block.length < 1400, `块太长了: ${block.length}`);
  assert.match(block, /只是开头/);
});

test("formatResultBlock: 没有文件时明说，不含文件路径字样", () => {
  const block = formatResultBlock({
    task: { prompt: "失败的", result: { text: "出错了", file: null, at: Date.now() } },
    previewChars: 1200,
  });
  assert.doesNotMatch(block, /Read 打开/);
});

// —— 执行 ——

// 一份够用的假 config：runBackgroundTask 只读这些字段。
const bgConfig = () => ({
  claudeExe: "unused",
  claudeBaseUrl: "unused",
  claudeAuthToken: "unused",
  claudeHome: "unused",
  claudeCwd: ".",
  claudeMcpConfig: "unused",
  allowedTools: "Read",
  maxTurns: 15,
  bgTimeoutMs: 1800000,
  mcpTimeoutMs: 30000,
  claudeModel: "",
});

test("runBackgroundTask: 用独立会话调用（sessionId 必须是 null）", async () => {
  useFile();
  silence();
  const seen = [];
  const stub = async (opts) => {
    seen.push(opts);
    return { text: "好了", cost: 0.01, sessionId: "sess-bg" };
  };

  await runBackgroundTask({
    task: { id: "t1", conv: "private:1", prompt: "查磁盘" },
    config: bgConfig(),
    log: () => {},
    runClaude: stub,
  });

  assert.equal(seen.length, 1);
  // 这条是本功能成立的前提：非 null 就会和主会话抢同一个会话文件
  assert.equal(seen[0].sessionId, null);
  assert.equal(seen[0].role, "admin");
  assert.equal(seen[0].timeoutMs, 1800000);
  assert.equal(seen[0].prompt, "查磁盘");
});

test("runBackgroundTask: 全文返回，不截断（对照 scheduler 的 3500 字截断）", async () => {
  useFile();
  silence();
  const long = "乙".repeat(5000);
  const stub = async () => ({ text: long, cost: 0.02, sessionId: "s1" });

  const out = await runBackgroundTask({
    task: { id: "t2", conv: "private:1", prompt: "长任务" },
    config: bgConfig(),
    log: () => {},
    runClaude: stub,
  });

  assert.equal(out.text.length, 5000, "尾部不能被丢掉");
});

test("runBackgroundTask: 历史在前、任务在后", async () => {
  useFile();
  silence();
  let got = null;
  const stub = async (opts) => {
    got = opts.prompt;
    return { text: "x", cost: 0, sessionId: "s" };
  };

  await runBackgroundTask({
    task: { id: "t3", conv: "private:1", prompt: "查磁盘" },
    config: bgConfig(),
    log: () => {},
    runClaude: stub,
    history: "机主: 先看看 C 盘",
  });

  assert.match(got, /先看看 C 盘/);
  assert.match(got, /当前任务/);
  assert.ok(got.indexOf("先看看 C 盘") < got.indexOf("当前任务"), "背景在前、请求在后");
});

test("runBackgroundTask: 失败时抛出去，交给调用方记账", async () => {
  useFile();
  silence();
  const stub = async () => {
    throw new Error("claude 超时");
  };
  await assert.rejects(
    runBackgroundTask({
      task: { id: "t4", conv: "private:1", prompt: "x" },
      config: bgConfig(),
      log: () => {},
      runClaude: stub,
    }),
    /超时/,
  );
});

test("buildClaudeArgs: --max-turns 接上了配置（此前是死配置）", async () => {
  const { buildClaudeArgs } = await import("../src/claude.js");
  const args = buildClaudeArgs({
    role: "admin",
    prompt: "hi",
    mcpConfigPath: "m.json",
    allowedTools: "Read",
    maxTurns: 7,
  });
  const i = args.indexOf("--max-turns");
  assert.ok(i > -1, "应该带上 --max-turns");
  assert.equal(args[i + 1], "7");
});

test("buildClaudeArgs: maxTurns 不传或为 0 时不加该参数", async () => {
  const { buildClaudeArgs } = await import("../src/claude.js");
  for (const maxTurns of [undefined, 0, null]) {
    const args = buildClaudeArgs({ role: "admin", prompt: "hi", mcpConfigPath: "m.json", allowedTools: "Read", maxTurns });
    assert.equal(args.includes("--max-turns"), false, `maxTurns=${maxTurns} 时不该带`);
  }
});
