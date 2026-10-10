import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  authenticateWithPassword,
  clearSession,
  createSession,
  getSessionCookieName,
  getSessionUserByToken,
  getSessionUserFromRequest,
  requireSession,
} from "../lib/session";
import { hashPassword, verifyPassword } from "../lib/password";
import { prisma } from "../lib/prisma";
import { getSessionResponse } from "../lib/container-views";

const loginSchema = z.object({
  username: z.string().trim().min(3).max(32),
  password: z.string().min(6),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6),
});

const desktopOpenSchema = z.object({
  _token: z.string().trim().min(1),
  redirect: z.string().trim().optional(),
});

export function resolveDesktopOpenRedirect(redirect?: string) {
  if (!redirect) {
    return "/gateway/";
  }

  if (!redirect.startsWith("/") || redirect.startsWith("//") || /[\\\u0000-\u0020]/.test(redirect)) {
    return "/gateway/";
  }

  return redirect;
}

export async function registerAuthRoutes(app: FastifyInstance) {
  app.post("/v1/auth/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid login payload" });
    }

    const user = await authenticateWithPassword(
      parsed.data.username,
      parsed.data.password,
    );

    if (!user) {
      return reply.code(401).send({ message: "Invalid credentials" });
    }

    const session = await createSession(reply, user.id);
    return {
      user,
      session: {
        token: session.token,
        tokenType: "Bearer" as const,
        expiresAt: session.expiresAt.toISOString(),
        cookieName: getSessionCookieName(),
      },
    };
  });

  app.get("/v1/auth/desktop-open", async (request, reply) => {
    reply.header("Referrer-Policy", "no-referrer").header("Cache-Control", "no-store");
    const parsed = desktopOpenSchema.safeParse(request.query);
    const redirectPath = resolveDesktopOpenRedirect(parsed.success ? parsed.data.redirect : undefined);

    if (!parsed.success) {
      return reply.redirect("/gateway/login");
    }

    const auth = await getSessionUserByToken(parsed.data._token);

    if (!auth) {
      return reply.redirect("/gateway/login");
    }

    await createSession(reply, auth.user.id);
    return reply.redirect(redirectPath);
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    await clearSession(request, reply);
    return reply.code(204).send();
  });

  app.get("/v1/auth/session", async (request) => {
    const auth = await getSessionUserFromRequest(request);
    return getSessionResponse(auth?.user ?? null);
  });

  app.put("/v1/auth/change-password", async (request, reply) => {
    const user = await requireSession(request, reply);
    if (!user) {
      return;
    }

    const parsed = changePasswordSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid payload" });
    }

    const { currentPassword, newPassword } = parsed.data;

    const dbUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: { passwordHash: true },
    });

    if (!dbUser) {
      return reply.code(404).send({ message: "User not found" });
    }

    const isValid = await verifyPassword(currentPassword, dbUser.passwordHash);
    if (!isValid) {
      return reply.code(401).send({ message: "Current password is incorrect" });
    }

    const newHash = await hashPassword(newPassword);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: newHash },
    });

    return reply.code(204).send();
  });

  app.get("/v1/auth/me", async (request, reply) => {
    const user = await requireSession(request, reply);

    if (!user) {
      return;
    }

    return { user };
  });
}
