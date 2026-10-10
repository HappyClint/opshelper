import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile("confirm-dialog.tsx", readFileSync(new URL("./confirm-dialog.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let effect: string | undefined;
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === "useEffect") effect = node.arguments[0].getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(effect);
const mount = ts.transpileModule(`globalThis.mount = ${effect};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function dialog(variant = "danger", busy = false) {
  const handlers = new Map<string, (event: unknown) => void>();
  const state = { cancelled: 0 };
  const document = {
    activeElement: null as Element | null,
    addEventListener: (key: string, fn: (event: unknown) => void) => { handlers.set(key, fn); },
    removeEventListener: (key: string) => { handlers.delete(key); },
  };
  class Element {
    isConnected = true;
    disabled = false;
    focus() { document.activeElement = this; }
  }
  const original = new Element();
  const cancel = new Element();
  const confirm = new Element();
  cancel.disabled = confirm.disabled = busy;
  const panel = Object.assign(new Element(), {
    querySelectorAll: () => [cancel, confirm].filter((button) => !button.disabled),
    contains: (target: Element) => [panel, cancel, confirm].includes(target),
  });
  original.focus();
  const busyRef = { current: busy };
  const cancelCallbackRef = { current: () => { state.cancelled += 1; } };
  const context = vm.createContext({
    document, HTMLElement: Element, open: true, variant, busyRef, cancelCallbackRef,
    dialogRef: { current: panel }, cancelRef: { current: cancel }, confirmRef: { current: confirm },
  });
  vm.runInContext(mount, context);
  const cleanup = context.mount() as () => void;
  return {
    state, document, original, cancel, confirm, panel, busyRef, cancelCallbackRef, cleanup,
    key: (key: string, shiftKey = false) => {
      const event = { key, shiftKey, isComposing: false, keyCode: 0, prevented: false,
        preventDefault() { this.prevented = true; }, stopPropagation() {} };
      handlers.get("keydown")?.(event);
      return event;
    },
    outsideFocus: () => { original.focus(); handlers.get("focusin")?.({ target: original }); },
  };
}

test("danger confirmation starts on cancel; Enter is not intercepted as a global confirm", () => {
  const modal = dialog();
  assert.equal(modal.document.activeElement, modal.cancel);
  assert.equal(modal.key("Enter").prevented, false);
  modal.cleanup();
  assert.equal(modal.document.activeElement, modal.original);
});

test("Tab and Shift+Tab wrap inside the confirmation, including outside focus attempts", () => {
  const modal = dialog();
  assert.equal(modal.key("Tab", true).prevented, true);
  assert.equal(modal.document.activeElement, modal.confirm);
  assert.equal(modal.key("Tab").prevented, true);
  assert.equal(modal.document.activeElement, modal.cancel);
  modal.outsideFocus();
  assert.equal(modal.document.activeElement, modal.cancel);
  modal.cleanup();
});

test("Escape uses the latest callback, does nothing while busy, and focus does not reset on callback changes", () => {
  const modal = dialog();
  modal.confirm.focus();
  modal.cancelCallbackRef.current = () => { modal.state.cancelled += 2; };
  modal.busyRef.current = true;
  modal.key("Escape");
  assert.equal(modal.state.cancelled, 0);
  assert.equal(modal.document.activeElement, modal.confirm);
  modal.busyRef.current = false;
  modal.key("Escape");
  assert.equal(modal.state.cancelled, 2);
  modal.cleanup();
});

test("busy confirmation remains keyboard-contained even when all buttons are disabled", () => {
  const modal = dialog("danger", true);
  assert.equal(modal.document.activeElement, modal.panel);
  assert.equal(modal.key("Tab").prevented, true);
  assert.equal(modal.document.activeElement, modal.panel);
  modal.cleanup();
});
