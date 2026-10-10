import { randomBytes } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadConfig } from "./config";
import { ensureOpencodeConfigDir } from "./file-service";

const config = loadConfig();
const CONFIG_FILE = "opencode.json";
const GLOBAL_INSTRUCTIONS_FILE = "AGENTS.md";
export const MAX_GLOBAL_INSTRUCTIONS_BYTES = 100 * 1024;
const CUSTOM_PROVIDER_KEY = "custom";
const CUSTOM_PROVIDER_NPM = "@ai-sdk/openai-compatible";
const CUSTOM_PROVIDER_NAME = "自定义模型";
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MAX_MODELS = 100;

type OpencodeConfigJson = Record<string, unknown> & {
  agent?: Record<string, unknown>;
  mcp?: Record<string, unknown>;
  tools?: Record<string, unknown>;
};

export class AdminConfigError extends Error {
  constructor(message: string, public readonly statusCode = 400) {
    super(message);
  }
}

export interface ModelEntry {
  id: string;
  name: string;
}

export interface ModelSettings {
  baseURL: string;
  apiKey: string;
  models: ModelEntry[];
  defaultModel: string;
}

export interface ChatModelOption {
  id: string;
  name: string;
  model: string;
}

export interface ChatModelsView {
  models: ChatModelOption[];
  defaultModel: string;
}

export interface RuntimeModelConfiguration {
  model: string;
  provider: Record<string, unknown>;
  configuredModels: string[];
}

function configFilePath() {
  return path.join(config.opencodeConfigPath, CONFIG_FILE);
}

function globalInstructionsFilePath() {
  return path.join(config.opencodeConfigPath, GLOBAL_INSTRUCTIONS_FILE);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}

async function readConfigJson(): Promise<OpencodeConfigJson> {
  await ensureOpencodeConfigDir();
  let raw: string;
  try {
    raw = await readFile(configFilePath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { $schema: "https://opencode.ai/config.json" };
    }
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid root");
    }
    return parsed as OpencodeConfigJson;
  } catch {
    throw new AdminConfigError("共享配置 opencode.json 不是合法 JSON，请先手动修复", 500);
  }
}

async function writeConfigJson(data: OpencodeConfigJson) {
  const destination = configFilePath();
  const temporary = `${destination}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function getGlobalInstructions() {
  await ensureOpencodeConfigDir();
  try {
    return await readFile(globalInstructionsFilePath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export async function updateGlobalInstructions(content: string) {
  await ensureOpencodeConfigDir();
  if (content.includes("\0")) {
    throw new AdminConfigError("全局规则不能包含空字符");
  }
  const destination = globalInstructionsFilePath();
  if (!content.trim()) {
    await rm(destination, { force: true });
    return "";
  }
  const normalized = content.endsWith("\n") ? content : `${content}\n`;
  if (Buffer.byteLength(normalized, "utf8") > MAX_GLOBAL_INSTRUCTIONS_BYTES) {
    throw new AdminConfigError(`全局规则不能超过 ${MAX_GLOBAL_INSTRUCTIONS_BYTES / 1024} KiB`);
  }
  const temporary = `${destination}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, normalized, "utf8");
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return normalized;
}

/** Remove the retired browser MCP from older fresh-install templates. */
export async function retireBrowserMcpConfig(): Promise<boolean> {
  const value = await readConfigJson();
  let changed = false;
  const mcp = asRecord(value.mcp);
  if (Object.hasOwn(mcp, "browser")) {
    delete mcp.browser;
    if (Object.keys(mcp).length) value.mcp = mcp;
    else delete value.mcp;
    changed = true;
  }
  const removeBrowserTool = (record: Record<string, unknown>) => {
    const tools = asRecord(record.tools);
    if (!Object.hasOwn(tools, "browser_*")) return;
    delete tools["browser_*"];
    if (Object.keys(tools).length) record.tools = tools;
    else delete record.tools;
    changed = true;
  };
  removeBrowserTool(value);
  for (const rawAgent of Object.values(asRecord(value.agent))) {
    removeBrowserTool(asRecord(rawAgent));
  }
  if (changed) await writeConfigJson(value);
  return changed;
}

function customProviderOf(value: OpencodeConfigJson) {
  return asRecord(asRecord(value.provider)[CUSTOM_PROVIDER_KEY]);
}

function modelSettingsOf(value: OpencodeConfigJson): ModelSettings {
  const provider = customProviderOf(value);
  const options = asRecord(provider.options);
  const models = Object.entries(asRecord(provider.models)).map(([id, raw]) => {
    const configuredName = asRecord(raw).name;
    return {
      id,
      name: typeof configuredName === "string" && configuredName.trim()
        ? configuredName
        : id,
    };
  });
  const prefix = `${CUSTOM_PROVIDER_KEY}/`;
  const configuredDefault = typeof value.model === "string" && value.model.startsWith(prefix)
    ? value.model.slice(prefix.length)
    : "";
  return {
    baseURL: typeof options.baseURL === "string" ? options.baseURL : "",
    apiKey: typeof options.apiKey === "string" ? options.apiKey : "",
    models,
    defaultModel: models.some((entry) => entry.id === configuredDefault)
      ? configuredDefault
      : "",
  };
}

export async function getModelSettings() {
  return modelSettingsOf(await readConfigJson());
}

export async function getChatModels(): Promise<ChatModelsView> {
  const settings = await getModelSettings();
  return {
    models: settings.models.map((entry) => ({
      ...entry,
      model: `${CUSTOM_PROVIDER_KEY}/${entry.id}`,
    })),
    defaultModel: settings.defaultModel
      ? `${CUSTOM_PROVIDER_KEY}/${settings.defaultModel}`
      : "",
  };
}

/** This credential-bearing projection is only used to build a managed runtime. */
export async function getRuntimeModelConfiguration(): Promise<RuntimeModelConfiguration> {
  const settings = await getModelSettings();
  if (!settings.defaultModel || !settings.models.length) {
    throw new AdminConfigError("尚未配置运行模型", 409);
  }
  const options: Record<string, unknown> = { baseURL: settings.baseURL };
  if (settings.apiKey) options.apiKey = settings.apiKey;
  return {
    model: `${CUSTOM_PROVIDER_KEY}/${settings.defaultModel}`,
    configuredModels: settings.models.map((entry) => `${CUSTOM_PROVIDER_KEY}/${entry.id}`),
    provider: {
      [CUSTOM_PROVIDER_KEY]: {
        npm: CUSTOM_PROVIDER_NPM,
        name: CUSTOM_PROVIDER_NAME,
        options,
        models: Object.fromEntries(settings.models.map((entry) => [entry.id, { name: entry.name }])),
      },
    },
  };
}

export async function updateModelSettings(input: ModelSettings): Promise<ModelSettings> {
  const baseURL = (input.baseURL ?? "").trim();
  const apiKey = (input.apiKey ?? "").trim();
  const models: ModelEntry[] = [];
  const seen = new Set<string>();
  for (const raw of input.models ?? []) {
    const id = (raw.id ?? "").trim();
    if (!MODEL_ID_RE.test(id)) {
      throw new AdminConfigError(`模型 ID「${id}」不合法：仅允许字母、数字与 . _ : / -，不含空白，长度不超过 128`);
    }
    if (seen.has(id)) throw new AdminConfigError(`模型 ID「${id}」重复`);
    seen.add(id);
    const name = (raw.name ?? "").trim();
    models.push({ id, name: name || id });
  }
  if (models.length > MAX_MODELS) {
    throw new AdminConfigError(`模型数量不能超过 ${MAX_MODELS} 个`);
  }
  const defaultModel = (input.defaultModel ?? "").trim();
  const value = await readConfigJson();
  const providerMap = asRecord(value.provider);

  if (!models.length) {
    delete providerMap[CUSTOM_PROVIDER_KEY];
    if (Object.keys(providerMap).length) value.provider = providerMap;
    else delete value.provider;
    const prefix = `${CUSTOM_PROVIDER_KEY}/`;
    if (typeof value.model === "string" && value.model.startsWith(prefix)) delete value.model;
    if (typeof value.small_model === "string" && value.small_model.startsWith(prefix)) delete value.small_model;
    await writeConfigJson(value);
    return modelSettingsOf(value);
  }
  if (!/^https?:\/\//.test(baseURL)) {
    throw new AdminConfigError("接口地址 (baseURL) 需以 http:// 或 https:// 开头");
  }
  if (!seen.has(defaultModel)) {
    throw new AdminConfigError("请在模型列表中选择一个默认模型");
  }

  const existing = customProviderOf(value);
  const existingModels = asRecord(existing.models);
  const options: Record<string, unknown> = { ...asRecord(existing.options), baseURL };
  if (apiKey) options.apiKey = apiKey;
  else delete options.apiKey;
  providerMap[CUSTOM_PROVIDER_KEY] = {
    name: CUSTOM_PROVIDER_NAME,
    ...existing,
    npm: CUSTOM_PROVIDER_NPM,
    options,
    models: Object.fromEntries(models.map((entry) => [
      entry.id,
      { ...asRecord(existingModels[entry.id]), name: entry.name },
    ])),
  };
  value.provider = providerMap;
  value.model = `${CUSTOM_PROVIDER_KEY}/${defaultModel}`;
  value.small_model = `${CUSTOM_PROVIDER_KEY}/${defaultModel}`;
  await writeConfigJson(value);
  return modelSettingsOf(value);
}
