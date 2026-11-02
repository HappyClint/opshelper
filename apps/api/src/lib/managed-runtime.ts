import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { withBuiltinInstructions } from "./builtin-instructions";
import { getAssignedRuntimeDefinition, type AssignedRuntimeDefinition } from "./agent-service";
import {
  getGlobalInstructions,
  getRuntimeModelConfiguration,
  type RuntimeModelConfiguration,
} from "./admin-config-service";
import { loadConfig, type AppConfig } from "./config";
import { assertSafeUserId, getUserPaths } from "./data-paths";

const agentKey = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);

function runtimeSkillName(agent: string, skill: string) {
  return `${agent}-${skill}`;
}

function rewriteSkillName(content: string, name: string) {
  const matched = /^(﻿?---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(content);
  if (!matched) throw new Error(`技能 ${name} 缺少有效 frontmatter`);
  const lines = matched[2].split(/\r?\n/);
  const index = lines.findIndex((line) => /^name:\s*/.test(line));
  if (index < 0) throw new Error(`技能 ${name} 缺少 name`);
  lines[index] = `name: ${name}`;
  return `${matched[1]}${lines.join("\n")}${matched[3]}${content.slice(matched[0].length)}`;
}

export class RuntimeNotConfiguredError extends Error {
  statusCode = 503;
  constructor() {
    super("用户尚未获配可用智能体，运行环境无法启动。");
  }
}

export interface ManagedRuntime {
  generation: string;
  agentKeys: string[];
  taskAgentKeys?: string[];
  model: string;
  configuredModels?: string[];
  password: string;
  desiredGeneration: number;
}

export interface ManagedRuntimeServices {
  assignedRuntime: (userId: string) => Promise<AssignedRuntimeDefinition>;
  modelConfiguration: () => Promise<RuntimeModelConfiguration>;
  globalInstructions: () => Promise<string>;
}

const defaultServices: ManagedRuntimeServices = {
  assignedRuntime: getAssignedRuntimeDefinition,
  modelConfiguration: getRuntimeModelConfiguration,
  globalInstructions: getGlobalInstructions,
};

// Managed sources must be ordinary files/directories. Never follow a symlink
// into another user's data or credentials when assembling the user's subset.
async function assertPlainTree(filename: string, digest?: ReturnType<typeof createHash>, relative = "") {
  const info = await lstat(filename);
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
    throw new Error("受管配置不允许符号链接或特殊文件");
  }
  if (info.isDirectory()) {
    for (const name of (await readdir(filename)).sort()) {
      await assertPlainTree(path.join(filename, name), digest, `${relative}/${name}`);
    }
  } else if (digest) {
    if (info.size > 16 * 1024 * 1024) throw new Error("受管文件超过 16 MiB");
    digest.update(relative).update("\0").update(await readFile(filename));
  }
}

export async function getRuntimePassword(userId: string, config: AppConfig = loadConfig()) {
  const { managed } = getUserPaths(userId, config);
  await mkdir(managed, { recursive: true, mode: 0o700 });
  const secretPath = path.join(managed, "server-password");
  try {
    await writeFile(secretPath, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await lstat(secretPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("无效的运行环境认证文件");
  await chmod(secretPath, 0o600);
  const secret = (await readFile(secretPath, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error("无效的运行环境认证文件");
  return secret;
}

export function runtimeAuthorization(password: string) {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
}

export async function readManagedRuntime(userId: string, generation: string, config: AppConfig = loadConfig()): Promise<ManagedRuntime> {
  if (!/^[a-f0-9]{24}$/.test(generation)) throw new RuntimeNotConfiguredError();
  const manifest = z.object({
    generation: z.literal(generation),
    agentKeys: z.array(agentKey),
    taskAgentKeys: z.array(agentKey).optional(),
    model: z.string(),
    configuredModels: z.array(z.string()).optional(),
    desiredGeneration: z.number().int().nonnegative().default(0),
  }).strict().parse(
    JSON.parse(await readFile(path.join(getUserPaths(userId, config).managed, "releases", generation, "manifest.json"), "utf8")),
  );
  return { ...manifest, password: await getRuntimePassword(userId, config) };
}

export async function prepareManagedRuntime(
  userId: string,
  config: AppConfig = loadConfig(),
  services: ManagedRuntimeServices = defaultServices,
): Promise<ManagedRuntime> {
  assertSafeUserId(userId);
  const [definition, modelConfiguration, globalInstructions] = await Promise.all([
    services.assignedRuntime(userId),
    services.modelConfiguration(),
    services.globalInstructions().then(withBuiltinInstructions),
  ]);
  if (!definition.agents.length) throw new RuntimeNotConfiguredError();
  const agentKeys = definition.agents.map((agent) => agent.key).sort();
  const defaultAgentKey = definition.agents.find((agent) => agent.mode !== "subagent")?.key;
  if (!defaultAgentKey) {
    throw new Error("用户至少需要一个 primary 或 all 模式的主智能体");
  }
  const taskAgentKeys = definition.agents
    .filter((agent) => agent.mode !== "primary")
    .map((agent) => agent.key);
  const configuredModels = new Set(modelConfiguration.configuredModels);
  for (const agent of definition.agents) {
    if (agent.model && !configuredModels.has(agent.model)) {
      throw new Error(`智能体 ${agent.key} 引用的模型未配置：${agent.model}`);
    }
  }
  const user = getUserPaths(userId, config);
  const digest = createHash("sha256").update(JSON.stringify({
    version: 12,
    desiredGeneration: definition.desiredGeneration,
    agents: definition.agents.map((agent) => ({
      key: agent.key,
      hash: agent.contentHash,
      description: agent.description,
      mode: agent.mode,
      model: agent.model,
      tools: agent.tools,
      skills: agent.skills,
      mcp: agent.mcp,
    })),
    model: modelConfiguration.model,
    configuredModels: modelConfiguration.configuredModels,
    provider: modelConfiguration.provider,
    globalInstructions,
  }));
  const prompts: Record<string, string> = {};
  for (const definitionAgent of definition.agents) {
    const key = definitionAgent.key;
    const source = definitionAgent.sourceDir;
    await assertPlainTree(source, digest, key);
    prompts[key] = await readFile(path.join(source, "agent.md"), "utf8");
    if (!prompts[key].trim()) throw new Error(`智能体 ${key} 的 agent.md 为空`);
  }
  const generation = digest.digest("hex").slice(0, 24);
  const releases = path.join(user.managed, "releases");
  const destination = path.join(releases, generation);
  await mkdir(releases, { recursive: true, mode: 0o700 });
  for (const directory of [user.workspace, "outputs", "chat-uploads"].map((value, index) => index ? path.join(user.workspace, value) : value)) {
    await mkdir(directory, { recursive: true });
  }
  for (const directory of ["data", "cache", "state"]) {
    await mkdir(path.join(user.state, directory), { recursive: true });
  }
  const runtime: ManagedRuntime = {
    generation,
    agentKeys,
    taskAgentKeys,
    model: modelConfiguration.model,
    configuredModels: modelConfiguration.configuredModels,
    password: await getRuntimePassword(userId, config),
    desiredGeneration: definition.desiredGeneration,
  };
  const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    // Releases are atomically published and mounted read-only in the runtime.
    // Revalidate sources above, and reject altered/symlinked releases before
    // reusing one; a cache hit must not bypass the assignment boundary.
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error("无效的受管运行环境目录");
    }
    await assertPlainTree(destination);
    const cached = await readManagedRuntime(userId, generation, config);
    const configuration = await lstat(path.join(destination, "config", "opencode", "opencode.json"));
    const cachedInstructions = await readFile(
      path.join(destination, "config", "opencode", "AGENTS.md"),
      "utf8",
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    const cachedAgents = (await readdir(path.join(destination, "agents"))).sort();
    if (!configuration.isFile() || configuration.isSymbolicLink() ||
      cachedInstructions !== (globalInstructions.trim() ? globalInstructions : null) ||
      cached.model !== runtime.model || cached.desiredGeneration !== runtime.desiredGeneration ||
      JSON.stringify(cached.agentKeys) !== JSON.stringify(agentKeys) ||
      JSON.stringify(cached.taskAgentKeys) !== JSON.stringify(taskAgentKeys) ||
      JSON.stringify(cachedAgents) !== JSON.stringify(agentKeys) ||
      JSON.stringify(cached.configuredModels) !== JSON.stringify(runtime.configuredModels)) {
      throw new Error("受管运行环境清单与当前配置不一致");
    }
    return runtime;
  }
  const staging = path.join(releases, `.staging-${randomUUID()}`);
  await mkdir(path.join(staging, "config", "opencode"), { recursive: true });
  try {
    const task = Object.fromEntries([["*", "deny"], ...taskAgentKeys.map((key) => [key, "allow"])]);
    const agent: Record<string, unknown> = Object.fromEntries(
      ["build", "plan", "general", "explore"].map((key) => [key, { disable: true }]),
    );
    const mcp: Record<string, unknown> = {};
    const globalMcpTools: Record<string, boolean> = {};
    for (const definitionAgent of definition.agents) {
      const key = definitionAgent.key;
      const ownSkills = definitionAgent.skills.map((skill) => runtimeSkillName(key, skill));
      const skillPermission = Object.fromEntries([
        ["*", "deny"],
        ...ownSkills.map((skill) => [skill, "allow"]),
      ]);
      const ownMcpPatterns: string[] = [];
      for (const [mcpKey, configuration] of Object.entries(definitionAgent.mcp)) {
        const runtimeKey = `${key}-${mcpKey}`;
        const { enabled, timeout, ...server } = configuration;
        mcp[runtimeKey] = {
          ...server,
          disabled: enabled === false,
          // Keep each MCP operation observable and individually permissioned.
          codemode: false,
          ...(timeout ? { timeout: { catalog: timeout, execution: timeout } } : {}),
          ...(configuration.type === "remote" && configuration.oauth && typeof configuration.oauth === "object" ? {
            oauth: { client_id: configuration.oauth.clientId, client_secret: configuration.oauth.clientSecret, scope: configuration.oauth.scope },
          } : {}),
        };
        const pattern = `${runtimeKey}_*`;
        globalMcpTools[pattern] = false;
        ownMcpPatterns.push(pattern);
      }
      const tools = Object.fromEntries([
        // Code Mode wrappers can return without invoking anything, while
        // models report success. Prefer observable tools; explicit opt-in
        // remains available for agents designed to use the execute API.
        ["execute", false] as const,
        ...definitionAgent.tools.map((tool) => [tool, true] as const),
        ...(ownSkills.length ? [["skill", true] as const] : []),
        ...ownMcpPatterns.map((pattern) => [pattern, true] as const),
      ]);
      agent[key] = {
        description: definitionAgent.description,
        mode: definitionAgent.mode,
        prompt: prompts[key],
        ...(definitionAgent.model ? { model: definitionAgent.model } : {}),
        ...(Object.keys(tools).length ? { tools } : {}),
        permission: { external_directory: "ask", task, skill: skillPermission },
      };
      const source = definitionAgent.sourceDir;
      await cp(source, path.join(staging, "agents", key), { recursive: true, dereference: false });
      for (const skill of definitionAgent.skills) {
        const runtimeName = runtimeSkillName(key, skill);
        const sourceSkill = path.join(source, "skills", skill);
        const destinationSkill = path.join(staging, "config", "opencode", "skills", runtimeName);
        await cp(sourceSkill, destinationSkill, { recursive: true, dereference: false });
        const skillDocument = path.join(destinationSkill, "SKILL.md");
        await writeFile(
          skillDocument,
          rewriteSkillName(await readFile(skillDocument, "utf8"), runtimeName),
        );
      }
    }
    const opencode = {
      $schema: "https://opencode.ai/config.json", model: modelConfiguration.model,
      small_model: modelConfiguration.model,
      default_agent: defaultAgentKey, provider: modelConfiguration.provider,
      share: "disabled",
      // V2 moves this setting under experimental. Keep the same observable
      // descendant limit as the platform execution monitor.
      experimental: { subagent_depth: 24 },
      ...(Object.keys(mcp).length ? { mcp: { servers: mcp }, tools: globalMcpTools } : {}),
      agent,
    };
    await writeFile(path.join(staging, "config", "opencode", "opencode.json"), JSON.stringify(opencode, null, 2));
    if (globalInstructions.trim()) {
      await writeFile(path.join(staging, "config", "opencode", "AGENTS.md"), globalInstructions);
    }
    await writeFile(path.join(staging, "config", "opencode", ".gitignore"), "node_modules\npackage.json\nbun.lock\n");
    await writeFile(path.join(staging, "manifest.json"), JSON.stringify({
      generation,
      agentKeys,
      taskAgentKeys,
      model: modelConfiguration.model,
      configuredModels: modelConfiguration.configuredModels,
      desiredGeneration: definition.desiredGeneration,
    }));
    try {
      await rename(staging, destination);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return runtime;
}
