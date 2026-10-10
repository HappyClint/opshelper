-- Deleting a schedule removes its schedule-run history. Executions retain their
-- conversations and are detached through Execution.scheduleRunId ON DELETE SET NULL.
ALTER TABLE "ScheduleRun" DROP CONSTRAINT "ScheduleRun_scheduleId_fkey";

ALTER TABLE "ScheduleRun"
ADD CONSTRAINT "ScheduleRun_scheduleId_fkey"
FOREIGN KEY ("scheduleId") REFERENCES "Schedule"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
