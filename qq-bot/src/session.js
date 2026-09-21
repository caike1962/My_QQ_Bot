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
