import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SkillPackageImport, SkillRepositorySkillSummary } from "@opshelper/shared";

import { AgentServiceError } from "./agent-service";
import { loadConfig } from "./config";
import { importSkillPackage, isUtf8Text, parseSkillMetadata } from "./skill-package";

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SKILL_DIRECTORY_BYTES = 32 * 1024 * 1024;
const MAX_SKILL_FILE_BYTES = 16 * 1024 * 1024;

function skillRepositoryRoot() {
  return path.join(loadConfig().dataRoot, "skill-repository");
}

function assertSkillName(name: string): string {
  if (!SKILL_NAME_RE.test(name) || name.length > 64) {
    throw new AgentServiceError("技能名称必须是长度不超过 64 的小写 kebab-case 名称");
  }
  return name;
}

function normalizeSkillPath(rawPath: string): string {
  if (!rawPath || rawPath.includes("\0")) {
    throw new AgentServiceError(`技能文件路径无效：${rawPath}`);
  }
  const normalized = rawPath.replace(/\\/g, "/");
  if (normalized !== path.posix.normalize(normalized) || normalized.startsWith("/")) {
    throw new AgentServiceError(`技能文件路径无效：${rawPath}`);
  }
  if (normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new AgentServiceError(`技能文件路径不安全：${rawPath}`);
  }
  return normalized;
}

async function ensureRepositoryRoot(root: string): Promise<void> {
  const parent = path.dirname(root);
  await mkdir(parent, { recursive: true });
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    throw new AgentServiceError("DATA_ROOT 必须是真实目录", 500);
  }
  await mkdir(root, { recursive: true });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new AgentServiceError("Skill 仓库根目录必须是真实目录", 500);
  }
}

async function readSkillTree(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  let totalBytes = 0;
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new AgentServiceError(`Skill 目录禁止符号链接：${relative}`);
      if (entry.isDirectory()) {
        await walk(fullPath, relative);
        continue;
      }
      if (!entry.isFile()) throw new AgentServiceError(`Skill 目录禁止特殊文件：${relative}`);
      normalizeSkillPath(relative);
      const content = await readFile(fullPath);
      if (content.byteLength > MAX_SKILL_FILE_BYTES) throw new AgentServiceError(`Skill 文件过大：${relative}`);
      totalBytes += content.byteLength;
      if (totalBytes > MAX_SKILL_DIRECTORY_BYTES) throw new AgentServiceError("Skill 目录总大小超过限制");
      files.set(relative, content);
    }
  }
  await walk(root, "");
  return files;
}

async function readSkillDirectory(skillName: string): Promise<{
  metadata: { name: string; description: string };
  files: Map<string, Buffer>;
  updatedAt: Date;
}> {
  const root = skillRepositoryRoot();
  await ensureRepositoryRoot(root);
  const name = assertSkillName(skillName);
  const skillDirectory = path.join(root, name);
  const info = await lstat(skillDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw new AgentServiceError("技能不存在", 404);
  }
  const files = await readSkillTree(skillDirectory);
  const skillDocument = files.get("SKILL.md");
  if (!skillDocument) throw new AgentServiceError("技能缺少 SKILL.md", 409);
  if (!isUtf8Text(skillDocument)) throw new AgentServiceError("SKILL.md 必须是 UTF-8 文本", 409);
  const metadata = parseSkillMetadata(skillDocument.toString("utf8"));
  if (metadata.name !== name) {
    throw new AgentServiceError(`技能「${name}」的 SKILL.md name 必须与目录名一致`, 409);
  }
  return { metadata, files, updatedAt: info.mtime };
}

function convertToSkillPackage(
  skillName: string,
  files: ReadonlyMap<string, Buffer>,
): SkillPackageImport {
  const textFiles: Record<string, string> = {};
  const binaryFiles: Record<string, string> = {};
  for (const [relativePath, content] of files.entries()) {
    const destination = `skills/${skillName}/${relativePath}`;
    if (isUtf8Text(content)) textFiles[destination] = content.toString("utf8");
    else binaryFiles[destination] = content.toString("base64");
  }
  return { skillName, files: textFiles, binaryFiles };
}

function stripSkillPrefix(
  skillName: string,
  packageFiles: Record<string, string>,
  packageBinaryFiles: Record<string, string>,
) {
  const prefix = `skills/${skillName}/`;
  const textFiles: Record<string, string> = {};
  const binaryFiles: Record<string, string> = {};
  for (const [filePath, content] of Object.entries(packageFiles)) {
    if (!filePath.startsWith(prefix)) throw new AgentServiceError(`技能包路径无效：${filePath}`);
    const relative = normalizeSkillPath(filePath.slice(prefix.length));
    textFiles[relative] = content;
  }
  for (const [filePath, content] of Object.entries(packageBinaryFiles)) {
    if (!filePath.startsWith(prefix)) throw new AgentServiceError(`技能包路径无效：${filePath}`);
    const relative = normalizeSkillPath(filePath.slice(prefix.length));
    binaryFiles[relative] = content;
  }
  return { textFiles, binaryFiles };
}

export async function listSkillRepositorySkills(): Promise<SkillRepositorySkillSummary[]> {
  const root = skillRepositoryRoot();
  await ensureRepositoryRoot(root);
  const entries = await readdir(root, { withFileTypes: true });
  const skills: SkillRepositorySkillSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (!SKILL_NAME_RE.test(entry.name) || entry.name.length > 64) continue;
    const name = entry.name;
    const loaded = await readSkillDirectory(name);
    skills.push({
      name,
      description: loaded.metadata.description,
      fileCount: loaded.files.size,
      updatedAt: loaded.updatedAt.toISOString(),
    });
  }
  skills.sort((left, right) => left.name.localeCompare(right.name));
  return skills;
}

export async function getSkillRepositorySkillPackage(skillName: string): Promise<SkillPackageImport> {
  const loaded = await readSkillDirectory(skillName);
  return convertToSkillPackage(loaded.metadata.name, loaded.files);
}

export async function createSkillRepositorySkillFromZip(archive: Buffer): Promise<SkillRepositorySkillSummary> {
  const imported = importSkillPackage(archive);
  const skillName = assertSkillName(imported.skillName);
  const { textFiles, binaryFiles } = stripSkillPrefix(skillName, imported.files, imported.binaryFiles);
  const root = skillRepositoryRoot();
  await ensureRepositoryRoot(root);
  const destination = path.join(root, skillName);
  const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) throw new AgentServiceError(`技能「${skillName}」已存在`, 409);

  const staging = await mkdtemp(path.join(root, ".skill-staging-"));
  try {
    for (const [relative, content] of Object.entries(textFiles)) {
      const filePath = path.join(staging, ...relative.split("/"));
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content, { flag: "wx", mode: 0o600 });
    }
    for (const [relative, content] of Object.entries(binaryFiles)) {
      const filePath = path.join(staging, ...relative.split("/"));
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, Buffer.from(content, "base64"), { flag: "wx", mode: 0o600 });
    }
    await rename(staging, destination);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }

  const saved = await readSkillDirectory(skillName);
  return {
    name: skillName,
    description: saved.metadata.description,
    fileCount: saved.files.size,
    updatedAt: saved.updatedAt.toISOString(),
  };
}

export async function deleteSkillRepositorySkill(skillName: string): Promise<void> {
  const root = skillRepositoryRoot();
  await ensureRepositoryRoot(root);
  const name = assertSkillName(skillName);
  const destination = path.join(root, name);
  const info = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new AgentServiceError("技能不存在", 404);
  await rm(destination, { recursive: true, force: false });
}
