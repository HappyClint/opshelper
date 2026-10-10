ALTER TABLE "Agent"
ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'all';

ALTER TABLE "Agent"
ADD CONSTRAINT "Agent_mode_check"
CHECK ("mode" IN ('primary', 'subagent', 'all'));
