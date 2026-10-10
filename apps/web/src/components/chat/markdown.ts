import MarkdownIt from "markdown-it";

const lineBreakTag = /^<br\s*\/?\s*>$/i;

const markdown = new MarkdownIt({ html: true, linkify: true, breaks: true });

function renderSafeHtml(tokens: { content: string }[], index: number) {
  const content = tokens[index]?.content ?? "";
  return lineBreakTag.test(content.trim()) ? "<br>" : markdown.utils.escapeHtml(content);
}

// Model output occasionally uses <br> inside Markdown tables. Allow that one
// presentation-only tag while escaping every other HTML fragment.
markdown.renderer.rules.html_inline = renderSafeHtml;
markdown.renderer.rules.html_block = renderSafeHtml;

// 宽表格自己横向滚动，不要带着整个页面一起滚。外面套一层专用容器而不是给
// .opshelper-markdown 加 overflow：后者会把正文里的其它溢出也一并裁掉。
const defaultTokenRule =
  (markdown.renderer.rules.table_open) ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
const defaultCloseRule =
  (markdown.renderer.rules.table_close) ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

markdown.renderer.rules.table_open = (tokens, idx, options, env, self) =>
  `<div class="opshelper-table-scroll">${defaultTokenRule(tokens, idx, options, env, self)}`;
markdown.renderer.rules.table_close = (tokens, idx, options, env, self) =>
  `${defaultCloseRule(tokens, idx, options, env, self)}</div>`;

export function renderAssistantMarkdown(value: string) {
  return markdown.render(value);
}
