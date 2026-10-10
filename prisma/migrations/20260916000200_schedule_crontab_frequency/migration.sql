ALTER TYPE "ScheduleFrequency" ADD VALUE 'CRON';

ALTER TABLE "Schedule" ADD COLUMN "cronExpression" TEXT;
