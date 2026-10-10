import { randomBytes } from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthenticatedUser } from "@opshelper/shared";

import { loadConfig } from "./config";
import { prisma } from "./prisma";
import { verifyPassword } from "./password";

const config = loadConfig();

function cookieOptions(expiresAt: Date) {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    expires: expiresAt,
  };
}

interface CreatedSession {
  token: string;
  expiresAt: Date;
}

function toAuthenticatedUser(input: {
  id: string;
  username: string;
  name: string;
  role: "USER" | "ADMIN";
}): AuthenticatedUser {
  return {
    id: input.id,
    username: input.username,
    name: input.name,
    role: input.role === "ADMIN" ? "admin" : "user",
  };
}

export function normalizeUsername(username: string) {
  return username.trim().toLowerCase();
}

export function extractBearerToken(
  authorizationHeader?: string | string[] | null,
) {
  const headerValue = Array.isArray(authorizationHeader)
    ? authorizationHeader[0]
    : authorizationHeader;

  if (!headerValue) {
    return null;
  }

  const [scheme, token] = headerValue.trim().split(/\s+/, 2);

  if (!scheme || !token || scheme.toLowerCase() !== "bearer") {
    return null;
  }

  return token;
}

async function createSessionRecord(userId: string): Promise<CreatedSession> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(
    Date.now() + config.sessionTtlHours * 60 * 60 * 1000,
  );

  await prisma.session.create({
    data: {
      token,
      userId,
      expiresAt,
    },
  });

  return {
    token,
    expiresAt,
  };
}

export async function createSession(reply: FastifyReply, userId: string) {
  const session = await createSessionRecord(userId);

  reply.setCookie(
    config.sessionCookieName,
    session.token,
    cookieOptions(session.expiresAt),
  );

  return session;
}

export async function clearSession(
  request: FastifyRequest,
  reply: FastifyReply,
  sessions: Pick<typeof prisma.session, "deleteMany"> = prisma.session,
) {
  const tokens = [...new Set([
    extractBearerToken(request.headers.authorization),
    request.cookies[config.sessionCookieName],
  ].filter((token): token is string => Boolean(token)))];

  if (tokens.length) {
    await sessions.deleteMany({
      where: { token: { in: tokens } },
    });
  }

  reply.clearCookie(config.sessionCookieName, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
  });
}

export async function authenticateWithPassword(
  username: string,
  password: string,
) {
  const normalizedUsername = normalizeUsername(username);
  const user =
    (await prisma.user.findUnique({
      where: { username: normalizedUsername },
    })) ??
    (normalizedUsername.includes("@")
      ? null
      : await prisma.user.findFirst({
          where: {
            username: {
              startsWith: `${normalizedUsername}@`,
            },
          },
          orderBy: {
            createdAt: "asc",
          },
        }));

  if (!user || !user.isActive) {
    return null;
  }

  const isValid = await verifyPassword(password, user.passwordHash);

  if (!isValid) {
    return null;
  }

  return toAuthenticatedUser(user);
}

export async function getSessionUserByToken(token?: string | null) {
  if (!token) {
    return null;
  }

  const session = await prisma.session.findUnique({
    where: { token },
    include: {
      user: true,
    },
  });

  if (!session) {
    return null;
  }

  if (session.expiresAt.getTime() <= Date.now() || !session.user.isActive) {
    await prisma.session.deleteMany({
      where: { token },
    });
    return null;
  }

  const updated = await prisma.session.updateMany({
    where: { id: session.id, expiresAt: { gt: new Date() } },
    data: {
      lastSeenAt: new Date(),
    },
  });

  if (updated.count === 0) return null;

  return {
    sessionId: session.id,
    user: toAuthenticatedUser(session.user),
  };
}

export async function getSessionUserFromRequest(request: FastifyRequest) {
  const token =
    extractBearerToken(request.headers.authorization) ??
    request.cookies[config.sessionCookieName] ??
    null;
  return getSessionUserByToken(token);
}

export async function requireSession(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const auth = await getSessionUserFromRequest(request);

  if (!auth) {
    await reply.code(401).send({ message: "Unauthorized" });
    return null;
  }

  return auth.user;
}

export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const user = await requireSession(request, reply);

  if (!user) {
    return null;
  }

  if (user.role !== "admin") {
    await reply.code(403).send({ message: "Admin access required" });
    return null;
  }

  return user;
}

export function getSessionCookieName() {
  return config.sessionCookieName;
}
