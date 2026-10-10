import assert from "node:assert/strict";
import test from "node:test";

import { stopDockerContainerIfRunning } from "./docker-lifecycle";

test("stopping a runtime tolerates missing and already stopped containers", async () => {
  assert.equal(await stopDockerContainerIfRunning({ inspect: async () => { throw { statusCode: 404 }; }, stop: async () => {} }), false);
  assert.equal(await stopDockerContainerIfRunning({ inspect: async () => ({ State: { Running: false } }), stop: async () => { throw new Error("must not stop"); } }), false);
  assert.equal(await stopDockerContainerIfRunning({ inspect: async () => ({ State: { Running: true } }), stop: async () => { throw { statusCode: 304 }; } }), true);
});

test("Docker stop failures propagate without reporting a successful stop", async () => {
  for (const statusCode of [403, 500, 503]) {
    const error = Object.assign(new Error("daemon failure"), { statusCode });
    await assert.rejects(stopDockerContainerIfRunning({ inspect: async () => ({ State: { Running: true } }), stop: async () => { throw error; } }), (actual) => actual === error);
    await assert.rejects(stopDockerContainerIfRunning({ inspect: async () => { throw error; }, stop: async () => {} }), (actual) => actual === error);
  }
});
