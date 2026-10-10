import assert from "node:assert/strict";
import test from "node:test";

import {
  agentAssignmentLabel,
  agentCatalogCount,
  agentCheckView,
  agentEnabledView,
  agentModeView,
} from "./agent-status";

test("角色模式、启用状态与检查状态分别取值，不共用绿色", () => {
  assert.deepEqual(agentModeView("subagent"), { label: "子智能体", tone: "neutral" });
  assert.deepEqual(agentModeView("all"), { label: "主/子智能体", tone: "neutral" });
});

test("停用是中性的，只有启用才使用成功色", () => {
  assert.deepEqual(agentEnabledView(true), { label: "启用", tone: "positive" });
  assert.deepEqual(agentEnabledView(false), { label: "停用", tone: "neutral" });
});

test("检查失败给出文字与危险语气，待检查不伪装成成功", () => {
  assert.deepEqual(agentCheckView("ready"), { label: "检查通过", tone: "positive" });
  assert.deepEqual(agentCheckView("pending"), { label: "待检查", tone: "prompt" });
  assert.deepEqual(agentCheckView("error"), { label: "检查失败", tone: "danger" });
});

test("获配人数沿用真实数据拼写", () => {
  assert.equal(agentAssignmentLabel(0), "0 人获配");
  assert.equal(agentAssignmentLabel(2), "2 人获配");
});

test("搜索时同时说明命中数与总数", () => {
  assert.equal(agentCatalogCount(4, 4, false), "共 4 个智能体");
  assert.equal(agentCatalogCount(4, 1, true), "匹配 1 个 / 共 4 个");
});
