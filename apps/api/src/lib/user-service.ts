import {
  type AdminUsersSnapshot,
  formatDateLabel,
} from "@opshelper/shared";
import { Prisma, type User } from "@prisma/client";

import { deleteContainerByUserId } from "./container-service";
import { removeUserDataDir } from "./file-service";
import { hashPassword } from "./password";
import { prisma } from "./prisma";
import { toRole } from "./serializers";
import { normalizeUsername } from "./session";
import { withAdminMutationLock } from "./user-config-lock";

interface AdminMutationServices {
  lock: typeof withAdminMutationLock;
  actor: (userId: string) => Promise<Pick<User, "role" | "isActive"> | null>;
}

const adminMutationServices: AdminMutationServices = {
  lock: withAdminMutationLock,
  actor: (id) => prisma.user.findUnique({ where: { id } }),
};

export async function withAdminAccountMutation<T>(
  actorUserId: string,
  callback: () => Promise<T>,
  services: AdminMutationServices = adminMutationServices,
) {
  return services.lock(async () => {
    const actor = await services.actor(actorUserId);
    if (!actor?.isActive || actor.role !== "ADMIN") {
      throw new Error("管理员权限已变更，请重新登录");
    }
    return callback();
  });
}

function serializeUserSummary(user: User) {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: toRole(user.role),
    isActive: user.isActive,
    keepContainerAlive: user.keepContainerAlive,
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

export async function getUserById(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
  });
}

export async function createUserAccount(input: {
  username: string;
  password: string;
  name?: string;
  role?: "user" | "admin";
  isActive?: boolean;
  keepContainerAlive?: boolean;
}) {
  const username = normalizeUsername(input.username);
  const passwordHash = await hashPassword(input.password);
  const displayName = input.name?.trim() || username;
  const role: "USER" | "ADMIN" = input.role === "admin" ? "ADMIN" : "USER";

  const user = await prisma.user.create({
    data: {
      username,
      name: displayName,
      passwordHash,
      role,
      isActive: input.isActive ?? true,
      keepContainerAlive: input.keepContainerAlive ?? false,
    },
  });

  return serializeUserSummary(user);
}

function buildUserSearchWhere(query?: string) {
  const normalizedQuery = query?.trim();

  if (!normalizedQuery) {
    return undefined;
  }

  return {
    OR: [
      {
        username: {
          contains: normalizedQuery,
          mode: "insensitive" as const,
        },
      },
      {
        name: {
          contains: normalizedQuery,
          mode: "insensitive" as const,
        },
      },
    ],
  };
}

export async function getAdminUsersSnapshot(
  query = "",
): Promise<AdminUsersSnapshot> {
  const users = await prisma.user.findMany({
    where: buildUserSearchWhere(query),
    orderBy: [
      {
        createdAt: "desc",
      },
    ],
  });

  return {
    query: query.trim(),
    total: users.length,
    users: users.map(serializeUserSummaryWithLabel),
  };
}

async function ensureAdminMutationAllowed(input: {
  actorUserId: string;
  targetUser: User;
  nextRole?: "USER" | "ADMIN";
  nextIsActive?: boolean;
}, database: Pick<Prisma.TransactionClient, "user"> = prisma) {
  const nextRole = input.nextRole ?? input.targetUser.role;
  const nextIsActive = input.nextIsActive ?? input.targetUser.isActive;
  const isDemotingLastActiveAdmin =
    input.targetUser.role === "ADMIN" &&
    (nextRole !== "ADMIN" || !nextIsActive);

  if (!isDemotingLastActiveAdmin) {
    return;
  }

  if (input.actorUserId === input.targetUser.id) {
    throw new Error("不能停用或降级当前登录管理员");
  }

  const activeAdmins = await database.user.count({
    where: {
      role: "ADMIN",
      isActive: true,
    },
  });

  if (activeAdmins <= 1) {
    throw new Error("至少需要保留一个启用状态的管理员账号");
  }
}

export async function updateUserAccount(input: {
  actorUserId: string;
  userId: string;
  username?: string;
  password?: string;
  name?: string;
  role?: "user" | "admin";
  isActive?: boolean;
  keepContainerAlive?: boolean;
}, database: Pick<Prisma.TransactionClient, "user"> = prisma) {
  const existing = await database.user.findUnique({
    where: { id: input.userId },
  });

  if (!existing) {
    return null;
  }

  await ensureAdminMutationAllowed({
    actorUserId: input.actorUserId,
    targetUser: existing,
    nextRole: input.role === undefined ? undefined : input.role === "admin" ? "ADMIN" : "USER",
    nextIsActive: input.isActive,
  }, database);

  const data: Prisma.UserUpdateInput = {};

  if (input.username !== undefined) {
    data.username = normalizeUsername(input.username);
  }

  if (input.name !== undefined) {
    data.name = input.name.trim() || existing.name;
  }

  if (input.role !== undefined) {
    data.role = input.role === "admin" ? "ADMIN" : "USER";
  }

  if (input.isActive !== undefined) {
    data.isActive = input.isActive;
  }

  if (input.keepContainerAlive !== undefined) {
    data.keepContainerAlive = input.keepContainerAlive;
  }

  if (input.password) {
    data.passwordHash = await hashPassword(input.password);
  }

  const user = await database.user.update({
    where: { id: input.userId },
    data,
  });

  return serializeUserSummary(user);
}

export async function deleteUserAccount(input: {
  actorUserId: string;
  userId: string;
}) {
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
  });

  if (!user) {
    return null;
  }

  if (input.actorUserId === user.id) {
    throw new Error("不能删除当前登录账号");
  }

  await ensureAdminMutationAllowed({
    actorUserId: input.actorUserId,
    targetUser: user,
    nextIsActive: false,
    nextRole: "USER",
  });

  await deleteContainerByUserId(user.id);
  await removeUserDataDir(user.id);
  await prisma.user.delete({
    where: { id: user.id },
  });

  return serializeUserSummary(user);
}
