import path from "node:path";

import { type AppConfig, loadConfig } from "./config";

export interface UserPaths {
  root: string;
  workspace: string;
  state: string;
  managed: string;
}

const SAFE_USER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function assertSafeUserId(userId: string): void {
  if (!SAFE_USER_ID.test(userId)) {
    throw new Error("Invalid user ID");
  }
}

function buildUserPaths(dataRoot: string, userId: string): UserPaths {
  assertSafeUserId(userId);
  const root = path.join(dataRoot, "users", userId);
  return {
    root,
    workspace: path.join(root, "workspace"),
    state: path.join(root, "state"),
    managed: path.join(root, "managed"),
  };
}

export function getUserPaths(
  userId: string,
  config: AppConfig = loadConfig(),
): UserPaths {
  return buildUserPaths(config.dataRoot, userId);
}

export function getHostUserPaths(
  userId: string,
  config: AppConfig = loadConfig(),
): UserPaths {
  return buildUserPaths(config.dataRootHost, userId);
}
