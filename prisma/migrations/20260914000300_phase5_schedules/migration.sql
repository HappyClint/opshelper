CREATE TYPE "ExecutionSource" AS ENUM ('CHAT', 'SCHEDULED', 'SCHEDULE_MANUAL');
CREATE TYPE "ScheduleFrequency" AS ENUM ('ONCE', 'DAILY', 'WEEKLY');
CREATE TYPE "ScheduleStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED');
CREATE TYPE "ScheduleRunTrigger" AS ENUM ('SCHEDULED', 'MANUAL');
CREATE TYPE "ScheduleRunDecision" AS ENUM ('ENQUEUED', 'SKIPPED');

CREATE TABLE "Schedule" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "prompt" TEXT NOT NULL,
  "leadAgentKey" TEXT NOT NULL,
  "participantAgentKeys" JSONB NOT NULL,
  "attachments" JSONB NOT NULL,
  "model" TEXT,
  "frequency" "ScheduleFrequency" NOT NULL,
  "localTime" TEXT NOT NULL,
  "weekday" INTEGER,
  "onceAt" TIMESTAMP(3),
  "timeZone" TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  "status" "ScheduleStatus" NOT NULL DEFAULT 'ACTIVE',
  "statusReason" TEXT,
  "nextRunAt" TIMESTAMP(3),
  "lastScheduledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Schedule_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Execution"
  ADD COLUMN "scheduleRunId" TEXT,
  ADD COLUMN "source" "ExecutionSource" NOT NULL DEFAULT 'CHAT',
  ADD COLUMN "actualAgentKeys" JSONB,
  ADD COLUMN "attachmentDigests" JSONB,
  ADD COLUMN "outputFiles" JSONB;

CREATE TABLE "ScheduleRun" (
  "id" TEXT NOT NULL,
  "scheduleId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "scheduledFor" TIMESTAMP(3) NOT NULL,
  "trigger" "ScheduleRunTrigger" NOT NULL,
  "decision" "ScheduleRunDecision" NOT NULL,
  "skipReason" TEXT,
  "missedThrough" TIMESTAMP(3),
  "missedCount" INTEGER NOT NULL DEFAULT 0,
  "scheduleSnapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScheduleRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Schedule_userId_status_nextRunAt_idx" ON "Schedule"("userId", "status", "nextRunAt");
CREATE INDEX "Schedule_status_nextRunAt_idx" ON "Schedule"("status", "nextRunAt");
CREATE UNIQUE INDEX "Execution_scheduleRunId_key" ON "Execution"("scheduleRunId");
CREATE UNIQUE INDEX "ScheduleRun_scheduleId_scheduledFor_key" ON "ScheduleRun"("scheduleId", "scheduledFor");
CREATE INDEX "ScheduleRun_userId_createdAt_idx" ON "ScheduleRun"("userId", "createdAt");
CREATE INDEX "ScheduleRun_scheduleId_createdAt_idx" ON "ScheduleRun"("scheduleId", "createdAt");

ALTER TABLE "Schedule"
  ADD CONSTRAINT "Schedule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Execution"
  ADD CONSTRAINT "Execution_scheduleRunId_fkey" FOREIGN KEY ("scheduleRunId") REFERENCES "ScheduleRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ScheduleRun"
  ADD CONSTRAINT "ScheduleRun_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "Schedule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
