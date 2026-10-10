import assert from "node:assert/strict";
import test from "node:test";

import type { ChatPart } from "./message-model";
import {
  operationCategories,
  operationKind,
  operationsFromParts,
  operationSummary,
  toolDisplayName,
} from "./tool-activity";

function toolPart(
  id: string,
  name: string,
  status: string,
  input: unknown,
  options: { output?: string; metadata?: unknown; title?: string; time?: unknown } = {},
): ChatPart {
  return {
    id,
    type: "tool",
    text: "",
    tool: {
      name,
      status,
      input,
      output: options.output ?? "",
      metadata: options.metadata,
      title: options.title,
      time: options.time,
    },
    raw: {},
  };
}

test("真实工具步骤转成面向用户的语义操作记录", () => {
  const operations = operationsFromParts([
    toolPart("read", "read", "completed", { filePath: "/workspace" }, {
      metadata: { display: { type: "directory", path: "/workspace", totalEntries: 3 } },
      time: { start: 1000, end: 1320 },
    }),
    toolPart("glob", "glob", "completed", { pattern: "**/*", path: "/workspace" }, {
      metadata: { count: 0 },
    }),
    toolPart("root", "read", "completed", { filePath: "/" }, {
      metadata: { display: { type: "directory", path: "/", totalEntries: 21 } },
    }),
  ], "system-ops");

  assert.equal(operations.length, 3);
  assert.deepEqual(operations[0], {
    id: "read",
    toolName: "read",
    kind: "read",
    status: "completed",
    label: "查看目录",
    target: "/workspace",
    result: "3 项",
    input: { filePath: "/workspace" },
    output: "",
    durationMs: 320,
    outsideWorkspace: false,
    changesState: false,
    externalAccess: false,
    skillName: null,
  });
  assert.equal(operations[1].label, "搜索文件或内容");
  assert.equal(operations[1].result, "0 个结果");
  assert.equal(operations[1].outsideWorkspace, false);
  assert.equal(operations[2].outsideWorkspace, true);
  assert.equal(operationsFromParts([
    toolPart("relative", "read", "completed", { filePath: "../private.txt" }),
  ])[0].outsideWorkspace, true);
  assert.equal(operationSummary(operations), "已完成 3 项操作");
  assert.deepEqual(operationCategories(operations).map(({ label, count }) => [label, count]), [
    ["查看", 2],
    ["搜索", 1],
  ]);
});

test("修改、命令和外部访问在摘要中保持醒目的类别", () => {
  const operations = operationsFromParts([
    toolPart("edit", "edit", "completed", { filePath: "/workspace/config.ts" }),
    toolPart("bash", "bash", "running", { command: "curl https://status.example.test", description: "Check status" }),
    toolPart("web", "webfetch", "pending", { url: "https://status.example.test" }),
  ]);

  assert.equal(operations[0].changesState, true);
  assert.equal(operations[1].changesState, true);
  assert.equal(operations[1].externalAccess, true);
  assert.equal(operations[1].target, "curl https://status.example.test");
  assert.equal(operations[2].kind, "network");
  assert.equal(operationSummary(operations), "正在执行 1 项操作");
  assert.deepEqual(operationCategories(operations).map(({ kind, emphasis }) => [kind, emphasis]), [
    ["change", "notice"],
    ["command", "notice"],
    ["network", "notice"],
  ]);
});

test("技能只在实际 tool part 出现时标记为按需使用，并去掉智能体前缀", () => {
  const [operation] = operationsFromParts([
    toolPart("skill", "skill", "completed", { name: "system-ops-diagnose" }, {
      output: "不应由展示模型解释为回答",
    }),
  ], "system-ops");

  assert.equal(operation.kind, "skill");
  assert.equal(operation.skillName, "diagnose");
  assert.equal(operation.target, "diagnose");
  assert.equal(toolDisplayName("skill"), "使用技能");
});

test("失败优先于仍在运行或等待的状态摘要", () => {
  const operations = operationsFromParts([
    toolPart("one", "read", "running", { filePath: "/workspace/a" }),
    toolPart("two", "bash", "error", { command: "false" }),
  ]);
  assert.equal(operationSummary(operations), "1 项操作失败");
});

test("常见、联网和扩展工具都能归入稳定类别", () => {
  assert.equal(operationKind("mcp.web-fetch"), "network");
  assert.equal(operationKind("webfetch"), "network");
  assert.equal(operationKind("apply_patch"), "change");
  assert.equal(operationKind("task"), "delegate");
  assert.equal(operationKind("shared-acceptance-probe_e2e_probe"), "integration");
  assert.equal(operationKind("custom_tool"), "other");
});
