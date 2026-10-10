import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import {
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test, { after } from "node:test";

const dataRoot = mkdtempSync(path.join(os.tmpdir(), "opshelper-files-"));
const outsideRoot = mkdtempSync(path.join(os.tmpdir(), "opshelper-outside-"));
process.env.DATA_ROOT = dataRoot;
process.env.OPENCODE_WORKING_DIR = "/workspace";

type FileService = typeof import("./file-service");
let cached: FileService | null = null;
async function loadFileService(): Promise<FileService> {
  if (!cached) cached = await import("./file-service");
  return cached;
}

after(async () => {
  await rm(dataRoot, { recursive: true, force: true });
  await rm(outsideRoot, { recursive: true, force: true });
});

test("file operations stay in data/users/<id>/workspace", async () => {
  const service = await loadFileService();
  assert.equal(
    service.getUserDataRoot("user-1"),
    path.join(dataRoot, "users", "user-1", "workspace"),
  );
  assert.equal(
    service.getUserStateRoot("user-1"),
    path.join(dataRoot, "users", "user-1", "state"),
  );

  await service.createDirectory("user-1", "/workspace/docs");
  await service.createEmptyFile("user-1", "docs/empty.txt");
  await service.writeTextFile("user-1", "docs/note.txt", "hello");
  assert.equal((await service.readTextFile("user-1", "/workspace/docs/note.txt")).content, "hello");

  await service.moveItem("user-1", "docs/note.txt", "", "renamed.txt");
  const listed = await service.listDirectory("user-1", "");
  assert.deepEqual(listed.map(({ name, type }) => ({ name, type })), [
    { name: "docs", type: "directory" },
    { name: "renamed.txt", type: "file" },
  ]);
  await service.deleteItem("user-1", "renamed.txt");
  await assert.rejects(stat(path.join(service.getUserDataRoot("user-1"), "renamed.txt")));
});

test("absolute paths are accepted only under /workspace", async () => {
  const { PathTraversalError, resolveUserPathSafe } = await loadFileService();
  assert.equal(
    await resolveUserPathSafe("user-2", "/workspace/report.txt"),
    path.join(dataRoot, "users", "user-2", "workspace", "report.txt"),
  );

  for (const value of ["/etc/passwd", "/root/workspace/old.txt", "C:\\secret.txt", "../state", "/workspace/../state"]) {
    await assert.rejects(resolveUserPathSafe("user-2", value), PathTraversalError);
  }
  await assert.rejects(resolveUserPathSafe("user-2", "bad\0name"), PathTraversalError);
  assert.equal(
    await resolveUserPathSafe("user-2", "%2e%2e/state"),
    path.join(dataRoot, "users", "user-2", "workspace", "%2e%2e", "state"),
  );
  await assert.rejects(resolveUserPathSafe("../user-2", "report.txt"), /Invalid user ID/);
});

test("nonexistent descendants below an escaping symlink are rejected", async () => {
  const { PathTraversalError, ensureUserDataDir, getUserDataRoot, resolveUserPathSafe } = await loadFileService();
  await ensureUserDataDir("user-3");
  await symlink(outsideRoot, path.join(getUserDataRoot("user-3"), "escape"));
  await assert.rejects(
    resolveUserPathSafe("user-3", "escape/new/secret.txt"),
    PathTraversalError,
  );
});

test("a symlink cannot replace the workspace root", async () => {
  const { PathTraversalError, resolveUserPathSafe } = await loadFileService();
  const userRoot = path.join(dataRoot, "users", "user-root-symlink");
  await mkdir(userRoot, { recursive: true });
  await symlink(outsideRoot, path.join(userRoot, "workspace"));
  await assert.rejects(
    resolveUserPathSafe("user-root-symlink", "secret.txt"),
    PathTraversalError,
  );
});

test("a symlink cannot replace a user root", async () => {
  const { PathTraversalError, resolveUserPathSafe } = await loadFileService();
  await mkdir(path.join(dataRoot, "users"), { recursive: true });
  await symlink(outsideRoot, path.join(dataRoot, "users", "user-root-link"));
  await assert.rejects(
    resolveUserPathSafe("user-root-link", "secret.txt"),
    PathTraversalError,
  );
});

test("listDirectory does not expose symlink targets", async () => {
  const { ensureUserDataDir, getUserDataRoot, listDirectory } = await loadFileService();
  await ensureUserDataDir("user-4");
  await writeFile(path.join(outsideRoot, "secret.txt"), "secret");
  await symlink(
    path.join(outsideRoot, "secret.txt"),
    path.join(getUserDataRoot("user-4"), "secret-link"),
  );
  assert.deepEqual(await listDirectory("user-4", "", true), []);
});

test("uploads never overwrite an existing file", async () => {
  const { getUserDataRoot, saveUploadedFile } = await loadFileService();
  assert.equal(
    await saveUploadedFile("user-5", "uploads", "report.txt", Buffer.from("first")),
    "/workspace/uploads/report.txt",
  );
  await assert.rejects(
    saveUploadedFile("user-5", "uploads", "report.txt", Buffer.from("second")),
    (error: NodeJS.ErrnoException) => error.code === "EEXIST",
  );
  assert.equal(
    await readFile(path.join(getUserDataRoot("user-5"), "uploads", "report.txt"), "utf8"),
    "first",
  );
  assert.equal(
    await saveUploadedFile(
      "user-5",
      "uploads",
      "stream.txt",
      Readable.from([Buffer.from("streamed")]),
    ),
    "/workspace/uploads/stream.txt",
  );
  assert.equal(
    await readFile(path.join(getUserDataRoot("user-5"), "uploads", "stream.txt"), "utf8"),
    "streamed",
  );
});

test("removeUserDataDir removes workspace, state, and managed together", async () => {
  const { ensureUserDataDir, ensureUserStateDir, getUserDataRoot, getUserStateRoot, removeUserDataDir } = await loadFileService();
  await ensureUserDataDir("user-6");
  await ensureUserStateDir("user-6");
  const userRoot = path.dirname(getUserDataRoot("user-6"));
  await mkdir(path.join(userRoot, "managed", "releases", "abc"), { recursive: true });
  await removeUserDataDir("user-6");
  await assert.rejects(stat(getUserDataRoot("user-6")));
  await assert.rejects(stat(getUserStateRoot("user-6")));
  await assert.rejects(stat(path.join(userRoot, "managed")));
});


test("directory downloads preserve long Unicode paths in standard TAR readers", async () => {
  const service = await loadFileService();
  const userId = "archive-user";
  const directory = "nested/" + "目录".repeat(25);
  const filenames = ["文件".repeat(30) + "-a.txt", "文件".repeat(30) + "-b.txt"];
  await service.createDirectory(userId, directory);
  for (const filename of filenames) await service.writeTextFile(userId, `${directory}/${filename}`, filename);
  const download = await service.getItemDownloadStream(userId, "nested");
  const chunks: Buffer[] = [];
  for await (const chunk of download.stream) chunks.push(Buffer.from(chunk));
  const archivePath = path.join(dataRoot, "unicode.tar");
  await writeFile(archivePath, Buffer.concat(chunks));
  const extracted = path.join(dataRoot, "unicode-extracted");
  await mkdir(extracted);
  execFileSync("tar", ["-xf", archivePath, "-C", extracted]);
  for (const filename of filenames) {
    const archived = `${directory}/${filename}`;
    assert.equal(await readFile(path.join(extracted, archived), "utf8"), filename);
  }
});
