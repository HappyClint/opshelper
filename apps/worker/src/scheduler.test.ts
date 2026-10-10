import assert from "node:assert/strict";
import test from "node:test";
import type { Schedule } from "@prisma/client";

import { missedWindow } from "./index";

function dailySchedule(): Schedule {
  return {
    id: "schedule",
    userId: "user",
    name: "每日检查",
    prompt: "检查",
    leadAgentKey: "network",
    participantAgentKeys: [],
    attachments: [],
    model: null,
    autoApprovePermissions: false,
    frequency: "DAILY",
    localTime: "09:00",
    weekday: null,
    onceAt: null,
    cronExpression: null,
    timeZone: "Asia/Shanghai",
    status: "ACTIVE",
    statusReason: null,
    nextRunAt: null,
    lastScheduledAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

test("worker 将连续停机漏点汇总成一条范围记录", () => {
  const result = missedWindow(
    dailySchedule(),
    new Date("2026-09-10T01:00:00.000Z"),
    new Date("2026-09-13T01:01:00.000Z"),
  );
  assert.equal(result.count, 4);
  assert.equal(result.through.toISOString(), "2026-09-13T01:00:00.000Z");
});
