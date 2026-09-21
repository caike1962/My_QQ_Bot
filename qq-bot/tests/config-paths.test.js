import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

// 配置测试直接读真实的 .env（CONFIG_PATH 是常量，只能靠环境变量改）。
// 但 process.env 会覆盖 .env 里的同名项，所以这里用 QQ_DATA_DIR 之类的
// **只在测试里出现**的变量来驱动，不会碰到生产配置。

const saved = {};
function withEnv(vars, fn) {
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("不设 QQ_DATA_DIR 时全部落到内置默认目录", () => {
  withEnv({ QQ_DATA_DIR: undefined, QQ_JOBS_PATH: undefined, QQ_WORKSPACE_DIR: undefined }, () => {
    const c = loadConfig();
    assert.equal(c.dataDir, "D:\\QQBOT\\qq-bot");
    assert.equal(c.sessionsPath, "D:\\QQBOT\\qq-bot\\sessions.json");
    assert.equal(c.queuePath, "D:\\QQBOT\\qq-bot\\queue.json");
    assert.equal(c.rolesPath, "D:\\QQBOT\\qq-bot\\roles.json");
    assert.equal(c.jobsPath, "D:\\QQBOT\\qq-bot\\jobs.json");
    assert.equal(c.workspaceDir, "D:\\QQBOT\\qq-bot\\workspace");
    assert.equal(c.claudeMcpConfig, "D:\\QQBOT\\qq-bot\\mcp-config.json");
  });
});

test("设了 QQ_DATA_DIR 后，状态文件全部跟着走", () => {
  withEnv({ QQ_DATA_DIR: "E:\\NewBot", QQ_JOBS_PATH: undefined, QQ_WORKSPACE_DIR: undefined }, () => {
    const c = loadConfig();
    assert.equal(c.sessionsPath, "E:\\NewBot\\sessions.json");
    assert.equal(c.queuePath, "E:\\NewBot\\queue.json");
    assert.equal(c.rolesPath, "E:\\NewBot\\roles.json");
    assert.equal(c.jobsPath, "E:\\NewBot\\jobs.json");
    assert.equal(c.workspaceDir, "E:\\NewBot\\workspace");
  });
});

test("mcp-config.json 不随 QQ_DATA_DIR 迁移（它是部署资产，不是数据）", () => {
  // 它描述的是"本机的 onebot-mcp 在哪个端口、用什么 token"，
  // 内容跟着代码与部署方式走。若跟着数据目录跑，转移后会指向一个
  // 不存在的文件，而报错会出现在 spawn claude 的那一刻——很难定位。
  withEnv({ QQ_DATA_DIR: "E:\\NewBot", QQ_CLAUDE_MCP_CONFIG: undefined }, () => {
    const c = loadConfig();
    assert.equal(c.claudeMcpConfig, "D:\\QQBOT\\qq-bot\\mcp-config.json");
  });
});

test("mcp-config.json 可以用专用变量单独指定", () => {
  withEnv({ QQ_CLAUDE_MCP_CONFIG: "E:\\deploy\\mcp.json" }, () => {
    const c = loadConfig();
    assert.equal(c.claudeMcpConfig, "E:\\deploy\\mcp.json");
  });
});

test("转移部署只需改 QQ_DATA_DIR 一行（这是本功能的核心承诺）", () => {
  withEnv({ QQ_DATA_DIR: "F:\\Bot", QQ_JOBS_PATH: undefined, QQ_WORKSPACE_DIR: undefined }, () => {
    const c = loadConfig();
    // 所有落盘位置都必须在 F:\Bot 之下
    for (const [name, p] of [
      ["sessionsPath", c.sessionsPath],
      ["queuePath", c.queuePath],
      ["rolesPath", c.rolesPath],
      ["jobsPath", c.jobsPath],
      ["workspaceDir", c.workspaceDir],
    ]) {
      assert.ok(p.startsWith("F:\\Bot\\"), `${name} 应随 QQ_DATA_DIR 迁移，实际 ${p}`);
    }
  });
});

test("专用变量优先于 QQ_DATA_DIR（精确指令胜过一把大伞）", () => {
  withEnv(
    {
      QQ_DATA_DIR: "E:\\NewBot",
      QQ_JOBS_PATH: "D:\\Custom\\jobs.json",
      QQ_WORKSPACE_DIR: "D:\\Custom\\work",
    },
    () => {
      const c = loadConfig();
      assert.equal(c.jobsPath, "D:\\Custom\\jobs.json");
      assert.equal(c.workspaceDir, "D:\\Custom\\work");
      // 没给专用变量的那些仍随根目录
      assert.equal(c.queuePath, "E:\\NewBot\\queue.json");
      assert.equal(c.sessionsPath, "E:\\NewBot\\sessions.json");
    },
  );
});

test("QQ_DATA_DIR 用正斜杠也能得到干净的 Windows 路径", () => {
  withEnv({ QQ_DATA_DIR: "E:/NewBot/data", QQ_JOBS_PATH: undefined, QQ_WORKSPACE_DIR: undefined }, () => {
    const c = loadConfig();
    assert.equal(c.dataDir, "E:\\NewBot\\data");
    assert.equal(c.sessionsPath, "E:\\NewBot\\data\\sessions.json");
    assert.ok(!c.sessionsPath.includes("/"), "不该出现混用的分隔符");
  });
});

test("QQ_DATA_DIR 末尾多余的反斜杠被去掉，不会拼出双斜杠", () => {
  withEnv({ QQ_DATA_DIR: "E:\\NewBot\\\\", QQ_JOBS_PATH: undefined, QQ_WORKSPACE_DIR: undefined }, () => {
    const c = loadConfig();
    assert.equal(c.sessionsPath, "E:\\NewBot\\sessions.json");
    assert.ok(!c.sessionsPath.includes("\\\\"), `不该有双反斜杠: ${c.sessionsPath}`);
  });
});

test("projectsBase 跟随 claudeHome（会话文件目录由 CLI 管理，位置固定）", () => {
  const c = loadConfig();
  assert.ok(c.projectsBase.endsWith(".claude\\projects"), c.projectsBase);
  assert.ok(
    c.projectsBase.startsWith(c.claudeHome),
    `projectsBase 应位于 claudeHome 之下: ${c.projectsBase} vs ${c.claudeHome}`,
  );
});

test("显式的状态文件路径仍能覆盖（保留既有部署的配置能力）", () => {
  withEnv(
    { QQBOT_QUEUE: "E:\\x\\q.json", QQBOT_ROLES: "E:\\x\\r.json", QQ_DATA_DIR: "E:\\NewBot" },
    () => {
      const c = loadConfig();
      assert.equal(c.queuePath, "E:\\x\\q.json");
      assert.equal(c.rolesPath, "E:\\x\\r.json");
    },
  );
});
