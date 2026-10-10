-- opshelper fresh-install baseline. The project is being rebuilt and does not
-- migrate an existing deployment; old-data handling remains a release-time
-- decision.
CREATE SCHEMA IF NOT EXISTS "public";

CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');
CREATE TYPE "ContainerStatus" AS ENUM ('CREATING', 'RUNNING', 'STOPPED', 'DELETING', 'ERROR');
CREATE TYPE "AgentCheckStatus" AS ENUM ('PENDING', 'READY', 'ERROR');
CREATE TYPE "ConfigApplyStatus" AS ENUM ('DRAINING', 'REVOKING', 'APPLYING', 'READY', 'FROZEN');

CREATE TABLE "User" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "role" "UserRole" NOT NULL DEFAULT 'USER',
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "keepContainerAlive" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Agent" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "isEnabled" BOOLEAN NOT NULL DEFAULT true,
  "contentHash" TEXT,
  "checkStatus" "AgentCheckStatus" NOT NULL DEFAULT 'PENDING',
  "checkError" TEXT,
  "checkedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserAgent" (
  "userId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserAgent_pkey" PRIMARY KEY ("userId", "agentId")
);

CREATE TABLE "Session" (
  "id" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ContainerInstance" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "image" TEXT NOT NULL,
  "status" "ContainerStatus" NOT NULL,
  "dockerContainerId" TEXT,
  "proxySlug" TEXT NOT NULL,
  "lastActivityAt" TIMESTAMP(3),
  "lastWakeAttemptAt" TIMESTAMP(3),
  "lifecycleLockedAt" TIMESTAMP(3),
  "lifecycleLockOwner" TEXT,
  "lastStartedAt" TIMESTAMP(3),
  "lastStoppedAt" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "desiredGeneration" INTEGER NOT NULL DEFAULT 0,
  "appliedGeneration" INTEGER NOT NULL DEFAULT 0,
  "desiredRuntimeHash" TEXT,
  "appliedRuntimeHash" TEXT,
  "configApplyStatus" "ConfigApplyStatus" NOT NULL DEFAULT 'FROZEN',
  "configApplyAttemptId" TEXT,
  "configApplyError" TEXT,
  "drainingRuntimeState" JSONB,
  "configAppliedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ContainerInstance_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ContainerActivity" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "containerId" TEXT,
  "kind" TEXT NOT NULL,
  "detail" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContainerActivity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MountedAsset" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "storagePath" TEXT NOT NULL,
  "mountPath" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MountedAsset_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "Agent_key_key" ON "Agent"("key");
CREATE INDEX "UserAgent_agentId_userId_idx" ON "UserAgent"("agentId", "userId");
CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");
CREATE INDEX "Session_userId_expiresAt_idx" ON "Session"("userId", "expiresAt");
CREATE UNIQUE INDEX "ContainerInstance_userId_key" ON "ContainerInstance"("userId");
CREATE UNIQUE INDEX "ContainerInstance_name_key" ON "ContainerInstance"("name");
CREATE UNIQUE INDEX "ContainerInstance_proxySlug_key" ON "ContainerInstance"("proxySlug");
CREATE INDEX "ContainerActivity_containerId_occurredAt_idx" ON "ContainerActivity"("containerId", "occurredAt");
CREATE INDEX "ContainerActivity_userId_occurredAt_idx" ON "ContainerActivity"("userId", "occurredAt");

ALTER TABLE "UserAgent" ADD CONSTRAINT "UserAgent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserAgent" ADD CONSTRAINT "UserAgent_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContainerInstance" ADD CONSTRAINT "ContainerInstance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContainerActivity" ADD CONSTRAINT "ContainerActivity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContainerActivity" ADD CONSTRAINT "ContainerActivity_containerId_fkey" FOREIGN KEY ("containerId") REFERENCES "ContainerInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;
