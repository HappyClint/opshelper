import assert from "node:assert/strict";
import test from "node:test";

import { resolveInitialAdminPassword, resolveSeedContainerImage } from "./seed";

test("seed uses the configured opencode runtime image for container records", () => {
  assert.equal(
    resolveSeedContainerImage({
      OPENCODE_DOCKER_IMAGE: "opshelper/opencode-runtime:v1",
    }),
    "opshelper/opencode-runtime:v1",
  );
});

test("seed falls back to the default opencode runtime image", () => {
  assert.equal(resolveSeedContainerImage({}), "opshelper/opencode-runtime:1.18.34");
});

test("fresh installation requires an explicit strong bootstrap password", () => {
  assert.throws(() => resolveInitialAdminPassword({}), /OPSHELPER_ADMIN_PASSWORD/);
  assert.throws(() => resolveInitialAdminPassword({ OPSHELPER_ADMIN_PASSWORD: "too-short" }));
  assert.equal(resolveInitialAdminPassword({ OPSHELPER_ADMIN_PASSWORD: "a-secure-test-password" }), "a-secure-test-password");
});

test("bootstrap rejects existing business data before creating or changing users", async () => {
  const { bootstrapEmptyDatabase } = await import("./seed");
  const client = {
    $transaction: async (action: (tx: unknown) => Promise<unknown>) => action({
      $queryRaw: async () => [{ populated: true }],
      user: { create: () => { throw new Error("must not create user"); } },
    }),
  } as unknown as import("@prisma/client").PrismaClient;
  await assert.rejects(bootstrapEmptyDatabase(client, { OPSHELPER_ADMIN_PASSWORD: "a-secure-test-password" }), /已有业务数据/);
});
