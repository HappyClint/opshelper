import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { prisma } from "./prisma";

function advisoryKey(namespace: "user" | "agent" | "admin", id: string) {
  const digest = createHash("sha256").update(`opshelper:${namespace}-config:${id}`).digest();
  return BigInt.asIntN(64, digest.readBigUInt64BE(0));
}

async function acquireTransactionLock(
  tx: Prisma.TransactionClient,
  namespace: "user" | "agent" | "admin",
  id: string,
) {
  // Put the void-returning PostgreSQL function in FROM so Prisma only needs
  // to deserialize the supported integer marker column.
  await tx.$queryRaw<{ locked: number }[]>`
    SELECT 1::integer AS locked
    FROM pg_advisory_xact_lock(${advisoryKey(namespace, id)})
  `;
}

/**
 * Serialize user execution admission with assignment changes across API
 * processes. Callbacks must stay short; long-running model work starts only
 * after OpenCode has acknowledged the prompt.
 */
export async function withUserConfigLock<T>(
  userId: string,
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  return prisma.$transaction(async (tx) => {
    await acquireTransactionLock(tx, "user", userId);
    return callback(tx);
  }, { maxWait: 15_000, timeout: 120_000 });
}

export async function withUserConfigLocks<T>(
  userIds: string[],
  callback: () => Promise<T>,
) {
  const ordered = Array.from(new Set(userIds)).sort();
  return prisma.$transaction(async (tx) => {
    for (const userId of ordered) {
      await acquireTransactionLock(tx, "user", userId);
    }
    return callback();
  }, { maxWait: 15_000, timeout: 120_000 });
}

export async function withAgentConfigLocks<T>(
  agentIds: string[],
  callback: () => Promise<T>,
) {
  const ordered = Array.from(new Set(agentIds)).sort();
  return prisma.$transaction(async (tx) => {
    for (const agentId of ordered) {
      await acquireTransactionLock(tx, "agent", agentId);
    }
    return callback();
  }, { maxWait: 15_000, timeout: 120_000 });
}

/** Serialize account mutations so concurrent demotions cannot remove all admins. */
export async function withAdminMutationLock<T>(callback: () => Promise<T>) {
  return prisma.$transaction(async (tx) => {
    await acquireTransactionLock(tx, "admin", "accounts");
    return callback();
  }, { maxWait: 15_000, timeout: 120_000 });
}
