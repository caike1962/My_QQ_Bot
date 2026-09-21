import { test } from "node:test";
import assert from "node:assert/strict";
import { renderReportHtml, renderBody, escapeHtml, reportFileName } from "../src/html-report.js";

const AT = Date.parse("2026-09-21T14:05:00+08:00");

// ---------- escapeHtml ----------

test("escapeHtml: 五个危险字符都转义", () => {
  assert.equal(escapeHtml("<script>"), "&lt;script&gt;");
  assert.equal(escapeHtml("a & b"), "a &amp; b");
  assert.equal(escapeHtml('say "hi"'), "say &quot;hi&quot;");
  assert.equal(escapeHtml("it's"), "it&#39;s");
});

test("escapeHtml: & 先转义，不会二次转义生成出来的实体", () => {
  // 若先转 < 再转 &，&lt; 会变成 &amp;lt;，页面上直接显示出 "&lt;" 这四个字符
  assert.equal(escapeHtml("<"), "&lt;");
  assert.equal(escapeHtml("&lt;"), "&amp;lt;");
});

test("escapeHtml: 空值不抛错", () => {
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml(""), "");
});

// ---------- renderBody ----------

test("renderBody: 普通段落包成 p", () => {
  assert.equal(renderBody("第一段"), "<p>第一段</p>");
});

test("renderBody: 空行分段", () => {
  assert.equal(renderBody("第一段\n\n第二段"), "<p>第一段</p>\n<p>第二段</p>");
});

test("renderBody: 单换行不另起段落（同一段内的折行）", () => {
  const html = renderBody("第一行\n第二行");
  assert.equal(html, "<p>第一行</p>\n<p>第二行</p>");
});

test("renderBody: 中文数字编号渲染成 h2 小节标题", () => {
  const html = renderBody("一、服务器迁移");
  assert.equal(html, "<h2>服务器迁移</h2>");
});

test("renderBody: 中文数字标题里丢掉「一、」前缀", () => {
  const html = renderBody("十二、年度总结");
  assert.equal(html, "<h2>年度总结</h2>");
});

test("renderBody: 阿拉伯数字编号合成 ol，丢掉原文编号", () => {
  const html = renderBody("1. 甲\n2. 乙");
  assert.equal(html, "<ol><li>甲</li><li>乙</li></ol>");
});

test("renderBody: 中文标题与它的子项保持层级，不被拍平进同一个列表", () => {
  // 这是最要紧的一条：模型真实输出就是「一、大标题」下面跟「1. 2. 3.」子项。
  // 若两者都当列表项，会渲染成「1. 服务器迁移 / 2. 迁移窗口 / 3. 备份策略」，
  // 层级完全丢失。
  const html = renderBody("一、服务器迁移\n\n1. 迁移窗口\n2. 备份策略\n\n二、新同事");
  assert.equal(
    html,
    "<h2>服务器迁移</h2>\n<ol><li>迁移窗口</li><li>备份策略</li></ol>\n<h2>新同事</h2>",
  );
});

test("renderBody: 中文标题里的粗体仍生效", () => {
  assert.equal(renderBody("一、**重点**事项"), "<h2><strong>重点</strong>事项</h2>");
});

test("renderBody: 中文编号后没有内容时退回普通段落，不产出空标题", () => {
  assert.equal(renderBody("一、"), "<p>一、</p>");
});

test("renderBody: 编号被普通段落打断时分成两个列表", () => {
  const html = renderBody("1. 甲\n2. 乙\n\n中间一段话\n\n1. 丙");
  assert.equal(
    html,
    "<ol><li>甲</li><li>乙</li></ol>\n<p>中间一段话</p>\n<ol><li>丙</li></ol>",
  );
});

test("renderBody: 编号项之间夹空行仍合成同一个列表（模型的真实写法）", () => {
  // 实测模型写列表是「编号项\n\n编号项\n\n编号项」。
  // 若按"空行即断列表"处理，每项都会变成独立的 ol，浏览器里全从 1 开始编号，
  // 屏幕上出现一串「1. 1. 1.」。
  const html = renderBody("1. 甲\n\n2. 乙\n\n3. 丙");
  assert.equal(html, "<ol><li>甲</li><li>乙</li><li>丙</li></ol>");
});

test("renderBody: 列表后的总结句断开列表，不被吞并", () => {
  const html = renderBody("1. 甲\n2. 乙\n\n综上，建议先做甲。");
  assert.equal(html, "<ol><li>甲</li><li>乙</li></ol>\n<p>综上，建议先做甲。</p>");
});

test("renderBody: 纯散文之间的空行仍是两段，不会误合", () => {
  assert.equal(renderBody("开头一段。\n\n第二段。"), "<p>开头一段。</p>\n<p>第二段。</p>");
});

test("renderBody: **粗体** 转 strong", () => {
  assert.equal(renderBody("这是**重点**内容"), "<p>这是<strong>重点</strong>内容</p>");
});

test("renderBody: 列表项里的粗体也生效", () => {
  assert.equal(renderBody("1. **关键**结论"), "<ol><li><strong>关键</strong>结论</li></ol>");
});

test("renderBody: 单个星号不动（不是粗体语法）", () => {
  assert.equal(renderBody("3 * 4 = 12"), "<p>3 * 4 = 12</p>");
});

test("renderBody: ** 跨行不匹配，避免把整段吞成粗体", () => {
  const html = renderBody("**开头\n结尾**");
  assert.ok(!html.includes("<strong>"), "跨行的 ** 不该被当成粗体");
});

test("renderBody: 正文里的尖括号被转义（真实场景：a < b、XML 片段）", () => {
  const html = renderBody("比较 a < b 与 c > d");
  assert.equal(html, "<p>比较 a &lt; b 与 c &gt; d</p>");
});

test("renderBody: 正文里的 script 标签不会变成真标签", () => {
  const html = renderBody("<script>alert(1)</script>");
  assert.ok(!html.includes("<script>"), "不该出现可执行的 script 标签");
  assert.ok(html.includes("&lt;script&gt;"));
});

test("renderBody: 转义后的内容里如果含 ** 仍能加粗，且不破坏实体", () => {
  const html = renderBody("**a < b**");
  assert.equal(html, "<p><strong>a &lt; b</strong></p>");
});

test("renderBody: 空输入与纯空白返回空串", () => {
  assert.equal(renderBody(""), "");
  assert.equal(renderBody("   \n\n  \n"), "");
  assert.equal(renderBody(null), "");
});

test("renderBody: CRLF 换行也当换行处理", () => {
  assert.equal(renderBody("第一段\r\n\r\n第二段"), "<p>第一段</p>\n<p>第二段</p>");
});

test("renderBody: 编号后没有内容时不吞掉整行", () => {
  const html = renderBody("1. ");
  assert.ok(html.includes("<li>"), "空列表项也要产出一个 li，而不是丢失这一行");
});

// ---------- renderReportHtml ----------

test("renderReportHtml: 完整文档结构", () => {
  const html = renderReportHtml({ title: "群聊日报", text: "内容", at: AT });
  assert.ok(html.startsWith("<!DOCTYPE html>"));
  assert.ok(html.includes('<html lang="zh-CN">'));
  assert.ok(html.includes('<meta charset="utf-8">'));
  assert.ok(html.includes("</html>"));
});

test("renderReportHtml: 移动端 viewport 与中文可读性样式", () => {
  const html = renderReportHtml({ title: "t", text: "x", at: AT });
  assert.ok(html.includes('name="viewport"'), "缺 viewport 手机端会按桌面宽度渲染");
  assert.ok(html.includes("prefers-color-scheme: dark"), "缺深色模式，夜里看会刺眼");
  assert.ok(html.includes("overflow-wrap"), "缺这条长串会撑破手机屏");
  assert.ok(html.includes("PingFang SC"), "缺中文字体栈");
});

test("renderReportHtml: 不引任何外网资源（离线也要能看）", () => {
  const html = renderReportHtml({ title: "t", text: "x", at: AT });
  assert.ok(!/https?:\/\//.test(html), "不该有外链，否则离线打开排版全丢");
});

test("renderReportHtml: 标题里的危险字符被转义", () => {
  const html = renderReportHtml({ title: "<img onerror=x>", text: "x", at: AT });
  assert.ok(!html.includes("<img"), "标题里的标签不该生效");
  assert.ok(html.includes("&lt;img"));
});

test("renderReportHtml: 标题为空时退回默认值", () => {
  for (const t of ["", "   ", null, undefined]) {
    const html = renderReportHtml({ title: t, text: "x", at: AT });
    assert.ok(html.includes("<h1>报告</h1>"), `标题 ${JSON.stringify(t)} 应退回「报告」`);
  }
});

test("renderReportHtml: 元信息给出时间与字数", () => {
  const html = renderReportHtml({ title: "t", text: "一二三四五", at: AT });
  assert.ok(html.includes("2026-09-21 14:05"));
  assert.ok(html.includes("全文 5 字"));
});

test("renderReportHtml: 字数按码点算，emoji 记 1 个", () => {
  const html = renderReportHtml({ title: "t", text: "👍👍", at: AT });
  assert.ok(html.includes("全文 2 字"), "两个 emoji 应算 2 字而不是 4");
});

test("renderReportHtml: 真实样例——中文标题 + 子项列表 + 粗体 + 尖括号", () => {
  const html = renderReportHtml({
    title: "本周群聊总结",
    at: AT,
    text: [
      "本周群里主要讨论了三件事：",
      "",
      "一、**服务器迁移**",
      "",
      "1. 计划把 a < b 的那台换掉。",
      "2. 下周三凌晨执行。",
      "",
      "二、新同事入职",
    ].join("\n"),
  });
  assert.ok(html.includes("<h2><strong>服务器迁移</strong></h2>"), "中文编号应是 h2 且保留粗体");
  assert.ok(html.includes("<ol><li>计划把 a &lt; b 的那台换掉。</li><li>下周三凌晨执行。</li></ol>"));
  assert.ok(html.includes("<h2>新同事入职</h2>"));
  assert.ok(!html.includes("一、"), "原文编号前缀应被丢掉");
});

test("renderReportHtml: 正文标签正确闭合（结构完整）", () => {
  const html = renderReportHtml({
    title: "日报",
    text: "开头一句\n\n一、甲方\n\n1. 子项\n\n结尾一段",
    at: AT,
  });
  for (const tag of ["p", "ol", "h2", "li", "main", "h1"]) {
    const opens = (html.match(new RegExp(`<${tag}[ >]`, "g")) || []).length;
    const closes = (html.match(new RegExp(`</${tag}>`, "g")) || []).length;
    assert.equal(opens, closes, `<${tag}> 开合数量应一致`);
  }
});

// ---------- reportFileName ----------

test("reportFileName: 带时间戳且以 .html 结尾", () => {
  assert.equal(reportFileName(AT), "report-20260921-1405.html");
});

test("reportFileName: 月日时分都补零", () => {
  const t = Date.parse("2026-01-02T03:04:00+08:00");
  assert.equal(reportFileName(t), "report-20260102-0304.html");
});
