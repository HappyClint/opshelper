import "server-only";

import { headers } from "next/headers";
import {
  type AdminAgentsSnapshot,
  type AdminSnapshot,
  type AdminUsersSnapshot,
  type ChatModelsResponse,
  type SessionResponse,
  type UserPortalSnapshot,
} from "@opshelper/shared";

const apiBaseUrl =
  process.env.OPSHELPER_API_INTERNAL_URL ?? "http://127.0.0.1:4000";

async function fetchJson<T>(path: string): Promise<T | null> {
  const incomingHeaders = await headers();
  const response = await fetch(`${apiBaseUrl}${path}`, {
    cache: "no-store",
    headers: {
      cookie: incomingHeaders.get("cookie") ?? "",
    },
  });

  if (response.status === 401) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Unexpected API response: ${response.status}`);
  }

  return (await response.json()) as T;
}

export async function getSession(): Promise<SessionResponse> {
  return (
    (await fetchJson<SessionResponse>("/v1/auth/session")) ?? {
      authenticated: false,
      user: null,
    }
  );
}

export async function getUserPortalSnapshot(): Promise<UserPortalSnapshot | null> {
  return fetchJson<UserPortalSnapshot>("/v1/users/me/portal");
}

export async function getChatModels(): Promise<ChatModelsResponse> {
  return (
    (await fetchJson<ChatModelsResponse>("/v1/users/me/models")) ?? {
      models: [],
      defaultModel: "",
    }
  );
}

export async function getAdminSnapshot(): Promise<AdminSnapshot | null> {
  return fetchJson<AdminSnapshot>("/v1/admin/overview");
}

export async function getAdminUsersSnapshot(
  query = "",
): Promise<AdminUsersSnapshot | null> {
  const search = query.trim()
    ? `?q=${encodeURIComponent(query.trim())}`
    : "";

  return fetchJson<AdminUsersSnapshot>(`/v1/admin/users${search}`);
}

export async function getAdminAgentsSnapshot(): Promise<AdminAgentsSnapshot | null> {
  return fetchJson<AdminAgentsSnapshot>("/v1/admin/agents");
}

export async function getUserAgentCatalogSnapshot(): Promise<AdminAgentsSnapshot | null> {
  return fetchJson<AdminAgentsSnapshot>("/v1/users/me/agent-catalog");
}

export function getSessionCookieName() {
  return process.env.OPSHELPER_SESSION_COOKIE_NAME ?? "opshelper_session";
}
