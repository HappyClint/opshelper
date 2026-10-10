import assert from "node:assert/strict";
import { test } from "node:test";
import type Docker from "dockerode";

import { loadConfig } from "./config";
import { buildContainerCreateOptions, isStaleRuntime } from "./opencode-container-runtime";

const config = { ...loadConfig(), dataRoot: "/data", dataRootHost: "/srv/opshelper/data" };
const runtime = { generation: "a".repeat(24), password: "b".repeat(64), agentKeys: ["network", "system"], model: "fixture/model", desiredGeneration: 1 };
const build = (userId = "user-a") => buildContainerCreateOptions({
  record: { name: `opshelper-user-${userId}`, image: "opshelper/runtime:test", userId }, runtime, config,
});

test("两个智能体只装进一个用户容器，数据bind指向宿主目录且只装配用户子集", () => {
  const options = build();
  assert.deepEqual(options.ExposedPorts, { "4096/tcp": {} });
  assert.equal(options.HostConfig?.Binds?.length, 3);
  assert.deepEqual(options.HostConfig?.Binds, [
    "/srv/opshelper/data/users/user-a/workspace:/workspace:rw",
    "/srv/opshelper/data/users/user-a/state:/state:rw",
    `/srv/opshelper/data/users/user-a/managed/releases/${runtime.generation}:/opt/opshelper:ro`,
  ]);
  assert.equal(options.HostConfig?.PortBindings, undefined);
  assert.equal(options.HostConfig?.ReadonlyRootfs, true);
  assert.equal(options.User, "1000:1000");
  assert.equal(options.HostConfig?.NetworkMode, "opshelper-runtime");
  assert.deepEqual(options.HostConfig?.CapDrop, ["ALL"]);
  assert.equal(options.HostConfig?.Binds?.some((bind) => /docker.sock|postgres|\/data\/agents:/.test(bind)), false);
});

test("用户B挂载完全独立的workspace/state，配置目录不可由用户选择", () => {
  const first = build("user-a").HostConfig!.Binds!;
  const second = build("user-b").HostConfig!.Binds!;
  assert.ok(second.every((bind) => bind.includes("/users/user-b/")));
  assert.ok(second.every((bind) => !first.includes(bind)));
  assert.throws(() => build("../user-b"));
});

test("安全参数漂移会要求重建，镜像内置PATH不会导致每次启动都重建", () => {
  const options = build();
  const inspect = {
    Config: { Cmd: options.Cmd, Env: [...options.Env!, "PATH=/usr/bin"], User: options.User },
    HostConfig: structuredClone(options.HostConfig),
  } as Docker.ContainerInspectInfo;
  assert.equal(isStaleRuntime(inspect, options, ["PATH=/usr/bin"]), false);
  inspect.Config.Env!.push("OPENCODE_CONFIG_CONTENT={\"agent\":{\"rogue\":{}}}");
  assert.equal(isStaleRuntime(inspect, options, ["PATH=/usr/bin"]), true);
  inspect.Config.Env!.pop();
  inspect.HostConfig.ReadonlyRootfs = false;
  assert.equal(isStaleRuntime(inspect, options, ["PATH=/usr/bin"]), true);
});
