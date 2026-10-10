import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

import { ScheduleServiceError } from "../lib/schedule-service";
import {
  registerScheduleRoutes,
  type ScheduleRouteServices,
} from "./schedules";

function services(overrides: Partial<ScheduleRouteServices> = {}): ScheduleRouteServices {
  return {
    requireSession: async () => ({ id: "owner-user", role: "user" }) as any,
    listSchedules: async () => ({ agents: [], schedules: [] }),
    getSchedule: async (_userId, scheduleId) => ({ schedule: { id: scheduleId }, runs: [] }) as any,
    getScheduleRunAnswer: async (_userId, _scheduleId, runId) => ({ runId, answer: null }),
    createSchedule: async () => ({ schedule: { id: "created" }, runs: [] }) as any,
    updateSchedule: async () => ({ schedule: { id: "updated" }, runs: [] }) as any,
    deleteSchedule: async () => undefined,
    pauseSchedule: async () => ({ schedule: { id: "paused" }, runs: [] }) as any,
    resumeSchedule: async () => ({ schedule: { id: "resumed" }, runs: [] }) as any,
    runScheduleNow: async () => ({ runId: "run", executionId: "execution", conversationId: "conversation" }),
    ...overrides,
  };
}

const validInput = {
  name: "每日检查",
  prompt: "检查入口状态并给出结论",
  leadAgentKey: "network",
  participantAgentKeys: ["system"],
  attachments: [],
  autoApprovePermissions: true,
  rule: { frequency: "daily", localTime: "09:30" },
};

test("定时任务接口只使用登录用户归属并拒绝多余权限字段", async () => {
  const calls: unknown[] = [];
  const app = Fastify();
  await registerScheduleRoutes(app, services({
    getSchedule: async (userId, scheduleId) => {
      calls.push(["get", userId, scheduleId]);
      return { schedule: { id: scheduleId }, runs: [] } as any;
    },
    createSchedule: async (userId, input) => {
      calls.push(["create", userId, input]);
      return { schedule: { id: "created" }, runs: [] } as any;
    },
    deleteSchedule: async (userId, scheduleId) => {
      calls.push(["delete", userId, scheduleId]);
    },
  }));
  try {
    assert.equal((await app.inject("/v1/me/schedules/schedule-a")).statusCode, 200);
    assert.deepEqual(calls[0], ["get", "owner-user", "schedule-a"]);

    const deleted = await app.inject({
      method: "DELETE",
      url: "/v1/me/schedules/schedule-a",
    });
    assert.equal(deleted.statusCode, 204);
    assert.deepEqual(calls[1], ["delete", "owner-user", "schedule-a"]);

    const forged = await app.inject({
      method: "POST",
      url: "/v1/me/schedules",
      payload: { ...validInput, userId: "other-user" },
    });
    assert.equal(forged.statusCode, 400);

    const valid = await app.inject({
      method: "POST",
      url: "/v1/me/schedules",
      payload: validInput,
    });
    assert.equal(valid.statusCode, 201);
    assert.equal((calls[2] as unknown[])[1], "owner-user");
    assert.equal(((calls[2] as unknown[])[2] as { autoApprovePermissions: boolean }).autoApprovePermissions, true);
  } finally {
    await app.close();
  }
});

test("删除定时任务时返回明确的执行冲突", async () => {
  const app = Fastify();
  await registerScheduleRoutes(app, services({
    deleteSchedule: async () => {
      throw new ScheduleServiceError("任务仍有正在进行的执行", 409);
    },
  }));
  try {
    const response = await app.inject({
      method: "DELETE",
      url: "/v1/me/schedules/schedule-a",
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().message, "任务仍有正在进行的执行");
  } finally {
    await app.close();
  }
});

test("接口接受 Crontab 频率，但仍拒绝自定义时区及无幂等标识的立即运行", async () => {
  const app = Fastify();
  await registerScheduleRoutes(app, services());
  try {
    const cron = await app.inject({
      method: "POST",
      url: "/v1/me/schedules",
      payload: {
        ...validInput,
        rule: { frequency: "cron", cronExpression: "0 9 * * 1-5" },
      },
    });
    assert.equal(cron.statusCode, 201);

    const customTimeZone = await app.inject({
      method: "POST",
      url: "/v1/me/schedules",
      payload: { ...validInput, timeZone: "UTC" },
    });
    assert.equal(customTimeZone.statusCode, 400);

    assert.equal((await app.inject({
      method: "POST",
      url: "/v1/me/schedules/schedule-a/runs",
      payload: {},
    })).statusCode, 400);

    assert.equal((await app.inject({
      method: "POST",
      url: "/v1/me/schedules/schedule-a/runs",
      payload: { requestKey: "request-12345678" },
    })).statusCode, 202);
  } finally {
    await app.close();
  }
});

test("结果弹窗回答接口按登录用户和任务归属读取", async () => {
  const calls: unknown[] = [];
  const app = Fastify();
  await registerScheduleRoutes(app, services({
    getScheduleRunAnswer: async (userId, scheduleId, runId) => {
      calls.push([userId, scheduleId, runId]);
      return { runId, answer: "模型回答" };
    },
  }));
  try {
    const response = await app.inject("/v1/me/schedules/schedule-a/runs/run-a/answer");
    assert.equal(response.statusCode, 200);
    assert.deepEqual(calls, [["owner-user", "schedule-a", "run-a"]]);
    assert.deepEqual(response.json(), { runId: "run-a", answer: "模型回答" });
  } finally {
    await app.close();
  }
});

test("结果弹窗回答接口对不存在的执行记录返回明确错误", async () => {
  const app = Fastify();
  await registerScheduleRoutes(app, services({
    getScheduleRunAnswer: async () => {
      throw new ScheduleServiceError("执行记录不存在", 404);
    },
  }));
  try {
    const response = await app.inject("/v1/me/schedules/schedule-a/runs/run-missing/answer");
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().message, "执行记录不存在");
  } finally {
    await app.close();
  }
});
