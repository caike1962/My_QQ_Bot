import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setRolesPath, loadRoles, addUser, removeUser, isUser } from "../src/roles.js";

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
  assert.deepEqual(loadRoles(), { users: [] });
  assert.equal(isUser(12345678), false);
});

test("loadRoles: 损坏的 JSON 按空名单处理，不抛错", () => {
  writeFileSync(join(dir, "roles.json"), "{ 不是json ]", "utf8");
  assert.deepEqual(loadRoles(true), { users: [] });
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