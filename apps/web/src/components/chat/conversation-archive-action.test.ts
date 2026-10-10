import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Exercise the component's actual submission callback without a Next router or DOM.
const source = ts.createSourceFile(
  "conversation-archive-action.tsx",
  readFileSync(new URL("./conversation-archive-action.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let initializer: string | undefined;
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "submitArchive") {
    initializer = node.initializer?.getText(source);
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(initializer);
const callback = ts.transpileModule(`globalThis.submitArchive = ${initializer};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function action(onArchive: () => Promise<void>) {
  const state = { busy: false, error: null as string | null, closed: 0, notices: 0 };
  const openRef = { current: true };
  const busyRef = { current: false };
  const context = vm.createContext({
    Error,
    openRef,
    busyRef,
    onArchive,
    setBusy: (value: boolean) => { state.busy = value; },
    setError: (value: string | null) => { state.error = value; },
    onClose: () => { state.closed += 1; },
    toast: { success: () => { state.notices += 1; } },
    triggerRef: { current: null },
    panelRef: { current: null },
    requestAnimationFrame: () => {},
  });
  vm.runInContext(callback, context);
  return { state, openRef, busyRef, submit: context.submitArchive as () => Promise<void> };
}

test("archive requires explicit submission and repeated clicks send only one request", async () => {
  let requests = 0;
  let resolve!: () => void;
  const pending = new Promise<void>((done) => { resolve = done; });
  const archive = action(() => { requests += 1; return pending; });
  assert.equal(requests, 0);
  const first = archive.submit();
  await archive.submit();
  assert.equal(requests, 1);
  assert.equal(archive.state.busy, true);
  resolve();
  await first;
  assert.equal(archive.state.closed, 1);
  assert.equal(archive.state.notices, 1);
  assert.equal(archive.state.busy, false);
  assert.equal(archive.busyRef.current, false);
});

test("failed archive keeps confirmation open, exposes the error, and allows retry", async () => {
  let requests = 0;
  const archive = action(async () => {
    requests += 1;
    if (requests === 1) throw new Error("服务暂不可用");
  });
  await archive.submit();
  assert.equal(archive.state.error, "服务暂不可用");
  assert.equal(archive.state.closed, 0);
  assert.equal(archive.state.notices, 0);
  assert.equal(archive.state.busy, false);
  await archive.submit();
  assert.equal(archive.state.error, null);
  assert.equal(archive.state.closed, 1);
});

test("an archive completed after navigating away cannot close another confirmation", async () => {
  let resolve!: () => void;
  const pending = new Promise<void>((done) => { resolve = done; });
  const archive = action(() => pending);
  const submitted = archive.submit();
  archive.openRef.current = false;
  resolve();
  await submitted;
  assert.equal(archive.state.closed, 0);
  assert.equal(archive.state.notices, 1);
});
