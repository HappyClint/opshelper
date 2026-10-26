import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type { Prisma, PrismaClient } from "@prisma/client";
import type { AgentMode } from "@opshelper/shared";
import { z } from "zod";

import { loadConfig } from "./config";
import { assertSafeUserId } from "./data-paths";
import { prisma } from "./prisma";
import { getModelSettings } from "./admin-config-service";
import { isUtf8Text, parseSkillMetadata } from "./skill-package";

const AGENT_KEY_RE = /^[a-z][a-z0-9-]{0,63}$/;
const DEPENDENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._*-]{0,127}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const MAX_AGENT_FILE_BYTES = 256 * 1024;
const MAX_SUPPORTING_FILE_BYTES = 16 * 1024 * 1024;
const MAX_AGENT_DIRECTORY_BYTES = 64 * 1024 * 1024;
const RESERVED_AGENT_KEYS = new Set([
  "build",
  "plan",
  "general",
  "explore",
  "scout",
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);
const RESERVED_PATH_PARTS = new Set([".git", ".opencode", "node_modules"]);
const MCP_KEY_RE = /^[a-z][a-z0-9_-]{0,63}$/;

const stringMapSchema = z.record(z.string().min(1).max(128), z.string().max(8192));
const localMcpSchema = z.object({
  type: z.literal("local"),
  command: z.array(z.string().min(1).max(2048)).min(1).max(32),
  cwd: z.string().min(1).max(4096).optional(),
  environment: stringMapSchema.optional(),
  enabled: z.boolean().optional(),
  timeout: z.number().int().min(100).max(120_000).optional(),
}).strict();
const remoteMcpSchema = z.object({
  type: z.literal("remote"),
  url: z.string().min(1).max(4096),
  headers: stringMapSchema.optional(),
  enabled: z.boolean().optional(),
  timeout: z.number().int().min(100).max(120_000).optional(),
  oauth: z.union([
    z.literal(false),
    z.object({
      clientId: z.string().max(4096).optional(),
      clientSecret: z.string().max(4096).optional(),
      scope: z.string().max(4096).optional(),
    }).strict(),
  ]).optional(),
}).strict();
const mcpServerSchema = z.discriminatedUnion("type", [localMcpSchema, remoteMcpSchema]);
export type AgentMcpServer = z.infer<typeof mcpServerSchema>;

export class AgentServiceError extends Error {
  constructor(message: string, public readonly statusCode = 400) {
    super(message);
  }
}

export interface AgentDirectoryInput {
  key: string;
  files: Record<string, string | Uint8Array>;
  ownerId?: string;
}

export interface AgentDependencyCatalog {
  models?: ReadonlySet<string>;
  tools?: ReadonlySet<string>;
}

export interface ValidatedAgentDirectory {
  key: string;
  displayName: string;
  description: string;
  mode: AgentMode;
  contentHash: string;
  model: string | null;
  tools: string[];
  skills: string[];
  scripts: string[];
  mcp: Record<string, AgentMcpServer>;
  sourceDir: string;
}

export interface AssignedRuntimeDefinition {
  desiredGeneration: number;
  appliedGeneration: number;
  applyStatus: "DRAINING" | "REVOKING" | "APPLYING" | "READY" | "FROZEN";
  agents: Array<ValidatedAgentDirectory & { id: string }>;
}

export interface AgentServiceDependencies {
  prisma: PrismaClient;
  dataRoot: string;
  dependencyCatalog?: AgentDependencyCatalog | (() => Promise<AgentDependencyCatalog>);
}

interface ParsedAgentDocument {
  displayName: string;
  description: string;
  mode: AgentMode;
  model: string | null;
  tools: string[];
  skills: string[];
  scripts: string[];
}

function normalizeScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === "string" ? parsed : trimmed;
    } catch {
      throw new AgentServiceError("agent.md frontmatter 含无效字符串");
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

export function assertValidAgentKey(rawKey: string): string {
  const key = rawKey.trim();
  if (!AGENT_KEY_RE.test(key)) {
    throw new AgentServiceError("Agent key 必须以小写字母开头，仅允许小写字母、数字和连字符，长度不超过 64");
  }
  if (RESERVED_AGENT_KEYS.has(key)) {
    throw new AgentServiceError(`Agent key「${key}」是 OpenCode 保留名`);
  }
  return key;
}

function normalizeSupportingPath(rawPath: string): string {
  if (!rawPath || rawPath.includes("\0") || rawPath.includes("\\") || path.posix.isAbsolute(rawPath)) {
    throw new AgentServiceError("Agent 文件路径无效");
  }
  const normalized = path.posix.normalize(rawPath);
  const parts = normalized.split("/");
  if (
    normalized !== rawPath ||
    parts.some((part) => !part || part === "." || part === ".." || RESERVED_PATH_PARTS.has(part))
  ) {
    throw new AgentServiceError(`Agent 文件路径不安全：${rawPath}`);
  }
  if (
    normalized !== "agent.md" &&
    normalized !== "mcp.json" &&
    !normalized.startsWith("skills/") &&
    !normalized.startsWith("scripts/")
  ) {
    throw new AgentServiceError(`Agent 附属文件只允许使用 mcp.json 或放在 skills/、scripts/：${rawPath}`);
  }
  return normalized;
}

function parseAgentDocument(content: string): ParsedAgentDocument {
  const matched = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(content);
  if (!matched) throw new AgentServiceError("agent.md 必须包含完整 frontmatter");
  if (!matched[2].trim()) throw new AgentServiceError("agent.md 正文不能为空");

  const scalars = new Map<string, string>();
  const listValues = new Map<string, string[]>();
  const tools: string[] = [];
  const permissionSkills: string[] = [];
  let section = "";

  for (const rawLine of matched[1].split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();
    if ((section === "skills" || section === "scripts") && indent > 0 && line.startsWith("- ")) {
      const values = listValues.get(section) ?? [];
      values.push(normalizeScalar(line.slice(2)));
      listValues.set(section, values);
      continue;
    }
    const match = /^([A-Za-z0-9_."'*-]+):\s*(.*)$/.exec(line);
    if (!match) throw new AgentServiceError(`agent.md frontmatter 行无法识别：${line}`);
    const key = normalizeScalar(match[1]);
    const value = match[2].trim();
    if (indent === 0) {
      section = "";
      if (["name", "display_name", "description", "model", "mode"].includes(key)) {
        scalars.set(key, normalizeScalar(value));
      } else if (["skills", "scripts"].includes(key)) {
        if (value === "") {
          section = key;
        } else {
          let parsed: unknown;
          try {
            parsed = JSON.parse(value);
          } catch {
            throw new AgentServiceError(`${key} 必须使用 YAML 列表或 JSON 字符串数组`);
          }
          if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
            throw new AgentServiceError(`${key} 必须是字符串数组`);
          }
          listValues.set(key, parsed as string[]);
        }
      } else if (["tools", "permission"].includes(key)) {
        if (value !== "") throw new AgentServiceError(`${key} 必须使用缩进映射`);
        section = key;
      }
      continue;
    }
    if (section === "tools" && value === "true") tools.push(key);
    if (section === "permission" && key === "skill" && value === "") {
      section = "permission.skill";
      continue;
    }
    if (section === "permission.skill" && key !== "*" && value === "allow") {
      permissionSkills.push(key);
    }
  }

  const displayName = (scalars.get("display_name") ?? scalars.get("name") ?? "").trim();
  const description = (scalars.get("description") ?? "").trim();
  const mode = scalars.get("mode") || "all";
  if (!displayName || displayName.length > 128) {
    throw new AgentServiceError("agent.md 必须提供长度不超过 128 的 name 或 display_name");
  }
  if (!description || description.length > 1024) {
    throw new AgentServiceError("agent.md 必须提供长度不超过 1024 的 description");
  }
  if (mode && !["primary", "subagent", "all"].includes(mode)) {
    throw new AgentServiceError("Agent mode 仅支持 primary、subagent 或 all");
  }
  return {
    displayName,
    description,
    mode: mode as AgentMode,
    model: scalars.get("model") || null,
    tools: Array.from(new Set(tools)).sort(),
    skills: Array.from(new Set([...(listValues.get("skills") ?? []), ...permissionSkills])).sort(),
    scripts: Array.from(new Set(listValues.get("scripts") ?? [])).sort(),
  };
}

async function assertDirectoryRoot(root: string): Promise<void> {
  const parent = path.dirname(root);
  await mkdir(parent, { recursive: true });
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    throw new AgentServiceError("DATA_ROOT 必须是真实目录", 500);
  }
  await mkdir(root, { recursive: true });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new AgentServiceError("Agent 根目录必须是真实目录", 500);
  }
}

async function readRegularTree(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  let totalBytes = 0;
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new AgentServiceError(`Agent 目录禁止符号链接：${relative}`);
      if (entry.isDirectory()) {
        await walk(fullPath, relative);
        continue;
      }
      if (!entry.isFile()) throw new AgentServiceError(`Agent 目录禁止特殊文件：${relative}`);
      normalizeSupportingPath(relative);
      const content = await readFile(fullPath);
      const limit = relative === "agent.md" ? MAX_AGENT_FILE_BYTES : MAX_SUPPORTING_FILE_BYTES;
      if (content.byteLength > limit) throw new AgentServiceError(`Agent 文件过大：${relative}`);
      totalBytes += content.byteLength;
      if (totalBytes > MAX_AGENT_DIRECTORY_BYTES) throw new AgentServiceError("Agent 目录总大小超过限制");
      files.set(relative, content);
    }
  }
  await walk(root, "");
  return files;
}

function parseMcpConfiguration(files: ReadonlyMap<string, Buffer>): Record<string, AgentMcpServer> {
  const content = files.get("mcp.json");
  if (!content) return {};
  if (!isUtf8Text(content)) throw new AgentServiceError("mcp.json 必须是 UTF-8 JSON 文本");
  let value: unknown;
  try {
    value = JSON.parse(content.toString("utf8"));
  } catch {
    throw new AgentServiceError("mcp.json 不是合法 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentServiceError("mcp.json 顶层必须是 MCP 服务名到配置的对象");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 16) throw new AgentServiceError("每个智能体最多配置 16 个 MCP 服务");
  const result: Record<string, AgentMcpServer> = {};
  for (const [key, raw] of entries) {
    if (!MCP_KEY_RE.test(key)) throw new AgentServiceError(`MCP 名称「${key}」只能使用小写字母、数字、连字符和下划线`);
    const parsed = mcpServerSchema.safeParse(raw);
    if (!parsed.success) throw new AgentServiceError(`MCP「${key}」配置不合法`);
    if (parsed.data.type === "remote") {
      let url: URL;
      try {
        url = new URL(parsed.data.url);
      } catch {
        throw new AgentServiceError(`MCP「${key}」远程地址无效`);
      }
      if (!["http:", "https:"].includes(url.protocol)) {
        throw new AgentServiceError(`MCP「${key}」远程地址只支持 http 或 https`);
      }
    } else if (parsed.data.cwd) {
      const cwd = parsed.data.cwd.replace(/\\/g, "/");
      if (path.posix.isAbsolute(cwd) || path.posix.normalize(cwd) !== cwd || cwd.split("/").includes("..")) {
        throw new AgentServiceError(`MCP「${key}」cwd 必须是 workspace 内的安全相对路径`);
      }
    }
    result[key] = parsed.data;
  }
  return result;
}

function validateDependencies(
  parsed: ParsedAgentDocument,
  files: ReadonlyMap<string, Buffer>,
  catalog?: AgentDependencyCatalog,
): void {
  if (parsed.model) {
    if (!MODEL_RE.test(parsed.model)) throw new AgentServiceError(`模型引用无效：${parsed.model}`);
    if (catalog?.models && !catalog.models.has(parsed.model)) {
      throw new AgentServiceError(`模型未配置：${parsed.model}`);
    }
  }
  for (const tool of parsed.tools) {
    if (!DEPENDENCY_KEY_RE.test(tool)) throw new AgentServiceError(`工具引用无效：${tool}`);
    if (catalog?.tools && !catalog.tools.has(tool)) throw new AgentServiceError(`工具未配置：${tool}`);
  }
  for (const skill of parsed.skills) {
    if (!AGENT_KEY_RE.test(skill)) throw new AgentServiceError(`技能引用无效：${skill}`);
    const skillDocument = files.get(`skills/${skill}/SKILL.md`);
    if (!skillDocument) throw new AgentServiceError(`技能文件缺失：${skill}`);
    if (!isUtf8Text(skillDocument)) throw new AgentServiceError(`技能文件必须是 UTF-8 文本：${skill}`);
    let metadata: { name: string; description: string };
    try {
      metadata = parseSkillMetadata(skillDocument.toString("utf8"));
    } catch (error) {
      throw new AgentServiceError(error instanceof Error ? `技能「${skill}」无效：${error.message}` : `技能「${skill}」无效`);
    }
    if (metadata.name !== skill) {
      throw new AgentServiceError(`技能「${skill}」的 SKILL.md name 必须与源目录名一致`);
    }
  }
  for (const script of parsed.scripts) {
    const relative = normalizeSupportingPath(`scripts/${script}`);
    if (!files.has(relative)) throw new AgentServiceError(`脚本文件缺失：${script}`);
  }
}

function hashFiles(files: ReadonlyMap<string, Buffer>): string {
  const hash = createHash("sha256");
  for (const name of Array.from(files.keys()).sort()) {
    hash.update(name);
    hash.update("\0");
    hash.update(files.get(name)!);
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function validateDirectory(
  key: string,
  sourceDir: string,
  catalog?: AgentDependencyCatalog,
): Promise<ValidatedAgentDirectory> {
  assertValidAgentKey(key);
  const info = await lstat(sourceDir).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new AgentServiceError(`Agent 目录不存在或不是普通目录：${key}`);
  const files = await readRegularTree(sourceDir);
  const agentMd = files.get("agent.md");
  if (!agentMd) throw new AgentServiceError("Agent 目录缺少 agent.md");
  const agentText = agentMd.toString("utf8");
  if (!Buffer.from(agentText, "utf8").equals(agentMd)) throw new AgentServiceError("agent.md 必须是 UTF-8 文本");
  const parsed = parseAgentDocument(agentText);
  validateDependencies(parsed, files, catalog);
  const mcp = parseMcpConfiguration(files);
  return { key, ...parsed, mcp, contentHash: hashFiles(files), sourceDir };
}

async function writeStagingDirectory(root: string, input: AgentDirectoryInput): Promise<string> {
  const staging = await mkdtemp(path.join(root, ".agent-staging-"));
  try {
    for (const [rawName, rawContent] of Object.entries(input.files)) {
      const name = normalizeSupportingPath(rawName);
      const destination = path.join(staging, ...name.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, rawContent, { flag: "wx", mode: name.startsWith("scripts/") ? 0o700 : 0o600 });
    }
    return staging;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function replaceDirectory(staging: string, destination: string): Promise<void> {
  const current = await lstat(destination).catch(() => null);
  if (current?.isSymbolicLink() || (current && !current.isDirectory())) {
    throw new AgentServiceError("不能替换符号链接或非目录 Agent 源", 409);
  }
  if (!current) {
    await rename(staging, destination);
    return;
  }
  const backup = `${destination}.replaced-${randomBytes(8).toString("hex")}`;
  await rename(destination, backup);
  try {
    await rename(staging, destination);
  } catch (error) {
    await rename(backup, destination).catch(() => undefined);
    throw error;
  }
  await rm(backup, { recursive: true, force: true }).catch(() => undefined);
}

async function markAffectedUsersForApply(
  tx: Prisma.TransactionClient,
  agentId: string,
  status: "DRAINING" | "REVOKING" = "DRAINING",
): Promise<void> {
  await tx.containerInstance.updateMany({
    where: { user: { agents: { some: { agentId } } } },
    data: {
      desiredGeneration: { increment: 1 },
      configApplyStatus: status,
      configApplyAttemptId: null,
      configApplyError: null,
      desiredRuntimeHash: null,
      drainingRuntimeState: [],
    },
  });
}

export function createAgentService(dependencies: AgentServiceDependencies) {
  const agentsRoot = path.join(dependencies.dataRoot, "agents");
  const locks = new Map<string, Promise<void>>();

  async function currentDependencyCatalog() {
    return typeof dependencies.dependencyCatalog === "function"
      ? dependencies.dependencyCatalog()
      : dependencies.dependencyCatalog;
  }

  async function withKeyLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.then(() => gate);
    locks.set(key, tail);
    await prior;
    try {
      return await operation();
    } finally {
      release();
      if (locks.get(key) === tail) locks.delete(key);
    }
  }

  async function prepare(input: AgentDirectoryInput) {
    const key = assertValidAgentKey(input.key);
    await assertDirectoryRoot(agentsRoot);
    const staging = await writeStagingDirectory(agentsRoot, { ...input, key });
    try {
      const validated = await validateDirectory(key, staging, await currentDependencyCatalog());
      return { staging, validated };
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  async function finishWrite(
    recordId: string,
    key: string,
    staging: string,
    validated: ValidatedAgentDirectory,
  ) {
    try {
      await replaceDirectory(staging, path.join(agentsRoot, key));
      return await dependencies.prisma.agent.update({
        where: { id: recordId },
        data: {
          displayName: validated.displayName,
          description: validated.description,
          mode: validated.mode,
          contentHash: validated.contentHash,
          checkStatus: "READY",
          checkError: null,
          checkedAt: new Date(),
        },
      });
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      await dependencies.prisma.agent.update({
        where: { id: recordId },
        data: { checkStatus: "ERROR", checkError: error instanceof Error ? error.message : String(error), checkedAt: new Date() },
      }).catch(() => undefined);
      throw error;
    }
  }

  async function createAgent(input: AgentDirectoryInput) {
    const key = assertValidAgentKey(input.key);
    return withKeyLock(key, async () => {
      const { staging, validated } = await prepare({ ...input, key });
      let record;
      try {
        record = await dependencies.prisma.agent.create({
          data: {
            key,
            ownerId: input.ownerId,
            displayName: validated.displayName,
            description: validated.description,
            mode: validated.mode,
            checkStatus: "PENDING",
          },
        });
      } catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw error;
      }
      return finishWrite(record.id, key, staging, validated);
    });
  }

  async function previewAgent(input: AgentDirectoryInput) {
    const key = assertValidAgentKey(input.key);
    return withKeyLock(key, async () => {
      const { staging, validated } = await prepare({ ...input, key });
      await rm(staging, { recursive: true, force: true });
      return validated;
    });
  }

  async function updateAgent(keyInput: string, input: Omit<AgentDirectoryInput, "key">) {
    const key = assertValidAgentKey(keyInput);
    return withKeyLock(key, async () => {
      const existing = await dependencies.prisma.agent.findUnique({ where: { key } });
      if (!existing) throw new AgentServiceError("Agent 不存在", 404);
      const { staging, validated } = await prepare({ ...input, key });
      await dependencies.prisma.$transaction(async (tx) => {
        await tx.agent.update({ where: { id: existing.id }, data: { checkStatus: "PENDING", checkError: null } });
        await markAffectedUsersForApply(tx, existing.id);
      }, { isolationLevel: "Serializable" });
      return finishWrite(existing.id, key, staging, validated);
    });
  }

  async function setAgentEnabled(keyInput: string, isEnabled: boolean) {
    const key = assertValidAgentKey(keyInput);
    return dependencies.prisma.$transaction(async (tx) => {
      const existing = await tx.agent.findUnique({ where: { key } });
      if (!existing) throw new AgentServiceError("Agent 不存在", 404);
      if (existing.isEnabled === isEnabled) return existing;
      const updated = await tx.agent.update({ where: { id: existing.id }, data: { isEnabled } });
      await markAffectedUsersForApply(tx, existing.id, isEnabled ? "DRAINING" : "REVOKING");
      return updated;
    }, { isolationLevel: "Serializable" });
  }

  async function deleteAgent(keyInput: string) {
    const key = assertValidAgentKey(keyInput);
    return withKeyLock(key, async () => {
      const existing = await dependencies.prisma.agent.findUnique({ where: { key } });
      if (!existing) throw new AgentServiceError("Agent 不存在", 404);
      if (await dependencies.prisma.userAgent.count({ where: { agentId: existing.id } })) {
        throw new AgentServiceError("Agent 仍分配给用户，请先撤销分配", 409);
      }
      const destination = path.join(agentsRoot, key);
      const info = await lstat(destination).catch(() => null);
      if (!info?.isDirectory() || info.isSymbolicLink()) {
        throw new AgentServiceError("Agent 源目录不存在或不安全", 409);
      }
      const tomb = path.join(agentsRoot, `.agent-deleted-${key}-${randomBytes(8).toString("hex")}`);
      await rename(destination, tomb);
      try {
        const deleted = await dependencies.prisma.agent.delete({ where: { id: existing.id } });
        await rm(tomb, { recursive: true, force: true }).catch(() => undefined);
        return deleted;
      } catch (error) {
        await rename(tomb, destination).catch(() => undefined);
        throw error;
      }
    });
  }

  async function checkAgent(keyInput: string) {
    const key = assertValidAgentKey(keyInput);
    return withKeyLock(key, async () => {
      const existing = await dependencies.prisma.agent.findUnique({ where: { key } });
      if (!existing) throw new AgentServiceError("Agent 不存在", 404);
      try {
        const validated = await validateDirectory(key, path.join(agentsRoot, key), await currentDependencyCatalog());
        await dependencies.prisma.$transaction(async (tx) => {
          if (existing.contentHash !== validated.contentHash || existing.checkStatus !== "READY") {
            await markAffectedUsersForApply(tx, existing.id);
          }
          await tx.agent.update({
            where: { id: existing.id },
            data: {
              displayName: validated.displayName,
              description: validated.description,
              mode: validated.mode,
              contentHash: validated.contentHash,
              checkStatus: "READY",
              checkError: null,
              checkedAt: new Date(),
            },
          });
        }, { isolationLevel: "Serializable" });
        return validated;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await dependencies.prisma.$transaction(async (tx) => {
          if (existing.checkStatus !== "ERROR" || existing.checkError !== message) await markAffectedUsersForApply(tx, existing.id);
          await tx.agent.update({ where: { id: existing.id }, data: { checkStatus: "ERROR", checkError: message, checkedAt: new Date() } });
        }, { isolationLevel: "Serializable" });
        throw error;
      }
    });
  }

  async function scanAgentCatalog() {
    await assertDirectoryRoot(agentsRoot);
    const entries = await readdir(agentsRoot, { withFileTypes: true });
    const results: Array<{ key: string; ok: boolean; error?: string }> = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (
        entry.name.startsWith(".agent-staging-") ||
        entry.name.startsWith(".agent-deleted-") ||
        entry.name.includes(".replaced-")
      ) continue;
      try {
        const key = assertValidAgentKey(entry.name);
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new AgentServiceError("Agent 源必须是真实目录");
        const validated = await validateDirectory(key, path.join(agentsRoot, key), await currentDependencyCatalog());
        const existing = await dependencies.prisma.agent.findUnique({ where: { key } });
        if (!existing) {
          await dependencies.prisma.agent.create({
            data: { key, displayName: validated.displayName, description: validated.description, mode: validated.mode, contentHash: validated.contentHash, checkStatus: "READY", checkedAt: new Date() },
          });
        } else {
          await checkAgent(key);
        }
        results.push({ key, ok: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const existing = await dependencies.prisma.agent.findUnique({ where: { key: entry.name } }).catch(() => null);
        if (existing) {
          await dependencies.prisma.$transaction(async (tx) => {
            if (existing.checkStatus !== "ERROR" || existing.checkError !== message) await markAffectedUsersForApply(tx, existing.id);
            await tx.agent.update({ where: { id: existing.id }, data: { checkStatus: "ERROR", checkError: message, checkedAt: new Date() } });
          }, { isolationLevel: "Serializable" });
        }
        results.push({ key: entry.name, ok: false, error: message });
      }
    }
    const onDisk = new Set(entries.map((entry) => entry.name));
    for (const existing of await dependencies.prisma.agent.findMany({ where: { key: { notIn: Array.from(onDisk) } } })) {
      const message = "Agent 源目录不存在";
      await dependencies.prisma.$transaction(async (tx) => {
        if (existing.checkStatus !== "ERROR" || existing.checkError !== message) await markAffectedUsersForApply(tx, existing.id);
        await tx.agent.update({ where: { id: existing.id }, data: { checkStatus: "ERROR", checkError: message, checkedAt: new Date() } });
      }, { isolationLevel: "Serializable" });
      results.push({ key: existing.key, ok: false, error: message });
    }
    return results.sort((a, b) => a.key.localeCompare(b.key));
  }

  async function getAgent(keyInput: string) {
    const key = assertValidAgentKey(keyInput);
    const record = await dependencies.prisma.agent.findUnique({ where: { key } });
    if (!record) throw new AgentServiceError("Agent 不存在", 404);
    const sourceDir = path.join(agentsRoot, key);
    let files: Map<string, Buffer> | null;
    try {
      files = await readRegularTree(sourceDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      files = null;
    }
    const filesBase64 = files
      ? Object.fromEntries(Array.from(files.entries()).map(([name, content]) => [name, content.toString("base64")]))
      : null;
    const content = files?.get("agent.md")?.toString("utf8") ?? null;
    return { ...record, sourceDir, content, filesBase64 };
  }

  function listAgents() {
    return dependencies.prisma.agent.findMany({ orderBy: { key: "asc" } });
  }

  async function replaceUserAgentAssignments(userId: string, agentIds: string[]) {
    const desiredIds = Array.from(new Set(agentIds)).sort();
    return dependencies.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, isActive: true } });
      if (!user?.isActive) throw new AgentServiceError("用户不存在或已停用", 404);
      const agents = await tx.agent.findMany({
        where: {
          id: { in: desiredIds },
          OR: [{ ownerId: null }, { ownerId: userId }],
        },
      });
      if (agents.length !== desiredIds.length) throw new AgentServiceError("分配清单包含不存在的 Agent");
      const invalid = agents.find((agent) => !agent.isEnabled || agent.checkStatus !== "READY");
      if (invalid) throw new AgentServiceError(`Agent「${invalid.key}」未启用或检查未通过`);
      if (agents.length && agents.every((agent) => agent.mode === "subagent")) {
        throw new AgentServiceError("至少需要分配一个 primary 或 all 模式的主智能体");
      }
      const current = await tx.userAgent.findMany({ where: { userId }, select: { agentId: true } });
      const currentIds = current.map((item) => item.agentId).sort();
      if (currentIds.length === desiredIds.length && currentIds.every((id, index) => id === desiredIds[index])) {
        return tx.userAgent.findMany({ where: { userId }, include: { agent: true }, orderBy: { agent: { key: "asc" } } });
      }
      await tx.userAgent.deleteMany({ where: { userId, agentId: { notIn: desiredIds } } });
      await tx.userAgent.createMany({ data: desiredIds.map((agentId) => ({ userId, agentId })), skipDuplicates: true });
      const isRevocation = currentIds.some((agentId) => !desiredIds.includes(agentId));
      const container = await tx.containerInstance.updateMany({
        where: { userId },
        data: {
          desiredGeneration: { increment: 1 },
          desiredRuntimeHash: null,
          configApplyStatus: isRevocation ? "REVOKING" : "DRAINING",
          configApplyAttemptId: null,
          configApplyError: null,
          drainingRuntimeState: [],
        },
      });
      if (container.count !== 1) throw new AgentServiceError("用户固定运行环境不存在", 409);
      return tx.userAgent.findMany({ where: { userId }, include: { agent: true }, orderBy: { agent: { key: "asc" } } });
    }, { isolationLevel: "Serializable" });
  }

  function listUserAgentAssignments(userId: string) {
    return dependencies.prisma.userAgent.findMany({
      where: { userId },
      include: { agent: true },
      orderBy: { agent: { key: "asc" } },
    });
  }

  async function assignedSourceDirectory(userId: string, key: string) {
    const shared = path.join(agentsRoot, assertValidAgentKey(key));
    const existing = await lstat(shared).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing || !key.startsWith("personal-")) return shared;
    // Older deployments store assigned personal agents under their owner's
    // directory. Never search another user or publish the source to the catalog.
    assertSafeUserId(userId);
    let directory = dependencies.dataRoot;
    for (const segment of ["users", userId, "agents"]) {
      directory = path.join(directory, segment);
      const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!info) return shared;
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new AgentServiceError("历史个人智能体目录不是普通目录");
      }
    }
    return path.join(directory, key);
  }

  async function getAssignedRuntimeDefinition(userId: string): Promise<AssignedRuntimeDefinition> {
    const user = await dependencies.prisma.user.findUnique({
      where: { id: userId },
      include: { container: true, agents: { include: { agent: true } } },
    });
    if (!user?.isActive) throw new AgentServiceError("用户不存在或已停用", 404);
    if (!user.container) throw new AgentServiceError("用户固定运行环境不存在", 409);
    const definitions = [];
    for (const assignment of user.agents.sort((a, b) => a.agent.key.localeCompare(b.agent.key))) {
      const agent = assignment.agent;
      if (!agent.isEnabled || agent.checkStatus !== "READY" || !agent.contentHash) {
        throw new AgentServiceError(`Agent「${agent.key}」未启用或检查未通过`, 409);
      }
      const validated = await validateDirectory(agent.key, await assignedSourceDirectory(userId, agent.key), await currentDependencyCatalog());
      if (validated.contentHash !== agent.contentHash) {
        throw new AgentServiceError(`Agent「${agent.key}」源目录已变化，必须重新检查`, 409);
      }
      definitions.push({ id: agent.id, ...validated });
    }
    return {
      desiredGeneration: user.container.desiredGeneration,
      appliedGeneration: user.container.appliedGeneration,
      applyStatus: user.container.configApplyStatus,
      agents: definitions,
    };
  }

  return {
    previewAgent,
    createAgent,
    updateAgent,
    deleteAgent,
    setAgentEnabled,
    checkAgent,
    scanAgentCatalog,
    getAgent,
    listAgents,
    replaceUserAgentAssignments,
    listUserAgentAssignments,
    getAssignedRuntimeDefinition,
  };
}

const defaultService = createAgentService({
  prisma,
  dataRoot: loadConfig().dataRoot,
  dependencyCatalog: async () => {
    const models = await getModelSettings();
    return {
      models: new Set(models.models.map((entry) => `custom/${entry.id}`)),
      tools: new Set([
        "bash", // Legacy agent packages remain importable.
        "shell",
        "subagent",
        "websearch",
        "execute",
        "edit",
        "glob",
        "grep",
        "list",
        "patch",
        "question",
        "read",
        "skill",
        "task",
        "todoread",
        "todowrite",
        "webfetch",
        "write",
      ]),
    };
  },
});

export const createAgent = defaultService.createAgent;
export const previewAgent = defaultService.previewAgent;
export const updateAgent = defaultService.updateAgent;
export const deleteAgent = defaultService.deleteAgent;
export const setAgentEnabled = defaultService.setAgentEnabled;
export const checkAgent = defaultService.checkAgent;
export const scanAgentCatalog = defaultService.scanAgentCatalog;
export const getAgent = defaultService.getAgent;
export const listAgents = defaultService.listAgents;
export const replaceUserAgentAssignments = defaultService.replaceUserAgentAssignments;
export const listUserAgentAssignments = defaultService.listUserAgentAssignments;
export const getAssignedRuntimeDefinition = defaultService.getAssignedRuntimeDefinition;
