import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile, stat, utimes, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// file-service captures config at import time, so point DATA_ROOT at a temp
// directory before loading the module.
const dataRoot = mkdtempSync(path.join(os.tmpdir(), "opshelper-uploads-"));
process.env.DATA_ROOT = dataRoot;

type FileService = typeof import("./file-service");
let cached: FileService | null = null;
async function loadFileService(): Promise<FileService> {
  if (!cached) cached = await import("./file-service");
  return cached;
}

async function makeUpload(
  dir: string,
  userId: string,
  batch: string,
  ageHours: number,
) {
  const batchDir = path.join(dataRoot, "users", userId, "workspace", dir, batch);
  await mkdir(batchDir, { recursive: true });
  await writeFile(path.join(batchDir, "doc.txt"), "x");
  const when = new Date(Date.now() - ageHours * 60 * 60 * 1000);
  // mtime on the batch folder is what the sweep checks.
  await utimes(batchDir, when, when);
  return batchDir;
}

test("pruneChatUploads removes batches older than the TTL, keeps fresh ones", async () => {
  const { pruneChatUploads, CHAT_UPLOAD_DIR_NAME } = await loadFileService();
  const stale = await makeUpload(CHAT_UPLOAD_DIR_NAME, "user-a", "old", 200); // > 168h
  const fresh = await makeUpload(CHAT_UPLOAD_DIR_NAME, "user-a", "new", 1); // recent
  const otherUser = await makeUpload(CHAT_UPLOAD_DIR_NAME, "user-b", "old", 300);

  const removed = await pruneChatUploads(168);

  assert.equal(removed, 2);
  await assert.rejects(stat(stale));
  await assert.rejects(stat(otherUser));
  const keep = await stat(fresh);
  assert.ok(keep.isDirectory());
});

test("pruneChatUploads is a no-op when TTL is 0 or negative", async () => {
  const { pruneChatUploads, CHAT_UPLOAD_DIR_NAME } = await loadFileService();
  await makeUpload(CHAT_UPLOAD_DIR_NAME, "user-c", "old", 500);
  assert.equal(await pruneChatUploads(0), 0);
  assert.equal(await pruneChatUploads(-5), 0);
  const entries = await readdir(
    path.join(dataRoot, "users", "user-c", "workspace", CHAT_UPLOAD_DIR_NAME),
  );
  assert.deepEqual(entries, ["old"]);
  const { rm } = await import("node:fs/promises");
  await rm(path.join(dataRoot, "users", "user-c"), {
    recursive: true,
    force: true,
  });
});

test("pruneChatUploads never follows symlinks out of a workspace", async () => {
  const { pruneChatUploads, CHAT_UPLOAD_DIR_NAME } = await loadFileService();
  const outside = path.join(dataRoot, "outside");
  await mkdir(outside, { recursive: true });
  const sentinel = path.join(outside, "keep.txt");
  await writeFile(sentinel, "keep");

  const uploadRoot = path.join(
    dataRoot,
    "users",
    "user-link",
    "workspace",
    CHAT_UPLOAD_DIR_NAME,
  );
  await mkdir(uploadRoot, { recursive: true });
  const { symlink } = await import("node:fs/promises");
  const link = path.join(uploadRoot, "old-link");
  await symlink(outside, link);
  const when = new Date(Date.now() - 500 * 60 * 60 * 1000);
  await utimes(link, when, when).catch(() => undefined);

  assert.equal(await pruneChatUploads(168), 0);
  assert.equal(await stat(sentinel).then((value) => value.isFile()), true);
  assert.equal(await stat(link).then((value) => value.isDirectory()), true);
});

test("pruneChatUploads rejects an upload-root symlink", async () => {
  const { pruneChatUploads, CHAT_UPLOAD_DIR_NAME } = await loadFileService();
  const outside = path.join(dataRoot, "outside-upload-root");
  const stale = path.join(outside, "old");
  await mkdir(stale, { recursive: true });
  await writeFile(path.join(stale, "keep.txt"), "keep");
  const when = new Date(Date.now() - 500 * 60 * 60 * 1000);
  await utimes(stale, when, when);

  const workspace = path.join(dataRoot, "users", "user-root-link", "workspace");
  await mkdir(workspace, { recursive: true });
  const { symlink } = await import("node:fs/promises");
  await symlink(outside, path.join(workspace, CHAT_UPLOAD_DIR_NAME));

  assert.equal(await pruneChatUploads(168), 0);
  assert.equal(await stat(path.join(stale, "keep.txt")).then((value) => value.isFile()), true);
});
