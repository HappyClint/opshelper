import assert from "node:assert/strict";
import test from "node:test";
import { normalizeQuestion } from "./interactions";

test("纯文本问题在省略 custom 时允许自由回答", () => {
  const result = normalizeQuestion({ id: "q-1", questions: [{ header: "URL", question: "输入地址", options: [] }] });
  assert.equal(result?.questions[0].custom, true);
  assert.deepEqual(result?.questions[0].options, []);
});

test("明确禁止自由回答时保留选项约束，也兼容 allowCustom", () => {
  for (const flags of [{ custom: false }, { allowCustom: false }, { custom: false, allowCustom: true }]) {
    const result = normalizeQuestion({ id: "q-1", questions: [{ question: "选择环境", options: ["生产", "测试"], ...flags }] });
    assert.equal(result?.questions[0].custom, false);
    assert.deepEqual(result?.questions[0].options.map((option) => option.label), ["生产", "测试"]);
  }
});
