import assert from "node:assert/strict";
import test from "node:test";

import { collaborationNote } from "./collaboration-note";

test("collaborationNote returns null when nothing is collaborating", () => {
  assert.equal(collaborationNote([]), null);
});

test("collaborationNote reports a running count while children work", () => {
  assert.deepEqual(
    collaborationNote([{ status: "running" }, { status: "completed" }]),
    { tone: "running", label: "1 项执行中" },
  );
});

test("collaborationNote prefers failures over running work", () => {
  assert.deepEqual(
    collaborationNote([{ status: "running" }, { status: "failed" }, { status: "failed" }]),
    { tone: "failed", label: "2 项失败" },
  );
});

test("collaborationNote surfaces waiting children ahead of running ones", () => {
  assert.deepEqual(
    collaborationNote([{ status: "waiting_input" }, { status: "running" }]),
    { tone: "waiting", label: "1 项等待输入" },
  );
});

test("collaborationNote reports completion when every child settled", () => {
  assert.deepEqual(
    collaborationNote([{ status: "completed" }, { status: "completed" }]),
    { tone: "completed", label: "全部已完成" },
  );
});
