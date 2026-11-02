import MarkdownIt from "markdown-it";
import { render as renderDiagram } from "pele";

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

// ```mermaid 代码块用 pele 同步渲染为 SVG（pele 会转义文本并过滤链接/样式）。
// 语法不完整（如流式输出中途）或渲染失败时回退为普通代码块。
const defaultFenceRule =
  markdown.renderer.rules.fence ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

markdown.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  if (token.info.trim().split(/\s+/)[0]?.toLowerCase() === "mermaid") {
    try {
      return `<div class="opshelper-diagram">${renderDiagram(token.content).svg}</div>\n`;
    } catch {
      // fall through to the plain code block
    }
  }
  return defaultFenceRule(tokens, idx, options, env, self);
};

// 助手用 ![说明](/workspace/outputs/x.svg) 引用工作区里的图片（如 pele 生成的 SVG），
// 改写为带登录态的文件下载地址；其它外链图片保持原样。
const FILES_API = "/v1/users/me/files";
const defaultImageRule =
  markdown.renderer.rules.image ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

markdown.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  // markdown-it 已把非 ASCII 字符（如中文文件名）百分号编码，先还原再编码，避免双重编码。
  let src = token.attrGet("src") ?? "";
  try {
    src = decodeURIComponent(src);
  } catch {
    return defaultImageRule(tokens, idx, options, env, self);
  }
  if (/^\/workspace\/[^?#]+$/.test(src) && !src.split("/").includes("..")) {
    token.attrSet("src", `${FILES_API}/download?path=${encodeURIComponent(src)}&inline=1`);
    token.attrSet("class", "opshelper-workspace-image");
    token.attrSet("loading", "lazy");
  }
  return defaultImageRule(tokens, idx, options, env, self);
};

export function renderAssistantMarkdown(value: string) {
  return markdown.render(value);
}
