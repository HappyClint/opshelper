import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

// 把组件里的纯函数原样搬进 VM：不引入 Next/React，也不重复一份状态判断逻辑，
// 这样「哪种状态禁用哪个动作」只有一处实现。
const source = ts.createSourceFile(
  "container-actions.tsx",
  readFileSync(new URL("./container-actions.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

function hoist(name: string) {
  let text: string | undefined;
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.getText(source) === name) {
      // 直接贴进 VM，去掉模块导出语法。
      text = node.getText(source).replace(/^export\s+/, "");
    }
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) {
      text = `const ${node.getText(source)};`;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(text, `missing declaration: ${name}`);
  return text;
}

const context = vm.createContext({});
vm.runInContext(
  ts.transpileModule(
    [
      hoist("TRANSITIONAL"),
      hoist("unavailable"),
      hoist("startActionState"),
      hoist("stopActionState"),
      "globalThis.api = { startActionState, stopActionState };",
    ].join("\n"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText,
  context,
);
const { startActionState, stopActionState } = context.api as {
  startActionState: (status: string, recovery?: string) => { disabled?: boolean; disabledHint?: string };
  stopActionState: (status: string) => { disabled?: boolean; disabledHint?: string };
};

test("运行中的容器不需要「启动」，并提示可用的恢复入口", () => {
  const state = startActionState("running", "重启或重建环境");
  assert.equal(state.disabled, true);
  assert.match(state.disabledHint ?? "", /重启或重建环境/);
});

test("已停止的容器只保留「启动」", () => {
  assert.equal(startActionState("stopped").disabled, undefined);
  assert.equal(stopActionState("stopped").disabled, true);
});

test("创建/删除过程中的容器禁用启停，避免点击注定失败的动作", () => {
  for (const status of ["creating", "deleting"]) {
    assert.equal(startActionState(status).disabled, true, status);
    assert.equal(stopActionState(status).disabled, true, status);
  }
});

test("异常状态不禁用启停：状态来自数据库，可能落后于真实情况", () => {
  assert.equal(startActionState("error").disabled, undefined);
  assert.equal(stopActionState("error").disabled, undefined);
});
