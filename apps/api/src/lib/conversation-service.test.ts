import assert from "node:assert/strict";
import test from "node:test";

import { ExecutionSource } from "@prisma/client";

import {
  collaborationDetail,
  nativeTaskPermissions,
  autoApprovePermissionRequests,
  pendingQuestion,
  assertConversationLeadMode,
  conversationLeadAgentWhere,
  conversationForkPoint,
  conversationHomeWhere,
  executionAnswerText,
  executionInteractionGuidance,
  executionPromptMarker,
  executionPromptPayload,
  executionUsesOutputDirectory,
  ownedConversationWhere,
  resolveExecutionPromptText,
  runtimeExecutionMarkers,
  sanitizeRuntimeMessages,
  summarizeMessage,
} from "./conversation-service";

test("V2 提示保留任意附件路径，但不把 ZIP、表格和二进制文件发送为模型附件", () => {
  const attachments = [
    { path: "/workspace/files/archive.zip", filename: "archive.zip", mime: "application/zip" },
    { path: "/workspace/files/report.xlsx", filename: "report.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
    { path: "/workspace/files/program.bin", filename: "program.bin", mime: "application/octet-stream" },
  ];
  const payload = executionPromptPayload({
    id: "execution-files", inputText: "检查附件", source: ExecutionSource.CHAT,
    attachments, promptMarker: "prompt-files",
  });

  assert.deepEqual(payload.files, []);
  for (const file of attachments) assert.ok(payload.text.includes(`${file.filename}（${file.path}）`));
  assert.ok(payload.text.includes("检查附件"));
  assert.ok(payload.text.includes(executionPromptMarker("prompt-files")));
  assert.equal(payload.id, "msg_opshelper_promptfiles");
  assert.equal(payload.delivery, "queue");
});

test("V2 混合附件仅将图片、文本和 PDF 加入模型载荷，所有路径仍可用于工具读取", () => {
  const attachments = [
    { path: "/workspace/files/photo.png", filename: "photo.png", mime: "image/png" },
    { path: "/workspace/files/archive.zip", filename: "archive.zip", mime: "application/zip" },
    { path: "/workspace/files/notes.txt", filename: "notes.txt", mime: "text/plain" },
    { path: "/workspace/files/report.pdf", filename: "report.pdf", mime: "application/pdf" },
  ];
  const payload = executionPromptPayload({
    id: "execution-mixed", inputText: "检查附件", source: ExecutionSource.CHAT,
    attachments, promptMarker: "prompt-mixed",
  });

  assert.deepEqual(payload.files, [
    { uri: "file:///workspace/files/photo.png", name: "photo.png" },
    { uri: "file:///workspace/files/notes.txt", name: "notes.txt" },
    { uri: "file:///workspace/files/report.pdf", name: "report.pdf" },
  ]);
  for (const file of attachments) assert.ok(payload.text.includes(file.path));
});

test("V2 无附件提示维持空文件列表", () => {
  const payload = executionPromptPayload({
    id: "execution-text", inputText: "你好", source: ExecutionSource.CHAT,
    attachments: [], promptMarker: "prompt-text",
  });
  assert.deepEqual(payload.files, []);
  assert.ok(payload.text.startsWith("你好"));
  assert.ok(!payload.text.includes("我上传了以下文件"));
});

test("V2 文件夹引用会作为工作区路径提示，而不会作为文件载荷发送", () => {
  const payload = executionPromptPayload({
    id: "execution-directory",
    inputText: "检查目录",
    source: ExecutionSource.CHAT,
    attachments: [{ path: "/workspace/docs", filename: "docs", mime: "inode/directory" }],
    promptMarker: "prompt-directory",
  });

  assert.deepEqual(payload.files, []);
  assert.ok(payload.text.includes("文件或文件夹"));
  assert.ok(payload.text.includes("docs（/workspace/docs）"));
});

test("会话分支边界只接受当前历史里的用户消息，包括附件消息", () => {
  const messages = [
    { info: { id: "msg-first", role: "user" }, parts: [{ type: "text", text: "前文" }] },
    { info: { id: "msg-answer", role: "assistant" }, parts: [{ type: "text", text: "回答" }] },
    { info: { id: "msg-file", role: "user" }, parts: [{ type: "file", url: "file:///workspace/a.txt" }] },
  ];
  assert.equal(conversationForkPoint(messages, "msg-first").index, 0);
  assert.equal(conversationForkPoint(messages, "msg-file").index, 2);
  assert.throws(() => conversationForkPoint(messages, "msg-answer"), /用户消息/);
  assert.throws(() => conversationForkPoint(messages, "optimistic-new"), /用户消息/);
  assert.throws(() => conversationForkPoint(messages, "msg-foreign"), /用户消息/);
});

test("分支的新消息编号仍可通过原执行标记恢复用户输入和附件", () => {
  const messages = [
    { info: { id: "msg-new-id", role: "user" }, parts: [{ type: "text", text: `原生内部提示\n${executionPromptMarker("old-marker")}` }] },
    { info: { id: "msg-answer", role: "assistant" }, parts: [{ type: "text", text: `回答 ${executionPromptMarker("forged-marker")}` }] },
  ];
  assert.deepEqual(runtimeExecutionMarkers(messages), ["old-marker"]);
  const inherited = { id: "old-execution", inputText: "实际输入", attachments: [{ path: "/workspace/a.txt", filename: "a.txt", mime: "text/plain" }], promptMarker: "old-marker" };
  const sanitized = sanitizeRuntimeMessages(messages, [inherited]) as any[];
  assert.equal(sanitized[0].info.id, "msg-new-id");
  assert.equal(sanitized[0].parts[0].text, "实际输入");
  assert.equal(sanitized[0].parts[1].url, "file:///workspace/a.txt");
  assert.ok(!JSON.stringify(sanitized).includes("opshelper-execution:"));
});

test("自动授权只处理当前执行会话并对临时失败重试", async () => {
  const calls: Array<[string, string]> = [];
  let attempts = 0;
  const result = await autoApprovePermissionRequests({
    executionId: "execution-1",
    permissions: [
      { id: "permission-owned", sessionID: "child-owned" },
      { id: "permission-foreign", sessionID: "child-foreign" },
    ],
    allowedSessionIds: new Set(["root-owned", "child-owned"]),
    retryDelaysMs: [0, 0],
    reply: async (sessionId, permissionId) => {
      calls.push([sessionId, permissionId]);
      attempts += 1;
      if (attempts === 1) throw new Error("temporary failure");
    },
  });

  assert.deepEqual(result, { resolved: 1, failed: 0 });
  assert.deepEqual(calls, [
    ["child-owned", "permission-owned"],
    ["child-owned", "permission-owned"],
  ]);
});

test("主对话智能体列表排除 subagent，服务端也拒绝其作为 lead", () => {
  assert.deepEqual(conversationLeadAgentWhere("user-1"), {
    userId: "user-1",
    agent: { isEnabled: true, checkStatus: "READY", mode: { not: "subagent" } },
  });
  assert.doesNotThrow(() => assertConversationLeadMode("primary"));
  assert.doesNotThrow(() => assertConversationLeadMode("all"));
  assert.throws(() => assertConversationLeadMode("subagent"), /不能作为主智能体/);
});

test("用户会话列表排除计划触发和手动触发的定时任务会话", () => {
  assert.deepEqual(conversationHomeWhere("user-1"), {
    userId: "user-1",
    archivedAt: null,
    executions: {
      none: {
        source: {
          in: [ExecutionSource.SCHEDULED, ExecutionSource.SCHEDULE_MANUAL],
        },
      },
    },
  });
});

test("归档的对话仍可按 id 读取：归档只影响会话列表", () => {
  const where = ownedConversationWhere("user-1", "conversation-1");
  assert.deepEqual(where, { id: "conversation-1", userId: "user-1" });
  assert.equal("archivedAt" in where, false);
});

test("普通说明性对话要求直接简洁回答，定时任务不追加该约束", () => {
  assert.match(executionInteractionGuidance(ExecutionSource.CHAT), /不要先检查工作区/);
  assert.match(executionInteractionGuidance(ExecutionSource.CHAT), /3 至 6 个要点/);
  assert.equal(executionInteractionGuidance(ExecutionSource.SCHEDULED), "");
});

test("普通对话不解释或准备定时任务输出目录变量", () => {
  const input = "解释 {{output_dir}} 的含义";
  assert.equal(executionUsesOutputDirectory(input, ExecutionSource.CHAT), false);
  assert.equal(
    resolveExecutionPromptText(input, ExecutionSource.CHAT, "execution-1"),
    input,
  );
});

test("定时任务只在用户明确写入变量时使用输出目录", () => {
  assert.equal(
    executionUsesOutputDirectory("保存到 {{output_dir}}/report.md", ExecutionSource.SCHEDULED),
    true,
  );
  assert.equal(
    executionUsesOutputDirectory("只返回检查结论", ExecutionSource.SCHEDULED),
    false,
  );
  assert.equal(
    executionUsesOutputDirectory("保存到 {{output_dir}}/report.md", ExecutionSource.SCHEDULE_MANUAL),
    true,
  );
  assert.equal(
    resolveExecutionPromptText(
      "生成报告并保存到 {{output_dir}}/report.md，同时记录目录 {{output_dir}}。",
      ExecutionSource.SCHEDULED,
      "execution-2",
    ),
    "生成报告并保存到 outputs/execution-2/report.md，同时记录目录 outputs/execution-2。",
  );
  assert.equal(
    resolveExecutionPromptText("只返回检查结论", ExecutionSource.SCHEDULE_MANUAL, "execution-3"),
    "只返回检查结论",
  );
});

test("内部执行标记和原生会话标识不会返回浏览器", () => {
  const marker = executionPromptMarker("9be2de30-2ee5-4f11-9117-c0d920320ee8");
  const sanitized = sanitizeRuntimeMessages([
    {
      info: {
        id: "message-public",
        role: "user",
        sessionID: "native-secret",
        parentID: "native-parent",
      },
      parts: [
        { id: "part-1", type: "text", text: `检查网络\n\n${marker}` },
        { id: "part-2", type: "tool", state: { sessionId: "native-child", status: "completed" } },
      ],
    },
  ]) as Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>;

  assert.equal(sanitized[0].info.sessionID, undefined);
  assert.equal(sanitized[0].info.parentID, undefined);
  assert.equal(sanitized[0].parts[0].text, "检查网络");
  assert.equal((sanitized[0].parts[1].state as Record<string, unknown>).sessionId, undefined);
  assert.doesNotMatch(JSON.stringify(sanitized), /native-secret|opshelper-execution/);
});

test("只删除平台自己的执行标记，不改写普通 HTML 注释", () => {
  const sanitized = sanitizeRuntimeMessages([
    {
      info: { id: "m1", role: "assistant" },
      parts: [{ id: "p1", type: "text", text: "结论<!-- customer-note:keep -->" }],
    },
  ]) as Array<{ parts: Array<{ text: string }> }>;
  assert.equal(sanitized[0].parts[0].text, "结论<!-- customer-note:keep -->");
});

test("浏览器获得真实工具状态，但不获得推理、技能说明或敏感参数", () => {
  const sanitized = sanitizeRuntimeMessages([
    {
      info: { id: "m1", role: "assistant", sessionID: "native-secret" },
      parts: [
        { id: "reasoning", type: "reasoning", text: "内部思考" },
        {
          id: "skill",
          type: "tool",
          tool: "skill",
          state: {
            status: "completed",
            input: { name: "system-ops-diagnose", apiKey: "secret-key" },
            output: "完整的技能系统指引",
            metadata: { source: "/managed/skills/diagnose/SKILL.md" },
          },
        },
        {
          id: "read",
          type: "tool",
          tool: "read",
          state: {
            status: "completed",
            input: { filePath: "/workspace/report.txt", password: "secret-password", token: "secret-token" },
            output: "用户文件内容",
          },
        },
      ],
    },
  ]) as Array<{ parts: Array<Record<string, any>> }>;

  assert.deepEqual(sanitized[0].parts.map((part) => part.id), ["skill", "read"]);
  assert.equal(sanitized[0].parts[0].state.status, "completed");
  assert.equal(sanitized[0].parts[0].state.input.name, "system-ops-diagnose");
  assert.equal(sanitized[0].parts[0].state.input.apiKey, "[已隐藏]");
  assert.equal(sanitized[0].parts[0].state.output, undefined);
  assert.equal(sanitized[0].parts[0].state.metadata, undefined);
  assert.equal(sanitized[0].parts[1].state.input.password, "[已隐藏]");
  assert.equal(sanitized[0].parts[1].state.input.token, "[已隐藏]");
  assert.equal(sanitized[0].parts[1].state.output, "用户文件内容");
  assert.doesNotMatch(JSON.stringify(sanitized), /内部思考|技能系统指引|secret-key|secret-password|secret-token|native-secret/);
});

test("浏览器只看到用户原始输入，不显示运行时追加的内部说明", () => {
  const promptMarker = "16ad0c57-a687-4a28-89d4-1eafac39b30b";
  const marker = executionPromptMarker(promptMarker);
  const sanitized = sanitizeRuntimeMessages([
    {
      info: { id: "message-user", role: "user", sessionID: "native-secret" },
      parts: [{
        id: "part-user",
        type: "text",
        text: `介绍一下你能做什么\n\n如需保留结果文件，请直接写入已准备好的相对目录 outputs/private/，无需创建该目录。\n\n${marker}`,
      }],
    },
  ], [{
    id: "execution-1",
    inputText: "介绍一下你能做什么",
    attachments: [],
    promptMarker,
  }]) as Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>;

  assert.equal(sanitized[0].info.sessionID, undefined);
  assert.deepEqual(sanitized[0].parts, [{
    id: "part-user",
    type: "text",
    text: "介绍一下你能做什么",
  }]);
  assert.doesNotMatch(JSON.stringify(sanitized), /outputs\/private|opshelper-execution/);
});

test("用户自己输入与内部说明相同的文字时仍完整保留", () => {
  const promptMarker = "3f263d4a-b2e0-4c58-bfb5-f2d869a1f8ad";
  const inputText = "请说明：如需保留结果文件，应该怎么做？";
  const sanitized = sanitizeRuntimeMessages([
    {
      info: { id: "message-user", role: "user" },
      parts: [{
        id: "part-user",
        type: "text",
        text: `${inputText}\n\n内部输出目录 outputs/private/\n\n${executionPromptMarker(promptMarker)}`,
      }],
    },
  ], [{
    id: "execution-2",
    inputText,
    attachments: [{ path: "/workspace/report.txt", filename: "report.txt", mime: "text/plain" }],
    promptMarker,
  }]) as Array<{ parts: Array<Record<string, unknown>> }>;

  assert.equal(sanitized[0].parts[0].text, inputText);
  assert.deepEqual(sanitized[0].parts[1], {
    id: "opshelper-attachment-execution-2-0",
    type: "file",
    mime: "text/plain",
    filename: "report.txt",
    url: "file:///workspace/report.txt",
  });
});

test("浏览器不显示当前执行的内部输出目录，普通用户文字不被误改", () => {
  const promptMarker = "4eb6da71-888d-4625-a55a-2605ddf7a24e";
  const executionId = "execution-private";
  const sanitized = sanitizeRuntimeMessages([
    {
      info: { id: "message-user", role: "user" },
      parts: [{
        id: "part-user",
        type: "text",
        text: `生成报告\n\n${executionPromptMarker(promptMarker)}`,
      }],
    },
    {
      info: { id: "message-assistant", role: "assistant", parentID: "message-user" },
      parts: [{
        id: "part-assistant",
        type: "text",
        text: `报告已保存到 outputs/${executionId}/report.md，绝对目录为 /workspace/outputs/${executionId}/。`,
      }],
    },
    {
      info: { id: "plain-user", role: "user" },
      parts: [{ id: "plain-part", type: "text", text: `请解释 outputs/${executionId}` }],
    },
  ], [{
    id: executionId,
    inputText: "生成报告",
    attachments: [],
    promptMarker,
  }]) as Array<{ parts: Array<{ text: string }> }>;

  assert.equal(sanitized[1].parts[0].text, "报告已保存到 结果文件/report.md，绝对目录为 结果文件/。");
  assert.equal(sanitized[2].parts[0].text, `请解释 outputs/${executionId}`);
  assert.doesNotMatch(JSON.stringify(sanitized[1]), new RegExp(executionId));
});

test("执行结果只保留模型回答，不包含推理内容", () => {
  const message = {
    info: { id: "assistant-1", role: "assistant" },
    parts: [
      { id: "reasoning-1", type: "reasoning", text: "先判断用户想要什么。" },
      { id: "text-1", type: "text", text: "入口检查通过，无需处理。" },
    ],
  };
  assert.equal(summarizeMessage(message), "入口检查通过，无需处理。");
  assert.equal(summarizeMessage({ parts: [{ type: "reasoning", text: "只有推理" }] }), null);
});

test("结果弹窗保留较长回答，协作摘要仍保持简短", () => {
  const answer = "x".repeat(5000);
  const message = { info: { role: "assistant" }, parts: [{ type: "text", text: answer }] };
  assert.equal(summarizeMessage(message, 8000), answer);
  assert.equal(summarizeMessage(message)?.length, 1200);
});

test("历史执行回答按对话页规则重新提取：不含推理，也不泄漏内部输出目录", () => {
  const promptMarker = "7c1f2b4e-2a91-4a0f-9f4d-0f8f0c4b7f31";
  const executionId = "execution-history";
  const messages = [
    {
      info: { id: "message-user", role: "user" },
      parts: [{
        id: "part-user",
        type: "text",
        text: `123\n\n如需保留结果文件，请直接写入已准备好的相对目录 outputs/${executionId}/，无需创建该目录。\n\n${executionPromptMarker(promptMarker)}`,
      }],
    },
    {
      info: { id: "message-assistant-1", role: "assistant", parentID: "message-user" },
      parts: [
        { id: "step", type: "step-start" },
        { id: "reasoning", type: "reasoning", text: "模型内部推理，不应展示。" },
        { id: "text", type: "text", text: `请问写入 outputs/${executionId}/ 下的哪个文件？` },
      ],
    },
    {
      info: { id: "later-user", role: "user" },
      parts: [{ id: "later", type: "text", text: "后面的对话" }],
    },
  ];

  assert.equal(
    executionAnswerText(messages, { id: executionId, promptMarker }),
    "请问写入 结果文件/ 下的哪个文件？",
  );
});

test("历史执行没有可展示回答时返回空，交由页面沿用已保存内容", () => {
  const promptMarker = "2a5c3d7e-8c1b-4c2d-9e3f-5b6a7c8d9e0f";
  const messages = [
    {
      info: { id: "message-user", role: "user" },
      parts: [{ id: "part-user", type: "text", text: `你好\n\n${executionPromptMarker(promptMarker)}` }],
    },
    {
      info: { id: "message-assistant", role: "assistant", parentID: "message-user" },
      parts: [{ id: "reasoning", type: "reasoning", text: "只有推理" }],
    },
  ];
  assert.equal(executionAnswerText(messages, { id: "execution-empty", promptMarker }), null);
  assert.equal(executionAnswerText([], { id: "execution-empty", promptMarker }), null);
});

const childState = () => ({
  rootMessages: [],
  children: [{ session: { id: "child-a", parentID: "root-owned", title: "问候" }, status: "busy", messages: [
    { info: { id: "m-child", sessionID: "child-a", role: "assistant", agent: "network-ops" }, parts: [{ type: "text", text: "你好" }] },
  ] }],
  statuses: {},
  questions: [{ id: "q-a", sessionID: "child-a", questions: [{ header: "URL", question: "请输入 URL", options: [] }] }],
  permissions: [],
  sessionIds: new Set(["root-owned", "child-a"]),
});

test("自由输入问题省略 custom 时仍提供回答入口，显式 false 保留", () => {
  const state = childState();
  assert.equal(pendingQuestion(state)?.questions[0].custom, true);
  state.questions[0].questions[0] = { ...state.questions[0].questions[0], custom: false } as any;
  assert.equal(pendingQuestion(state)?.questions[0].custom, false);
});

test("子会话详情只接受所属会话树中的排障编号并清理原生 ID", async () => {
  const { createHash } = await import("node:crypto");
  const trace = createHash("sha256").update("child-a").digest("hex").slice(0, 12);
  const state = childState();
  state.questions.unshift({ id: "q-other", sessionID: "other-child", questions: [] });
  const detail = collaborationDetail(state, trace);
  assert.equal(detail.collaboration.agentKey, "network-ops");
  assert.equal(detail.collaboration.status, "waiting_input");
  assert.equal(detail.autoApprovePermissions, false);
  assert.equal(detail.pendingQuestion?.id, "q-a");
  assert.match(JSON.stringify(detail.messages), /你好/);
  assert.doesNotMatch(JSON.stringify(detail.messages), /child-a/);
  assert.throws(() => collaborationDetail(state, "000000000000"), /子智能体会话不存在/);
});

test("V2 会话 subagent 权限默认禁止，仅明确允许已分配的协作智能体", () => {
  assert.deepEqual(nativeTaskPermissions({ agentKeys: ["lead", "sub"], taskAgentKeys: ["sub"] }), [
    { action: "subagent", resource: "*", effect: "deny" },
    { action: "subagent", resource: "sub", effect: "allow" },
  ]);
});

test("旧清单缺少可委派列表时不会允许 primary 委派", () => {
  assert.equal(nativeTaskPermissions({ agentKeys: ["lead"] })[0].effect, "deny");
});
