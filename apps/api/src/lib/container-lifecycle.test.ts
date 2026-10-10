import assert from "node:assert/strict";
import test from "node:test";

import {
  isLifecycleLockExpired,
  isWakeAttemptCoolingDown,
  lifecycleLockTtlMs,
  startContainerIfNeeded,
  wakeAttemptCooldownMs,
} from "./container-lifecycle";

test("running containers are reused without a start or startup delay", async () => {
  let starts = 0;
  let waits = 0;
  const started = await startContainerIfNeeded({
    inspect: async () => ({ State: { Running: true } }),
    start: async () => { starts++; },
  }, async () => { waits++; });
  assert.equal(started, false);
  assert.equal(starts, 0);
  assert.equal(waits, 0);
});

test("stopped containers complete the startup stability delay before verification", async () => {
  const events: string[] = [];
  const started = await startContainerIfNeeded({
    inspect: async () => ({ State: { Running: false } }),
    start: async () => { events.push("start"); },
  }, async (milliseconds) => { events.push(`wait:${milliseconds}`); });
  assert.equal(started, true);
  assert.deepEqual(events, ["start", "wait:2500"]);
});

test("failed starts propagate without waiting or reporting an already running container", async () => {
  let waited = false;
  await assert.rejects(startContainerIfNeeded({
    inspect: async () => { throw new Error("inspect unavailable"); },
    start: async () => { throw new Error("start failed"); },
  }, async () => { waited = true; }), /start failed/);
  assert.equal(waited, false);
});

test("lifecycle lock is available when it is missing or stale", () => {
  const now = new Date("2026-05-08T10:00:00.000Z");

  assert.equal(isLifecycleLockExpired(null, now), true);
  assert.equal(
    isLifecycleLockExpired(
      new Date(now.getTime() - lifecycleLockTtlMs - 1),
      now,
    ),
    true,
  );
  assert.equal(
    isLifecycleLockExpired(new Date(now.getTime() - lifecycleLockTtlMs + 1), now),
    false,
  );
});

test("wake attempt cooldown blocks repeated automatic starts", () => {
  const now = new Date("2026-05-08T10:00:00.000Z");

  assert.equal(isWakeAttemptCoolingDown(null, now), false);
  assert.equal(
    isWakeAttemptCoolingDown(
      new Date(now.getTime() - wakeAttemptCooldownMs + 1),
      now,
    ),
    true,
  );
  assert.equal(
    isWakeAttemptCoolingDown(
      new Date(now.getTime() - wakeAttemptCooldownMs - 1),
      now,
    ),
    false,
  );
});
