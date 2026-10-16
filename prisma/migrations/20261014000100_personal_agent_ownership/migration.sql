ALTER TABLE "Agent"
ADD COLUMN "ownerId" TEXT;

CREATE INDEX "Agent_ownerId_idx" ON "Agent"("ownerId");

ALTER TABLE "Agent"
ADD CONSTRAINT "Agent_ownerId_fkey"
FOREIGN KEY ("ownerId") REFERENCES "User"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
