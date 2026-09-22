import { readFileSync, writeFileSync, renameSync, statSync, unlinkSync } from "node:fs";

// roles.json 存两类名单：
//   users  —— 人类用户，可私聊、可在群里 @ 机器人（权限与模型会话同 admin 之外的 user 角色）
//   robots —— 另一个机器人账号。行为与 user 类似，但多两条：它会收到专用的机器人提示词，
//             且当模型判断"这轮该收尾"时会把它置为 paused，之后不再回复它（防止两个机器人无限接龙）。
// Admin 由 .env 的 QQ_ALLOWED_SENDERS 定义（保持现状语义不变）。
//
// ——热重载——
//
// loadRoles 按 mtime 校验：文件被外部改过（手改文件、另一个进程写）就重读，
// 不必再重启进程。重启的代价在这个项目里很高（pm2 走 taskkill /F，正在跑的
// claude 会话被直接砍掉、没有收尾机会）。
//
// 两条必须守住的规矩：
//
//   1. **重读失败绝不改成空名单**。"文件缺失/损坏 → 当没有名单"只在**进程启动
//      时**成立（宁可少放行，不可多放行）；运行中重读失败若也这么办，一次误写
//      就会让所有人立刻失去权限，比继续用旧名单危险得多。所以只有曾经成功读到
//      过文件时才判空，运行中读不到就保留上一份。
//   2. **写必须是 load-modify-write**。mutator 每次都先重读文件，只改自己那一项，
//      再整体写回。否则周期重读会让"读缓存 → 判断 → 写回"之间的外部编辑被整个
//      覆盖掉——这类丢失要等几分钟后才有人发现。
//
// 与 jobs.json 的对比：调度器每 20s 无条件重读，因为它的写入方只有一个（自己）。
// 这里还要考虑外部手改，所以走 mtime 判断 + 写前重读：发现得更快（下一次查询
// 就可见，而不是等一个轮询周期）。
let rolesPath = process.env.QQBOT_ROLES || "D:\\QQBOT\\qq-bot\\roles.json";

// 缓存的是一份**可能被外部改过**的文件，所以判断"要不要重读"必须靠 mtime，
// 不能靠"缓存里有没有东西"。
//
// 外部改动要**立即**可见（admin 手改完文件发一条消息，就该生效），所以这里
// 没有读节流：每次查询都 stat 一次，mtime 没变才吃缓存。stat 比这个模块里
// 任何一次 JSON.parse 都便宜，而这个文件只有几行——对比 queue.js 每次操作
// 都整读整写，这点开销可以忽略。
let cache = null;
// 读到过的 mtime。MISSING 是"文件不存在"的标记：它和任何真实 mtime 都不相等，
// 所以文件一旦被创建就会被下一次 stat 发现。用 null 表示"还没读过"，
// 两者必须分开，否则"文件不存在"会变成每轮都重读。
let cacheMtime = null;

const MISSING = Symbol("roles.json 不存在");

// 读失败时最多每分钟报一次，否则每条消息都会刷一行。
let lastWarnAt = 0;

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

// 文件的当前 mtime；不存在返回 MISSING。抛出的其它错误（被占用、无权限）
// 交给调用方按"读失败"处理。
function currentMtime() {
  try {
    return statSync(rolesPath).mtimeMs;
  } catch (error) {
    if (error?.code === "ENOENT") return MISSING;
    throw error;
  }
}

// 读一次文件。返回：
//   { data, mtime }            —— 读到了（可能是空名单）
//   { missing: true }          —— 文件不存在
//   { error }                  —— 存在但读不出来（损坏 / 被占用）
function readOnce() {
  let text;
  let stat;
  try {
    stat = statSync(rolesPath);
    text = readFileSync(rolesPath, "utf8");
  } catch (error) {
    // ENOENT 是"文件不存在"，其余（EACCES、EPERM、EBUSY）是"存在但读不了"。
    // 两者对缓存的影响完全不同，不能混为一谈。
    return error?.code === "ENOENT" ? { missing: true } : { error };
  }

  try {
    const parsed = JSON.parse(text);
    return {
      data: {
        users: normalize(parsed?.users),
        robots: normalizeRobots(parsed?.robots),
      },
      mtime: stat.mtimeMs,
    };
  } catch (error) {
    // 文件在但内容坏了。mtime 照样返回，否则每一轮都会重读、重报一次。
    return { error, mtime: stat.mtimeMs };
  }
}

export function setRolesPath(path) {
  rolesPath = path;
  cache = null;
  cacheMtime = null;
}

export function loadRoles(force = false) {
  let mtime;
  try {
    mtime = currentMtime();
  } catch (error) {
    return keepOrEmpty(error);
  }

  // 文件仍然不存在：不必再 stat 一次，空名单照旧。这条早退是为了让"从来没建过
  // 名单"的部署（以及测试里路径指向不存在文件的场景）不重复付出系统调用。
  // 文件一旦被创建，mtime 就不再等于 MISSING，会走到下面的完整读取。
  if (!force && cache && mtime === MISSING && cacheMtime === MISSING) return cache;

  if (!force && cache && mtime === cacheMtime) return cache;

  const read = readOnce();
  if (read.error) return keepOrEmpty(read.error);

  if (read.missing) {
    // 文件不存在是**明确状态**（不是"读不出来"），按空名单处理。
    cache = { users: [], robots: [] };
    cacheMtime = MISSING;
    return cache;
  }

  cache = read.data;
  cacheMtime = read.mtime;
  return cache;
}

// 读不到时的共同出口：有旧缓存就用旧的，没有才判空名单。
//
// 运行中读到坏文件却把名单清空，是这个功能最危险的失败模式——它会让所有
// 非 admin 立刻失去权限，而且没人会想到是"文件被人打开保存了一半"。
// 宁可多给人一次说话的机会，也不要让一次误写变成静默的权限事故。
//
// 两种情况都要报一声，措辞必须分清，否则用户看到的是一句自相矛盾的话：
//   有旧缓存 —— 名单还在用，只是没跟上文件。
//   无旧缓存 —— 真的按空名单跑（文件坏了或权限不对），不报就等于静默失效。
//
// 注意"文件从来就不存在"与"文件坏了"是两回事：前者走 loadRoles 里的 missing
// 分支，是正常状态（还没建名单），不报错。
function keepOrEmpty(error) {
  const now = Date.now();
  const detail = error?.message || error;
  if (cache) {
    if (now - lastWarnAt > 60_000) {
      lastWarnAt = now;
      console.error(`[qq-bot] roles.json 读不出内容，继续沿用上一次的名单: ${detail}`);
    }
    return cache;
  }
  if (now - lastWarnAt > 60_000) {
    lastWarnAt = now;
    console.error(`[qq-bot] roles.json 读不出内容，暂按空名单处理: ${detail}`);
  }
  cache = { users: [], robots: [] };
  cacheMtime = MISSING;
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

// 先写临时文件再改名：直接覆盖时若进程被杀，会留下半截 JSON，
// 而下一次重读就把它当成损坏文件——热重载意味着这个窗口会被反复经过。
//
// 临时文件那一路失败时退回直接写：rename 在 Windows 上可能因为杀软/索引器
// 短暂占用而失败（实测过），但"能写进去"总比"完全写不进去"好。两条都失败
// 才抛出去——写不进去却更新缓存是最坏的结果，用户以为加成功了。
//
// 写成功后取一次已落定文件的 mtime 记账，好让下一次 loadRoles 直接吃缓存。
function writeAll(next) {
  const text = JSON.stringify(next, null, 2);
  const tmp = `${rolesPath}.tmp`;

  let wrote = false;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, rolesPath);
    wrote = true;
  } finally {
    if (!wrote) {
      cleanupTmp(tmp);
      writeFileSync(rolesPath, text);
    }
  }

  cache = next;
  cacheMtime = currentMtimeSafe();
}

// 取当前 mtime；取不到就返回 0。返回 0 的后果只是"下一次调用会重读一次文件"
// （0 不等于任何真实 mtime），比让缓存永久失效或误判成没变过都好。
function currentMtimeSafe() {
  try {
    return statSync(rolesPath).mtimeMs;
  } catch {
    return 0;
  }
}

function cleanupTmp(tmp) {
  try {
    unlinkSync(tmp);
  } catch {
    /* 残留的 .tmp 不影响功能，下次写会覆盖它 */
  }
}

// 拿一份"当前最新"的名单给 mutator 用。**不**接受缓存里的快照就直接改：
// 那正是外部改动被覆盖的来源。loadRoles() 内部按 mtime 校验，变了就重读。
function currentRoles() {
  return loadRoles();
}

// true=已添加；false=本来就在名单里
export function addUser(qq) {
  const id = assertValidId(qq);
  const roles = currentRoles();
  if (roles.users.includes(id)) return false;
  writeAll({ users: [...roles.users, id], robots: roles.robots });
  return true;
}

// true=已移除；false=本来就不在名单里
export function removeUser(qq) {
  const id = assertValidId(qq);
  const roles = currentRoles();
  if (!roles.users.includes(id)) return false;
  writeAll({ users: roles.users.filter((n) => n !== id), robots: roles.robots });
  return true;
}

// true=已添加；false=本来就在名单里（已有条目原样保留，不重置它的暂停状态）
export function addRobot(qq) {
  const id = assertValidId(qq);
  const roles = currentRoles();
  if (roles.robots.some((r) => r.id === id)) return false;
  writeAll({ users: roles.users, robots: [...roles.robots, { id, paused: false }] });
  return true;
}

// true=已移除；false=本来就不在名单里
export function removeRobot(qq) {
  const id = assertValidId(qq);
  const roles = currentRoles();
  if (!roles.robots.some((r) => r.id === id)) return false;
  writeAll({ users: roles.users, robots: roles.robots.filter((r) => r.id !== id) });
  return true;
}

// 手动开关暂停，不依赖模型判断。true=状态真的变了。
export function setRobotPaused(qq, paused) {
  const id = assertValidId(qq);
  const roles = currentRoles();
  const target = roles.robots.find((r) => r.id === id);
  if (!target || target.paused === Boolean(paused)) return false;
  writeAll({
    users: roles.users,
    robots: roles.robots.map((r) => (r.id === id ? { ...r, paused: Boolean(paused) } : r)),
  });
  return true;
}
