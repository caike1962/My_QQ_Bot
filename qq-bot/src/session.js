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
