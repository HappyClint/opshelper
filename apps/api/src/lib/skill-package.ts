import path from "node:path";

import { unzip, ZipError } from "./zip";

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const IGNORED_NAMES = new Set([".DS_Store", "Thumbs.db"]);
const RESERVED_PARTS = new Set([".git", ".opencode", "node_modules", "__MACOSX"]);

export interface ImportedSkillPackage {
  skillName: string;
  files: Record<string, string>;
  binaryFiles: Record<string, string>;
}

export function isUtf8Text(content: Buffer): boolean {
  if (content.includes(0)) return false;
  const text = content.toString("utf8");
  return Buffer.from(text, "utf8").equals(content);
}

function scalar(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === "string" ? parsed : trimmed;
    } catch {
      return trimmed;
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

export function parseSkillMetadata(content: string): { name: string; description: string } {
  const matched = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!matched) throw new ZipError("SKILL.md 必须包含完整 frontmatter");
  const values = new Map<string, string>();
  for (const rawLine of matched[1].split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
    if (rawLine.length !== rawLine.trimStart().length) continue;
    const entry = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(rawLine.trim());
    if (entry) values.set(entry[1], scalar(entry[2]));
  }
  const name = (values.get("name") ?? "").trim();
  const description = (values.get("description") ?? "").trim();
  if (!SKILL_NAME_RE.test(name) || name.length > 64) {
    throw new ZipError("SKILL.md 的 name 必须是长度不超过 64 的小写 kebab-case 名称");
  }
  if (!description || description.length > 1024) {
    throw new ZipError("SKILL.md 必须提供长度不超过 1024 的 description");
  }
  return { name, description };
}

function safeParts(name: string): string[] {
  if (!name || name.includes("\0") || name.startsWith("/") || /^[A-Za-z]:\//.test(name)) {
    throw new ZipError(`技能包路径无效：${name}`);
  }
  const normalized = path.posix.normalize(name);
  const parts = normalized.split("/").filter(Boolean);
  if (
    normalized !== name.replace(/\/$/, "") ||
    parts.some((part) => part === "." || part === ".." || RESERVED_PARTS.has(part))
  ) {
    throw new ZipError(`技能包路径不安全：${name}`);
  }
  return parts;
}

/** Parse one skill ZIP and project it into an Agent's skills/<name>/ tree. */
export function importSkillPackage(archive: Buffer): ImportedSkillPackage {
  const entries = unzip(archive, {
    maxEntries: 512,
    maxTotalBytes: 32 * 1024 * 1024,
    maxEntryBytes: 16 * 1024 * 1024,
  }).filter((entry) =>
    !entry.isDirectory &&
    !IGNORED_NAMES.has(path.posix.basename(entry.name)) &&
    !entry.name.replace(/\\/g, "/").split("/").includes("__MACOSX"),
  );

  const normalized = entries.map((entry) => ({ ...entry, parts: safeParts(entry.name) }));
  const skillDocuments = normalized.filter((entry) => entry.parts.at(-1) === "SKILL.md");
  if (skillDocuments.length !== 1) {
    throw new ZipError(skillDocuments.length ? "一个技能包只能包含一个 SKILL.md" : "技能包缺少 SKILL.md");
  }

  const skillDocument = skillDocuments[0];
  if (!isUtf8Text(skillDocument.data)) throw new ZipError("SKILL.md 必须是 UTF-8 文本");
  const metadata = parseSkillMetadata(skillDocument.data.toString("utf8"));
  const rootParts = skillDocument.parts.slice(0, -1);
  const files: Record<string, string> = {};
  const binaryFiles: Record<string, string> = {};

  for (const entry of normalized) {
    if (!rootParts.every((part, index) => entry.parts[index] === part)) {
      throw new ZipError(`技能包包含技能目录之外的文件：${entry.name}`);
    }
    const relativeParts = entry.parts.slice(rootParts.length);
    if (!relativeParts.length) continue;
    const destination = `skills/${metadata.name}/${relativeParts.join("/")}`;
    if (isUtf8Text(entry.data)) files[destination] = entry.data.toString("utf8");
    else binaryFiles[destination] = entry.data.toString("base64");
  }

  return { skillName: metadata.name, files, binaryFiles };
}
