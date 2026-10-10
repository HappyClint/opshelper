import assert from "node:assert/strict";
import test from "node:test";

import { withAdminAccountMutation } from "./user-service";

test("account mutations recheck administrator permissions after acquiring the shared lock", async () => {
  let role: "ADMIN" | "USER" = "ADMIN";
  let called = false;
  await assert.rejects(withAdminAccountMutation("actor", async () => { called = true; }, {
    lock: async (callback) => { role = "USER"; return callback(); },
    actor: async () => ({ role, isActive: true }),
  }), /管理员权限已变更/);
  assert.equal(called, false);
});

test("inactive and missing administrators cannot mutate accounts", async () => {
  for (const actor of [null, { role: "ADMIN" as const, isActive: false }]) {
    await assert.rejects(withAdminAccountMutation("actor", async () => { throw new Error("must not execute"); }, {
      lock: async (callback) => callback(), actor: async () => actor,
    }), /管理员权限已变更/);
  }
  assert.equal(await withAdminAccountMutation("actor", async () => 42, {
    lock: async (callback) => callback(), actor: async () => ({ role: "ADMIN", isActive: true }),
  }), 42);
});
