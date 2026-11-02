import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// admin-config-service 通过 config 单例读取 DATA_ROOT，必须在导入前设置。
const DATA_ROOT = mkdtempSync(path.join(tmpdir(), "opshelper-models-"));
process.env.DATA_ROOT = DATA_ROOT;
const CONFIG_ROOT = path.join(DATA_ROOT, "config", "opencode");

let cachedService: typeof import("./admin-config-service") | null = null;
async function service() {
  if (!cachedService) cachedService = await import("./admin-config-service");
  return cachedService;
}

const CONFIG_FILE = path.join(CONFIG_ROOT, "opencode.json");
const GLOBAL_INSTRUCTIONS_FILE = path.join(CONFIG_ROOT, "AGENTS.md");

async function readConfig(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(CONFIG_FILE, "utf8"));
}

test("空配置下读取模型设置返回空组", async () => {
  const { getModelSettings } = await service();
  const settings = await getModelSettings();
  assert.deepEqual(settings, {
    baseURL: "",
    apiKey: "",
    models: [],
    defaultModel: "",
  });
});

test("退役浏览器 MCP 时保留其他配置且可重复执行", async () => {
  await writeFile(
    CONFIG_FILE,
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      tools: { "browser_*": false, "github_*": false },
      mcp: {
        browser: { type: "remote", url: "http://localhost:4097/mcp" },
        github: { type: "remote", url: "https://mcp.example.com" },
      },
      agent: {
        assistant: {
          description: "小信助理",
          tools: { "browser_*": true, "github_*": true },
        },
      },
    }),
    "utf8",
  );

  const { retireBrowserMcpConfig } = await service();
  assert.equal(await retireBrowserMcpConfig(), true);
  assert.equal(await retireBrowserMcpConfig(), false);

  const cfg = await readConfig();
  assert.equal(cfg.mcp.browser, undefined);
  assert.deepEqual(cfg.mcp.github, {
    type: "remote",
    url: "https://mcp.example.com",
  });
  assert.deepEqual(cfg.tools, { "github_*": false });
  assert.deepEqual(cfg.agent.assistant.tools, { "github_*": true });
});

test("保存模型组写入 provider.custom 并同步顶层默认模型", async () => {
  await writeFile(
    CONFIG_FILE,
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: "custom/old-default",
      small_model: "custom/old-default",
      agent: { assistant: { description: "小信助理" } },
    }),
    "utf8",
  );

  const { updateModelSettings, getChatModels } = await service();
  const settings = await updateModelSettings({
    baseURL: "https://gw.example.com/v1",
    apiKey: "sk-test",
    models: [
      { id: "qwen-plus", name: "通义千问 Plus" },
      { id: "deepseek-chat", name: "" },
    ],
    defaultModel: "qwen-plus",
  });
  assert.equal(settings.defaultModel, "qwen-plus");
  // 显示名留空时回退到模型 id。
  assert.deepEqual(
    settings.models.map((m) => m.name),
    ["通义千问 Plus", "deepseek-chat"],
  );

  const cfg = await readConfig();
  assert.equal(cfg.model, "custom/qwen-plus");
  assert.equal(cfg.small_model, "custom/qwen-plus");
  assert.equal(cfg.provider.custom.npm, "@ai-sdk/openai-compatible");
  assert.equal(cfg.provider.custom.options.baseURL, "https://gw.example.com/v1");
  assert.equal(cfg.provider.custom.options.apiKey, "sk-test");
  assert.deepEqual(Object.keys(cfg.provider.custom.models), [
    "qwen-plus",
    "deepseek-chat",
  ]);
  // 其他配置键原样保留。
  assert.equal(cfg.agent.assistant.description, "小信助理");

  // 用户侧只读视图不含凭证，引用带 custom/ 前缀。
  const view = await getChatModels();
  assert.equal(view.defaultModel, "custom/qwen-plus");
  assert.deepEqual(view.models[0], {
    id: "qwen-plus",
    name: "通义千问 Plus",
    model: "custom/qwen-plus",
  });
});

test("保留模型条目上手工添加的额外字段", async () => {
  const before = await readConfig();
  before.provider.custom.models["qwen-plus"].limit = { context: 131072 };
  await writeFile(CONFIG_FILE, JSON.stringify(before), "utf8");

  const { updateModelSettings } = await service();
  await updateModelSettings({
    baseURL: "https://gw.example.com/v1",
    apiKey: "sk-test",
    models: [{ id: "qwen-plus", name: "千问" }],
    defaultModel: "qwen-plus",
  });
  const cfg = await readConfig();
  assert.deepEqual(cfg.provider.custom.models["qwen-plus"].limit, {
    context: 131072,
  });
  assert.equal(cfg.provider.custom.models["qwen-plus"].name, "千问");
});

test("模型 ID 支持包含和前缀斜杠", async () => {
  const { updateModelSettings, getModelSettings, getChatModels } = await service();
  await updateModelSettings({
    baseURL: "https://gw.example.com/v1",
    apiKey: "",
    models: [{ id: "/data/chatgpt", name: "" }],
    defaultModel: "/data/chatgpt",
  });
  const settings = await getModelSettings();
  assert.equal(settings.defaultModel, "/data/chatgpt");
  assert.deepEqual(settings.models, [{ id: "/data/chatgpt", name: "/data/chatgpt" }]);

  const view = await getChatModels();
  assert.equal(view.defaultModel, "custom//data/chatgpt");
  assert.deepEqual(view.models, [
    { id: "/data/chatgpt", name: "/data/chatgpt", model: "custom//data/chatgpt" },
  ]);
});

test("非法输入被拒绝", async () => {
  const { updateModelSettings, AdminConfigError } = await service();
  const base = {
    baseURL: "https://gw.example.com/v1",
    apiKey: "",
    defaultModel: "a",
  };
  await assert.rejects(
    updateModelSettings({ ...base, models: [{ id: "有空格 x", name: "" }] }),
    AdminConfigError,
  );
  await assert.rejects(
    updateModelSettings({
      ...base,
      models: [
        { id: "a", name: "" },
        { id: "a", name: "重复" },
      ],
    }),
    AdminConfigError,
  );
  await assert.rejects(
    updateModelSettings({
      ...base,
      defaultModel: "missing",
      models: [{ id: "a", name: "" }],
    }),
    AdminConfigError,
  );
  await assert.rejects(
    updateModelSettings({
      ...base,
      baseURL: "gw.example.com",
      models: [{ id: "a", name: "" }],
    }),
    AdminConfigError,
  );
});

test("清空模型组移除 provider.custom 并删掉顶层 model 键", async () => {
  const { updateModelSettings, getModelSettings } = await service();
  await updateModelSettings({
    baseURL: "",
    apiKey: "",
    models: [],
    defaultModel: "",
  });
  const cfg = await readConfig();
  assert.equal(cfg.provider, undefined);
  assert.equal("model" in cfg, false);
  assert.equal("small_model" in cfg, false);
  const settings = await getModelSettings();
  assert.deepEqual(settings.models, []);
});

test("全局规则原样保存并在空内容时删除", async () => {
  const {
    getGlobalInstructions,
    updateGlobalInstructions,
  } = await service();
  assert.equal(await getGlobalInstructions(), "");

  assert.equal(
    await updateGlobalInstructions("工作目录是 /workspace。"),
    "工作目录是 /workspace。\n",
  );
  assert.equal(await readFile(GLOBAL_INSTRUCTIONS_FILE, "utf8"), "工作目录是 /workspace。\n");
  assert.equal(await getGlobalInstructions(), "工作目录是 /workspace。\n");

  assert.equal(await updateGlobalInstructions("  \n"), "");
  await assert.rejects(readFile(GLOBAL_INSTRUCTIONS_FILE, "utf8"), { code: "ENOENT" });
});

test("全局规则拒绝空字符和超长内容", async () => {
  const {
    AdminConfigError,
    MAX_GLOBAL_INSTRUCTIONS_BYTES,
    updateGlobalInstructions,
  } = await service();
  await assert.rejects(updateGlobalInstructions("a\0b"), AdminConfigError);
  await assert.rejects(
    updateGlobalInstructions("中".repeat(MAX_GLOBAL_INSTRUCTIONS_BYTES)),
    AdminConfigError,
  );
});
