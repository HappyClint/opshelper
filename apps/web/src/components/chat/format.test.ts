import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanTitle,
  formatConversationTime,
  formatConversationTimestamp,
  fullConversationTitle,
  messageHasContent,
  messageSignature,
} from "./format";
import type { ChatMessage, ChatPart } from "./message-model";

test("长会话标题的提示保留不同结尾，侧栏标签仍保持缩略", () => {
  const prefix = "排查生产服务连接超时，核对网络、代理、防火墙与服务端日志，记录处理结果：";
  const first = `${prefix}网络服务`;
  const second = `${prefix}系统服务`;

  assert.equal(fullConversationTitle(first), first);
  assert.equal(fullConversationTitle(second), second);
  assert.notEqual(fullConversationTitle(first), fullConversationTitle(second));
  assert.equal(cleanTitle(first), cleanTitle(second));
  assert.ok(cleanTitle(first).length < first.length);
  assert.ok(cleanTitle(first).endsWith("…"));
});

test("完整标题和缩略标题保留新会话的友好名称与短标题", () => {
  for (const title of ["New session - 2026-10-10T06:00:00Z", "new session"]) {
    assert.equal(fullConversationTitle(title), "新的对话");
    assert.equal(cleanTitle(title), "新的对话");
  }
  assert.equal(fullConversationTitle("检查 DNS 解析"), "检查 DNS 解析");
  assert.equal(cleanTitle("检查 DNS 解析"), "检查 DNS 解析");
});

function part(input: Partial<ChatPart>): ChatPart {
  return { id: "part", type: "text", text: "", raw: {}, ...input };
}

test("成功工具形成结构化操作记录，推理本身仍不可见", () => {
  const message: ChatMessage = {
    id: "message",
    role: "assistant",
    order: 1,
    parts: [
      part({ type: "reasoning", text: "内部推理" }),
      part({ tool: { name: "bash", status: "completed", input: {}, output: "ok" } }),
    ],
  };

  assert.equal(messageHasContent(message), true);
  assert.equal(messageHasContent({ ...message, parts: [part({ type: "reasoning", text: "内部推理" })] }), false);
});

test("工具失败仍保留在对话中", () => {
  const message: ChatMessage = {
    id: "message",
    role: "assistant",
    order: 1,
    parts: [part({ tool: { name: "bash", status: "failed", input: {}, output: "boom" } })],
  };

  assert.equal(messageHasContent(message), true);
});

test("消息签名包含正文和附件，供乐观消息去重", () => {
  const message: ChatMessage = {
    id: "message",
    role: "user",
    order: 1,
    parts: [
      part({ text: "检查服务" }),
      part({ type: "file", raw: { filename: "service.log" } }),
    ],
  };

  assert.equal(messageSignature(message), JSON.stringify({
    text: "检查服务",
    files: ["service.log"],
  }));
});

test("同日会话时间用于区分同名记录", () => {
  const now = new Date(2026, 8, 15, 23, 50);
  const value = new Date(2026, 8, 15, 23, 36).toISOString();

  assert.equal(formatConversationTime(value, now), "23:36");
});

test("侧栏时间列只显示时刻与日期，完整时间另给一份", () => {
  const now = new Date(2026, 8, 15, 23, 50);

  assert.equal(formatConversationTime(new Date(2026, 8, 15, 9, 5).toISOString(), now), "09:05");
  assert.equal(formatConversationTime(new Date(2026, 7, 2, 9, 5).toISOString(), now), "8/2");
  assert.equal(formatConversationTime("not-a-date", now), "");

  // 时间列宽度固定，所以两种写法的长度差异不能太大，否则标题可用宽度会跟着变。
  assert.equal(formatConversationTimestamp(new Date(2026, 8, 15, 23, 36).toISOString()), "2026年9月15日 23:36");
  assert.equal(formatConversationTimestamp("not-a-date"), "");
});
