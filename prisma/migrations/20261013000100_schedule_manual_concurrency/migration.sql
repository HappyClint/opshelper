-- Only a natural scheduled occurrence is unique by its due time. Independent
-- manual requests may legitimately arrive during the same millisecond.
CREATE UNIQUE INDEX "ScheduleRun_scheduled_occurrence_key"
  ON "ScheduleRun" ("scheduleId", "scheduledFor")
  WHERE "trigger" = 'SCHEDULED';

DROP INDEX "ScheduleRun_scheduleId_scheduledFor_key";
CREATE INDEX "ScheduleRun_scheduleId_scheduledFor_idx"
  ON "ScheduleRun" ("scheduleId", "scheduledFor");
