import assert from "node:assert/strict";
import test from "node:test";

import { renderAssistantMarkdown } from "./markdown";

test("Markdown 表格中的 br 标签渲染为换行", () => {
  const rendered = renderAssistantMarkdown("| 项目 | 说明 |\n| --- | --- |\n| A | 第一行<br>第二行 |");

  assert.match(rendered, /第一行<br>第二行/);
  assert.doesNotMatch(rendered, /&lt;br&gt;/);
});

test("宽表格套一层可横向滚动的容器，闭合标签成对", () => {
  const rendered = renderAssistantMarkdown("| 项目 | 说明 |\n| --- | --- |\n| A | B |");

  assert.match(rendered, /<div class="opshelper-table-scroll"><table>/);
  assert.match(rendered, /<\/table>\s*<\/div>/);
});

test("除 br 外的模型 HTML 仍按文本转义", () => {
  const rendered = renderAssistantMarkdown("<img src=x onerror=alert(1)>");

  assert.match(rendered, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(rendered, /<img/);
});

test("代码块中的 br 保持代码文本", () => {
  const rendered = renderAssistantMarkdown("```html\n<br>\n```");

  assert.match(rendered, /&lt;br&gt;/);
});

test("mermaid 代码块渲染为 SVG 图表", () => {
  const rendered = renderAssistantMarkdown("```mermaid\nflowchart LR\n  A[开始] --> B[结束]\n```");

  assert.match(rendered, /<div class="opshelper-diagram"><svg/);
  assert.doesNotMatch(rendered, /<pre>/);
});

test("无法解析的 mermaid 代码块回退为普通代码块", () => {
  const rendered = renderAssistantMarkdown("```mermaid\nflowchart LR\n  A -->\n```");

  assert.match(rendered, /<pre>/);
  assert.doesNotMatch(rendered, /<svg/);
});

test("工作区图片改写为内联下载地址，且拒绝路径穿越", () => {
  const ok = renderAssistantMarkdown("![流程](/workspace/outputs/a.svg)");
  assert.match(ok, /src="\/v1\/users\/me\/files\/download\?path=%2Fworkspace%2Foutputs%2Fa\.svg&amp;inline=1"/);
  assert.match(ok, /class="opshelper-workspace-image"/);

  const bad = renderAssistantMarkdown("![x](/workspace/../etc/passwd)");
  assert.doesNotMatch(bad, /files\/download/);
});

test("中文文件名的工作区图片只编码一次", () => {
  const rendered = renderAssistantMarkdown("![图](/workspace/outputs/市场调研流程图.svg)");
  const expected = encodeURIComponent("/workspace/outputs/市场调研流程图.svg");

  assert.ok(rendered.includes(`download?path=${expected}&amp;inline=1`));
  assert.doesNotMatch(rendered, /%25E5/);
});

test("编码形式的路径穿越同样被拒绝", () => {
  assert.doesNotMatch(renderAssistantMarkdown("![x](/workspace/%2e%2e/etc/passwd)"), /files\/download/);
});
