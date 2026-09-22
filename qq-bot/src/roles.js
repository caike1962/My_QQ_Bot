import { readFileSync, writeFileSync } from "node:fs";

// roles.json 存两类名单：
//   users  —— 人类用户，可私聊、可在群里 @ 机器人（权限与模型会话同 admin 之外的 user 角色）
//   robots —— 另一个机器人账号。行为与 user 类似，但多两条：它会收到专用的机器人提示词，
//             且当模型判断"这轮该收尾"时会把它置为 paused，之后不再回复它（防止两个机器人无限接龙）。
// Admin 由 .env 的 QQ_ALLOWED_SENDERS 定义（保持现状语义不变）。
//
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

// robots 是对象数组（要带 paused 状态），与 users 的纯号码数组不同，
// 所以单独归一。同一 id 出现多次时**后出现的赢**——手工编辑文件时往往是
// 在末尾补一条修正，按后者生效符合直觉。
function normalizeRobots(list) {
  if (!Array.isArray(list)) return [];
  const byId = new Map();
  for (const raw of list) {
    const isObj = typeof raw === "object" && raw !== null;
    const id = Number(isObj ? raw.id : raw);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    byId.set(id, { id, paused: isObj && raw.paused === true });
  }
  return [...byId.values()];
}

export function setRolesPath(path) {
  rolesPath = path;
  cache = null;
}

export function loadRoles(force = false) {
  if (cache && !force) return cache;
  let users = [];
  let robots = [];
  try {
    const parsed = JSON.parse(readFileSync(rolesPath, "utf8"));
    users = normalize(parsed?.users);
    robots = normalizeRobots(parsed?.robots);
  } catch {
    // 文件不存在或损坏：按空名单处理
  }
  cache = { users, robots };
  return cache;
}

export function isUser(qq) {
  const id = Number(qq);
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  return loadRoles().users.includes(id);
}

// 人类优先：同一个号码同时出现在 users 和 robots 里时，它是人不是机器人。
// 这个判据只在**同时**出现时才有意义，但写在这里一次，就不必在每个调用点
// 重复"先查 users 再查 robots"的顺序约束——顺序一漏，人就会被静默掉。
export function isRobot(qq) {
  const id = Number(qq);
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  const roles = loadRoles();
  if (roles.users.includes(id)) return false;
  return roles.robots.some((r) => r.id === id);
}

// 在名单里**且**被暂停。不在名单里一律 false（不认识的号不走这条路径）。
export function isRobotPaused(qq) {
  const id = Number(qq);
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  const roles = loadRoles();
  if (roles.users.includes(id)) return false;
  return roles.robots.some((r) => r.id === id && r.paused);
}

// 处于暂停状态的机器人号码。诊断日志和 /解除 要用。
export function pausedRobots() {
  return loadRoles().robots.filter((r) => r.paused).map((r) => r.id);
}

function assertValidId(qq) {
  const id = Number(qq);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`QQ 号无效: ${qq}`);
  }
  return id;
}

// 先写盘后更新缓存：写盘失败时内存状态不得前进，避免"假装成功"。
function commit(nextUsers, nextRobots) {
  writeFileSync(
    rolesPath,
    JSON.stringify({ users: nextUsers, robots: nextRobots }, null, 2),
  );
  cache = { users: nextUsers, robots: nextRobots };
}

// true=已添加；false=本来就在名单里
export function addUser(qq) {
  const id = assertValidId(qq);
  const roles = loadRoles();
  if (roles.users.includes(id)) return false;
  commit([...roles.users, id], roles.robots);
  return true;
}

// true=已移除；false=本来就不在名单里
export function removeUser(qq) {
  const id = assertValidId(qq);
  const roles = loadRoles();
  if (!roles.users.includes(id)) return false;
  commit(roles.users.filter((n) => n !== id), roles.robots);
  return true;
}

// true=已添加；false=本来就在名单里（已有条目原样保留，不重置它的暂停状态）
export function addRobot(qq) {
  const id = assertValidId(qq);
  const roles = loadRoles();
  if (roles.robots.some((r) => r.id === id)) return false;
  commit(roles.users, [...roles.robots, { id, paused: false }]);
  return true;
}

// true=已移除；false=本来就不在名单里
export function removeRobot(qq) {
  const id = assertValidId(qq);
  const roles = loadRoles();
  if (!roles.robots.some((r) => r.id === id)) return false;
  commit(roles.users, roles.robots.filter((r) => r.id !== id));
  return true;
}

// 手动开关暂停，不依赖模型判断。true=状态真的变了。
export function setRobotPaused(qq, paused) {
  const id = assertValidId(qq);
  const roles = loadRoles();
  const target = roles.robots.find((r) => r.id === id);
  if (!target || target.paused === Boolean(paused)) return false;
  commit(
    roles.users,
    roles.robots.map((r) => (r.id === id ? { ...r, paused: Boolean(paused) } : r)),
  );
  return true;
}
