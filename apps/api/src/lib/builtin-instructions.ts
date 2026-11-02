// 平台内置的全局规则：始终先于管理员配置的全局规则写入 AGENTS.md。
export const BUILTIN_INSTRUCTIONS = `# 可视化图表

需要流程图、时序图、架构图、甘特图、状态图、ER 图、饼图等图表时，默认使用已离线预装的 pele（Mermaid 语法）渲染，不要联网下载渲染库，也不要使用 mermaid.js、matplotlib 等其他方式，除非用户明确要求。

- 在回复中直接输出 \`\`\`mermaid 代码块，对话窗口会自动渲染为图表。
- 需要交付图片文件时：先把 Mermaid 源码写入 /workspace/outputs/<名称>.mmd，再执行 \`pele-render /workspace/outputs/<名称>.mmd /workspace/outputs/<名称>.svg\` 生成 SVG。
- 在回复中用 Markdown 图片语法引用生成的文件即可在对话中直接显示，例如 \`![流程图](/workspace/outputs/<名称>.svg)\`。
- 渲染报错说明 Mermaid 语法有误，修正后重试。
`;

export function withBuiltinInstructions(adminInstructions: string) {
  return adminInstructions.trim()
    ? `${BUILTIN_INSTRUCTIONS}\n${adminInstructions}`
    : BUILTIN_INSTRUCTIONS;
}
