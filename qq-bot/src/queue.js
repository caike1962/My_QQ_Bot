import { readFileSync, writeFileSync, renameSync, statSync, existsSync, unlinkSync } from "node:fs";

// 消息队列磁盘副本。目的：进程被 pm2 强杀（taskkill /F，不发信号）时，
// 「已入队但还没开始处理」的消息不再凭空消失。
//
// 条目自带 status，这是重放安全性的全部依据：
//   "queued"  → 进程在把它改成 running 之前就死了，确定**没执行过**，重放安全
//   "running" → 可能已经跑了一部分，**不自动重放**（这台机器上真的会卸载软件、踢人），
//               改为告知用户可回「继续」手动重放
//   "notified"→ 已经告知过用户，用户还没回「继续」。停在终态不再动它——
//               用户可能正在犹豫，或压根不打算重放，替他做决定等于擅自执行
//
// 体积超过 MAX_MB 直接整体丢弃：正常队列是个位数条目，触发上限说明严重积压
// 或异常，此时宁可丢队列也不要让启动流程卡住。
const MAX_MB = 1;

let queuePath = process.env.QQBOT_QUEUE || "D:\\QQBOT\\qq-bot\\queue.json";
let warn = (msg) => console.error("[qq-bot]", msg);

export function setQueuePath(path) {
  queuePath = path;
}

export function setQueueLogger(fn) {
  warn = fn;
}

function readAll() {
  if (!existsSync(queuePath)) return [];
  try {
    if (statSync(queuePath).size / 1048576 > MAX_MB) {
      warn(`队列文件超过 ${MAX_MB} MB，整体丢弃（消息会丢失，请检查是否严重积压）`);
      return [];
    }
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(queuePath, "utf8"));
  } catch (error) {
    // 解析失败绝不能静默当作空队列——那等于悄悄丢消息
    warn(`队列文件损坏，已丢弃: ${error.message}`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    warn("队列文件格式异常（非数组），已丢弃");
    return [];
  }
  return parsed.filter((e) => e && typeof e === "object" && e.event);
}

// 先写临时文件再 rename，保证读到的永远是完整文件
function writeAll(entries) {
  const tmp = queuePath + ".tmp";
  try {
    writeFileSync(tmp, JSON.stringify(entries));
    renameSync(tmp, queuePath);
  } catch (error) {
    warn(`队列写入失败（消息可能在重启时丢失）: ${error.message}`);
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* 清理失败不影响主流程 */
    }
  }
}

// 条目带唯一 id：一个会话可能同时积压多条（用户连发），
// 而同一时刻只有队首那条在真正执行。若按 key 标记，会把整批都标成 running，
// 导致**从未执行过**的后续消息在恢复时被误判为「状态未知」，不敢自动重放。
let seq = 0;
const nextId = () => `${Date.now()}-${seq++}`;

export function markQueued(key, event) {
  const entries = readAll();
  const id = nextId();
  entries.push({ id, key, event, status: "queued", at: Date.now() });
  writeAll(entries);
  return id;
}

export function markRunning(id) {
  const entries = readAll();
  const entry = entries.find((e) => e.id === id);
  if (!entry || entry.status === "running") return;
  entry.status = "running";
  entry.at = Date.now();
  writeAll(entries);
}

// 记下"本条开始执行时会话文件的行数"。
//
// 重启恢复靠它判断一条 running 条目到底是**压根没跑**还是**跑过一部分**：
// 文件没长过 = 模型连一次工具都没调 = 重放零副作用，可以自动恢复；
// 长过 = 已经动过工具，可能踢了人、卸了软件，绝不能猜。
//
// 必须在本进程、claude 还没启动时调用——spawn 后 CLI 会立刻写约 4 行
// 记账记录，那时取就分不清"记账"和"模型真的动了工具"。调用点放在
// markRunning 之后、invoke 之前，中间没有 await。
//
// baseline 为 null 表示"取不到"（文件不存在等），恢复时按不安全处理。
export function markBaseline(id, lines) {
  const entries = readAll();
  const entry = entries.find((e) => e.id === id);
  if (!entry || entry.status !== "running") return;
  if (entry.baseline !== undefined) return; // 幂等，不覆盖已记下的锚点
  entry.baseline = Number.isFinite(lines) ? lines : null;
  writeAll(entries);
}

export function removePending(id) {
  const entries = readAll();
  const left = entries.filter((e) => e.id !== id);
  if (left.length !== entries.length) writeAll(left);
}

// 把 running 标成「已告知」。必须在**发送通知之前**调用：
// 发完再标的话，若在两者之间被强杀，下次启动还会再通知一遍。
//
// 标记本身不丢信息——条目仍在磁盘上，只是换了个终态名，
// 用户回「继续」时照样能取到它的事件。
export function markNotified(id) {
  const entries = readAll();
  const entry = entries.find((e) => e.id === id);
  if (!entry || entry.status !== "running") return;
  entry.status = "notified";
  entry.at = Date.now();
  writeAll(entries);
}

// 被合并打断的那条：内容已经并入合并后的 prompt，不需要重放，
// 但**也不能直接删**——它必须成为 notified 终态（而不是从磁盘消失），
// 否则重启恢复时它既不在 queued 里、也不在 interrupted 里，
// 就成了无人知晓的幽灵条目。
//
// 之所以叫 "merging" 而不是复用 "notified"：两者含义不同。
// notified 是「已告知用户，等 ta 回继续」，merging 是「已并入新的一条，无需动作」。
// 混用会让启动恢复把合并掉的条目当成待重放，凭空多执行一遍。
export function markMerging(id) {
  const entries = readAll();
  const entry = entries.find((e) => e.id === id);
  // queued 也要认：合并可能打断的是一条**还没轮到执行**的排队消息
  // （用户在窗口内连发三条时，第二条尚未成为队首就被并进了合并）。
  if (!entry || (entry.status !== "running" && entry.status !== "queued")) return;
  entry.status = "merging";
  entry.at = Date.now();
  writeAll(entries);
}

// 合并被打断、但内容没能并入新条目时，退回 notified 终态：
// 重启后按「已告知、等用户决定」处理，让用户回「继续」重放。
// 若停在 merging，恢复逻辑既不重放也不通知——那条消息就真的静默丢了。
export function markMergingAborted(id) {
  const entries = readAll();
  const entry = entries.find((e) => e.id === id);
  if (!entry || entry.status !== "merging") return;
  entry.status = "notified";
  entry.at = Date.now();
  writeAll(entries);
}

// 供启动恢复：把条目按到达顺序返回，交由调用方决定 queued 重放 / running 交由用户决定
export function loadEntries() {
  return readAll();
}
