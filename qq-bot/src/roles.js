import { readFileSync, writeFileSync } from "node:fs";

// roles.json 只存 User 名单；Admin 由 .env 的 QQ_ALLOWED_SENDERS 定义（保持现状语义不变）。
// 文件缺失/损坏时按空名单处理并照常启动——宁可少放行，不可多放行。
let rolesPath = process.env.QQBOT_ROLES || "D:\\QQBOT\\qq-bot\\roles.json";
let cache = null;

function normalize(list) {
  if (!Array.isArray(list)) return [];
  return [
    ...new Set(
      list.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0),
    ),
  ];
}

export function setRolesPath(path) {
  rolesPath = path;
  cache = null;
}

export function loadRoles(force = false) {
  if (cache && !force) return cache;
  let users = [];
  try {
    const parsed = JSON.parse(readFileSync(rolesPath, "utf8"));
    users = normalize(parsed?.users);
  } catch {
    // 文件不存在或损坏：按空名单处理
  }
  cache = { users };
  return cache;
}

export function isUser(qq) {
  const id = Number(qq);
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  return loadRoles().users.includes(id);
}

function assertValidId(qq) {
  const id = Number(qq);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`QQ 号无效: ${qq}`);
  }
  return id;
}

// 先写盘后更新缓存：写盘失败时内存状态不得前进，避免"假装成功"。
function commit(nextUsers) {
  try {
    writeFileSync(rolesPath, JSON.stringify({ users: nextUsers }, null, 2));
  } catch (error) {
    throw error;
  }
  cache = { users: nextUsers };
}

// true=已添加；false=本来就在名单里
export function addUser(qq) {
  const id = assertValidId(qq);
  const roles = loadRoles();
  if (roles.users.includes(id)) return false;
  commit([...roles.users, id]);
  return true;
}

// true=已移除；false=本来就不在名单里
export function removeUser(qq) {
  const id = assertValidId(qq);
  const roles = loadRoles();
  if (!roles.users.includes(id)) return false;
  commit(roles.users.filter((n) => n !== id));
  return true;
}