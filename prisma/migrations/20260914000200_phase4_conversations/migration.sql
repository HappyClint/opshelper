CREATE TYPE "ExecutionStatus" AS ENUM (
  'QUEUED',
  'DISPATCHING',
  'RUNNING',
  'WAITING_INPUT',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'INTERRUPTED'
);

ALTER TABLE "ContainerInstance"
  ADD COLUMN "activeExecutionId" TEXT,
  ADD COLUMN "executionLeaseOwner" TEXT,
  ADD COLUMN "executionLeaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "executionRecoveryRequired" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "executionRecoveryReason" TEXT;

CREATE TABLE "Conversation" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "nativeSessionId" TEXT,
  "sessionCreateAttemptId" TEXT,
  "title" TEXT NOT NULL,
  "lastAgentKey" TEXT NOT NULL,
  "lastConfigGeneration" INTEGER,
  "recoveryRequired" BOOLEAN NOT NULL DEFAULT false,
  "recoveryReason" TEXT,
  "archivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Execution" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "status" "ExecutionStatus" NOT NULL DEFAULT 'QUEUED',
  "queueSequence" BIGSERIAL NOT NULL,
  "requestKey" TEXT NOT NULL,
  "leadAgentKey" TEXT NOT NULL,
  "agentKeysSnapshot" JSONB NOT NULL,
  "configGeneration" INTEGER NOT NULL,
  "inputText" TEXT NOT NULL,
  "attachments" JSONB NOT NULL,
  "model" TEXT,
  "dispatchAttemptId" TEXT,
  "promptMarker" TEXT NOT NULL,
  "promptAcceptedAt" TIMESTAMP(3),
  "cancelRequestedAt" TIMESTAMP(3),
  "waitingSince" TIMESTAMP(3),
  "resultSummary" TEXT,
  "error" TEXT,
  "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Execution_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ContainerInstance_activeExecutionId_key"
  ON "ContainerInstance"("activeExecutionId");
CREATE UNIQUE INDEX "Conversation_nativeSessionId_key"
  ON "Conversation"("nativeSessionId");
CREATE UNIQUE INDEX "Conversation_userId_id_key"
  ON "Conversation"("userId", "id");
CREATE INDEX "Conversation_userId_archivedAt_updatedAt_idx"
  ON "Conversation"("userId", "archivedAt", "updatedAt");
CREATE UNIQUE INDEX "Execution_promptMarker_key"
  ON "Execution"("promptMarker");
CREATE UNIQUE INDEX "Execution_queueSequence_key"
  ON "Execution"("queueSequence");
CREATE UNIQUE INDEX "Execution_userId_requestKey_key"
  ON "Execution"("userId", "requestKey");
CREATE INDEX "Execution_userId_status_queueSequence_idx"
  ON "Execution"("userId", "status", "queueSequence");
CREATE INDEX "Execution_conversationId_createdAt_idx"
  ON "Execution"("conversationId", "createdAt");

ALTER TABLE "Conversation"
  ADD CONSTRAINT "Conversation_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Execution"
  ADD CONSTRAINT "Execution_userId_conversationId_fkey"
  FOREIGN KEY ("userId", "conversationId") REFERENCES "Conversation"("userId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
