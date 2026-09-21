import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDiagnostic, fmtDur, fmtMb, fmtClock, keyLabel } from "../src/diagnostics.js";

// 固定时间基准：报告里所有相对时长都由 state.now 推出，
// 不依赖真实时钟，断言才能稳定。
const NOW = Date.parse("2026-09-21T22:00:00+08:00");
const MIN = 60_000;

function base(over = {}) {
  return {
    now: NOW,
    pid: 1234,
    ws: "已连接",
    startedAt: NOW - 30 * MIN,
    lastRecvAt: NOW - 5 * MIN,
    queuedSinceBoot: 7,
    bootRecent: false,
    mergeWindowMs: 5000,
    processes: [],
    execs: [],
    queueEntries: [],
    queueTotal: 0,
    sessionMeta: [],
    activity: [],
    deps: { proxy: { ok: true }, claudeExe: "C:\\claude.exe" },
    files: { queueFile: { sizeMb: 0.01 }, jobsFile: { count: 2 }, pendingFiles: 0, pendingRetry: 0 },
    sessions: { compactMb: 1.5, maxMb: 3 },
    ...over,
  };
}

test("fmtDur: 秒/分/时/天 的进位与边界", () => {
  assert.equal(fmtDur(0), "0秒");
  assert.equal(fmtDur(999), "1秒");
  assert.equal(fmtDur(59_400), "59秒");
  assert.equal(fmtDur(60_000), "1分");
  assert.equal(fmtDur(90_000), "1分30秒");
  assert.equal(fmtDur(3600_000), "1时");
  assert.equal(fmtDur(3600_000 + 60_000), "1时1分");
  assert.equal(fmtDur(25 * 3600_000), "1天1时");
  assert.equal(fmtDur(NaN), "?");
  assert.equal(fmtDur(-1), "?");
});

test("fmtMb: 读不到时给的是「读取失败」而不是 0.00 MB", () => {
  assert.equal(fmtMb(1.234), "1.23 MB");
  assert.equal(fmtMb(null), "读取失败");
  assert.equal(fmtMb(NaN), "读取失败");
});

test("keyLabel: 三种键都转成人话", () => {
  assert.equal(keyLabel("group:123", 42), "群123(42人)");
  assert.equal(keyLabel("group:123", null), "群123");
  assert.equal(keyLabel("private:9", 42), "私聊9");
  // 关闭群共享会话时是「群号:QQ号」，直接显示两个裸数字没人看得懂
  assert.equal(keyLabel("894815246:2998981505"), "群894815246·用户2998981505");
  assert.equal(keyLabel("莫名其妙的键"), "莫名其妙的键");
});

test("空快照：该显示的一节不落，不该出现的节不冒出来", () => {
  const text = buildDiagnostic(base());
  assert.match(text, /诊断（09-21 22:00:00）/);
  assert.match(text, /pid=1234｜WebSocket 已连接/);
  assert.match(text, /已运行 30分/);
  assert.match(text, /最后收到消息于 5分前/);
  assert.match(text, /自启动已回复 7 条消息/);
  assert.match(text, /cc-switch 代理可连接/);
  // 空队列要显示出来——它是"链路通畅"的证据
  assert.match(text, /【队列】/);
  // 无事可报的节连标题都不显示
  assert.ok(!text.includes("【任务】"), "没有子进程时不该出现【任务】");
  assert.ok(!text.includes("【执行】"), "没有执行中任务时不该出现【执行】");
  assert.ok(!text.includes("【会话】"), "没有会话时不该出现【会话】");
  assert.ok(!text.includes("【最近】"), "没有活动记录时不该出现【最近】");
});

test("刚启动：附上「连不上 3001 属正常」的提示", () => {
  const text = buildDiagnostic(base({ bootRecent: true, lastRecvAt: null }));
  assert.match(text, /【提示】/);
  assert.match(text, /40~60 秒后稳定/);
  assert.match(text, /本次启动还没收到过消息/);
});

test("卡住的子进程：显示 pid 与已运行时长", () => {
  const text = buildDiagnostic(
    base({
      processes: [{ pid: 999, startedAt: NOW - 20 * MIN, label: "对话：帮我查下天气", done: false }],
    }),
  );
  assert.match(text, /【任务】/);
  assert.match(text, /pid=999 已运行 20分/);
  assert.match(text, /对话：帮我查下天气/);
});

test("执行中：超过合并窗口要说明不会再被打断", () => {
  const text = buildDiagnostic(
    base({
      execs: [
        {
          key: "private:1",
          what: "帮我装个软件",
          startedAt: NOW - 90_000,
          sessionId: "abcdef1234567890",
          memberCount: null,
        },
      ],
    }),
  );
  assert.match(text, /【执行】/);
  assert.match(text, /运行 1分30秒|运行 90秒/);
  assert.match(text, /已超出合并窗口/);
  assert.match(text, /会话 abcdef12/);
  // 正在做什么交给【任务】节，执行行不重复贴 prompt
  assert.ok(!text.includes("帮我装个软件"), "【执行】不该重复【任务】已经给出的话题");
});

test("执行中：窗口内不该出现「超出合并窗口」的提示", () => {
  const text = buildDiagnostic(
    base({
      execs: [{ key: "private:1", what: "x", startedAt: NOW - 1000, sessionId: null, memberCount: null }],
    }),
  );
  assert.ok(!text.includes("已超出合并窗口"));
  assert.match(text, /会话 未建立/);
});

test("队列：按会话归组，排队超窗口才算卡住", () => {
  const text = buildDiagnostic(
    base({
      queueEntries: [
        { id: "a", key: "private:1", status: "queued", at: NOW - 40_000 },
        { id: "b", key: "private:1", status: "queued", at: NOW - 30_000 },
        { id: "c", key: "group:9", status: "notified", at: NOW - 10_000 },
      ],
      queueTotal: 3,
    }),
  );
  assert.match(text, /私聊1｜2 排队｜最久 40秒 ⚠ 排队超过合并窗口/);
  assert.match(text, /群9｜1 待回「继续」/);
  assert.ok(!text.includes("队列共"), "队列全部列出时不该有省略说明");
});

test("队列：超过展示上限时说明有多少条没列出来", () => {
  const entries = Array.from({ length: 30 }, (_, i) => ({
    id: String(i),
    key: "private:1",
    status: "queued",
    at: NOW - 1000,
  }));
  const text = buildDiagnostic(base({ queueEntries: entries, queueTotal: 57 }));
  assert.match(text, /队列共 57 条，上面只列了前 30 条/);
});

test("会话：达到压缩阈值和超过上限是两种不同的告警", () => {
  const text = buildDiagnostic(
    base({
      sessionMeta: [
        { key: "private:1", sessionId: "aaaaaaaa1111", sizeMb: 1.8, memberCount: null },
        { key: "group:9", sessionId: "bbbbbbbb2222", sizeMb: 4.2, memberCount: 88 },
      ],
    }),
  );
  assert.match(text, /私聊1｜会话 aaaaaaaa｜1\.80 MB ⚠ 达到压缩阈值 1\.5 MB/);
  assert.match(text, /群9\(88人\)｜会话 bbbbbbbb｜4\.20 MB ⚠ 超过上限 3 MB，下条将开新会话/);
});

test("会话：文件不存在与读取失败是两回事", () => {
  const text = buildDiagnostic(
    base({
      sessionMeta: [
        { key: "private:1", sessionId: "aaa", sizeMb: null, memberCount: null },
      ],
    }),
  );
  assert.match(text, /文件不存在（下条会开新会话）/);
});

test("最近活动：给出收到时刻和回复耗时", () => {
  const text = buildDiagnostic(
    base({
      activity: [
        {
          key: "private:1",
          memberCount: null,
          lastRecv: NOW - 2 * MIN,
          lastText: "帮我查下磁盘",
          lastReply: NOW - 2 * MIN + 3000,
        },
      ],
    }),
  );
  assert.match(text, /【最近】/);
  assert.match(text, /最后收到：帮我查下磁盘/);
  assert.match(text, /回复耗时 3秒/);
});

test("最近活动：全部会话都沉默时压成一行汇总，不重复 N 遍", () => {
  const text = buildDiagnostic(
    base({
      activity: [
        { key: "group:1", memberCount: 42, lastRecv: null, lastText: null, lastReply: null },
        { key: "group:2", memberCount: 43, lastRecv: null, lastText: null, lastReply: null },
        { key: "private:7", memberCount: null, lastRecv: null, lastText: null, lastReply: null },
      ],
    }),
  );
  assert.match(text, /【最近】/);
  assert.match(text, /跟踪 3 个会话，本次启动都还没收到过消息/);
  // 关键：三行"还没收到过消息"要被压成一行
  assert.equal((text.match(/还没收到过消息/g) || []).length, 1);
});

test("最近活动：有会话活跃时只列活跃的那些", () => {
  const text = buildDiagnostic(
    base({
      activity: [
        {
          key: "group:1",
          memberCount: 42,
          lastRecv: NOW - MIN,
          lastText: "活的",
          lastReply: NOW - MIN + 1000,
        },
        { key: "group:2", memberCount: 43, lastRecv: null, lastText: null, lastReply: null },
      ],
    }),
  );
  assert.match(text, /【最近】/);
  assert.match(text, /最后收到：活的/);
  assert.ok(!text.includes("还没收到过消息"), "有活跃会话时不该再列沉默的会话");
});

test("依赖：代理不通要给出「所有消息都会失败」的结论", () => {
  const text = buildDiagnostic(
    base({ deps: { proxy: { ok: false, error: "connect ECONNREFUSED" }, claudeExe: null } }),
  );
  assert.match(text, /⚠ cc-switch 代理连不上/);
  assert.match(text, /所有消息都会失败/);
  assert.match(text, /⚠ 找不到 claude\.exe/);
});

test("文件：queue.json 偏大要告警", () => {
  const text = buildDiagnostic(base({ files: { queueFile: { sizeMb: 0.6 }, jobsFile: null } }));
  assert.match(text, /⚠ queue\.json 0\.60 MB/);
  assert.match(text, /涨到 1MB 会整体丢弃/);
});

test("超长时从低优先级开始整节砍掉，并说明砍了什么", () => {
  // 活动项的相对时间必须在拿到最终 now 之后再算——base() 的 now 会被
  // over 覆盖，提前算好会让它们变成"未来时间"而在过滤时丢掉。
  const heavy = (n) => {
    const s = base();
    return {
      ...s,
      activity: Array.from({ length: n }, (_, i) => ({
        key: `group:${i}`,
        memberCount: 100 + i,
        lastRecv: s.now - i * 1000,
        lastText: "这是一条足够长的消息内容用来把报告撑到上限之外",
        lastReply: s.now - i * 1000 + 500,
      })),
    };
  };

  // 先确认这个规模确实能撑破 3200 字符——否则下面的断言是在测空气。
  // （40 条约 3000 字符，60 条必定越过阈值。）
  assert.ok(buildDiagnostic(heavy(60)).length <= 3400, "截断后应当缩短");
  assert.ok(buildDiagnostic(heavy(60)) !== buildDiagnostic(heavy(40)), "60 条必须触发截断");

  const text = buildDiagnostic(heavy(60));
  assert.match(text, /内容过长，已省略：「最近」/);
  // 高优先级的节必须还在
  assert.match(text, /【运行】/);
  assert.match(text, /【依赖】/);
  assert.ok(!text.includes("【最近】"), "被砍掉的节不该再出现");
});

test("砍一节还不够时继续砍下一节", () => {
  const s = base();
  const text = buildDiagnostic({
    ...s,
    activity: Array.from({ length: 150 }, (_, i) => ({
      key: `group:${i}`,
      memberCount: 100 + i,
      lastRecv: s.now - i * 1000,
      lastText: "足够长的内容".repeat(6),
      lastReply: s.now - i * 1000 + 500,
    })),
    sessionMeta: Array.from({ length: 100 }, (_, i) => ({
      key: `group:${i}`,
      sessionId: `session${i}abcdef`,
      sizeMb: 0.5,
      memberCount: 100 + i,
    })),
  });
  assert.ok(text.length <= 3400, `报告过长: ${text.length}`);
  assert.match(text, /已省略：「最近」、「会话」/);
  assert.match(text, /【运行】/);
});

test("压缩中：要说清是哪条会话、已经跑了多久", () => {
  const text = buildDiagnostic(
    base({
      compacting: [
        {
          key: "private:1",
          sessionId: "abcdef1234567890",
          startedAt: NOW - 90_000,
          memberCount: null,
        },
      ],
    }),
  );
  assert.match(text, /【压缩】/);
  assert.match(text, /私聊1 正在压缩会话 abcdef12（已 90秒|已 1分30秒）/);
  assert.match(text, /下一条会明显变慢/);
});

test("所有字段缺失也不该抛错（防御性：命令行路径可能传进半截快照）", () => {
  const text = buildDiagnostic({ now: NOW });
  assert.match(text, /诊断（/);
  assert.match(text, /【运行】/);
});

test("时间格式：fmtClock 补零", () => {
  assert.equal(fmtClock(Date.parse("2026-01-02T03:04:05+08:00")), "01-02 03:04:05");
  assert.equal(fmtClock(NaN), "?");
});
