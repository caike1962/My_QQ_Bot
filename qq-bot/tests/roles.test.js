import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setRolesPath, loadRoles, addUser, removeUser, isUser, isRobot, isRobotPaused, pausedRobots, addRobot, removeRobot, setRobotPaused } from "../src/roles.js";

let dir;

test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qqbot-roles-"));
  setRolesPath(join(dir, "roles.json"));
});

test.afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 已清理 */
  }
});

test("loadRoles: 文件不存在返回空名单", () => {
  assert.deepEqual(loadRoles(), { users: [], robots: [] });
  assert.equal(isUser(12345678), false);
  assert.equal(isRobot(12345678), false);
});

test("loadRoles: 损坏的 JSON 按空名单处理，不抛错", () => {
  writeFileSync(join(dir, "roles.json"), "{ 不是json ]", "utf8");
  assert.deepEqual(loadRoles(true), { users: [], robots: [] });
});

// 旧文件里没有 robots 字段——装在旧版名单上的部署升级后必须照常启动，
// 多出来的一类名单按空处理（宁可少放行，不可多放行）。
test("loadRoles: 缺 robots 字段的旧文件照常工作", () => {
  writeFileSync(join(dir, "roles.json"), JSON.stringify({ users: [12345678] }), "utf8");
  assert.deepEqual(loadRoles(true), { users: [12345678], robots: [] });
  assert.equal(isUser(12345678), true);
});

test("addUser: 添加后立即生效并可持久化", () => {
  assert.equal(addUser(12345678), true);
  assert.equal(isUser(12345678), true);
  const onDisk = JSON.parse(readFileSync(join(dir, "roles.json"), "utf8"));
  assert.deepEqual(onDisk.users, [12345678]);
});

test("addUser: 重复添加返回 false 且名单不膨胀", () => {
  addUser(12345678);
  assert.equal(addUser(12345678), false);
  assert.deepEqual(loadRoles(true).users, [12345678]);
});

test("addUser: 支持字符串 QQ 号", () => {
  assert.equal(addUser("12345678"), true);
  assert.equal(isUser("12345678"), true);
});

test("addUser: 非法 QQ 号抛错且不写入", () => {
  for (const bad of [0, -1, 1.5, "abc", null]) {
    assert.throws(() => addUser(bad), undefined, `qq=${bad} 应抛错`);
  }
  assert.deepEqual(loadRoles(true).users, []);
});

test("removeUser: 移除后名单更新并持久化", () => {
  addUser(12345678);
  addUser(87654321);
  assert.equal(removeUser(12345678), true);
  assert.equal(isUser(12345678), false);
  assert.equal(isUser(87654321), true);
  const onDisk = JSON.parse(readFileSync(join(dir, "roles.json"), "utf8"));
  assert.deepEqual(onDisk.users, [87654321]);
});

test("removeUser: 名单外返回 false", () => {
  assert.equal(removeUser(12345678), false);
});

test("removeUser: 文件回落后重读能继续工作", () => {
  addUser(111);
  assert.equal(removeUser(111), true);
  setRolesPath(join(dir, "roles.json"));
  assert.equal(isUser(111), false);
});

// ---------- robots ----------

test("addRobot: 添加后立即生效并可持久化", () => {
  assert.equal(addRobot(22334455), true);
  assert.equal(isRobot(22334455), true);
  assert.equal(isRobotPaused(22334455), false, "新加入的默认不暂停");
  const onDisk = JSON.parse(readFileSync(join(dir, "roles.json"), "utf8"));
  assert.deepEqual(onDisk.robots, [{ id: 22334455, paused: false }]);
});

test("addRobot: 重复添加返回 false，且不重置已有的暂停状态", () => {
  addRobot(22334455);
  setRobotPaused(22334455, true);
  assert.equal(addRobot(22334455), false);
  assert.equal(isRobotPaused(22334455), true, "重复 add 不该把它解放出来");
});

test("addRobot: 非法 QQ 号抛错且不写入", () => {
  for (const bad of [0, -1, 1.5, "abc", null]) {
    assert.throws(() => addRobot(bad), undefined, `qq=${bad} 应抛错`);
  }
  assert.deepEqual(loadRoles(true).robots, []);
});

test("removeRobot: 移除后名单更新并持久化", () => {
  addRobot(22334455);
  addRobot(99887766);
  assert.equal(removeRobot(22334455), true);
  assert.equal(isRobot(22334455), false);
  assert.equal(isRobot(99887766), true);
  const onDisk = JSON.parse(readFileSync(join(dir, "roles.json"), "utf8"));
  assert.deepEqual(onDisk.robots, [{ id: 99887766, paused: false }]);
});

test("removeRobot: 名单外返回 false", () => {
  assert.equal(removeRobot(22334455), false);
});

test("setRobotPaused: 状态真的变了才返回 true", () => {
  addRobot(22334455);
  assert.equal(setRobotPaused(22334455, true), true);
  assert.equal(setRobotPaused(22334455, true), false, "已经是暂停，不该报改变了");
  assert.equal(isRobotPaused(22334455), true);
  assert.equal(setRobotPaused(22334455, false), true);
  assert.equal(isRobotPaused(22334455), false);
});

test("setRobotPaused: 名单外的号码返回 false 且不写盘", () => {
  assert.equal(setRobotPaused(22334455, true), false);
  assert.deepEqual(loadRoles(true).robots, []);
});

test("pausedRobots: 只列暂停中的", () => {
  addRobot(111);
  addRobot(222);
  setRobotPaused(222, true);
  assert.deepEqual(pausedRobots(), [222]);
});

// 人类优先：同一个号码同时出现在两张名单里时，它是**人**不是机器人。
// 顺序一漏，人就会被静默掉——这是本功能里后果最重的一种错。
test("isRobot: 同时在 users 名单里时判为人（人类优先）", () => {
  addUser(55555);
  addRobot(55555);
  assert.equal(isRobot(55555), false);
  assert.equal(isRobotPaused(55555), false);
});

test("setRobotPaused: 对同时在 users 名单里的号无效（不会静默人类）", () => {
  addUser(55555);
  addRobot(55555);
  // 强行置暂停：isRobotPaused 仍为 false，人类的消息不会被吞
  setRobotPaused(55555, true);
  assert.equal(isRobotPaused(55555), false);
});

test("loadRoles: robots 里的裸号码与非法项被归一", () => {
  writeFileSync(
    join(dir, "roles.json"),
    JSON.stringify({ users: [], robots: [22334455, "99887766", { id: 11223344, paused: true }, 0, -3, "abc"] }),
    "utf8",
  );
  assert.deepEqual(loadRoles(true).robots, [
    { id: 22334455, paused: false },
    { id: 99887766, paused: false },
    { id: 11223344, paused: true },
  ]);
});

test("loadRoles: robots 里同一 id 重复时后者生效", () => {
  writeFileSync(
    join(dir, "roles.json"),
    JSON.stringify({ users: [], robots: [{ id: 22334455, paused: false }, { id: 22334455, paused: true }] }),
    "utf8",
  );
  assert.deepEqual(loadRoles(true).robots, [{ id: 22334455, paused: true }]);
});

test("addUser: 改 users 不会丢掉 robots 名单", () => {
  addRobot(22334455);
  setRobotPaused(22334455, true);
  addUser(12345678);
  assert.deepEqual(loadRoles(true).robots, [{ id: 22334455, paused: true }]);
  assert.equal(isUser(12345678), true);
});

test("removeUser: 改 users 不会丢掉 robots 名单", () => {
  addUser(12345678);
  addRobot(22334455);
  removeUser(12345678);
  assert.deepEqual(loadRoles(true).robots, [{ id: 22334455, paused: false }]);
});