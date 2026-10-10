import assert from "node:assert/strict";
import test from "node:test";

import {
  OPERATIONS_PANEL_STORAGE_KEY,
  OPERATION_SCROLL_LIMIT,
  chatStorage,
  clampPanelScrollTop,
  createOperationsPanelState,
  hasEarlierRecords,
  isPinnedToLatest,
  loadOperationsPanelState,
  operationsTurnKey,
  panelOpen,
  panelScrollTop,
  parseOperationsPanelState,
  pendingOperationCount,
  rememberPanelOpen,
  rememberPanelScroll,
  saveOperationsPanelState,
  serializeOperationsPanelState,
  type StorageLike,
} from "./operation-panel";
import type { ToolOperation } from "./tool-activity";

function operation(id: string): ToolOperation {
  return {
    id,
    toolName: "read",
    kind: "read",
    status: "completed",
    label: "读取文件",
    target: "/workspace/a",
    result: null,
    input: { filePath: "/workspace/a" },
    output: "",
    durationMs: null,
    outsideWorkspace: false,
    changesState: false,
    externalAccess: false,
    skillName: null,
  };
}

function memoryStorage(seed?: string): StorageLike & { value: string | null } {
  return {
    value: seed ?? null,
    getItem(key) {
      assert.equal(key, OPERATIONS_PANEL_STORAGE_KEY);
      return this.value;
    },
    setItem(key, value) {
      assert.equal(key, OPERATIONS_PANEL_STORAGE_KEY);
      this.value = value;
    },
  };
}

test("滚动位置按轮次记录，超过上限淘汰最久没用过的一轮", () => {
  let state = createOperationsPanelState();
  for (let index = 0; index < OPERATION_SCROLL_LIMIT + 5; index += 1) {
    state = rememberPanelScroll(state, `turn-${index}`, index * 10);
  }
  assert.equal(Object.keys(state.scroll).length, OPERATION_SCROLL_LIMIT);
  assert.equal(panelScrollTop(state, "turn-0"), null);
  assert.equal(panelScrollTop(state, `turn-${OPERATION_SCROLL_LIMIT + 4}`), (OPERATION_SCROLL_LIMIT + 4) * 10);

  // 看过旧的一轮会把它挪回最近使用的位置，被淘汰的换成更久没看的。
  state = rememberPanelScroll(state, "turn-5", 55);
  assert.equal(state.scroll["turn-5"], 55);
  assert.deepEqual(Object.keys(state.scroll).at(-1), "turn-5");
  assert.equal(panelScrollTop(state, "turn-5"), 55);
});

test("滚动位置只接受有限非负数，缺键时保持原状态", () => {
  const state = createOperationsPanelState();
  assert.equal(rememberPanelScroll(state, "turn", Number.NaN), state);
  assert.equal(rememberPanelScroll(state, "turn", -4), state);
  assert.equal(rememberPanelScroll(state, null, 100), state);
  assert.equal(rememberPanelScroll(state, "turn", 12.6).scroll.turn, 13);
});

test("展开状态按工具框隔离，新工具框默认折叠", () => {
  let state = createOperationsPanelState();
  assert.equal(panelOpen(state, "turn-a"), false);
  state = rememberPanelOpen(state, "turn-a", true);
  assert.equal(panelOpen(state, "turn-a"), true);
  assert.equal(panelOpen(state, "turn-b"), false);
  state = rememberPanelOpen(state, "turn-b", true);
  state = rememberPanelOpen(state, "turn-a", false);
  assert.equal(panelOpen(state, "turn-a"), false);
  assert.equal(panelOpen(state, "turn-b"), true);
  assert.equal(Object.hasOwn(state.open, "turn-a"), false);
  assert.equal(rememberPanelOpen(state, null, true), state);
});

test("贴在底部和隐藏更早记录的判定", () => {
  const tall = { scrollTop: 400, scrollHeight: 1000, clientHeight: 300 };
  const atBottom = { scrollTop: 700, scrollHeight: 1000, clientHeight: 300 };
  const nearBottom = { scrollTop: 690, scrollHeight: 1000, clientHeight: 300 };
  assert.equal(isPinnedToLatest(tall), false);
  assert.equal(isPinnedToLatest(atBottom), true);
  assert.equal(isPinnedToLatest(nearBottom), true);
  assert.equal(hasEarlierRecords(tall), true);
  assert.equal(hasEarlierRecords({ ...atBottom, scrollTop: 0 }), false);
});

test("用户往上翻后只统计新到的记录，回到最底部时清零", () => {
  assert.equal(pendingOperationCount(9, 6, false), 3);
  assert.equal(pendingOperationCount(9, 6, true), 0);
  assert.equal(pendingOperationCount(2, 6, false), 0);
});

test("恢复滚动位置时会按当前内容高度收敛", () => {
  const metrics = { scrollTop: 0, scrollHeight: 600, clientHeight: 300 };
  assert.equal(clampPanelScrollTop(5000, metrics), 300);
  assert.equal(clampPanelScrollTop(-20, metrics), 0);
  assert.equal(clampPanelScrollTop(120, metrics), 120);
  assert.equal(clampPanelScrollTop(120, { ...metrics, scrollHeight: 200 }), 0);
});

test("存储读写能容忍损坏内容和不可用的 localStorage", () => {
  assert.deepEqual(parseOperationsPanelState(null), createOperationsPanelState());
  assert.deepEqual(parseOperationsPanelState("不是 JSON"), createOperationsPanelState());
  assert.deepEqual(parseOperationsPanelState('"折叠"'), createOperationsPanelState());
  assert.deepEqual(
    parseOperationsPanelState('{"open":true,"scroll":{"a":40,"b":-1,"c":"x","d":null}}'),
    { open: {}, scroll: { a: 40 } },
  );
  assert.deepEqual(parseOperationsPanelState('{"open":true}'), createOperationsPanelState());
  assert.deepEqual(
    parseOperationsPanelState('{"open":{"a":true,"b":false,"c":"yes"}}'),
    { open: { a: true, b: false }, scroll: {} },
  );

  const state = rememberPanelScroll(
    rememberPanelOpen(createOperationsPanelState(), "turn-1", true),
    "turn-1",
    88,
  );
  const storage = memoryStorage();
  saveOperationsPanelState(storage, state);
  assert.deepEqual(loadOperationsPanelState(storage), state);
  assert.equal(storage.value, serializeOperationsPanelState(state));

  const broken: StorageLike = {
    getItem() {
      throw new Error("SecurityError");
    },
    setItem() {
      throw new Error("SecurityError");
    },
  };
  assert.deepEqual(loadOperationsPanelState(broken), createOperationsPanelState());
  saveOperationsPanelState(broken, state);
  assert.deepEqual(loadOperationsPanelState(null), createOperationsPanelState());
  assert.equal(chatStorage(), null);
});

test("一轮记录的键取第一条操作，流式追加不换键", () => {
  assert.equal(operationsTurnKey([operation("first"), operation("second")]), "first");
  assert.equal(operationsTurnKey([]), null);
});
