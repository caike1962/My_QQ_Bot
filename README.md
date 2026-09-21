# QQbot 一体化部署

基于 **NapCat + onebot-mcp + qq-bot** 的 QQ 机器人系统：收到私聊/群聊消息后，由 Claude Code 无头模式处理并回复。三个组件同仓管理。

## 消息链路

```
QQ 消息
  │
  ▼
NapCat ──3001 WS──▶ qq-bot 守护进程 ──spawn──▶ claude.exe（无头）
(QQ 协议端)                  │                      │
  6099 WebUI                 │                ┌────┴────┐
                             │                ▼         ▼
                             │            cc-switch   onebot-mcp
                             │           (15721 凭证)  (3000/mcp 工具)
                             │                │         │
                             └────────◀────────┴───────┘ 回复经 NapCat 发出
```

## 组件

| 目录 | 角色 | 端口 | 托管 | 来源 |
| --- | --- | --- | --- | --- |
| [NapCat.Shell.Windows.Node/](NapCat.Shell.Windows.Node/) | QQ 协议端 | 3001 WS（事件）、6099 WebUI | 计划任务 `NapCat` | 运行时二进制不入库 |
| [onebot-mcp/](onebot-mcp/) | OneBot API → MCP 工具 | 3000 HTTP | pm2 | 上游 [Frostbite-time/onebot-mcp](https://github.com/Frostbite-time/onebot-mcp) |
| [qq-bot/](qq-bot/) | 守护进程：监听事件 → spawn Claude 回复 | — | pm2（随 `OneBotMCP` 任务） | 自研 |

### NapCat.Shell.Windows.Node/

QQ 协议端。运行时文件（node.exe、DLL、`config/`）一律不入库，仅保留自启脚本 `napcat/launch-hidden.vbs`。新机器配置要点：

- `config/onebot11_<uin>.json` 的 `websocketServers` 默认是空数组，必须手写监听 3001
- `config/webui.json` 的 `autoLoginAccount` 是快速登录最可靠的开关
- `-q` 启动参数常在此 Shell 版丢失，改用环境变量 `NAPCAT_QUICK_ACCOUNT` / `NAPCAT_QUICK_PASSWORD_MD5`

### onebot-mcp/

```bash
cd onebot-mcp
npm install && npm run build   # 产物在 dist/（不入库）
cp .env.example .env           # 填入 webui token / QQ 号 / Anthropic 端点等
```

MCP HTTP 端点为 `http://127.0.0.1:3000/mcp`。工具名与底层 OneBot API 名不同（如工具 `send_group_message` 实际调 `send_group_msg`），映射见 `src/tools.ts`。

### qq-bot/

自研守护进程，`npm start`（pm2 进程名 `qq-bot`）。配置经 `src/config.js` 读取 `onebot-mcp/.env`。需要一份 `qq-bot/mcp-config.json`（含 localhost Bearer token，不入库，内容模板）：

```json
{
  "mcpServers": {
    "onebot-http": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp",
      "headers": { "Authorization": "Bearer <与 .env 中一致>" }
    }
  }
}
```

### cc-switch（外部程序，不在本仓）

`AppData\Local\Programs\CC Switch\cc-switch.exe`，在 `127.0.0.1:15721` 提供本地凭证代理——外部 spawn 的 claude 设 `ANTHROPIC_BASE_URL=http://127.0.0.1:15721` + 任意 token 即可获得真实凭证。**必须常驻**：它不在任何自启配置里，是链路最脆弱一环，掉线则 qq-bot 全部失败。

## 自启（Windows）

两个计划任务，均为 **AtLogOn 触发 + Administrator + 最高权限**。身份放 SYSTEM 会导致 QQ 数据目录落到 `systemprofile` 下、快速登录失效退回扫码：

| 任务 | 延迟 | 动作 |
| --- | --- | --- |
| `NapCat` | 20s | `wscript.exe napcat/launch-hidden.vbs`（隐藏窗口） |
| `OneBotMCP` | 45s | `pm2 resurrect`（拉起 onebot-mcp + qq-bot） |

初始安装脚本见 [setup-napcat-task.ps1](setup-napcat-task.ps1)。

## 安全边界（重要）

- 发送者分为两个角色：**admin**（`QQ_ALLOWED_SENDERS`，默认只含机主）与 **user**（`qq-bot/roles.json`，不提交）。admin 拥有全部权限；user 只能纯聊天——spawn 时以 `--permission-mode default` + 无 MCP + 无工具白名单运行，任何工具调用都会被硬拒绝（`tests/claude-spawn.test.js` 是这条边界的回归红线）
- **角色管理指令**（仅 admin 可用，由代码确定性执行、不经过模型）：私聊或群里 @ 机器人说「将 12345678 添加为用户」/「将 12345678 移出用户」即可增删 user，结果写入 `roles.json` 即时生效
- **后台任务**（仅 admin 可用）：发 `/bg <任务>` 或直接说「后台帮我查一下 X」，任务转到独立会话执行，回执立即返回，跑完把结果发回本会话。它**不占用会话锁**，布置后可以继续正常聊天
- admin 会话使用 `--dangerously-skip-permissions`，**工具白名单不构成边界**；真正决定谁能干什么的是角色名单
- 密钥与账号配置全部不入库：`onebot-mcp/.env`、`qq-bot/mcp-config.json`、`qq-bot/roles.json`、NapCat `config/` 需在部署机上手工创建/生成

## 已知行为备忘

- 开机后约 40~60s 内 NapCat 未登录、3001 未监听，qq-bot 日志刷 `连接关闭 code=1006` 属正常，会自动递增重连
- 群聊 @ 识别依赖 `QQ_GROUP_MENTION_NAMES`，机器人改群昵称后必须同步，否则表现为「完全没反应」（连日志都没有）
- 从机器人账号给自己发消息不会触发处理（`userId === selfId` 被过滤），联调要用另一个 QQ 号
- 排查顺序：3000（MCP 活着吗）→ 3001（NapCat 登录了吗）→ 6099（WebUI loginPhase/loginError）
- 后台任务跑在**独立会话**里（`sessionId: null`，同定时任务的做法），刻意不复用聊天会话——同一个会话文件不能被两个 claude 进程同时追加。任务完成后结果会**注入主会话**，所以接着追问细节能答上来
- 自然语言触发（「后台帮我查一下 X」）走的是「先跑一遍、跑完再看」：模型一步工具都没调过才转后台。所以像「后台是什么」这类一句话就能答完的，不会被误转
- 后台任务的超时是 30 分钟（`QQ_BG_TIMEOUT_MS`），不是聊天那条 5 分钟的——那条限制的成立理由是「有人在等」，后台任务没人等
- 进程重启时**不自动重放**后台任务，只推一条「被打断了，需要的话再发一次」。重跑一条 `/bg` 只是重打一行字，而自动重放可能把破坏性操作又做一遍
- **`preset.prompt` 决定「是不是合并重跑」这个判别式，普通消息必须传 null**（见 `startExec` 的调用点）。传了实际文本会让下游三处静默失效：群聊历史回溯、群聊署名前缀（`QQ_SENDER_PREFIX`）、后台结果注入——都不报错，只是内容悄悄不带。这个坑此前踩过两次（`2cbffc6` 声称修复但判据反了）

## 版本

- **v1.00** — 三个组件并入单仓，建立忽略规则与文档基线