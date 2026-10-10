import assert from "node:assert/strict";
import test from "node:test";

import { anchoredConfirmPosition } from "./anchored-confirm-position";

const panel = { width: 280, height: 160 };
const anchor = { left: 236, right: 264, top: 300, bottom: 328 };

test("confirmation stays beside the conversation on desktop", () => {
  assert.deepEqual(anchoredConfirmPosition(anchor, panel, { width: 1440, height: 900 }), {
    left: 272,
    top: 300,
  });
});

test("narrow screens place confirmation below the row within viewport margins", () => {
  assert.deepEqual(anchoredConfirmPosition(anchor, panel, { width: 375, height: 800 }), {
    left: 12,
    top: 336,
  });
});

test("confirmation near the bottom of a narrow screen flips above the row", () => {
  assert.deepEqual(anchoredConfirmPosition(
    { ...anchor, top: 700, bottom: 728 }, panel, { width: 375, height: 800 },
  ), { left: 12, top: 532 });
});

test("desktop confirmation near the bottom stays inside the viewport", () => {
  assert.deepEqual(anchoredConfirmPosition(
    { ...anchor, top: 850, bottom: 878 }, panel, { width: 1440, height: 900 },
  ), { left: 272, top: 728 });
});

test("right-edge anchors keep the fallback panel horizontally visible", () => {
  assert.deepEqual(anchoredConfirmPosition(
    { left: 960, right: 988, top: 20, bottom: 48 }, panel, { width: 1000, height: 800 },
  ), { left: 708, top: 56 });
});
