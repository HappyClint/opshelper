ALTER TABLE "Execution"
ADD COLUMN "autoApprovePermissions" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Schedule"
ADD COLUMN "autoApprovePermissions" BOOLEAN NOT NULL DEFAULT false;
