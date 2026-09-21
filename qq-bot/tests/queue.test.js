import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  setQueuePath,
  setQueueLogger,
  markQueued,
  markRunning,
  removePending,
  loadEntries,
  markMerging,
  markMergingAborted,
  markNotified,
} from "../src/queue.js";

let dir;
let warnings;

const EV = (text) => ({
  post_type: "message",
  message_type: "private",
  user_id: 123,
  message: [{ type: "text", data: { text } }],
});

test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qqbot-queue-"));
  setQueuePath(join(dir, "queue.json"));
  warnings = [];
  setQueueLogger((m) => warnings.push(m));
});

test.afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 已清理 */
  }
});

const qpath = () => join(dir, "queue.json");

test("空队列：文件不存在时返回空数组", () => {
  assert.deepEqual(loadEntries(), []);
});

test("markQueued: 入队后可读回，状态为 queued，且返回唯一 id", () => {
  const id = markQueued("k1", EV("你好"));
  assert.ok(id, "应返回条目 id");
  const entries = loadEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].key, "k1");
  assert.equal(entries[0].status, "queued");
  assert.equal(entries[0].id, id);
  assert.equal(entries[0].event.message[0].data.text, "你好");
});

test("markRunning: 按 id 把 queued 改成 running", () => {
  const id = markQueued("k1", EV("a"));
  markRunning(id);
  assert.equal(loadEntries()[0].status, "running");
});

test("markRunning: 只影响该 id，不碰其他条目", () => {
  const a = markQueued("k1", EV("a"));
  markQueued("k2", EV("b"));
  markRunning(a);
  const byId = Object.fromEntries(loadEntries().map((e) => [e.id, e.status]));
  assert.equal(byId[a], "running");
  const others = loadEntries().filter((e) => e.id !== a);
  assert.ok(others.every((e) => e.status === "queued"), "其他条目应保持 queued");
});

test("markRunning: 已经是 running 的不重复写（幂等）", () => {
  const id = markQueued("k1", EV("a"));
  markRunning(id);
  const first = readFileSync(qpath(), "utf8");
  markRunning(id);
  assert.equal(readFileSync(qpath(), "utf8"), first, "内容不应变化");
});

test("removePending: 按 id 摘除，其余保留", () => {
  const a = markQueued("k1", EV("a"));
  markQueued("k2", EV("b"));
  removePending(a);
  const entries = loadEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].key, "k2");
});

test("removePending: id 不存在时不写盘", () => {
  markQueued("k1", EV("a"));
  const before = readFileSync(qpath(), "utf8");
  removePending("不存在的id");
  assert.equal(readFileSync(qpath(), "utf8"), before);
});

// 这个场景是设计的关键：用户连发多条时，同时只有队首在执行。
// 若按 key 标记，「从未执行过」的后续消息会被误判成 running，
// 恢复时就不敢自动重放——本该自动恢复的消息被降级为需要用户手动确认。
test("连发多条：只标记队首，后续仍为 queued（可自动重放）", () => {
  const a = markQueued("k1", EV("第一"));
  markQueued("k1", EV("第二"));

  markRunning(a); // 只标记队首（与 enqueue 的实际行为一致）

  const entries = loadEntries();
  assert.equal(entries[0].status, "running", "队首应标为执行中");
  assert.equal(entries[1].status, "queued", "未执行的第二条必须仍是 queued");

  // 模拟重启后的分类：running 进 pendingRetry，queued 自动重放
  const auto = entries.filter((e) => e.status === "queued");
  const manual = entries.filter((e) => e.status !== "queued");
  assert.equal(auto.length, 1, "第二条应可自动重放");
  assert.equal(manual.length, 1, "第一条应进 pendingRetry");
});

test("同一 key 多条消息按到达顺序保留（连发场景）", () => {
  markQueued("k1", EV("第一"));
  markQueued("k1", EV("第二"));
  const entries = loadEntries();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].event.message[0].data.text, "第一");
  assert.equal(entries[1].event.message[0].data.text, "第二");
});

test("条目 id 唯一（连发不会互相覆盖）", () => {
  const ids = new Set();
  for (let i = 0; i < 20; i++) ids.add(markQueued("k1", EV("m" + i)));
  assert.equal(ids.size, 20, "20 次入队应产生 20 个不同 id");
});

test("损坏的队列文件：丢弃并告警，不静默当空队列", () => {
  writeFileSync(qpath(), "{ 不是json ][", "utf8");
  assert.deepEqual(loadEntries(), []);
  assert.ok(warnings.some((w) => /损坏/.test(w)), "应有损坏告警，实际: " + JSON.stringify(warnings));
});

test("非数组格式：丢弃并告警", () => {
  writeFileSync(qpath(), '{"not":"array"}', "utf8");
  assert.deepEqual(loadEntries(), []);
  assert.ok(warnings.some((w) => /格式异常/.test(w)));
});

test("缺 event 字段的脏条目被过滤，不影响其他条目", () => {
  writeFileSync(qpath(), JSON.stringify([{ key: "bad" }, { key: "k1", event: EV("好的"), status: "queued" }]), "utf8");
  const entries = loadEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].key, "k1");
});

test("超过体积上限：整体丢弃并告警", () => {
  // 1 MB 上限，写一个大数组撑爆它
  const big = Array.from({ length: 4000 }, (_, i) => ({
    key: "k" + i,
    event: EV("x".repeat(300)),
    status: "queued",
  }));
  writeFileSync(qpath(), JSON.stringify(big), "utf8");
  const entries = loadEntries();
  assert.deepEqual(entries, [], "超限应整体丢弃");
  assert.ok(warnings.some((w) => /超过 1 MB/.test(w)), "应告警: " + JSON.stringify(warnings));
});

test("正常写入是原子的：不留 .tmp 残留", () => {
  markQueued("k1", EV("a"));
  assert.ok(existsSync(qpath()), "应生成 queue.json");
  assert.ok(!existsSync(qpath() + ".tmp"), "不应残留 .tmp");
});

// ---- 合并打断用的状态迁移 ----
//
// 语义：被合并的条目内容已并入新的一条 prompt，不需要重放，但必须停在
// 终态而不是从磁盘消失——否则重启恢复时它既不在 queued 也不在 interrupted，
// 成了无人知晓的幽灵条目，而 queueDepth 又把它算进排队数。

test("markMerging: running → merging（内容已并入新消息）", () => {
  const id = markQueued("k1", EV("第一条"));
  markRunning(id);
  markMerging(id);
  assert.equal(loadEntries()[0].status, "merging");
});

test("markMerging: 只动 running/queued，不碰终态条目", () => {
  const id = markQueued("k1", EV("a"));
  markRunning(id);
  markNotified(id);
  markMerging(id); // 已是终态，不该被改回 merging
  assert.equal(loadEntries()[0].status, "notified", "终态条目不该被标成 merging");
});

test("markMerging: 排队中的消息也能被合并（连发三条时第二条尚未成为队首）", () => {
  const first = markQueued("k1", EV("第一条"));
  const second = markQueued("k1", EV("第二条"));
  markRunning(first); // 只有队首在跑
  assert.equal(loadEntries()[1].status, "queued");
  markMerging(second); // 用户连发，第二条被并进合并
  assert.equal(loadEntries()[1].status, "merging", "排队中的条目也必须能被标记");
});

test("markMergingAborted: merging → notified（退回待重放）", () => {
  const id = markQueued("k1", EV("a"));
  markRunning(id);
  markMerging(id);
  markMergingAborted(id);
  assert.equal(loadEntries()[0].status, "notified");
});

test("markMergingAborted: 不是 merging 的不动", () => {
  const id = markQueued("k1", EV("a"));
  markRunning(id);
  markMergingAborted(id); // 仍是 running
  assert.equal(loadEntries()[0].status, "running");
});

// 最坏时序：旧条目已标 merging、新条目还没落盘时被强杀。
// 恢复逻辑必须能识别出"内容无着落"，退回 notified 让用户可重放，
// 而不是当作已合并的垃圾清掉——那等于静默丢消息。
test("最坏时序：merging 条目在无同类活跃条目时应退回待重放", () => {
  const id = markQueued("k1", EV("唯一的一条"));
  markRunning(id);
  markMerging(id);

  const entries = loadEntries();
  const active = entries.filter(
    (e) => e.status === "queued" || e.status === "running",
  );
  assert.equal(active.length, 0, "没有活跃条目 → 这条 merging 的内容无着落");
  // 恢复逻辑据此走 markMergingAborted 分支（而不是 removePending）
  markMergingAborted(id);
  assert.equal(loadEntries()[0].status, "notified", "应退回待重放而不是被清掉");
});

test("同步合并：merging 条目在同会话有活跃条目时可安全清除", () => {
  const old = markQueued("k1", EV("第一条"));
  markRunning(old);
  markMerging(old);
  markQueued("k1", EV("第二条")); // 合并后的新条目

  const entries = loadEntries();
  const hasActive = entries.some(
    (e) => e.key === "k1" && e.id !== old && (e.status === "queued" || e.status === "running"),
  );
  assert.equal(hasActive, true, "同会话有活跃条目 → 合并内容有着落，可清除");
});
