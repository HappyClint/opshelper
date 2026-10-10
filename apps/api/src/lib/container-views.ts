// Read/serialization layer over the container + user tables: it shapes the
// portal/admin snapshots and the small HTTP response envelopes the routes
// return. Kept separate from container-service.ts (which owns Docker lifecycle
// and persistence) so the "view" concerns don't bloat the runtime module — and
// so auth.ts can get a session response without importing the container engine.
import { ContainerStatus, type User } from "@prisma/client";
import {
  type AdminSnapshot,
  type AuthenticatedUser,
  type ContainerActionResponse,
  formatDateLabel,
  type SessionResponse,
  type UserPortalSnapshot,
} from "@opshelper/shared";

import { loadConfig } from "./config";
import { prisma } from "./prisma";
import {
  type ContainerWithUser,
  serializeActivity,
  serializeContainerWithLabels,
  toAuthedUser,
  toRole,
} from "./serializers";

const config = loadConfig();

function serializeUserSummary(user: User) {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: toRole(user.role),
    isActive: user.isActive,
    createdAt: user.createdAt.toISOString(),
  };
}

function serializeUserSummaryWithLabel(user: User) {
  const summary = serializeUserSummary(user);

  return {
    ...summary,
    createdAtLabel: formatDateLabel(summary.createdAt),
  };
}

export async function getUserPortalSnapshot(userId: string): Promise<UserPortalSnapshot> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
  });

  const container = await prisma.containerInstance.findUnique({
    where: { userId },
    include: {
      user: true,
    },
  });

  const activities = await prisma.containerActivity.findMany({
    where: {
      userId,
    },
    orderBy: {
      occurredAt: "desc",
    },
    take: 12,
  });

  const serializedContainer = container
    ? serializeContainerWithLabels(container)
    : null;

  return {
    user: toAuthedUser(user),
    container: serializedContainer,
    recentActivity: activities.map(serializeActivity),
  };
}

export async function getAdminSnapshot(): Promise<AdminSnapshot> {
  const [users, containers] = await Promise.all([
    prisma.user.findMany({
      orderBy: {
        createdAt: "asc",
      },
    }),
    prisma.containerInstance.findMany({
      include: {
        user: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    }),
  ]);

  const idleThreshold = Date.now() - config.idleTimeoutMinutes * 60 * 1000;
  const idleCandidates = containers.filter(
    (container) =>
      container.status === ContainerStatus.RUNNING &&
      !container.user.keepContainerAlive &&
      container.lastActivityAt &&
      container.lastActivityAt.getTime() <= idleThreshold,
  ).length;

  return {
    metrics: {
      totalUsers: users.length,
      runningContainers: containers.filter(
        (container) => container.status === ContainerStatus.RUNNING,
      ).length,
      idleCandidates,
    },
    users: users.map(serializeUserSummaryWithLabel),
    containers: containers.map(serializeContainerWithLabels),
    nextSteps: [
      "业务智能体统一放在 data/agents，检查通过后按用户分配。",
      "每位用户固定使用一个运行环境，同一用户的智能体共享工作目录并可协作。",
      "数据库、用户文件和运行状态均保存在部署目录 data 下，便于备份迁移。",
    ],
  };
}

export async function getSessionResponse(
  user: AuthenticatedUser | null,
): Promise<SessionResponse> {
  return {
    authenticated: Boolean(user),
    user,
  };
}

export function toContainerActionResponse(
  container: ContainerWithUser | null,
): ContainerActionResponse {
  return {
    container: container ? serializeContainerWithLabels(container) : null,
  };
}
