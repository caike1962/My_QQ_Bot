import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setRolesPath, loadRoles, addUser, removeUser, isUser, isRobot, isRobotPaused, pausedRobots, addRobot, removeRobot, setRobotPaused } from "../src/roles.js";

let dir;

// 写文件并把 mtime 明确推后：热重载靠 mtime 判定"文件变了"，而测试跑得比
// 文件系统的时间戳粒度（秒级）快得多，同一个毫秒里改两次会被误判成"没变"。
// 生产里没这个问题——人改文件和进程读文件之间至少隔一次心跳。
let stamp = Date.now();
function writeRoles(data) {
  const file = join(dir, "roles.json");
  writeFileSync(file, JSON.stringify(data), "utf8");
  stamp += 2000;
  utimesSync(file, new Date(stamp), new Date(stamp));
}

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
//
// 这个状态现在**造不出来了**：addUser/addRobot 会自动迁移，一个号只占一张名单
// （见 roles.js 的「一对一角色」注释）。所以要模拟的是**存量脏数据**——老版本
// 留下的、或有人手改文件造成的双身份。读路径的守卫必须兜住它，否则升级后
// 这些号会被静默。
test("isRobot: 手改文件造成的双身份判为人（人类优先）", () => {
  writeRoles({ users: [55555], robots: [{ id: 55555, paused: false }] });
  assert.equal(isRobot(55555), false);
  assert.equal(isRobotPaused(55555), false);
});

test("setRobotPaused: 对同时在 users 名单里的号无效（不会静默人类）", () => {
  writeRoles({ users: [55555], robots: [{ id: 55555, paused: false }] });
  // 强行置暂停：isRobotPaused 仍为 false，人类的消息不会被吞
  setRobotPaused(55555, true);
  assert.equal(isRobotPaused(55555), false);
});

// 一个号只占一张名单：加进一张就自动从另一张摘掉。
// 这条不变式是"读路径守卫"之外的**第二道**防线，缺了它双身份会不断产生，
// 而守卫只能兜住存量、兜不住新增。
test("addRobot: 把已在 users 里的号加为机器人时自动移出 users", () => {
  addUser(55555);
  assert.equal(addRobot(55555), true);
  assert.equal(isUser(55555), false, "不该同时占两张名单");
  assert.equal(isRobot(55555), true);
  const onDisk = JSON.parse(readFileSync(join(dir, "roles.json"), "utf8"));
  assert.deepEqual(onDisk.users, [], "落盘也必须只有一张名单");
  assert.deepEqual(onDisk.robots, [{ id: 55555, paused: false }]);
});

test("addUser: 把已在 robots 里的号加为用户时自动移出 robots", () => {
  addRobot(55555);
  setRobotPaused(55555, true);
  assert.equal(addUser(55555), true);
  assert.equal(isRobot(55555), false);
  assert.equal(isUser(55555), true);
  const onDisk = JSON.parse(readFileSync(join(dir, "roles.json"), "utf8"));
  assert.deepEqual(onDisk.users, [55555]);
  assert.deepEqual(onDisk.robots, [], "迁移时暂停状态一并作废");
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

// ---------- 热重载 ----------
//
// 这一组测的是"进程运行期间有人改了文件"——不必重启、不必 setRolesPath。

test("热重载: 外部加人后立刻生效", () => {
  loadRoles(); // 先建立缓存（文件此时还不存在）
  assert.equal(isUser(12345678), false);

  writeRoles({ users: [12345678], robots: [] });

  // 没有重启、没有 setRolesPath，下一次查询就该看到新人
  assert.equal(isUser(12345678), true, "外部改动应立即生效");
});

test("热重载: 外部加机器人并置暂停后立刻生效", () => {
  loadRoles();
  writeRoles({ users: [], robots: [{ id: 22334455, paused: true }] });
  assert.equal(isRobot(22334455), true);
  assert.equal(isRobotPaused(22334455), true);
  assert.deepEqual(pausedRobots(), [22334455]);
});

test("热重载: 文件不存在时缓存成立，文件随后出现能被发现", () => {
  assert.deepEqual(loadRoles(), { users: [], robots: [] });
  writeRoles({ users: [111], robots: [{ id: 222, paused: true }] });
  assert.equal(isUser(111), true);
  assert.equal(isRobotPaused(222), true);
});

test("热重载: 文件被删除后退回空名单", () => {
  writeRoles({ users: [12345678], robots: [] });
  assert.equal(isUser(12345678), true);
  rmSync(join(dir, "roles.json"));
  assert.equal(isUser(12345678), false, "文件没了就该回到空名单");
});

// 最危险的失败模式：用户手改坏了文件，运行中的进程把名单清空，
// 于是所有非 admin 立刻失去权限——而没人会想到是"文件保存了一半"。
test("热重载: 文件损坏时保留旧名单，不清空", () => {
  writeRoles({ users: [12345678], robots: [{ id: 22334455, paused: true }] });
  assert.equal(isUser(12345678), true);

  writeFileSync(join(dir, "roles.json"), "{ 半截 json", "utf8");

  assert.equal(isUser(12345678), true, "读坏了不该把已有的人踢出去");
  assert.equal(isRobotPaused(22334455), true);
});

test("热重载: 文件修好后能恢复到新内容", () => {
  writeRoles({ users: [111], robots: [] });
  assert.equal(isUser(111), true);

  writeFileSync(join(dir, "roles.json"), "{ 坏", "utf8");
  assert.equal(isUser(111), true, "坏文件期间沿用旧名单");

  writeRoles({ users: [222], robots: [] });
  assert.equal(isUser(111), false);
  assert.equal(isUser(222), true, "修好后应读到新内容");
});

// 这是"写必须是 load-modify-write"的核心用例：进程内加人时，
// 文件上已经有过一次外部改动，那次改动不能被覆盖掉。
test("热重载: 进程内加人不会覆盖外部刚写进去的人", async () => {
  writeRoles({ users: [111], robots: [] });
  assert.equal(isUser(111), true);

  // 外部再加一个（模拟用户手改，或另一个进程写）
  writeRoles({ users: [111, 222], robots: [] });

  // 进程内加第三个。它必须先读到 111 和 222，再写回三个。
  assert.equal(addUser(333), true);

  const onDisk = JSON.parse(readFileSync(join(dir, "roles.json"), "utf8"));
  assert.deepEqual(onDisk.users, [111, 222, 333], "外部写进去的 222 不能被覆盖");
});

test("热重载: 进程内加机器人不会覆盖外部改动", () => {
  writeRoles({ users: [], robots: [] });
  loadRoles();

  writeRoles({ users: [111], robots: [{ id: 222, paused: true }] });

  assert.equal(addRobot(333), true);

  const onDisk = JSON.parse(readFileSync(join(dir, "roles.json"), "utf8"));
  assert.deepEqual(onDisk.users, [111], "外部加的人不能被覆盖");
  assert.deepEqual(onDisk.robots, [
    { id: 222, paused: true },
    { id: 333, paused: false },
  ]);
});

test("热重载: 外部把某人移出名单后，进程内改别的东西不会把他加回来", () => {
  writeRoles({ users: [111, 222], robots: [] });
  assert.equal(isUser(222), true);

  // 外部把 222 移出
  writeRoles({ users: [111], robots: [] });

  // 进程内加第三个
  assert.equal(addUser(333), true);

  const onDisk = JSON.parse(readFileSync(join(dir, "roles.json"), "utf8"));
  assert.deepEqual(onDisk.users, [111, 333], "被外部移出的 222 不该复活");
});

test("热重载: 外部改暂停状态后，进程内加机器人不会把它重置", () => {
  writeRoles({ users: [], robots: [{ id: 222, paused: false }] });
  loadRoles();

  // 外部把它暂停
  writeRoles({ users: [], robots: [{ id: 222, paused: true }] });

  addRobot(333);

  const onDisk = JSON.parse(readFileSync(join(dir, "roles.json"), "utf8"));
  assert.deepEqual(onDisk.robots, [
    { id: 222, paused: true },
    { id: 333, paused: false },
  ]);
});

test("热重载: 写入用临时文件再改名，不留半截 JSON", () => {
  addUser(111);
  const text = readFileSync(join(dir, "roles.json"), "utf8");
  assert.doesNotThrow(() => JSON.parse(text), "写完的文件必须是完整 JSON");
  assert.deepEqual(JSON.parse(text).users, [111]);
});

test("热重载: 多次写读交替后内容一致", () => {
  for (let i = 0; i < 5; i++) {
    addUser(1000 + i);
    // 每次写完立刻读，确认 mtime 记账没把"自己刚写的"误判成外部改动
    assert.equal(isUser(1000 + i), true, `第 ${i} 次写入后应能读到`);
  }
  assert.deepEqual(loadRoles().users, [1000, 1001, 1002, 1003, 1004]);
});