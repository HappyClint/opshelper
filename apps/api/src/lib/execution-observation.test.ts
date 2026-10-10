import assert from "node:assert/strict";
import test from "node:test";

import {
  assistantError,
  currentExecutionMessages,
  isFinalAssistant,
  latestCurrentAssistant,
} from "./execution-observation";

function user(id: string, text: string) {
  return { info: { id, role: "user" }, parts: [{ type: "text", text }] };
}

function assistant(
  id: string,
  parentID: string,
  options: { completed?: number; finish?: string; error?: unknown; text?: string } = {},
) {
  return {
    info: {
      id,
      parentID,
      role: "assistant",
      time: { created: 1, ...(options.completed === undefined ? {} : { completed: options.completed }) },
      ...(options.finish === undefined ? {} : { finish: options.finish }),
      ...(options.error === undefined ? {} : { error: options.error }),
    },
    parts: [{ type: "text", text: options.text ?? "" }],
  };
}

test("当前执行只包含 marker 用户消息对应的 assistant，旧 turn 错误不会混入", () => {
  const oldMarker = "<!-- opshelper-execution:old -->";
  const marker = "<!-- opshelper-execution:current -->";
  const oldError = assistant("a-old", "u-old", {
    error: { name: "APIError" },
    text: "旧执行失败",
  });
  const currentAnswer = assistant("a-current", "u-current", {
    completed: 20,
    finish: "stop",
    text: "本轮成功",
  });
  const messages = [
    user("u-old", `旧任务\n${oldMarker}`),
    oldError,
    user("u-current", `新任务\n${marker}`),
    currentAnswer,
  ];

  assert.deepEqual(currentExecutionMessages(messages, marker), [currentAnswer]);
  assert.equal(latestCurrentAssistant(messages, marker), currentAnswer);
  assert.equal(assistantError(latestCurrentAssistant(messages, marker)), null);
  assert.equal(isFinalAssistant(latestCurrentAssistant(messages, marker)), true);
});

test("parentID 不匹配的后续 assistant 不属于当前执行", () => {
  const marker = "<!-- opshelper-execution:current -->";
  const currentAnswer = assistant("a-current", "u-current", {
    completed: 20,
    finish: "stop",
  });
  const laterAnswer = assistant("a-later", "u-later", {
    completed: 40,
    finish: "stop",
  });
  const messages = [
    user("u-current", marker),
    currentAnswer,
    user("u-later", "后续任务"),
    laterAnswer,
  ];

  assert.deepEqual(currentExecutionMessages(messages, marker), [currentAnswer]);
  assert.equal(latestCurrentAssistant(messages, marker), currentAnswer);
});

test("未完成 assistant 和 tool-calls 中间步骤都不是最终回复", () => {
  assert.equal(isFinalAssistant(assistant("a-empty", "u-current")), false);
  assert.equal(isFinalAssistant(assistant("a-no-finish", "u-current", { completed: 20 })), false);
  assert.equal(isFinalAssistant(assistant("a-no-time", "u-current", { finish: "stop" })), false);
  assert.equal(isFinalAssistant(assistant("a-tool", "u-current", {
    completed: 20,
    finish: "tool-calls",
  })), false);
});

test("精确 parentID 且完整持久化的非工具调用 assistant 是最终回复", () => {
  const message = assistant("a-final", "u-current", {
    completed: 20,
    finish: "stop",
    text: "完成",
  });

  assert.equal(isFinalAssistant(message), true);
});

test("显式 assistant error 是保守的失败终态", () => {
  const error = { name: "ProviderAuthError" };
  const message = assistant("a-error", "u-current", { error });

  assert.equal(isFinalAssistant(message), true);
  assert.equal(assistantError(message), error);
});

test("缺少 marker、用户消息 id 或数组结构时不猜测归属", () => {
  const marker = "<!-- opshelper-execution:current -->";
  assert.deepEqual(currentExecutionMessages([], marker), []);
  assert.deepEqual(currentExecutionMessages([user("u-current", "普通消息")], ""), []);
  assert.deepEqual(currentExecutionMessages([
    { info: { role: "user" }, parts: [{ type: "text", text: marker }] },
    assistant("a-current", "u-current", { completed: 20, finish: "stop" }),
  ], marker), []);
  assert.deepEqual(currentExecutionMessages([null, "bad", []], marker), []);
});
