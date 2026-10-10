import { createReadStream, type ReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { loadConfig } from "./config";
import { assertSafeUserId, getUserPaths } from "./data-paths";

const config = loadConfig();
const WORKSPACE_MOUNT_PATH = config.opencodeDirectory;

export interface FileInfo {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number | null;
  modified_at: number;
}

export interface DownloadStreamInfo {
  stream: ReadStream | Readable;
  stat?: Stats;
  filename: string;
  contentType: string;
}

// ---------------------------------------------------------------------------
// Path security
// ---------------------------------------------------------------------------

export function getUserDataRoot(userId: string): string {
  return getUserPaths(userId, config).workspace;
}

// OpenCode's persistent state stays outside the workspace, so the file manager
// cannot expose it and a runtime rebuild does not erase conversation history.
export function getUserStateRoot(userId: string): string {
  return getUserPaths(userId, config).state;
}

async function ensureRealDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new PathTraversalError();
  }
}

async function ensureUserRoot(userId: string): Promise<void> {
  const paths = getUserPaths(userId, config);
  await ensureRealDirectory(config.dataRoot);
  await ensureRealDirectory(path.join(config.dataRoot, "users"));
  await ensureRealDirectory(paths.root);
}

function normalizeUserScopedPath(inputPath: string): string {
  if (inputPath.includes("\0")) {
    throw new PathTraversalError();
  }

  const cleaned = (inputPath || "").replace(/\\/g, "/").trim();
  if (!cleaned || cleaned === "." || cleaned === "/") {
    return "";
  }

  if (cleaned === WORKSPACE_MOUNT_PATH) {
    return "";
  }

  if (cleaned.startsWith(`${WORKSPACE_MOUNT_PATH}/`)) {
    return cleaned.slice(WORKSPACE_MOUNT_PATH.length + 1);
  }

  if (path.posix.isAbsolute(cleaned) || /^[A-Za-z]:\//.test(cleaned)) {
    throw new PathTraversalError();
  }

  return cleaned;
}

/**
 * Resolve either a user-relative path or a container workspace path like
 * /workspace/foo.txt to an absolute API-container path, ensuring it stays within
 * the user's data root.
 */
function resolveUserPath(userId: string, relativePath: string): string {
  const root = getUserDataRoot(userId);
  const normalized = normalizeUserScopedPath(relativePath);
  const resolved = path.resolve(root, normalized);

  if (!resolved.startsWith(root + "/") && resolved !== root) {
    throw new PathTraversalError();
  }

  return resolved;
}

/**
 * Same as resolveUserPath but also verifies symlinks don't escape the root.
 */
export async function resolveUserPathSafe(
  userId: string,
  relativePath: string,
): Promise<string> {
  const resolved = resolveUserPath(userId, relativePath);
  const root = getUserDataRoot(userId);
  await ensureUserRoot(userId);
  await ensureRealDirectory(root);
  const realRoot = await realpath(root);

  let real: string;
  try {
    real = await realpath(resolved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      throw error;
    }
    // For a new nested target, validate the closest existing ancestor. This
    // catches an intermediate symlink even when the immediate parent is absent.
    let ancestor = path.dirname(resolved);
    while (ancestor !== root) {
      try {
        const realAncestor = await realpath(ancestor);
        if (
          realAncestor !== realRoot &&
          !realAncestor.startsWith(`${realRoot}${path.sep}`)
        ) {
          throw new PathTraversalError();
        }
        return resolved;
      } catch (ancestorError) {
        if (ancestorError instanceof PathTraversalError) throw ancestorError;
        const ancestorCode = (ancestorError as NodeJS.ErrnoException).code;
        if (ancestorCode !== "ENOENT" && ancestorCode !== "ENOTDIR") {
          throw ancestorError;
        }
        ancestor = path.dirname(ancestor);
      }
    }
    return resolved;
  }

  if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) {
    throw new PathTraversalError();
  }

  return resolved;
}

export class PathTraversalError extends Error {
  constructor() {
    super("Path traversal denied");
  }
}

export class PayloadTooLargeError extends Error {
  constructor(public readonly limit: number, public readonly actual: number) {
    super(`File too large: ${actual} bytes exceeds limit ${limit}`);
  }
}

export class BinaryFileError extends Error {
  constructor() {
    super("File appears to be binary");
  }
}

export class StaleFileError extends Error {
  constructor(public readonly currentModifiedAt: number) {
    super("File has been modified by another process");
  }
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/\0/g, "")
    .replace(/[/\\]/g, "_")
    .replace(/^\.+$/, "_");
}

function toRelativePath(userId: string, absolutePath: string): string {
  const root = getUserDataRoot(userId);
  const rel = path.relative(root, absolutePath);
  return rel === "." ? "" : rel;
}

function toWorkspacePath(userId: string, absolutePath: string): string {
  const relative = toRelativePath(userId, absolutePath)
    .split(path.sep)
    .join("/");
  return relative
    ? `${WORKSPACE_MOUNT_PATH}/${relative}`
    : WORKSPACE_MOUNT_PATH;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function ensureUserDataDir(userId: string): Promise<string> {
  const workspace = getUserDataRoot(userId);
  await ensureUserRoot(userId);
  await ensureRealDirectory(workspace);
  return workspace;
}

/**
 * Ensure the per-user opencode state dir exists on the host before a container
 * binds it. Created by the api (host user), so the bound history DB stays
 * host-user-owned rather than root-created by the docker daemon.
 */
export async function ensureUserStateDir(userId: string): Promise<string> {
  const root = getUserStateRoot(userId);
  await ensureUserRoot(userId);
  await ensureRealDirectory(root);
  return root;
}

/**
 * Transitional directory for the existing admin config routes. It is not
 * mounted into user runtimes; phase 3 will project approved subsets into each
 * user's managed release directory.
 */
export async function ensureOpencodeConfigDir(): Promise<string> {
  const root = config.opencodeConfigPath;
  await mkdir(root, { recursive: true });
  return root;
}

export async function listDirectory(
  userId: string,
  dirPath: string,
  showHidden = false,
): Promise<FileInfo[]> {
  const resolved = await resolveUserPathSafe(userId, dirPath);
  await ensureUserDataDir(userId);

  let entries;
  try {
    entries = await readdir(resolved, { withFileTypes: true });
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw e;
  }

  const results: FileInfo[] = [];

  for (const entry of entries) {
    // Skip hidden dot entries unless explicitly requested.
    if (!showHidden && entry.name.startsWith(".")) continue;

    const entryPath = path.join(resolved, entry.name);
    const workspacePath = toWorkspacePath(userId, entryPath);

    try {
      const s = await lstat(entryPath);
      if (s.isSymbolicLink()) continue;
      const isDir = s.isDirectory();
      results.push({
        name: entry.name,
        path: workspacePath,
        type: isDir ? "directory" : "file",
        size: isDir ? null : s.size,
        modified_at: Math.floor(s.mtimeMs / 1000),
      });
    } catch {
      // Entry disappeared between readdir and stat — skip
    }
  }

  // Sort: directories first, then alphabetical
  results.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return results;
}

export async function deleteItem(
  userId: string,
  itemPath: string,
): Promise<void> {
  if (!itemPath || itemPath === "/" || itemPath === ".") {
    throw new Error("Cannot delete root directory");
  }

  const resolved = await resolveUserPathSafe(userId, itemPath);
  const root = getUserDataRoot(userId);

  if (resolved === root) {
    throw new Error("Cannot delete root directory");
  }

  await rm(resolved, { recursive: true, force: true });
}

export async function createDirectory(
  userId: string,
  dirPath: string,
): Promise<void> {
  const resolved = await resolveUserPathSafe(userId, dirPath);
  await mkdir(resolved, { recursive: true });
}

export async function createEmptyFile(
  userId: string,
  filePath: string,
): Promise<void> {
  const resolved = await resolveUserPathSafe(userId, filePath);
  await mkdir(path.dirname(resolved), { recursive: true });
  const handle = await open(resolved, "wx");
  await handle.close();
}

export async function moveItem(
  userId: string,
  sourcePath: string,
  targetDir: string,
  targetName?: string,
): Promise<void> {
  const resolvedSource = await resolveUserPathSafe(userId, sourcePath);
  const sourceName = targetName ? sanitizeFilename(targetName) : path.basename(resolvedSource);
  if (!sourceName) {
    throw new Error("Invalid filename");
  }
  const resolvedTargetDir = await resolveUserPathSafe(userId, targetDir || "");
  const resolvedDest = path.join(resolvedTargetDir, sourceName);

  // Ensure destination is also within user root
  const root = getUserDataRoot(userId);
  if (!resolvedDest.startsWith(root + "/") && resolvedDest !== root) {
    throw new PathTraversalError();
  }

  // Don't move to same location
  if (resolvedSource === resolvedDest) return;

  try {
    await lstat(resolvedDest);
    const error = new Error("Destination already exists") as NodeJS.ErrnoException;
    error.code = "EEXIST";
    throw error;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  // Can't move a directory into its own subtree
  const sourceStats = await lstat(resolvedSource);
  if (
    sourceStats.isDirectory() &&
    resolvedDest.startsWith(resolvedSource + "/")
  ) {
    throw new Error("Cannot move a directory into itself");
  }

  await mkdir(resolvedTargetDir, { recursive: true });
  await rename(resolvedSource, resolvedDest);
}

function writeOctal(
  header: Buffer,
  value: number,
  offset: number,
  length: number,
) {
  const text = value.toString(8).padStart(length - 1, "0").slice(-(length - 1));
  header.write(text, offset, length - 1, "ascii");
  header[offset + length - 1] = 0;
}

function createTarHeader(name: string, s: Stats, type: "file" | "directory" | "pax", size = s.size) {
  const header = Buffer.alloc(512, 0);
  const safeName = name.replace(/^\/+/, "");
  if (Buffer.byteLength(safeName) > 100) throw new Error("TAR header path requires PAX metadata");
  header.write(safeName, 0, 100, "utf8");
  writeOctal(header, type === "directory" ? 0o755 : 0o644, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, type === "directory" ? 0 : size, 124, 12);
  writeOctal(header, Math.floor(s.mtimeMs / 1000), 136, 12);
  header.fill(" ", 148, 156);
  header[156] = (type === "directory" ? "5" : type === "pax" ? "x" : "0").charCodeAt(0);
  header.write("ustar", 257, 5, "ascii");
  header.write("00", 263, 2, "ascii");

  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeOctal(header, checksum, 148, 8);
  return header;
}

function* createTarHeaders(name: string, stats: Stats, type: "file" | "directory") {
  if (Buffer.byteLength(name) <= 100) {
    yield createTarHeader(name, stats, type);
    return;
  }
  // POSIX PAX records count UTF-8 bytes, including their own length prefix.
  const field = ` path=${name}\n`;
  let length = Buffer.byteLength(field) + 1;
  while (length !== Buffer.byteLength(field) + String(length).length) {
    length = Buffer.byteLength(field) + String(length).length;
  }
  const record = Buffer.from(`${length}${field}`);
  yield createTarHeader("PaxHeader", stats, "pax", record.length);
  yield record;
  if (record.length % 512) yield Buffer.alloc(512 - record.length % 512);
  yield createTarHeader("entry", stats, type);
}

async function* createDirectoryTarStream(root: string, archiveName: string) {
  async function* walk(
    current: string,
    archivePath: string,
  ): AsyncGenerator<Buffer> {
    const s = await lstat(current);
    if (s.isSymbolicLink()) return;
    if (s.isDirectory()) {
      const dirName = archivePath.endsWith("/") ? archivePath : `${archivePath}/`;
      yield* createTarHeaders(dirName, s, "directory");

      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const childPath = path.join(current, entry.name);
        const childArchivePath = `${dirName}${entry.name}`;
        yield* walk(childPath, childArchivePath);
      }
      return;
    }

    if (!s.isFile()) return;
    yield* createTarHeaders(archivePath, s, "file");
    for await (const chunk of createReadStream(current)) {
      yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    }
    const remainder = s.size % 512;
    if (remainder !== 0) {
      yield Buffer.alloc(512 - remainder, 0);
    }
  }

  yield* walk(root, archiveName);
  yield Buffer.alloc(1024, 0);
}

export async function getItemDownloadStream(
  userId: string,
  itemPath: string,
): Promise<DownloadStreamInfo> {
  const resolved = await resolveUserPathSafe(userId, itemPath);
  const s = await stat(resolved);
  const filename = path.basename(resolved);

  if (s.isDirectory()) {
    return {
      stream: Readable.from(
        createDirectoryTarStream(resolved, filename || "userdata"),
      ),
      filename: `${filename || "userdata"}.tar`,
      contentType: "application/x-tar",
    };
  }

  if (!s.isFile()) {
    throw new Error("Not a file");
  }

  return {
    stream: createReadStream(resolved),
    stat: s,
    filename,
    contentType: "application/octet-stream",
  };
}

export async function saveUploadedFile(
  userId: string,
  targetDir: string,
  filename: string,
  data: Buffer | AsyncIterable<Buffer>,
): Promise<string> {
  const safe = sanitizeFilename(filename);
  if (!safe) {
    throw new Error("Invalid filename");
  }

  const dirResolved = await resolveUserPathSafe(userId, targetDir || "");
  await mkdir(dirResolved, { recursive: true });

  const dest = path.join(dirResolved, safe);
  const root = getUserDataRoot(userId);
  if (!dest.startsWith(root + "/")) {
    throw new PathTraversalError();
  }

  const handle = await open(dest, "wx");
  try {
    if (Buffer.isBuffer(data)) {
      await handle.writeFile(data);
      await handle.close();
    } else {
      await pipeline(data, handle.createWriteStream());
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(dest).catch(() => undefined);
    throw error;
  }

  return toWorkspacePath(userId, dest);
}

export interface TextFileContent {
  content: string;
  size: number;
  modified_at: number;
  encoding: "utf-8";
}

export async function readTextFile(
  userId: string,
  filePath: string,
  maxBytes = 2 * 1024 * 1024,
): Promise<TextFileContent> {
  const resolved = await resolveUserPathSafe(userId, filePath);
  const s = await stat(resolved);

  if (!s.isFile()) {
    throw new Error("Not a file");
  }

  if (s.size > maxBytes) {
    throw new PayloadTooLargeError(maxBytes, s.size);
  }

  const buffer = await readFile(resolved);

  // Treat NUL byte as binary marker
  if (buffer.includes(0)) {
    throw new BinaryFileError();
  }

  // Decode strictly: throw on invalid UTF-8
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new BinaryFileError();
  }

  return {
    content,
    size: s.size,
    modified_at: Math.floor(s.mtimeMs / 1000),
    encoding: "utf-8",
  };
}

export async function writeTextFile(
  userId: string,
  filePath: string,
  content: string,
  expectedModifiedAt?: number,
): Promise<{ size: number; modified_at: number }> {
  const resolved = await resolveUserPathSafe(userId, filePath);

  let preExisting: Stats | null = null;
  try {
    preExisting = await stat(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  if (preExisting) {
    if (!preExisting.isFile()) {
      throw new Error("Not a file");
    }
    if (expectedModifiedAt !== undefined) {
      const currentMtime = Math.floor(preExisting.mtimeMs / 1000);
      if (currentMtime !== expectedModifiedAt) {
        throw new StaleFileError(currentMtime);
      }
    }
  }

  await mkdir(path.dirname(resolved), { recursive: true });

  // Atomic write: tmp file in same dir, then rename
  const tmpPath = `${resolved}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmpPath, content, "utf-8");
    await rename(tmpPath, resolved);
  } catch (error) {
    await unlink(tmpPath).catch(() => undefined);
    throw error;
  }

  const finalStat = await stat(resolved);
  return {
    size: finalStat.size,
    modified_at: Math.floor(finalStat.mtimeMs / 1000),
  };
}

export async function removeUserDataDir(userId: string): Promise<void> {
  // Explicit deletion removes this user's workspace, state, and managed
  // snapshots together. Runtime recreation never calls this function.
  await rm(getUserPaths(userId, config).root, { recursive: true, force: true });
}

// Hidden staging folder (under each user's workspace root) that the chat
// composer uploads land in. Must match CHAT_UPLOAD_DIR on the web side.
export const CHAT_UPLOAD_DIR_NAME = ".chat-uploads";

/**
 * Prune chat-composer uploads older than `ttlHours` across every user's
 * `.chat-uploads/` staging folder. opencode never stages these itself — they
 * exist only because we need a real on-disk file behind each `file://` prompt
 * part — so the api owns their lifecycle. Best-effort: a failure on one user's
 * folder never aborts the others. Returns the number of entries removed.
 */
export async function pruneChatUploads(ttlHours: number): Promise<number> {
  if (!Number.isFinite(ttlHours) || ttlHours <= 0) {
    return 0;
  }
  const cutoff = Date.now() - ttlHours * 60 * 60 * 1000;

  let userDirs: string[];
  try {
    const entries = await readdir(path.join(config.dataRoot, "users"), {
      withFileTypes: true,
    });
    userDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((userId) => {
        try {
          assertSafeUserId(userId);
          return true;
        } catch {
          return false;
        }
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }

  let removed = 0;
  for (const userId of userDirs) {
    let uploadRoot: string;
    let batches;
    try {
      uploadRoot = await resolveUserPathSafe(userId, CHAT_UPLOAD_DIR_NAME);
      batches = await readdir(uploadRoot, { withFileTypes: true });
    } catch {
      // No staging folder for this user (or unreadable) — skip.
      continue;
    }
    for (const batch of batches) {
      const entryPath = path.join(uploadRoot, batch.name);
      try {
        const info = await lstat(entryPath);
        if (info.isSymbolicLink()) {
          continue;
        }
        if (info.mtimeMs >= cutoff) {
          continue;
        }
        await rm(entryPath, { recursive: true, force: true });
        removed += 1;
      } catch {
        // Entry vanished or could not be removed — ignore and continue.
      }
    }
  }
  return removed;
}
