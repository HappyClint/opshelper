import assert from "node:assert/strict";
import test from "node:test";

import { assertScheduleAgentModes } from "./schedule-service";

test("定时任务区分主智能体与可协作的子智能体", () => {
  assert.doesNotThrow(() => assertScheduleAgentModes("primary", [
    { key: "network-check", mode: "subagent" },
    { key: "shared-helper", mode: "all" },
  ]));
  assert.throws(
    () => assertScheduleAgentModes("subagent", []),
    /子智能体不能作为定时任务的主智能体/,
  );
  assert.throws(
    () => assertScheduleAgentModes("all", [{ key: "primary-only", mode: "primary" }]),
    /不能作为协作智能体/,
  );
});
