// 合并打断的判据。
//
// 用户连发两条时，把第一条正在跑的进程杀掉，两条消息合成一条重新执行——
// 模拟"对前一条按 ESC，然后继续对话"。注意语义是**合并**而非放弃：
// 第一条的内容原样保留在合并后的 prompt 里。
//
// 为什么不是真发一个 ESC 信号：交互式会话里 CLI 长驻，按键能被读到；
// 而这里每条消息都是 spawn 一个无头 claude.exe，跑完就退出，
// **没有一个活着的进程可以收信号**。所以唯一可行的机制是杀掉重跑。
//
// 关键在于"杀掉是安全的"这个判断。这台机器上机器人真的会执行破坏性操作
// （卸软件、踢人），所以绝不能无条件打断。判据取"会话文件相对起点有没有变化"：
//
//   实测（2026-09-21）无头 spawn 的写入时间线：
//     0.57s  记账记录写完（queue-operation / user / attachment），文件随后冻结
//     1.8s+  assistant 记录才出现（短闲聊全程 2.32s）
//   也就是说**模型在生成文本期间不写文件**，文件只在工具调用前后才增长。
//
//   零变化 → 一个工具都没调过 → 杀掉重跑零副作用（只浪费 token）
//   有变化 → 已经动了工具   → 放弃打断，第二条照常排队
//
// 按构造，被打断时不存在半截的工具调用，所以合并后 --resume 是干净的
// （实测：被杀会话 resume 返回 is_error=false，模型仍记得被打断的内容）。
//
// 一个诚实的局限：判据保证不丢工作，代价是**已经在调工具的任务几乎永远
// 打断不了**。要覆盖那种，得允许截断做了一半的副作用——不值得。

export function canMerge({ messageType, role, enabled = true }) {
  if (!enabled) return false;
  // 群聊是共享会话：别人正常发言会因为你的第二条消息被杀掉重跑，
  // 且两人同时打字必然互相打断。只在私聊生效。
  if (messageType !== "private") return false;
  return role === "admin";
}

// 会话文件相对 sentinel 有无变化。
//
// sentinel 是这条消息开始执行时的行数。null 表示还没建立锚点
// （claude 启动后约 0.6s 内文件还没写），此时退化为"文件有没有超过
// spawn 时的行数"——同样安全：那一刻模型必然还没调工具。
export function sessionUntouched({ baselineLines, currentLines }) {
  if (baselineLines === null || baselineLines === undefined) return true;
  if (!Number.isFinite(currentLines)) return false; // 读不到文件 → 宁可保守
  return currentLines <= baselineLines;
}

// 合并后的 prompt。必须说明两条是一起的：
// 被杀的会话里已经写入了第一条（作为一条没有 assistant 回复的 user 记录），
// 若不解释，模型会看到自己刚被打断、又收到一段没有上下文的补充。
export function mergePrompt(first, second) {
  return `[补充：下面两条消息一起处理，后一条是我对前一条的补充]\n${first}\n${second}`;
}

// 总判据。参数全部注入（不读全局配置），便于单测覆盖每个分支。
export function shouldInterrupt({
  enabled = true,
  messageType,
  role,
  windowMs,
  startedAt,
  now,
  baselineLines,
  currentLines,
  mergedLength,
  maxPromptChars,
}) {
  if (!canMerge({ messageType, role, enabled })) return false;
  if (!Number.isFinite(startedAt) || now - startedAt > windowMs) return false;
  if (!sessionUntouched({ baselineLines, currentLines })) return false;
  if (mergedLength > maxPromptChars) return false;
  return true;
}
