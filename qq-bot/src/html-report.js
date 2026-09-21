// 长回复的 HTML 渲染。
//
// 为什么要这个：模型回复超过 maxReplyChars 时原来只能截断，用户拿到的
// 是半截内容——而长回复往往正是最有价值的那些（报告、分析、总结）。
// 改成写 HTML 文件发出去，完整内容都在，手机端用浏览器打开即可阅读。
//
// 为什么**不写 Markdown 解析器**：实测过 41 条长回复（>300 字），
//   含 `#` 标题的：0 条
//   含代码块的：0 条
//   含 `**加粗**` 的：4 条
// 这个模型（deepseek-v4-flash）输出的是纯中文散文 + 中文数字编号
// （「一、」「1.」）。为 4/41 的加粗写一整套 Markdown 解析不划算，
// 而 `#`/代码块根本不会出现。所以只处理三样：段落、编号列表、粗体。
//
// 纯函数，不碰 IO —— 边界情况（空输入、危险字符、超长段落）都能用单测钉死。
// 写盘与上传在 index.js。

// HTML 转义。必须做，不是可选项：模型输出里出现 `<` 的场景很多
// （「a < b」、XML/HTML 片段、正则），不转义轻则排版错乱，重则注入。
export function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;") // 必须第一个替换，否则会把下面生成实体的 & 再转一次
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 行内格式。只认 **粗体**——它是实测唯一会出现的行内语法。
// 输入必须是**已转义**的文本，这里只插入标签、不再做转义。
function inline(escaped) {
  return escaped.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
}

// 中文数字编号（「一、」「十二、」）渲染成 <h2> 而不是 <li>。
//
// 两条理由：
//   1. 中文语境里它常被当**段落标题**用（「一、服务器迁移」后面跟的不是
//      并列内容，而是这一节本身），渲染成小节标题更贴近阅读习惯。
//   2. 它经常和阿拉伯数字**分级混用**——实测真实输出长这样：
//        「一、服务器迁移」→「1. 迁移窗口…」「2. 备份策略…」
//      若两者都当列表项，标题会和它的子项混进同一个列表，屏幕上出现
//      「1. 服务器迁移 / 2. 迁移窗口 / 3. 备份策略」——层级完全丢失。
// 分开处理后，标题是标题、子项是列表，结构就对了。
const CN_ORDERED = /^([一二三四五六七八九十百]+)[、.．]\s*(.*)$/;
// 阿拉伯数字编号：「1.」「1、」「1)」等。
const AR_ORDERED = /^\d{1,3}[、.．)]\s*/;

const isArabicOrdered = (line) => AR_ORDERED.test(line);

// 把模型输出的纯文本转成 HTML 正文。
//
// 分块规则：按空行切段，逐行判断——
//   中文数字编号 → <h2> 小节标题（见上面 CN_ORDERED 的说明）
//   阿拉伯数字编号 → 合进同一个 <ol>
//   其余 → <p>
//
// 为什么列表要跨空行连续：实测模型的真实写法是**每个编号项之间夹一个空行**。
// 若"空行即断列表"，每一项都会变成独立的 <ol>，浏览器里每项都从 1 开始编号，
// 屏幕上出现一串「1. 1. 1.」。所以断列表的唯一依据是"这行不是编号"，
// 而不是"前面有空白"。
//
// 阿拉伯数字的编号前缀会被丢掉，交给 <ol> 自动序号：模型写的编号有时会串
// （连写两段都从「1.」开始），交给浏览器按序编号更整齐。
export function renderBody(text) {
  const raw = String(text ?? "").replace(/\r\n/g, "\n");
  if (!raw.trim()) return "";

  const blocks = [];
  let listItems = null;

  const flushList = () => {
    if (listItems) {
      blocks.push(`<ol>${listItems.map((t) => `<li>${t}</li>`).join("")}</ol>`);
      listItems = null;
    }
  };

  for (const chunk of raw.split(/\n{2,}/)) {
    // 一个段落块本身可能是多行（无空行的连续行），逐行判断
    const lines = chunk.split("\n").map((l) => l.trim()).filter(Boolean);

    for (const line of lines) {
      const cn = CN_ORDERED.exec(line);
      if (cn) {
        // 标题要断开列表：它下面跟的是新一节的子项，不是上一节的延续
        flushList();
        const heading = cn[2].trim();
        // 「一、」后面没内容的退化情况：保留原文，别产出空标题
        blocks.push(
          heading ? `<h2>${inline(escapeHtml(heading))}</h2>` : `<p>${inline(escapeHtml(line))}</p>`,
        );
        continue;
      }

      if (isArabicOrdered(line)) {
        const body = line.replace(AR_ORDERED, "");
        if (!listItems) listItems = [];
        listItems.push(inline(escapeHtml(body)));
        continue;
      }

      flushList();
      blocks.push(`<p>${inline(escapeHtml(line))}</p>`);
    }
    // 注意这里**不** flushList：编号块之间夹空行是常态，列表要继续。
    // 列表只在遇到标题或普通段落时断开。
  }
  flushList();

  return blocks.join("\n");
}

// 元信息行：生成时间 + 字数。给读者一个"这是什么时候、多长的东西"的锚点。
function metaLine(at, charCount) {
  const d = new Date(at);
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${stamp} · 全文 ${charCount} 字`;
}

// 样式全部内联，不引外网资源——这个文件是在手机上离线打开的，
// 任何 CDN 依赖都会变成"打不开"或"排版全乱"。
//
// 关键几条：
//   max-width + margin auto —— 桌面端不要拉满整屏，一行的字数才读得下去
//   line-height 1.75      —— 中文正文的行距要松一些
//   overflow-wrap         —— 长串（URL、无空格长词）不许撑破手机屏
//   prefers-color-scheme  —— 跟随系统深色模式，手机夜里看才不刺眼
const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 2.5rem 1.25rem 4rem;
  background: #fbfbfa;
  color: #1f2328;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
               "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  font-size: 17px;
  line-height: 1.75;
  -webkit-text-size-adjust: 100%;
}
main { max-width: 42em; margin: 0 auto; }
h1 {
  font-size: 1.5rem;
  line-height: 1.4;
  margin: 0 0 .5rem;
  letter-spacing: -.01em;
}
h2 {
  font-size: 1.15rem;
  line-height: 1.5;
  margin: 2rem 0 .9rem;
  padding-left: .7rem;
  border-left: 3px solid #c9c6c0;
}
h2:first-of-type { margin-top: 1.5rem; }
.meta {
  margin: 0 0 2rem;
  padding-bottom: 1.25rem;
  border-bottom: 1px solid #e6e4e0;
  color: #6b7280;
  font-size: .875rem;
}
p { margin: 0 0 1.15rem; overflow-wrap: break-word; }
ol { margin: 0 0 1.15rem; padding-left: 1.6rem; }
li { margin-bottom: .5rem; overflow-wrap: break-word; }
strong { font-weight: 650; }
@media (prefers-color-scheme: dark) {
  body { background: #16171a; color: #e6e6e6; }
  .meta { border-bottom-color: #2c2e33; color: #9aa0a6; }
  h2 { border-left-color: #3a3d42; }
}
@media (max-width: 480px) {
  body { padding: 1.5rem 1rem 3rem; font-size: 16px; }
  h1 { font-size: 1.3rem; }
}
`.trim();

// 完整 HTML 文档。
//
// title 与 text 都来自模型，必须转义——title 里放个 `<` 就能毁掉整页。
export function renderReportHtml({ title, text, at = Date.now() }) {
  const body = String(text ?? "");
  const charCount = Array.from(body).length;
  const heading = escapeHtml(String(title || "报告").trim() || "报告");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${heading}</title>
<style>
${STYLE}
</style>
</head>
<body>
<main>
<h1>${heading}</h1>
<p class="meta">${escapeHtml(metaLine(at, charCount))}</p>
${renderBody(body)}
</main>
</body>
</html>
`;
}

// 给文件起名。时间戳到分钟，同一分钟内连发两次会重名——
// 调用方负责在重名时加序号（见 index.js 的 writeReportFile）。
export function reportFileName(at = Date.now()) {
  const d = new Date(at);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `report-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}.html`
  );
}
