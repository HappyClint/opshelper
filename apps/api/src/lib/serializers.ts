import {
  type AuthenticatedUser,
  type ContainerSummary,
  formatDateLabel,
  toContainerStatus,
  toKindLabel,
} from "@opshelper/shared";
import {
  Prisma,
  type ContainerActivity,
  type User,
} from "@prisma/client";

export type ContainerWithUser = Prisma.ContainerInstanceGetPayload<{
  include: { user: true };
}>;

export function toRole(role: "USER" | "ADMIN"): "user" | "admin" {
  return role === "ADMIN" ? "admin" : "user";
}

export function toAuthedUser(user: User): AuthenticatedUser {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: toRole(user.role),
  };
}

export function serializeContainer(container: ContainerWithUser): ContainerSummary {
  return {
    id: container.id,
    ownerId: container.userId,
    ownerName: container.user.name,
    name: container.name,
    image: container.image,
    status: toContainerStatus(container.status),
    lastActivityAt: container.lastActivityAt?.toISOString() ?? null,
    lastStartedAt: container.lastStartedAt?.toISOString() ?? null,
    lastStoppedAt: container.lastStoppedAt?.toISOString() ?? null,
  };
}

export function serializeContainerWithLabels(container: ContainerWithUser) {
  const summary = serializeContainer(container);

  return {
    ...summary,
    lastActivityAtLabel: formatDateLabel(summary.lastActivityAt),
    lastStartedAtLabel: formatDateLabel(summary.lastStartedAt),
    lastStoppedAtLabel: formatDateLabel(summary.lastStoppedAt),
  };
}

export function serializeActivity(activity: ContainerActivity) {
  return {
    id: activity.id,
    containerId: activity.containerId,
    kind: activity.kind as "proxy" | "start" | "stop" | "delete",
    detail: activity.detail ?? "",
    occurredAt: activity.occurredAt.toISOString(),
    occurredAtLabel: formatDateLabel(activity.occurredAt.toISOString()),
    kindLabel: toKindLabel(activity.kind as "proxy" | "start" | "stop" | "delete"),
  };
}
