import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import { registerEmptyJsonBodyParser } from "./empty-json-body-parser";

test("Fastify rejects empty JSON bodies before route handlers by default", async () => {
  const app = Fastify();

  app.post("/api/console/chat/stop", async () => ({ reached: true }));

  const response = await app.inject({
    method: "POST",
    url: "/api/console/chat/stop?chat_id=abc",
    headers: {
      "content-type": "application/json",
    },
  });

  assert.equal(response.statusCode, 400);
  assert.match(response.body, /FST_ERR_CTP_EMPTY_JSON_BODY/);

  await app.close();
});

test("registerEmptyJsonBodyParser lets empty JSON POST requests reach handlers", async () => {
  const app = Fastify();

  registerEmptyJsonBodyParser(app);
  app.post("/api/console/chat/stop", async (request) => ({
    bodyIsUndefined: request.body === undefined,
  }));

  const response = await app.inject({
    method: "POST",
    url: "/api/console/chat/stop?chat_id=abc",
    headers: {
      "content-type": "application/json",
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { bodyIsUndefined: true });

  await app.close();
});

test("registerEmptyJsonBodyParser keeps non-empty JSON parsing intact", async () => {
  const app = Fastify();

  registerEmptyJsonBodyParser(app);
  app.post("/api/echo", async (request) => request.body);

  const response = await app.inject({
    method: "POST",
    url: "/api/echo",
    headers: {
      "content-type": "application/json",
    },
    payload: JSON.stringify({ ok: true }),
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true });

  await app.close();
});
