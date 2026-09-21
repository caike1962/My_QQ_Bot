import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startScheduler, loadJobs, saveJobs, addJob, removeJobByIndex } from "../src/scheduler.js";

const tmp = mkdtempSync(join(tmpdir(), "jobs-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
const freshPath = () => join(tmp, `jobs-${seq++}.json`);

const pad = (n) => String(n).padStart(2, "0");
const now = new Date();
const clock = `${pad(now.getHours())}:${pad(now.getMinutes())}`;

// 假的 client：只记录收到的 action，不真的发消息。
function fakeClient({ failWith = null, failTimes = Infinity } = {}) {
  const calls = [];
  let failures = 0;
  return {
    calls,
    action(action, params) {
      calls.push({ action, params });
      if (failWith && failures < failTimes) {
        failures++;
        return Promise.reject(new Error(failWith));
      }
      return Promise.resolve({ status: "ok" });
    },
  };
}

const baseConfig = (jobsPath) => ({
  jobsPath,
  maxReplyChars: 3500,
  claudeExe: "unused",
  claudeBaseUrl: "unused",
  claudeAuthToken: "unused",
  claudeHome: "unused",
  claudeCwd: process.cwd(),
  claudeMcpConfig: "unused",
  allowedTools: "",
  timeoutMs: 1000,
  mcpTimeoutMs: 1000,
  claudeModel: "",
});

// 等到条件成立或超时。调度器是异步 fire，测试里得等它落地。
async function waitFor(fn, ms = 2000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return fn();
}

// —— 任务文件读写 ——

test("loadJobs: 文件不存在返回空数组", () => {
  assert.deepEqual(loadJobs(freshPath()), []);
});

test("loadJobs: 兼容裸数组与 {jobs:[]} 两种格式", () => {
  const p1 = freshPath();
  writeFileSync(p1, JSON.stringify([{ name: "a", time: "08:00" }]));
  assert.equal(loadJobs(p1).length, 1);

  const p2 = freshPath();
  writeFileSync(p2, JSON.stringify({ jobs: [{ name: "b", time: "09:00" }] }));
  assert.equal(loadJobs(p2).length, 1);
});

test("loadJobs: 文件损坏时安静返回空数组，不抛错", () => {
  const p = freshPath();
  writeFileSync(p, "{ 这不是 json");
  assert.deepEqual(loadJobs(p), []);
});

test("addJob: 追加任务并落盘", () => {
  const p = freshPath();
  addJob(p, { name: "a", time: "08:00", text: "起床" });
  addJob(p, { name: "b", time: "09:00", text: "上班" });
  const jobs = loadJobs(p);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].name, "a");
});

test("addJob: 同名任务覆盖而非重复（避免连点两下变双倍轰炸）", () => {
  const p = freshPath();
  addJob(p, { name: "same", time: "08:00", text: "旧" });
  addJob(p, { name: "same", time: "09:00", text: "新" });
  const jobs = loadJobs(p);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].text, "新");
});

test("removeJobByIndex: 按 1 起始的序号删除", () => {
  const p = freshPath();
  addJob(p, { name: "a", time: "08:00" });
  addJob(p, { name: "b", time: "09:00" });
  const removed = removeJobByIndex(p, 1);
  assert.equal(removed.name, "a");
  assert.equal(loadJobs(p).length, 1);
  assert.equal(loadJobs(p)[0].name, "b");
});

test("removeJobByIndex: 越界返回 null 且不修改文件", () => {
  const p = freshPath();
  addJob(p, { name: "a", time: "08:00" });
  assert.equal(removeJobByIndex(p, 5), null);
  assert.equal(removeJobByIndex(p, 0), null);
  assert.equal(loadJobs(p).length, 1);
});

test("saveJobs: 先写临时文件再改名，不留半截 JSON", () => {
  const p = freshPath();
  saveJobs(p, [{ name: "a", time: "08:00" }]);
  // 直接能被 JSON.parse 说明没写坏
  assert.doesNotThrow(() => JSON.parse(readFileSync(p, "utf8")));
});

// —— 调度触发 ——

test("到点触发：文本任务直接发送，不走模型", async () => {
  const p = freshPath();
  const client = fakeClient();
  saveJobs(p, [{ name: "t", time: clock, text: "该起床了", target: { type: "private", id: 123 } }]);
  const s = startScheduler({ client, config: baseConfig(p), log: () => {} });

  assert.ok(await waitFor(() => client.calls.length > 0), "应当触发发送");
  const call = client.calls[0];
  assert.equal(call.action, "send_private_msg");
  assert.equal(call.params.user_id, 123);
  assert.equal(call.params.message, "该起床了");
  s.stop();
});

test("群任务用 send_group_msg", async () => {
  const p = freshPath();
  const client = fakeClient();
  saveJobs(p, [{ name: "g", time: clock, text: "开会", target: { type: "group", id: 456 } }]);
  const s = startScheduler({ client, config: baseConfig(p), log: () => {} });

  assert.ok(await waitFor(() => client.calls.length > 0));
  assert.equal(client.calls[0].action, "send_group_msg");
  assert.equal(client.calls[0].params.group_id, 456);
  s.stop();
});

test("时间不匹配的任务不触发", async () => {
  const p = freshPath();
  const client = fakeClient();
  // 取一个肯定不是当前分钟的时刻
  const other = clock === "03:33" ? "04:44" : "03:33";
  saveJobs(p, [{ name: "x", time: other, text: "不该发", target: { type: "private", id: 1 } }]);
  const s = startScheduler({ client, config: baseConfig(p), log: () => {} });

  await new Promise((r) => setTimeout(r, 300));
  assert.equal(client.calls.length, 0);
  s.stop();
});

test("enabled:false 的任务被跳过", async () => {
  const p = freshPath();
  const client = fakeClient();
  saveJobs(p, [{ name: "d", time: clock, text: "停用", enabled: false, target: { type: "private", id: 1 } }]);
  const s = startScheduler({ client, config: baseConfig(p), log: () => {} });

  await new Promise((r) => setTimeout(r, 300));
  assert.equal(client.calls.length, 0);
  s.stop();
});

test("date 不匹配的一次性任务不触发", async () => {
  const p = freshPath();
  const client = fakeClient();
  saveJobs(p, [
    { name: "once", time: clock, date: "1999-01-01", text: "过去的日子", target: { type: "private", id: 1 } },
  ]);
  const s = startScheduler({ client, config: baseConfig(p), log: () => {} });

  await new Promise((r) => setTimeout(r, 300));
  assert.equal(client.calls.length, 0);
  s.stop();
});

test("weekdays 不匹配的任务不触发", async () => {
  const p = freshPath();
  const client = fakeClient();
  const otherDay = (now.getDay() + 3) % 7;
  saveJobs(p, [
    { name: "wd", time: clock, weekdays: [otherDay], text: "别的日子", target: { type: "private", id: 1 } },
  ]);
  const s = startScheduler({ client, config: baseConfig(p), log: () => {} });

  await new Promise((r) => setTimeout(r, 300));
  assert.equal(client.calls.length, 0);
  s.stop();
});

test("同一分钟不重复发送（幂等状态）", async () => {
  const p = freshPath();
  const client = fakeClient();
  saveJobs(p, [{ name: "once", time: clock, text: "只发一次", target: { type: "private", id: 1 } }]);
  const s = startScheduler({ client, config: baseConfig(p), log: () => {} });

  assert.ok(await waitFor(() => client.calls.length > 0));
  // 手动再 tick 几次，模拟 interval 连续触发
  s.tick();
  s.tick();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(client.calls.length, 1, "同一分钟只应发一次");
  s.stop();
});

test("重启后同一分钟不重发（状态落盘）", async () => {
  const p = freshPath();
  const c1 = fakeClient();
  saveJobs(p, [{ name: "persist", time: clock, text: "重启也别重发", target: { type: "private", id: 1 } }]);
  const s1 = startScheduler({ client: c1, config: baseConfig(p), log: () => {} });
  assert.ok(await waitFor(() => c1.calls.length > 0));
  s1.stop();

  // 模拟 pm2 重启：新调度器读同一份状态文件
  const c2 = fakeClient();
  const s2 = startScheduler({ client: c2, config: baseConfig(p), log: () => {} });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(c2.calls.length, 0, "状态文件应阻止重启后重发");
  s2.stop();
});

test("发送失败时记录日志且不抛出", async () => {
  const p = freshPath();
  // 用非"未连接"的失败：走的是硬失败路径，不触发重试。
  const client = fakeClient({ failWith: "群不存在" });
  const logs = [];
  saveJobs(p, [{ name: "f", time: clock, text: "会失败", target: { type: "private", id: 1 } }]);
  const s = startScheduler({ client, config: baseConfig(p), log: (m) => logs.push(m) });

  assert.ok(await waitFor(() => logs.some((l) => /执行失败/.test(l))), "应当记录失败日志");
  s.stop();
});

test("未连接时重试，连上后仍能发出", async () => {
  const p = freshPath();
  // 前两次失败（模拟启动瞬间 WS 正在握手），第三次成功。
  const client = fakeClient({ failWith: "WebSocket 未连接，无法执行", failTimes: 2 });
  saveJobs(p, [{ name: "retry", time: clock, text: "重试成功", target: { type: "private", id: 7 } }]);
  const s = startScheduler({ client, config: baseConfig(p), log: () => {} });

  assert.ok(
    await waitFor(() => client.calls.length >= 3 && client.calls.at(-1)?.params?.message === "重试成功", 4000),
    "应当在重试后成功发送",
  );
  s.stop();
});

test("超过长度上限时截断并标注", async () => {
  const p = freshPath();
  const client = fakeClient();
  const long = "字".repeat(100);
  saveJobs(p, [{ name: "long", time: clock, text: long, target: { type: "private", id: 1 } }]);
  const cfg = { ...baseConfig(p), maxReplyChars: 20 };
  const s = startScheduler({ client, config: cfg, log: () => {} });

  assert.ok(await waitFor(() => client.calls.length > 0));
  const msg = client.calls[0].params.message;
  assert.ok(msg.length < long.length, "应当被截断");
  assert.match(msg, /已截断/);
  s.stop();
});

test("任务文件缺失时安静空转，不抛错", async () => {
  const client = fakeClient();
  const cfg = baseConfig(join(tmp, "不存在.json"));
  assert.doesNotThrow(() => {
    const s = startScheduler({ client, config: cfg, log: () => {} });
    s.stop();
  });
});
