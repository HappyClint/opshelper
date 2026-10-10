import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile("composer.tsx", readFileSync(new URL("./composer.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function callback(name: string) {
  let initializer: string | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) initializer = node.initializer?.getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(initializer);
  return ts.transpileModule(`globalThis.${name} = ${initializer};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}
function composer({ composing = false, showMentions = false, canSend = true } = {}) {
  const state = { sent: 0, picked: 0, prevented: false, mentionUpdates: 0 };
  const context = vm.createContext({
    useCallback: (fn: unknown) => fn,
    composingRef: { current: composing },
    showMentions,
    canSend,
    mentionResults: [{ filename: "test.txt" }],
    mentionActive: 0,
    pickMention: () => { state.picked += 1; },
    onSend: () => { state.sent += 1; },
    setMention: () => { state.mentionUpdates += 1; },
    setMentionActive: () => { state.mentionUpdates += 1; },
  });
  vm.runInContext(callback("handleKeyDown"), context);
  vm.runInContext(callback("syncMention"), context);
  return {
    state,
    key: (key: string, nativeEvent = { isComposing: false, keyCode: 13 }, shiftKey = false) => context.handleKeyDown({
      key, shiftKey, nativeEvent, preventDefault: () => { state.prevented = true; },
    }),
    syncMention: context.syncMention as (text: string, caret: number) => void,
  };
}

for (const key of ["Enter", "Tab", "ArrowDown", "ArrowUp", "Escape"]) {
  test(`IME owns ${key} while composing, including when a file suggestion is visible`, () => {
    const input = composer({ composing: true, showMentions: true });
    input.key(key);
    assert.deepEqual(input.state, { sent: 0, picked: 0, prevented: false, mentionUpdates: 0 });
  });
}

test("native composition and Safari keyCode 229 do not send or select mentions", () => {
  for (const nativeEvent of [{ isComposing: true, keyCode: 13 }, { isComposing: false, keyCode: 229 }]) {
    const input = composer({ showMentions: true });
    input.key("Enter", nativeEvent);
    assert.equal(input.state.sent, 0);
    assert.equal(input.state.picked, 0);
    assert.equal(input.state.prevented, false);
  }
});

test("Enter sends after composition, Shift+Enter remains a newline, and blocked input cannot send", () => {
  const input = composer();
  input.key("Enter");
  assert.equal(input.state.sent, 1);
  const multiline = composer();
  multiline.key("Enter", undefined, true);
  assert.equal(multiline.state.sent, 0);
  assert.equal(multiline.state.prevented, false);
  const blocked = composer({ canSend: false });
  blocked.key("Enter");
  assert.equal(blocked.state.sent, 0);
});

test("Enter selects a file suggestion instead of sending after composition", () => {
  const input = composer({ showMentions: true });
  input.key("Enter");
  assert.equal(input.state.picked, 1);
  assert.equal(input.state.sent, 0);
});

test("file autocomplete detection is paused while composing", () => {
  const input = composer({ composing: true });
  input.syncMention("@test", 5);
  assert.equal(input.state.mentionUpdates, 0);
});

for (const blocked of [false, true]) {
  test(`file drop ${blocked ? "is rejected while blocked" : "starts uploading when editable"}`, () => {
    const files = [{ name: "late.txt" }];
    let added: unknown;
    let prevented = false;
    let dragOver = true;
    const depth = { current: 2 };
    const context = vm.createContext({
      blocked, dragDepth: depth,
      setDragOver: (value: boolean) => { dragOver = value; },
      onAddFiles: (value: unknown) => { added = value; },
    });
    vm.runInContext(callback("handleDrop"), context);
    context.handleDrop({ dataTransfer: { files }, preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(depth.current, 0);
    assert.equal(dragOver, false);
    assert.equal(added !== undefined, !blocked);
    if (!blocked) assert.equal((added as unknown[])[0], files[0]);
  });
}
