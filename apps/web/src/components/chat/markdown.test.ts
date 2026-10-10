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
