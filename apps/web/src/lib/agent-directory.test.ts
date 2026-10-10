import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAgentFileTree,
  buildAgentPathTree,
  formatAgentFileSize,
  parseAgentReferences,
  removeAgentSkillReference,
} from "./agent-directory";

test("解析 agent.md 的 YAML 列表引用", () => {
  const document = [
    "---",
    "name: 网络运维",
    "skills:",
    "  - net-diag",
    "  - dns-trace",
    "scripts:",
    "  - probe.mjs",
    "---",
    "",
    "正文",
    "",
  ].join("\n");

  assert.deepEqual(parseAgentReferences(document), {
    skills: ["net-diag", "dns-trace"],
    scripts: ["probe.mjs"],
  });
});

test("解析内联 JSON 数组并按需去重", () => {
  const document = [
    "---",
    'skills: ["net-diag", "net-diag", \'dns-trace\']',
    "scripts: [probe.mjs]",
    "---",
    "",
    "正文",
    "",
  ].join("\n");

  assert.deepEqual(parseAgentReferences(document), {
    skills: ["net-diag", "dns-trace"],
    scripts: ["probe.mjs"],
  });
});

test("frontmatter 缺失或写坏时返回空引用而不是抛错", () => {
  assert.deepEqual(parseAgentReferences("没有 frontmatter"), { skills: [], scripts: [] });
  assert.deepEqual(parseAgentReferences(["---", "skills: 未闭合", "---"].join("\n")), {
    skills: [],
    scripts: [],
  });
  assert.deepEqual(
    parseAgentReferences(["---", "skills:", "  - a", "scripts:", "# 注释", "---"].join("\n")),
    {
      skills: ["a"],
      scripts: [],
    },
  );
});

test("删除块列表中的技能引用并保留其他配置", () => {
  const document = [
    "---",
    "name: 网络运维",
    "skills:",
    "  - net-diag",
    "  - shared-proof",
    "scripts:",
    "  - probe.mjs",
    "---",
    "",
    "正文",
  ].join("\n");

  const result = removeAgentSkillReference(document, "shared-proof");
  assert.deepEqual(parseAgentReferences(result), {
    skills: ["net-diag"],
    scripts: ["probe.mjs"],
  });
  assert.match(result, /name: 网络运维/);
  assert.match(result, /正文/);
  assert.doesNotMatch(result, /shared-proof/);
});

test("删除内联数组中的技能引用并兼容未引用或损坏的文档", () => {
  const document = [
    "---",
    "skills: [net-diag, 'shared-proof']",
    "---",
    "",
  ].join("\r\n");

  const result = removeAgentSkillReference(document, "shared-proof");
  assert.equal(result, ["---", 'skills: ["net-diag"]', "---", ""].join("\r\n"));
  assert.equal(removeAgentSkillReference(result, "missing"), result);
  assert.equal(removeAgentSkillReference("没有 frontmatter", "net-diag"), "没有 frontmatter");
});

test("文件清单按根文件、技能目录、脚本分组", () => {
  const tree = buildAgentFileTree(
    [
      "mcp.json",
      "agent.md",
      "scripts/e2e-mcp.mjs",
      "skills/shared-proof/SKILL.md",
      "skills/shared-proof/reference.md",
      "skills/net-diag/SKILL.md",
      "skills/net-diag/assets/probe.sh",
    ],
    ["shared-proof"],
  );

  assert.deepEqual(tree.rootFiles, ["agent.md", "mcp.json"]);
  assert.deepEqual(tree.others, []);
  assert.deepEqual(tree.skills.map((skill) => skill.name), ["net-diag", "shared-proof"]);
  assert.deepEqual(tree.skills[0].nodes.map((node) => node.name), ["assets", "SKILL.md"]);
  assert.deepEqual(tree.skills[0].nodes[0].children.map((node) => node.file), [
    "skills/net-diag/assets/probe.sh",
  ]);
  assert.equal(tree.skills[0].fileCount, 2);
  assert.equal(tree.skills[0].referenced, false);
  assert.equal(tree.skills[1].referenced, true);
  assert.deepEqual(tree.scripts.map((node) => node.file), ["scripts/e2e-mcp.mjs"]);
  assert.equal(tree.scriptCount, 1);
});

test("技能目录只保留一个分组，重复与异常路径不会丢文件", () => {
  const tree = buildAgentFileTree(
    ["agent.md", "skills/solo/SKILL.md", "skills/solo/SKILL.md", "assets/logo.png", "skills/dangling"],
    [],
  );

  assert.deepEqual(tree.rootFiles, ["agent.md"]);
  assert.deepEqual(tree.skills.map((skill) => [skill.name, skill.fileCount]), [["solo", 1]]);
  assert.deepEqual(tree.others, ["assets/logo.png", "skills/dangling"]);
});

test("技能包里的子目录按层级展开，不再拍平到一层", () => {
  const tree = buildAgentFileTree(
    [
      "skills/pdf/SKILL.md",
      "skills/pdf/scripts/fill_pdf_form.py",
      "skills/pdf/scripts/convert_pdf_to_images.py",
      "skills/pdf/scripts/nested/helper.py",
      "skills/pdf/reference.md",
    ],
    ["pdf"],
  );

  const [scripts] = tree.skills[0].nodes; // 目录排在文件之前
  assert.deepEqual(tree.skills[0].nodes.map((node) => node.name), ["scripts", "reference.md", "SKILL.md"]);
  assert.deepEqual(scripts.children.map((node) => node.name), ["nested", "convert_pdf_to_images.py", "fill_pdf_form.py"]);
  assert.deepEqual(scripts.children[0].children.map((node) => node.file), [
    "skills/pdf/scripts/nested/helper.py",
  ]);
  assert.equal(tree.skills[0].fileCount, 5);
});

test("嵌套脚本目录同样建成分层结构", () => {
  const tree = buildAgentFileTree(["agent.md", "scripts/lib/common.sh", "scripts/probe.mjs"]);

  assert.deepEqual(tree.scripts.map((node) => node.name), ["lib", "probe.mjs"]);
  assert.deepEqual(tree.scripts[0].children.map((node) => node.file), ["scripts/lib/common.sh"]);
  assert.equal(tree.scriptCount, 2);
});

test("目录树按目录优先、同级名称排序，并保留完整路径", () => {
  const nodes = buildAgentPathTree(["b.txt", "a/inner.txt", "c.txt"]);

  assert.deepEqual(nodes.map((node) => node.name), ["a", "b.txt", "c.txt"]);
  assert.equal(nodes[0].file, null);
  assert.equal(nodes[0].path, "a");
  assert.equal(nodes[1].file, "b.txt");
});

test("文件大小按常用单位展示", () => {
  assert.equal(formatAgentFileSize(0), "0 B");
  assert.equal(formatAgentFileSize(512), "512 B");
  assert.equal(formatAgentFileSize(2048), "2.0 KiB");
  assert.equal(formatAgentFileSize(20480), "20 KiB");
  assert.equal(formatAgentFileSize(3 * 1024 * 1024), "3.0 MiB");
});
