import assert from "node:assert/strict";
import test from "node:test";

import {
  agentIconKind,
  agentRole,
  starterExamplesFor,
  type Assistant,
} from "./assistants";

function assistant(input: Partial<Assistant> & { id: string }): Assistant {
  return { name: input.id, description: "", ...input };
}

test("用户提供的新智能体名称匹配故障、数据库、班组、系统、网络与安全图标", () => {
  const cases = [
    ["故障分析", "diagnostics"],
    ["数据库", "database"],
    ["班组综合员", "team"],
    ["系统管理员", "system"],
    ["网络管理员", "network"],
    ["安全管理员", "security"],
  ];
  for (const [name, expected] of cases) {
    assert.equal(agentIconKind(assistant({ id: "custom", name })), expected, name);
  }
});

test("明确的名称或 key 优先于职责说明中提到的其他领域", () => {
  const cases = [
    { id: "custom", name: "故障分析", description: "分析网络、数据库与系统日志", expected: "diagnostics" },
    { id: "custom", name: "数据库", description: "分析数据库日志及网络访问故障", expected: "database" },
    { id: "custom", name: "班组综合员", description: "汇总网络故障与系统安全巡检资料", expected: "team" },
    { id: "system-ops", name: "系统管理员", description: "检查数据库和 DNS 访问", expected: "system" },
    { id: "network-ops", name: "网络管理员", description: "维护网络安全与数据库连接", expected: "network" },
    { id: "custom", name: "安全管理员", description: "分析网络与系统日志", expected: "security" },
    { id: "mysql-ops", name: "自定义智能体", description: "检查网络连接", expected: "database" },
  ];
  for (const { expected, ...input } of cases) {
    assert.equal(agentIconKind(assistant(input)), expected, input.name);
  }
});

test("复合名称优先匹配安全与数据库等专门领域", () => {
  const cases = [
    ["网络安全管理员", "security"],
    ["信息安全助理", "security"],
    ["数据库故障分析", "database"],
    ["故障诊断助理", "diagnostics"],
    ["班组综合助理", "team"],
  ];
  for (const [name, expected] of cases) {
    assert.equal(agentIconKind(assistant({ id: "custom", name })), expected, name);
  }
});

test("图标支持常见中文职责与英文技术标识，并在身份未知时读取说明", () => {
  const cases = [
    { id: "ROOT_CAUSE", expected: "diagnostics" },
    { id: "fault-analysis", expected: "diagnostics" },
    { id: "postgres-dba", expected: "database" },
    { id: "MYSQL_ops", expected: "database" },
    { id: "redis-admin", expected: "database" },
    { id: "security-admin", expected: "security" },
    { id: "shift-coordinator", expected: "team" },
    { id: "custom", description: "根因分析与告警诊断", expected: "diagnostics" },
    { id: "custom", description: "管理数据仓库", expected: "database" },
    { id: "custom", description: "管理防火墙与漏洞排查", expected: "security" },
    { id: "custom", description: "办理班务与综合事务", expected: "team" },
  ];
  for (const { expected, ...input } of cases) {
    assert.equal(agentIconKind(assistant(input)), expected, JSON.stringify(input));
  }
});

test("英文词内部的子串不触发专门图标，既有智能体和通用回退保持正确", () => {
  for (const id of ["rediscovery", "insecurity", "incidental", "databaseish", "blog-writer", "steam-guide"]) {
    assert.equal(agentIconKind(assistant({ id })), "generic", id);
  }
  for (const [id, expected] of [
    ["network-ops", "network"],
    ["system-ops", "system"],
    ["shared-acceptance", "team"],
    ["personal-123", "person"],
    ["assistant", "person"],
  ]) {
    assert.equal(agentIconKind(assistant({ id })), expected, id);
  }
});

test("新增图标分类不改变首屏任务示例，管理员配置的示例仍优先", () => {
  const custom = assistant({ id: "custom", name: "安全管理员" });
  assert.equal(agentIconKind(custom), "security");
  assert.equal(agentRole(custom), "generic");
  assert.equal(starterExamplesFor(custom)[0].text, "介绍一下你能做什么");

  const network = assistant({ id: "custom", name: "故障分析", description: "网络连通性排障" });
  assert.equal(agentIconKind(network), "diagnostics");
  assert.equal(agentRole(network), "network");
  assert.equal(starterExamplesFor(network)[0].title, "排查网络访问");
  const prompt = "整理班组工作记录";
  assert.deepEqual(starterExamplesFor({ ...custom, prompts: [prompt] }), [{ title: prompt, text: prompt }]);
});

test("按 key 与职责识别角色，网络排在系统之前", () => {
  assert.equal(
    agentRole(assistant({ id: "network-ops", name: "网络运维", description: "网络连通性、DNS、路由、代理和服务访问排障" })),
    "network",
  );
  assert.equal(
    agentRole(assistant({ id: "system-ops", name: "系统运维", description: "主机资源、进程、服务、日志和文件系统排障" })),
    "system",
  );
  assert.equal(
    agentRole(assistant({ id: "shared-acceptance", name: "共享验收智能体", description: "验证角色定义、Skill、MCP 与跨用户共享隔离" })),
    "team",
  );
  assert.equal(
    agentRole(assistant({ id: "personal-ae7360e1", name: "个人助理", description: "处理我的日常运维任务" })),
    "person",
  );
});

test("职责未知时使用通用角色，不按名字猜测能力", () => {
  assert.equal(
    agentRole(assistant({ id: "custom-1", name: "小助手", description: "临时创建的智能体" })),
    "generic",
  );
});

test("英文单词内部的子串不会把自定义智能体引导到运维或团队任务", () => {
  const cases = [
    { id: "blog-writer", name: "写作助手", description: "撰写产品博客", role: "generic" },
    { id: "catalog-assistant", name: "商品目录助手", description: "维护商品目录", role: "person" },
    { id: "observer", name: "信息助手", description: "整理业务信息", role: "generic" },
    { id: "steam-guide", name: "游戏助手", description: "查询游戏资料", role: "generic" },
  ];

  for (const { role, ...input } of cases) {
    const custom = assistant(input);
    assert.equal(agentRole(custom), role, input.id);
    assert.deepEqual(
      starterExamplesFor(custom).map((example) => example.title),
      ["它能做什么", "能处理哪些任务", "看一个使用示例"],
      input.id,
    );
  }
});

test("英文职责关键词支持大小写、独立单词和智能体标识分隔符", () => {
  const cases = [
    { id: "NETWORK-ops", role: "network" },
    { id: "network_ops", role: "network" },
    { id: "system-ops", role: "system" },
    { id: "sysops_helper", role: "system" },
    { id: "shared_acceptance", role: "team" },
    { id: "personal_123", role: "person" },
    { id: "custom", description: "Analyze server logs.", role: "system" },
    { id: "custom", description: "Analyze LOGS.", role: "system" },
    { id: "custom", description: "Check DNS and server logs.", role: "network" },
  ];

  for (const { role, ...input } of cases) {
    assert.equal(agentRole(assistant(input)), role, JSON.stringify(input));
  }
});

test("首屏示例按角色给出具体任务，并且都只是填入输入框的文字", () => {
  const examples = starterExamplesFor(
    assistant({ id: "network-ops", name: "网络运维", description: "网络连通性排障" }),
  );

  assert.ok(examples.length > 0 && examples.length <= 3);
  assert.equal(examples[0].title, "排查网络访问");
  assert.match(examples[0].text, /排查/);
  for (const example of examples) {
    assert.ok(example.title.length > 0);
    assert.ok(example.text.length > 0);
  }
});

test("管理员配置的示例优先，且入口标题就是这句正文", () => {
  const prompt = "帮我把今天的告警整理成一份巡检记录。";
  const examples = starterExamplesFor(
    assistant({ id: "network-ops", name: "网络运维", prompts: [prompt] }),
  );

  assert.deepEqual(examples, [{ title: prompt, text: prompt }]);
});

test("职责未知的智能体保留能力询问入口", () => {
  const examples = starterExamplesFor(assistant({ id: "custom-1", name: "小助手" }));

  assert.equal(examples.length, 3);
  assert.equal(examples[0].text, "介绍一下你能做什么");
});

test("示例最多三条，且每条都是可以继续编辑的正文", () => {
  const examples = starterExamplesFor(
    assistant({ id: "system-ops", name: "系统运维", description: "主机与日志排查" }),
  );

  assert.equal(examples.length, 3);
  assert.equal(examples[0].title, "分析错误日志");
  assert.ok(examples.every((example) => example.text.length > 0));
});
