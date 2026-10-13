import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "./config";
import type { AgentMcpServer } from "./agent-service";
import {
  type ManagedRuntimeServices,
  prepareManagedRuntime,
  readManagedRuntime,
  RuntimeNotConfiguredError,
} from "./managed-runtime";

test("装配只包含获配智能体，同一内容复用代次，重建保留密码与用户文件", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opshelper-managed-"));
  const config = { ...loadConfig(), dataRoot: root, dataRootHost: root };
  try {
    for (const key of ["network", "system", "secret-agent"]) {
      await mkdir(path.join(root, "agents", key), { recursive: true });
      await writeFile(path.join(root, "agents", key, "agent.md"), `${key}: fixture prompt`);
    }
    await mkdir(path.join(root, "agents", "network", "skills", "diagnose"), { recursive: true });
    await writeFile(
      path.join(root, "agents", "network", "skills", "diagnose", "SKILL.md"),
      "---\nname: diagnose\ndescription: Diagnose the network\n---\nUse evidence.\n",
    );
    const contentHashes: Record<string, string> = {
      network: "network-source-v1",
      system: "system-source-v1",
    };
    const assignments: Record<string, string[]> = {
      alice: ["network", "system"],
      bob: ["network"],
    };
    const services: ManagedRuntimeServices = {
      assignedRuntime: async (userId) => ({
        desiredGeneration: 7,
        appliedGeneration: 6,
        applyStatus: "APPLYING",
        agents: (assignments[userId] ?? []).map((key) => ({
          id: `${key}-id`,
          key,
          displayName: key,
          description: `${key} fixture agent`,
          mode: key === "network" ? "primary" : "subagent",
          contentHash: contentHashes[key],
          model: null,
          tools: key === "system" ? ["execute"] : [],
          skills: key === "network" ? ["diagnose"] : [],
          scripts: [],
          mcp: key === "network" ? {
            observer: {
              type: "remote",
              url: "https://mcp.example.com/mcp",
              enabled: true,
              oauth: false,
            },
          } as Record<string, AgentMcpServer> : {},
          sourceDir: path.join(root, "agents", key),
        })),
      }),
      modelConfiguration: async () => ({
        model: "fixture/model",
        provider: {},
        configuredModels: ["fixture/model"],
      }),
      globalInstructions: async () => "所有交付文件必须保存在 /workspace。\n",
    };

    const first = await prepareManagedRuntime("alice", config, services);
    await writeFile(path.join(root, "users", "alice", "workspace", "keep.txt"), "keep");
    const releases = path.join(root, "users", "alice", "managed", "releases");
    const previousTime = new Date("2000-01-01T00:00:00.000Z");
    await utimes(releases, previousTime, previousTime);
    const again = await prepareManagedRuntime("alice", config, services);
    assert.deepEqual(again, first);
    assert.equal((await stat(releases)).mtime.toISOString(), previousTime.toISOString(), "cache hits do not create staging directories");
    assert.equal(first.desiredGeneration, 7);
    assert.equal(await readFile(path.join(root, "users", "alice", "workspace", "keep.txt"), "utf8"), "keep");
    const release = path.join(root, "users", "alice", "managed", "releases", first.generation);
    assert.deepEqual((await readdir(path.join(release, "agents"))).sort(), ["network", "system"]);
    const parsed = JSON.parse(await readFile(path.join(release, "config", "opencode", "opencode.json"), "utf8"));
    assert.equal(
      await readFile(path.join(release, "config", "opencode", "AGENTS.md"), "utf8"),
      "所有交付文件必须保存在 /workspace。\n",
    );
    assert.equal(parsed.small_model, parsed.model);
    assert.equal(parsed.experimental.subagent_depth, 24);
    assert.equal(parsed.experimental.continue_loop_on_deny, undefined);
    assert.equal(parsed.default_agent, "network");
    assert.equal(parsed.agent.network.mode, "primary");
    assert.equal(parsed.agent.system.mode, "subagent");
    assert.equal(parsed.agent.network.tools.execute, false);
    assert.equal(parsed.agent.system.tools.execute, true);
    assert.equal(parsed.agent.network.permission.task.system, "allow");
    assert.equal(parsed.agent.network.permission.task.network, undefined);
    assert.equal(parsed.agent.network.permission.skill["network-diagnose"], "allow");
    assert.equal(parsed.agent.system.permission.skill["network-diagnose"], undefined);
    assert.equal(parsed.mcp.servers["network-observer"].url, "https://mcp.example.com/mcp");
    assert.equal(parsed.tools["network-observer_*"], false);
    assert.equal(parsed.agent.network.tools["network-observer_*"], true);
    assert.equal(parsed.agent.system.tools?.["network-observer_*"], undefined);
    assert.equal(parsed.agent["secret-agent"], undefined);
    assert.match(
      await readFile(path.join(release, "config", "opencode", "skills", "network-diagnose", "SKILL.md"), "utf8"),
      /name: network-diagnose/,
    );
    const bob = await prepareManagedRuntime("bob", config, services);
    assert.notEqual(first.password, bob.password);
    assert.deepEqual(bob.agentKeys, ["network"]);
    assert.deepEqual(await readManagedRuntime("alice", first.generation, config), first);
    const changedModelServices: ManagedRuntimeServices = {
      ...services,
      modelConfiguration: async () => ({
        model: "fixture/model",
        provider: {},
        configuredModels: ["fixture/model", "fixture/second"],
      }),
    };
    const changedModels = await prepareManagedRuntime("alice", config, changedModelServices);
    assert.notEqual(changedModels.generation, first.generation);
    assert.deepEqual(changedModels.configuredModels, ["fixture/model", "fixture/second"]);
    const changedInstructions = await prepareManagedRuntime("alice", config, {
      ...services,
      globalInstructions: async () => "优先使用任务指定的输出目录。\n",
    });
    assert.notEqual(changedInstructions.generation, first.generation);
    const changedAgentServices: ManagedRuntimeServices = {
      ...services,
      assignedRuntime: async (userId) => {
        const definition = await services.assignedRuntime(userId);
        return {
          ...definition,
          agents: definition.agents.map((agent) => ({ ...agent, tools: ["bash"] })),
        };
      },
    };
    assert.notEqual((await prepareManagedRuntime("alice", config, changedAgentServices)).generation, first.generation);
    await symlink(path.join(root, "agents", "secret-agent", "agent.md"), path.join(release, "escape"));
    await assert.rejects(prepareManagedRuntime("alice", config, services), /符号链接/);
    await rm(path.join(release, "escape"));
    const manifestPath = path.join(release, "manifest.json");
    const originalManifest = await readFile(manifestPath, "utf8");
    await writeFile(manifestPath, JSON.stringify({ ...JSON.parse(originalManifest), agentKeys: ["secret-agent"] }));
    await assert.rejects(prepareManagedRuntime("alice", config, services), /清单与当前配置不一致/);
    await writeFile(manifestPath, originalManifest);
    await writeFile(path.join(root, "agents", "network", "agent.md"), "updated prompt");
    contentHashes.network = "network-source-v2";
    assert.notEqual(
      (await prepareManagedRuntime("alice", config, services)).generation,
      first.generation,
    );
    await assert.rejects(
      prepareManagedRuntime("unknown", config, services),
      RuntimeNotConfiguredError,
    );
    await symlink(path.join(root, "agents", "secret-agent", "agent.md"), path.join(root, "agents", "system", "escape"));
    await assert.rejects(prepareManagedRuntime("alice", config, services), /符号链接/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
