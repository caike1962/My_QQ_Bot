import { readFileSync, writeFileSync, statSync, existsSync } from "node:fs";

// 1x1 透明 PNG。图片被替换成它，而不是删除。
//
// 为什么不直接删：Claude Code 读会话时会无条件访问 `source.data.length`，
// 字段缺失会直接抛 `undefined is not an object`，整个会话不可用。已实测。
// 替换成合法的最小图片则能正常 resume，只是模型看不到原图内容。
const PLACEHOLDER_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export function sessionPath(projectDir, sessionId) {
  return `C:\\Users\\Administrator\\.claude\\projects\\${projectDir}\\${sessionId}.jsonl`;
}

// 截断字符串用于日志，但不切碎 emoji。
//
// 直接用 slice(0, n) 可能落在代理对中间，落盘后那个字符变成 U+FFFD（）。
// 不抛错，所以不会崩——但日志里出现乱码会干扰排查，而且用户发的内容
// 被静默损坏本身就不该发生。多截一个字符比留下半截代理对好。
export function truncate(text, max) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  let end = max;
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1; // 末位是孤立高位代理，回退一格
  return s.slice(0, end) + "…";
}

// 看某条会话最新使用的模型。
//
// 模型要跟着会话走而不是跟着当前配置走：会话历史里存着旧模型产生的
// 思考签名等内容，换模型 resume 可能直接报错，或者让模型风格在中途突变。
// 所以只在会话是全新的（没有历史）时才用配置里的模型。
//
// 从后往前扫、命中即返回：只需要最后一条有 model 字段的记录。
// 返回 null 表示读不到（文件不存在/无 model 字段），调用方自行决定回退。
export function sessionModel(filePath) {
  if (!existsSync(filePath)) return null;
  let lines;
  try {
    lines = readFileSync(filePath, "utf8").trim().split("\n");
  } catch {
    return null;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const rec = JSON.parse(lines[i]);
      if (typeof rec?.message?.model === "string" && rec.message.model) {
        return rec.message.model;
      }
    } catch {
      /* 解析不了的整行跳过 */
    }
  }
  return null;
}

// 判断某条会话最后一次运行是不是正常收尾了。
//
// 用途：进程被强杀后，队列里会留下 status=running 的条目，但**它其实可能
// 已经跑完了**——结果都发出去了，只是没来得及从队列摘除（实测「重启 qq-bot」
// 那条就是如此：会话末尾早就是 assistant 的正式回复 + cost-state）。
// 无脑通知等于每次重启都误报一次，用户很快就会无视这句话，真正的丢消息
// 反而被淹没。
//
// 判据是助手最后有没有产出一段**正式回复文本**（不隔着工具调用）：
//   - 有  → 这轮跑完了，不用打扰用户
//   - 无  → 收尾卡在工具调用之后，这轮确实没走完
//
// 只看最后一个 assistant 记录：thinking 是过程内容，走完不表示说完了话，
// 所以不能算数——只认含 text 块的那种。
//
//   true  = 已完成     false = 未完成     null = 读不到（文件不存在等，交调用方决定）
export function sessionCompleted(filePath) {
  if (!existsSync(filePath)) return null;
  let lines;
  try {
    lines = readFileSync(filePath, "utf8").trim().split("\n");
  } catch {
    return null;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    let rec;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      continue; // 解析不了的整行跳过
    }
    if (rec?.type !== "assistant") continue;
    const content = rec.message?.content;
    if (!Array.isArray(content)) return false;
    // 只要最后一个 assistant 记录里有 text 块，就说明它把话说完了
    return content.some((c) => c?.type === "text" && String(c.text || "").trim());
  }
  return false; // 一条 assistant 记录都没有 → 肯定没跑完
}

// 自上次读取以来，这次运行都调用了哪些工具。
//
// 用途：事后查账。进程被强杀后，光知道"这轮没跑完"不够用——用户想知道的
// 是"断在哪一步"。会话文件里有完整的 tool_use / tool_result 记录，
// 按 tool_use_id 配对就能算出哪些调用拿到了结果、哪些悬在那里。
//
// 为什么用行号做游标（而不是字节偏移）：实测 --resume 是**纯追加**
// （579 行 → 590 行，原前缀逐字节一致），旧内容不会被重写、更不会被重排。
// 所以"读到第几行"是个稳定的位置，下次从那里接着读即可。
//
// 但配对**必须**按 id 精确匹配，不能假设 tool_use 和 tool_result 相邻：
// 实测两者之间会夹着 last-prompt / mode / atis-latch 等记录。
//
// 返回 { calls, dangling, lines, truncated }：
//   calls[]   = { id, name, preview, done } —— 这段区间内的全部调用
//   dangling  = 有调用、没结果的 id 列表（被强杀时非空）
//   lines     = 本次读到的总行数，下次原样传回来
//   truncated = calls 是否因长度上限被截断（dangling 永远完整）
//
// 返回 null 表示读不到文件，交调用方决定——不要在这里替它当作"没有调用"。
//
// limit 默认 200：模型陷入循环时可能产生几百个调用，工具输入又可能很大
// （实测一个 Bash 调用的输入能到 50 KB），全量返回会让调用方的内存和日志失控。
const MAX_CALLS = 200;

export function readSessionDelta(filePath, fromLine = 0, { limit = MAX_CALLS } = {}) {
  if (!existsSync(filePath)) return null;
  let lines;
  try {
    lines = readFileSync(filePath, "utf8").trimEnd().split("\n");
  } catch {
    return null;
  }

  // 游标比文件还长说明文件被换过（换会话、或用户清过）。从 0 重读——
  // 多读一轮不会有副作用，漏读才会。
  const cursor = Math.max(0, Math.min(Number(fromLine) || 0, lines.length));

  const meta = new Map(); // id → { id, name, preview }
  const order = []; // 按出现顺序的 id，用于保留调用序
  const resolved = new Set();

  for (let i = cursor; i < lines.length; i++) {
    let rec;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      continue; // 解析不了的整行跳过（与 stripImages 一致，绝不因一行坏掉就放弃）
    }
    const content = rec?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (item?.type === "tool_use" && item.id) {
        meta.set(item.id, {
          id: item.id,
          name: item.name || "?",
          preview: truncate(JSON.stringify(item.input ?? {}), 120),
        });
        order.push(item.id);
      } else if (item?.type === "tool_result" && item.tool_use_id) {
        resolved.add(item.tool_use_id);
      }
    }
  }

  // dangling 从全量 order 算：截断只影响展示，不影响"断在哪一步"的准确性
  const dangling = order.filter((id) => !resolved.has(id));
  const shown = order.slice(-limit);

  return {
    calls: shown.map((id) => ({ ...meta.get(id), done: resolved.has(id) })),
    dangling,
    lines: lines.length,
    truncated: order.length > shown.length,
  };
}

// 把一次运行的调用记录压成给用户看的几行摘要。
//
// 只显示**最后一个悬空工具之后**的调用，悬空的那个本身**不显示**：
// 它的结果没拿到，后面无论有什么都不可信——尤其结果可能就写在它的输出里。
// 给用户看的只有"确定已经做完"的步骤（✓），不确定的一律不列。
//
//   全部悬空   → 说清"这一步没等到结果"，而不是撒谎说"已跑完"
//   有完成的   → 列出来，让用户判断要不要重跑
//
// 这个账本只在"确实没跑完、通知用户回继续"时才渲染。已经跑完的任务不会
// 走到这里，所以它天然只在真要重放的时候才出现——不构成噪音。
export function pendingSummary(delta, max = 5) {
  if (!delta?.calls?.length) return "";

  const lastDangling = delta.dangling?.length ? delta.dangling.at(-1) : null;
  let doneAfter;

  if (lastDangling) {
    const idx = delta.calls.findIndex((c) => c.id === lastDangling);
    // 悬空点之后的调用才是可信的；idx 之后全是悬空（它就是最后一个），所以是空数组
    doneAfter = delta.calls.slice(idx + 1).filter((c) => c.done);
    // 注意：lastDangling 是全局最后一个悬空，其后不该再有调用——
    // 这里仍做一次 filter，是为了不依赖"dangling 一定按顺序"这个隐含假设。
    if (!doneAfter.length) return "\n（最后一步没有执行完，没拿到结果）";
  } else {
    doneAfter = delta.calls.filter((c) => c.done);
  }

  const shown = doneAfter.slice(-max);
  if (!shown.length) return "";
  return `\n已跑完的步骤：\n${shown.map((c) => `✓ ${c.name}`).join("\n")}`;
}

// 把会话里的图片 base64 换成占位图，原地重写文件。
//
// 必要性：QQ 机器人每条消息都 spawn 新进程 + --resume，进程在自动压缩有机会
// 触发之前就退出了，历史只增不减。而图片是 base64 全量存储、且**存两份**
// （message.content[].source.data 和 toolUseResult.file.base64）。
// 实测一份 10 MB 会话里图片占 8 MB。精简后上下文（文字部分）完整保留。
//
// 返回 { beforeMb, afterMb, replaced } 或 null（文件不存在/解析失败）。
export function stripImages(filePath) {
  if (!existsSync(filePath)) return null;

  let before;
  try {
    before = statSync(filePath).size;
  } catch {
    return null;
  }

  let lines;
  try {
    lines = readFileSync(filePath, "utf8").trim().split("\n");
  } catch {
    return null;
  }

  let replaced = 0;
  const out = lines.map((line) => {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      return line; // 解析不了的整行原样保留，绝不丢数据
    }

    const content = rec.message?.content;
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item?.type !== "tool_result" || !Array.isArray(item.content)) continue;
        for (const inner of item.content) {
          if (inner?.source?.data) {
            inner.source.data = PLACEHOLDER_PNG;
            replaced++;
          }
        }
      }
    }

    const t = rec.toolUseResult;
    if (t?.file?.base64) {
      t.file.base64 = PLACEHOLDER_PNG;
      replaced++;
    }

    return JSON.stringify(rec);
  });

  if (replaced === 0) return { beforeMb: before / 1048576, afterMb: before / 1048576, replaced: 0 };

  try {
    writeFileSync(filePath, out.join("\n") + "\n");
  } catch {
    return null; // 写失败就当作没精简，交给体积上限兜底
  }

  return { beforeMb: before / 1048576, afterMb: statSync(filePath).size / 1048576, replaced };
}
