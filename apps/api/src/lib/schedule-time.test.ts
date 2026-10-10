import assert from "node:assert/strict";
import test from "node:test";

import {
  nextScheduleOccurrence,
  normalizeScheduleRule,
  shanghaiLocalDateTime,
} from "@opshelper/shared";

test("一次任务按北京时间转换为 UTC，并拒绝过去时间", () => {
  assert.equal(
    shanghaiLocalDateTime("2026-09-15", "09:30").toISOString(),
    "2026-09-15T01:30:00.000Z",
  );
  assert.throws(
    () => normalizeScheduleRule(
      { frequency: "once", localDate: "2026-09-15", localTime: "09:30" },
      new Date("2026-09-15T01:30:00.000Z"),
    ),
    /晚于当前时间/,
  );
});

test("每日任务跨上海本地日期计算下一次时间", () => {
  const rule = { frequency: "daily" as const, localTime: "00:05" };
  assert.equal(
    nextScheduleOccurrence(rule, new Date("2026-12-31T15:59:00.000Z"))?.toISOString(),
    "2026-12-31T16:05:00.000Z",
  );
  assert.equal(
    nextScheduleOccurrence(rule, new Date("2026-12-31T16:06:00.000Z"))?.toISOString(),
    "2027-01-01T16:05:00.000Z",
  );
});

test("每周任务使用周一到周日并正确处理周日边界", () => {
  const sunday = { frequency: "weekly" as const, weekday: 7, localTime: "10:00" };
  assert.equal(
    nextScheduleOccurrence(sunday, new Date("2026-09-13T01:00:00.000Z"))?.toISOString(),
    "2026-09-13T02:00:00.000Z",
  );
  assert.equal(
    nextScheduleOccurrence(sunday, new Date("2026-09-13T03:00:00.000Z"))?.toISOString(),
    "2026-09-20T02:00:00.000Z",
  );
});

test("Crontab 规则按北京时间计算下一次时间", () => {
  const rule = {
    frequency: "cron" as const,
    cronExpression: "*/15 9-10 * * 1-5",
    localTime: "",
  };
  assert.equal(
    nextScheduleOccurrence(rule, new Date("2026-09-14T00:59:00.000Z"))?.toISOString(),
    "2026-09-14T01:00:00.000Z",
  );
  assert.equal(
    nextScheduleOccurrence(rule, new Date("2026-09-14T01:00:00.000Z"))?.toISOString(),
    "2026-09-14T01:15:00.000Z",
  );
});

test("计划规则不接受无效日期、时间、星期或 Crontab 表达式", () => {
  assert.throws(() => shanghaiLocalDateTime("2026-02-30", "10:00"), /日期无效/);
  assert.throws(
    () => nextScheduleOccurrence(
      { frequency: "weekly", weekday: 0, localTime: "10:00" },
      new Date(),
    ),
    /星期/,
  );
  assert.throws(
    () => nextScheduleOccurrence(
      { frequency: "daily", localTime: "24:00" },
      new Date(),
    ),
    /时间无效/,
  );
  assert.throws(
    () => normalizeScheduleRule(
      { frequency: "cron", cronExpression: "0 9 * *" },
      new Date(),
    ),
    /5 段格式/,
  );
  assert.throws(
    () => normalizeScheduleRule(
      { frequency: "cron", cronExpression: "H 9 * * *" },
      new Date(),
    ),
    /Crontab 表达式无效/,
  );
});
