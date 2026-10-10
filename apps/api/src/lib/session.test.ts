import assert from "node:assert/strict";
import test from "node:test";
import type { FastifyReply, FastifyRequest } from "fastify";

import { clearSession, getSessionCookieName, getSessionUserFromRequest } from "./session";

function request(input: Partial<FastifyRequest>): FastifyRequest {
  return { headers: {}, cookies: {}, ...input } as FastifyRequest;
}

test("logout revokes both bearer and cookie sessions", async () => {
  const deleted: unknown[] = [];
  const sessions = { deleteMany: async (args: unknown) => { deleted.push(args); return { count: 2 }; } };
  let cleared = false;
  const reply = { clearCookie() { cleared = true; } } as unknown as FastifyReply;
  await clearSession(request({ headers: { authorization: "Bearer bearer-session" }, cookies: { [getSessionCookieName()]: "cookie-session" } }), reply, sessions as unknown as Parameters<typeof clearSession>[2]);
  assert.deepEqual(deleted, [{ where: { token: { in: ["bearer-session", "cookie-session"] } } }]);
  assert.equal(cleared, true);
});

test("ordinary API requests do not authenticate with query-string tokens", async () => {
  assert.equal(await getSessionUserFromRequest(request({ query: { _token: "url-credential" } })), null);
});
