import assert from "node:assert/strict";
import test from "node:test";

import type { AppConfig } from "./config";
import {
  assertSafeUserId,
  getHostUserPaths,
  getUserPaths,
} from "./data-paths";

const config = {
  dataRoot: "/data",
  dataRootHost: "/srv/opshelper/data",
} as AppConfig;

test("getUserPaths returns the container-side user layout", () => {
  assert.deepEqual(getUserPaths("user-01", config), {
    root: "/data/users/user-01",
    workspace: "/data/users/user-01/workspace",
    state: "/data/users/user-01/state",
    managed: "/data/users/user-01/managed",
  });
});

test("getHostUserPaths returns Docker-daemon-visible bind sources", () => {
  assert.deepEqual(getHostUserPaths("user_01", config), {
    root: "/srv/opshelper/data/users/user_01",
    workspace: "/srv/opshelper/data/users/user_01/workspace",
    state: "/srv/opshelper/data/users/user_01/state",
    managed: "/srv/opshelper/data/users/user_01/managed",
  });
});

test("assertSafeUserId rejects traversal, separators, and ambiguous IDs", () => {
  for (const value of ["", ".", "..", "../alice", "alice/li", "alice\\li", " alice", "alice "]) {
    assert.throws(() => assertSafeUserId(value), /Invalid user ID/);
  }
});

test("assertSafeUserId accepts database-style IDs", () => {
  for (const value of ["u1", "user-01", "019c7714-3b77-74d1-9866-e1f484aae2ab"]) {
    assert.doesNotThrow(() => assertSafeUserId(value));
  }
});
