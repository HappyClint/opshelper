import assert from "node:assert/strict";
import test from "node:test";

import { hashPassword, verifyPassword } from "./password";

test("password hashing preserves compatibility and uses distinct salts", async () => {
  const hashes = await Promise.all([hashPassword("密码-test-password"), hashPassword("密码-test-password")]);
  assert.notEqual(hashes[0], hashes[1]);
  assert.equal(await verifyPassword("密码-test-password", hashes[0]), true);
  assert.equal(await verifyPassword("wrong-password", hashes[0]), false);
});

test("malformed stored password hashes fail closed", async () => {
  for (const stored of ["", "salt:hash", "a".repeat(32) + ":" + "g".repeat(128), "a:b:extra"]) {
    assert.equal(await verifyPassword("password", stored), false);
  }
});
