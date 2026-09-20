import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";

export class ClaudeError extends Error {
  constructor(message, { code, stderr, cost, raw } = {}) {
    super(message);
    this.name = "ClaudeError";
    this.code = code;
    this.stderr = stderr;
    this.cost = cost;
    this.raw = raw;
  }
}

// user 会话的附加提示词：纯聊天角色，无任何工具权限。
// 重点声明两点：不存在授权弹窗（无头下被拒=永久没权限，别再请求批准，
// 否则会陷入"要求用户点授权"的死循环）；绝不允许编造执行结果。
const USER_SYSTEM_PROMPT =
  "你是聊天机器人，只能聊天。你没有任何工具权限：不能读写文件、不能执行命令、不能操作 QQ（发消息、查群等）。" +
  "如果对方要求你读文件、执行命令或代为操作，必须明确拒绝并说明没有权限。" +
  "不存在授权弹窗：你不会得到任何新权限，不要请求对方批准，也不要重复尝试。" +
  "不要编造执行结果——你从未执行过任何操作。";

// user 会话绝不允许出现的参数。buildClaudeArgs 会做运行时断言 + 测试双保险，
// 防止未来重构把 admin 的权限模式泄漏进受限会话。
export const FORBIDDEN_ARGS_FOR_USER = [
  "--dangerously-skip-permissions",
  "--mcp-config",
  "--strict-mcp-config",
  "--allowedTools",
];

export function buildClaudeArgs({ role = "admin", prompt, sessionId, mcpConfigPath, allowedTools }) {
  const isUser = role === "user";
  let args;
  if (isUser) {
    // default 权限模式 + 无白名单 + 无 MCP：无头场景下任何工具调用都会被硬拒绝，
    // 会话退化为纯文本聊天。绝不能用 acceptEdits（允许写文件）或 bypass。
    args = [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--permission-mode",
      "default",
      "--append-system-prompt",
      USER_SYSTEM_PROMPT,
    ];
  } else {
    args = [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--mcp-config",
      mcpConfigPath,
      "--strict-mcp-config",
      // 完全 bypass —— 用户明确选择（admin 会话）。
      //
      // 已实测确认：bypass 会**完全绕过** --allowedTools。给白名单只留
      // Read/Glob/Grep 时，仍能执行 Bash（whoami 返回 Administrator），
      // 且 permission_denials 为空。
      //
      // 因此 QQ_ALLOWED_TOOLS 在 bypass 下**不再构成安全边界**，保留它只是
      // 为了记录意图。真正的边界是发送者角色：QQ_ALLOWED_SENDERS（admin）。
      //
      // 若要收窄，改回 "--permission-mode", "acceptEdits"，白名单即重新生效。
      "--dangerously-skip-permissions",
      "--allowedTools",
      allowedTools,
    ];
  }

  if (sessionId) {
    args.push("--resume", sessionId);
  }

  if (isUser) {
    for (const flag of FORBIDDEN_ARGS_FOR_USER) {
      if (args.includes(flag)) {
        throw new Error(`user 会话参数泄漏: ${flag} 不允许出现在受限参数中`);
      }
    }
  }

  return args;
}

// claude.exe is a self-contained binary (pkg-style), so it can be spawned
// directly without a shell. This is what keeps QQ message text from ever
// reaching cmd.exe, where characters like & and | would be interpreted.
export function runClaude({
  exePath,
  baseUrl,
  authToken,
  homeDir,
  cwd,
  mcpConfigPath,
  prompt,
  sessionId,
  allowedTools,
  timeoutMs,
  mcpTimeoutMs,
  role = "admin",
}) {
  const args = buildClaudeArgs({ role, prompt, sessionId, mcpConfigPath, allowedTools });

  // Working directory decides which project the session lands in, so a bad
  // value silently scatters sessions across the wrong folders.
  if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new ClaudeError(`工作目录无效: ${cwd}（检查 QQ_CLAUDE_CWD）`);
  }

  const env = {
    HOME: homeDir,
    USERPROFILE: homeDir,
    PATH: process.env.PATH || "",
    SystemRoot: process.env.SystemRoot || "C:\\Windows",
    TEMP: process.env.TEMP || "",
    TMP: process.env.TMP || "",
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: authToken,
    MCP_TIMEOUT: String(mcpTimeoutMs),
    MCP_TOOL_TIMEOUT: String(timeoutMs),
  };

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(exePath, args, { env, cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(new ClaudeError(`无法启动 claude: ${error.message}`));
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new ClaudeError(`claude 进程错误: ${error.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);

      if (timedOut) {
        reject(new ClaudeError(`claude 超时（${Math.round(timeoutMs / 1000)}秒）`));
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        const hint = stderr.trim().slice(0, 300) || stdout.trim().slice(0, 300);
        reject(new ClaudeError(`无法解析 claude 输出 (exit=${code}): ${hint}`, { code, stderr }));
        return;
      }

      if (parsed.is_error || parsed.subtype !== "success") {
        // 保留原始输出：is_error=true 且 subtype=success 时，仅凭 subtype
        // 完全看不出失败原因（日志里只会显示"claude 返回错误: success"）。
        const raw = stdout.trim().slice(0, 500);
        reject(
          new ClaudeError(
            `claude 返回错误 (is_error=${parsed.is_error}, subtype=${parsed.subtype || "unknown"})`,
            {
              code,
              stderr: parsed.result || stderr,
              raw,
            },
          ),
        );
        return;
      }

      const text = (parsed.result || "").trim();
      if (!text) {
        reject(new ClaudeError("claude 返回空回复", { code }));
        return;
      }

      resolve({
        text,
        sessionId: parsed.session_id || null,
        cost: parsed.total_cost_usd || 0,
        durationMs: parsed.duration_ms || 0,
      });
    });
  });
}

// 让 CLI 把指定会话的历史压缩成摘要。
//
// 为什么单独一个函数而不复用 runClaude：这是维护性操作，不是对话。
// 它没有"回复文本"，失败也不该影响用户那条消息——调用方自行决定
// 失败时是忽略还是告知。
//
// 实测行为：CLI 会在会话文件里写入 compact_boundary 标记 + 摘要记录。
// 之后 resume 只加载标记之后的内容（input_tokens 从数万降到约 5k），
// 但**磁盘文件不会变小**——所以不要用文件体积判断压缩是否生效。
//
// 耗时较长（大会话可达数分钟），调用方务必给足超时。
export function compactSession({ exePath, baseUrl, authToken, homeDir, cwd, sessionId, timeoutMs = 600000 }) {
  const args = [
    "-p",
    "/compact",
    "--output-format",
    "json",
    "--resume",
    sessionId,
    "--dangerously-skip-permissions",
  ];

  const env = {
    HOME: homeDir,
    USERPROFILE: homeDir,
    PATH: process.env.PATH || "",
    SystemRoot: process.env.SystemRoot || "C:\\Windows",
    TEMP: process.env.TEMP || "",
    TMP: process.env.TMP || "",
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: authToken,
  };

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(exePath, args, { env, cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(new ClaudeError(`无法启动 claude compact: ${error.message}`));
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new ClaudeError(`claude compact 进程错误: ${error.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new ClaudeError(`compact 超时（${Math.round(timeoutMs / 1000)}秒），会话未压缩`));
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        const hint = stderr.trim().slice(0, 300) || stdout.trim().slice(0, 300);
        reject(new ClaudeError(`无法解析 compact 输出 (exit=${code}): ${hint}`, { code, stderr }));
        return;
      }

      if (parsed.is_error) {
        reject(new ClaudeError(`compact 失败: ${parsed.subtype || "unknown"}`, { code }));
        return;
      }

      resolve({
        cost: parsed.total_cost_usd || 0,
        durationMs: parsed.duration_ms || 0,
      });
    });
  });
}
