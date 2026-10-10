import assert from "node:assert/strict";
import test from "node:test";

import { groupConversationTurns, turnErrors, turnParts } from "./conversation-turns";
import type { ChatMessage } from "./message-model";

function message(id: string, role: ChatMessage["role"], type: string, text = ""): ChatMessage {
  return {
    id,
    role,
    order: Number(id.replace(/\D/g, "")) || 0,
    parts: [{ id: `${id}-part`, type, text, raw: {} }],
  };
}

test("连续工具消息和最终回答合并为同一轮助手卡片", () => {
  const messages = [
    message("user-1", "user", "text", "查看项目"),
    message("assistant-1", "assistant", "tool"),
    message("assistant-2", "assistant", "tool"),
    message("assistant-3", "assistant", "text", "检查完成"),
    message("user-2", "user", "text", "下一问"),
    message("assistant-4", "assistant", "text", "下一答"),
  ];
  messages[1].parts[0].tool = { name: "read", status: "completed", input: {}, output: "" };
  messages[2].parts[0].tool = { name: "glob", status: "completed", input: {}, output: "" };

  const turns = groupConversationTurns(messages);
  assert.deepEqual(turns.map((turn) => [turn.role, turn.messages.length]), [
    ["user", 1],
    ["assistant", 3],
    ["user", 1],
    ["assistant", 1],
  ]);
  assert.equal(turns[1].key, "assistant-1");
  assert.deepEqual(turnParts(turns[1]).map((part) => part.id), [
    "assistant-1-part",
    "assistant-2-part",
    "assistant-3-part",
  ]);
});

test("助手消息错误随合并后的回答轮保留", () => {
  const first = message("assistant-1", "assistant", "tool");
  const second = message("assistant-2", "assistant", "text", "稍后重试");
  first.error = { message: "工具失败" };
  second.error = "回答失败";
  const [turn] = groupConversationTurns([first, second]);
  assert.deepEqual(turnErrors(turn), [{ message: "工具失败" }, "回答失败"]);
});
