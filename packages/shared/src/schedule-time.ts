import { CronExpressionParser } from "cron-parser";

export const SHANGHAI_TIME_ZONE = "Asia/Shanghai" as const;
export const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

export type ScheduleRule =
  | { frequency: "once"; localDate: string; localTime: string }
  | { frequency: "daily"; localTime: string }
  | { frequency: "weekly"; weekday: number; localTime: string }
  | { frequency: "cron"; cronExpression: string };

export interface StoredScheduleRule {
  frequency: "once" | "daily" | "weekly" | "cron";
  localTime: string;
  weekday?: number | null;
  onceAt?: Date | string | null;
  cronExpression?: string | null;
}

export function normalizeCronExpression(value: string) {
  const expression = value.trim().replace(/\s+/g, " ");
  if (expression.split(" ").length !== 5 || /\bH(?:\b|\()/i.test(expression)) {
    throw new Error("Crontab 表达式无效，请使用 5 段格式：分 时 日 月 周");
  }
  try {
    CronExpressionParser.parse(expression, { tz: SHANGHAI_TIME_ZONE });
  } catch {
    throw new Error("Crontab 表达式无效，请使用 5 段格式：分 时 日 月 周");
  }
  return expression;
}

function nextCronOccurrence(expression: string, after: Date) {
  try {
    return CronExpressionParser.parse(expression, {
      currentDate: after,
      tz: SHANGHAI_TIME_ZONE,
    }).next().toDate();
  } catch {
    throw new Error("Crontab 表达式无效，请使用 5 段格式：分 时 日 月 周");
  }
}

function parseTime(localTime: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(localTime);
  if (!match) throw new Error("时间格式必须为 HH:mm");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error("时间无效");
  return { hour, minute };
}

export function shanghaiLocalDateTime(localDate: string, localTime: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) throw new Error("日期格式必须为 YYYY-MM-DD");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const { hour, minute } = parseTime(localTime);
  const localAsUtc = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (
    localAsUtc.getUTCFullYear() !== year ||
    localAsUtc.getUTCMonth() !== month - 1 ||
    localAsUtc.getUTCDate() !== day
  ) {
    throw new Error("日期无效");
  }
  return new Date(localAsUtc.getTime() - SHANGHAI_OFFSET_MS);
}

function localParts(value: Date) {
  const shifted = new Date(value.getTime() + SHANGHAI_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay() || 7,
  };
}

function localCandidate(value: Date, dayOffset: number, localTime: string) {
  const { hour, minute } = parseTime(localTime);
  const parts = localParts(value);
  return new Date(
    Date.UTC(parts.year, parts.month, parts.day + dayOffset, hour, minute) -
      SHANGHAI_OFFSET_MS,
  );
}

export function nextScheduleOccurrence(rule: StoredScheduleRule, after: Date) {
  if (rule.frequency === "once") {
    const onceAt = rule.onceAt ? new Date(rule.onceAt) : null;
    return onceAt && !Number.isNaN(onceAt.getTime()) && onceAt > after ? onceAt : null;
  }

  if (rule.frequency === "daily") {
    const today = localCandidate(after, 0, rule.localTime);
    return today > after ? today : localCandidate(after, 1, rule.localTime);
  }

  if (rule.frequency === "cron") {
    return nextCronOccurrence(normalizeCronExpression(rule.cronExpression ?? ""), after);
  }

  const weekday = rule.weekday;
  if (!Number.isInteger(weekday) || weekday! < 1 || weekday! > 7) {
    throw new Error("星期必须为 1 到 7");
  }
  const currentWeekday = localParts(after).weekday;
  let offset = weekday! - currentWeekday;
  if (offset < 0) offset += 7;
  let candidate = localCandidate(after, offset, rule.localTime);
  if (candidate <= after) candidate = localCandidate(after, offset + 7, rule.localTime);
  return candidate;
}

export function normalizeScheduleRule(rule: ScheduleRule, now = new Date()) {
  const localTime = rule.frequency === "cron" ? "" : rule.localTime.trim();
  if (rule.frequency !== "cron") parseTime(localTime);
  const onceAt = rule.frequency === "once"
    ? shanghaiLocalDateTime(rule.localDate, localTime)
    : null;
  const stored: StoredScheduleRule = {
    frequency: rule.frequency,
    localTime,
    weekday: rule.frequency === "weekly" ? rule.weekday : null,
    onceAt,
    cronExpression: rule.frequency === "cron"
      ? normalizeCronExpression(rule.cronExpression)
      : null,
  };
  const nextRunAt = nextScheduleOccurrence(stored, now);
  if (!nextRunAt) throw new Error("一次任务的执行时间必须晚于当前时间");
  return { ...stored, nextRunAt };
}

export function formatShanghaiDateTime(value: Date | string | null | undefined) {
  if (!value) return "暂无";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: SHANGHAI_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}
