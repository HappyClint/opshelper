import assert from "node:assert/strict";
import test from "node:test";
import { Writable } from "node:stream";
import Fastify from "fastify";

import { redactRequestUrl, requestLoggerOptions } from "./request-logger";

test("request URLs redact encoded and repeated credential parameters", () => {
  const url = redactRequestUrl("/v1/auth/desktop-open?%5Ftoken=secret-one&_token=secret-two&API_KEY=secret-three&redirect=%2Fchat");
  assert.ok(!url.includes("secret-"));
  assert.match(url, /redirect=%2Fchat/);
  assert.equal(redactRequestUrl("/health"), "/health");
});

test("Fastify request logs never include desktop tokens or authentication headers", async () => {
  let log = "";
  const stream = new Writable({ write(chunk, _encoding, callback) { log += chunk.toString(); callback(); } });
  const app = Fastify({ logger: { ...requestLoggerOptions, stream } });
  app.get("/probe", async () => ({ ok: true }));
  await app.inject({ url: "/probe?_token=secret-query", headers: { authorization: "Bearer secret-header", cookie: "secret-cookie" } });
  await app.close();
  assert.match(log, /incoming request/);
  assert.ok(!log.includes("secret-"));
});
