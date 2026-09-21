import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { truncate } from "./session.js";

// 活着/刚活过的 claude 子进程。给 /诊断 用。
//
// 为什么在这里登记而不是让 index.js 自己追踪：killTree 是所有 spawn 的
// 天然收口（超时、合并打断都走它）。挂在 spawn 那一刻，将来新增的调用点
// 不必记得登记也不会漏。
//
// 条目只在 close 时标成 done，不删除：诊断要回答的正是「有没有卡住/残留的
// 进程」，一条刚跑完的记录（done=true）恰好是「它跑过、现在没了」的证据。
// 数量有上限，>8 个时丢最老的记录。
const PROC_HISTORY = 8;
const procs = [];

export function liveProcs() {
  return procs.map((p) => ({ ...p }));
}

function noteSpawn(child, label) {
  const rec = { pid: child.pid, startedAt: Date.now(), label, done: false };
  procs.push(rec);
  if (procs.length > PROC_HISTORY) procs.shift();
  const mark = () => {
    rec.done = true;
  };
  if (child.exitCode !== null || child.signalCode !== null) mark();
  else child.once("close", mark);
  return rec;
}

// 强杀整个进程树。
//
// 为什么不能用 child.kill()：Windows 上 claude.exe 是控制台程序，
// Node 的 kill 信号投递不可靠；而它派生的子进程不会跟着退出，
// 残留进程会一直持有 stdout 管道 —— 于是 'close' 事件**永不触发**，
// 超时分支就永远挂在那里（实测遇到过，见 QQ_TIMEOUT_MS 的 300s 卡死）。
// taskkill /T /F 是唯一能连子进程一起收掉的办法（pm2 自己也是这么干的）。
//
// 注意 stdio 用了 ignore，不依赖管道关闭；'close' 在进程真正退出后才触发。
function killTree(child) {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
    }
    return;
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* 已退出 */
  }
}

export class ClaudeError extends Error {
  constructor(message, { code, stderr, cost, raw, aborted = false } = {}) {
    super(message);
    this.name = "ClaudeError";
    this.code = code;
    this.stderr = stderr;
    this.cost = cost;
    this.raw = raw;
    // 被合并打断而杀掉，区别于超时/崩溃等真失败。
    // 调用方据此静默退出（这条消息已经并入新的一条，不该报错也不该重试）。
    this.aborted = aborted;
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

export function buildClaudeArgs({ role = "admin", prompt, sessionId, mcpConfigPath, allowedTools, model }) {
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

  // 模型用别名（haiku/sonnet/opus），不是具体模型名 —— cc-switch 按槽位路由，
  // 传模型名会被当成无效槽位键。见 config.js 的 claudeModel 注释。
  if (model) {
    args.push("--model", model);
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
  model,
  abortSignal,
  label,
}) {
  const args = buildClaudeArgs({ role, prompt, sessionId, mcpConfigPath, allowedTools, model });

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

    // 诊断标签优先用调用方给的可读描述（如「private:123 帮我查磁盘」）。
    // 直接用 prompt 会在合并打断后打出一大段 [补充：…] 前缀，那一长串
    // 对"这条为什么还没回"没有帮助，反而把真正的意图挤到看不见。
    //
    // 先压缩空白再截断：prompt 里的换行会毁掉报告排版，而截断必须用
    // session.js 的 truncate（代理对安全），否则用户的中文/emoji 会被切成乱码。
    noteSpawn(
      child,
      label || `对话：${truncate(String(prompt ?? "").replace(/\s+/g, " ").trim(), 30)}`,
    );

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    // 合并打断：信号一到就杀进程树，并**立即**以 aborted 拒绝。
    //
    // 为什么不能等 close 事件再判 aborted：close 只保证进程退出了，
    // 不保证它是被我们杀掉的。若 abort 恰好落在"模型已生成完整回复、
    // 进程正要正常退出"的窗口里，close 会以成功路径先到——于是这次运行
    // 正常返回、把回复发出去，而合并后的重跑又发一次，用户收到两条。
    // 让 abort 本身成为权威，这个竞态就不存在了。
    //
    // 杀进程仍然要做：不杀的话它会继续往会话文件里写，和重跑的那条撞车。
    const onAbort = () => {
      if (aborted) return;
      aborted = true;
      killTree(child);
      clearTimeout(timer);
      reject(new ClaudeError("claude 被合并打断", { aborted: true }));
    };
    // abortSignal 传错必须**立刻报错**，不能静默降级。
    //
    // 曾经写成"不是 AbortSignal 就跳过"，结果一次调用方的笔误让打断完全失效：
    // 进程照常跑完、回复照常发出，而合并后的重跑又发一次，用户收到两条内容。
    // 这种"看起来装了 abort 其实没装"的失败模式最难排查——它没有任何症状。
    // 宁可当场让这次调用失败。
    //
    // 注意收的是 **signal**（controller.signal），不是 controller 本身；
    // 传反了是很容易犯的错，所以报错信息里带上构造器名字便于定位。
    if (abortSignal !== undefined && abortSignal !== null) {
      if (typeof abortSignal.addEventListener !== "function") {
        clearTimeout(timer);
        const got = abortSignal?.constructor?.name || typeof abortSignal;
        reject(
          new ClaudeError(
            `abortSignal 不是有效的 AbortSignal（收到 ${got}）。` +
              `若传的是 AbortController，请改传它的 .signal`,
          ),
        );
        return;
      }
      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener("abort", onAbort, { once: true });
    }

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
      if (abortSignal?.removeEventListener) abortSignal.removeEventListener("abort", onAbort);

      // aborted 时 onAbort 已经 reject 过了，这里再 reject 一次没有副作用
      // （Promise 只认第一次），保留是为了让"没装 abort 信号"的路径也能
      // 在进程被杀后正确收尾。
      if (aborted) {
        reject(new ClaudeError("claude 被合并打断", { code, aborted: true }));
        return;
      }

      if (timedOut) {
        // 带上截止时的输出量：0 字符 = 进程起来了一条 JSON 都没吐，
        // 有字符 = 它在干活只是没跑完。这两种超时该查的方向完全不同。
        reject(
          new ClaudeError(
            `claude 超时（${Math.round(timeoutMs / 1000)}秒），` +
              `截止时已收到 ${stdout.length} 字符 stdout / ${stderr.length} 字符 stderr`,
          ),
        );
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
export function compactSession({ exePath, baseUrl, authToken, homeDir, cwd, sessionId, timeoutMs = 600000, model }) {
  // 这些参数直接进 spawn 的 args/env，运行时才报错的话进程已经起来了。
  // 提前挡掉，顺带让 unit test 不必真的去 spawn。
  if (!sessionId || typeof sessionId !== "string") {
    return Promise.reject(new ClaudeError(`compact 需要 sessionId，收到 ${JSON.stringify(sessionId)}`));
  }
  if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
    return Promise.reject(new ClaudeError(`工作目录无效: ${cwd}（检查 QQ_CLAUDE_CWD）`));
  }

  const args = [
    "-p",
    "/compact",
    "--output-format",
    "json",
    "--resume",
    sessionId,
    "--dangerously-skip-permissions",
  ];

  if (model) {
    args.push("--model", model);
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
  };

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(exePath, args, { env, cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(new ClaudeError(`无法启动 claude compact: ${error.message}`));
      return;
    }

    noteSpawn(child, `压缩会话 ${String(sessionId).slice(0, 8)}`);

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
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
