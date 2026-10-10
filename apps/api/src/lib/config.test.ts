import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "./config";

const CONFIG_ENV_KEYS = [
  "DATA_ROOT",
  "DATA_ROOT_HOST",
  "OPSHELPER_DOCKER_NETWORK",
  "OPSHELPER_SESSION_COOKIE_NAME",
  "OPENCODE_RUNTIME_CPUS",
  "OPENCODE_RUNTIME_GID",
  "OPENCODE_RUNTIME_MEMORY_MB",
  "OPENCODE_RUNTIME_UID",
  "OPENCODE_WORKING_DIR",
  "OPSHELPER_EXECUTION_POLL_MS",
  "OPSHELPER_EXECUTION_TIMEOUT_MINUTES",
  "OPSHELPER_INTERACTION_TIMEOUT_MINUTES",
] as const;

async function withConfigEnv(
  values: Partial<Record<(typeof CONFIG_ENV_KEYS)[number], string>>,
  run: () => void | Promise<void>,
) {
  const previous = new Map<string, string | undefined>();
  for (const key of CONFIG_ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  Object.assign(process.env, values);

  try {
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("loadConfig uses the data and runtime defaults", async () => {
  await withConfigEnv({}, () => {
    const config = loadConfig();
    assert.equal(config.dataRoot, "/data");
    assert.equal(config.dataRootHost, path.resolve("data"));
    assert.equal(config.opencodeConfigPath, "/data/config/opencode");
    assert.equal(config.opencodeDirectory, "/workspace");
    assert.equal(config.dockerNetwork, "opshelper-runtime");
    assert.equal(config.runtimeUid, 1000);
    assert.equal(config.runtimeGid, 1000);
    assert.equal(config.runtimeMemoryMb, 2048);
    assert.equal(config.runtimeCpus, 2);
    assert.equal(config.executionPollMs, 1000);
    assert.equal(config.executionTimeoutMinutes, 30);
    assert.equal(config.interactionTimeoutMinutes, 30);
  });
});

test("loadConfig derives the shared model config path from DATA_ROOT", async () => {
  await withConfigEnv(
    {
      DATA_ROOT: "/srv/opshelper-data",
      DATA_ROOT_HOST: "/host/opshelper-data",
      OPENCODE_RUNTIME_UID: "501",
      OPENCODE_RUNTIME_GID: "20",
      OPENCODE_RUNTIME_MEMORY_MB: "4096",
      OPENCODE_RUNTIME_CPUS: "1.5",
    },
    () => {
      const config = loadConfig();
      assert.equal(config.opencodeConfigPath, "/srv/opshelper-data/config/opencode");
      assert.equal(config.runtimeUid, 501);
      assert.equal(config.runtimeGid, 20);
      assert.equal(config.runtimeMemoryMb, 4096);
      assert.equal(config.runtimeCpus, 1.5);
    },
  );
});

test("loadConfig treats empty environment values as unset", async () => {
  await withConfigEnv(
    {
      DATA_ROOT: "",
      DATA_ROOT_HOST: "  ",
      OPSHELPER_SESSION_COOKIE_NAME: "",
    },
    () => {
      const config = loadConfig();
      assert.equal(config.dataRoot, "/data");
      assert.equal(config.dataRootHost, path.resolve("data"));
      assert.equal(config.sessionCookieName, "opshelper_session");
    },
  );
});

test("loadConfig rejects relative data roots", async () => {
  await withConfigEnv({ DATA_ROOT_HOST: "./data" }, () => {
    assert.throws(() => loadConfig(), /absolute path/);
  });
});

test("loadConfig rejects root runtimes and alternate workspace mounts", async () => {
  await withConfigEnv({ OPENCODE_RUNTIME_UID: "0" }, () => {
    assert.throws(() => loadConfig());
  });
  await withConfigEnv({ OPENCODE_WORKING_DIR: "/root/workspace" }, () => {
    assert.throws(() => loadConfig());
  });
});
