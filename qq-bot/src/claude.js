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
}) {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--mcp-config",
    mcpConfigPath,
    "--strict-mcp-config",
    // 完全 bypass —— 用户明确选择。
    //
    // 已实测确认：bypass 会**完全绕过** --allowedTools。给白名单只留
    // Read/Glob/Grep 时，仍能执行 Bash（whoami 返回 Administrator），
    // 且 permission_denials 为空。
    //
    // 因此 config.js 里的 QQ_ALLOWED_TOOLS 在 bypass 下**不再构成安全边界**，
    // 保留它只是为了记录意图。真正的边界是 QQ_ALLOWED_SENDERS ——
    // 谁能给 bot 发消息，谁就能以 Administrator 权限在这台机器上执行任意命令。
    //
    // 若要收窄，改回 "--permission-mode", "acceptEdits"，白名单即重新生效。
    "--dangerously-skip-permissions",
    "--allowedTools",
    allowedTools,
  ];

  if (sessionId) {
    args.push("--resume", sessionId);
  }

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
