import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { PrismaClient } from "@prisma/client";

import {
  AgentServiceError,
  assertValidAgentKey,
  createAgentService,
} from "./agent-service";

type AgentRow = {
  id: string;
  key: string;
  displayName: string;
  description: string;
  mode: "primary" | "subagent" | "all";
  isEnabled: boolean;
  contentHash: string | null;
  checkStatus: "PENDING" | "READY" | "ERROR";
  checkError: string | null;
  checkedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function createFakePrisma() {
  const agents: AgentRow[] = [];
  const users = [{ id: "user-1", isActive: true }];
  const containers = [{
    userId: "user-1",
    desiredGeneration: 0,
    appliedGeneration: 0,
    configApplyStatus: "READY" as "DRAINING" | "REVOKING" | "APPLYING" | "READY" | "FROZEN",
    configApplyError: null as string | null,
    desiredRuntimeHash: null as string | null,
  }];
  const assignments: Array<{ userId: string; agentId: string; createdAt: Date }> = [];
  let id = 0;

  const matchesAgentWhere = (agent: AgentRow, where: Record<string, unknown> | undefined) => {
    if (!where) return true;
    if (typeof where.id === "string" && agent.id !== where.id) return false;
    if (typeof where.key === "string" && agent.key !== where.key) return false;
    const keyFilter = where.key as { notIn?: string[] } | undefined;
    if (keyFilter?.notIn?.includes(agent.key)) return false;
    const idFilter = where.id as { in?: string[] } | undefined;
    if (idFilter?.in && !idFilter.in.includes(agent.id)) return false;
    return true;
  };

  const client: any = {
    agent: {
      async findUnique({ where }: { where: Record<string, unknown> }) {
        return agents.find((agent) => matchesAgentWhere(agent, where)) ?? null;
      },
      async findMany({ where, orderBy }: { where?: Record<string, unknown>; orderBy?: unknown } = {}) {
        const result = agents.filter((agent) => matchesAgentWhere(agent, where));
        if (orderBy) result.sort((a, b) => a.key.localeCompare(b.key));
        return result;
      },
      async create({ data }: { data: Partial<AgentRow> & Pick<AgentRow, "key" | "displayName" | "description"> }) {
        if (agents.some((agent) => agent.key === data.key)) throw new Error("unique Agent.key");
        const now = new Date();
        const row: AgentRow = {
          id: `agent-${++id}`,
          key: data.key,
          displayName: data.displayName,
          description: data.description,
          mode: data.mode ?? "all",
          isEnabled: data.isEnabled ?? true,
          contentHash: data.contentHash ?? null,
          checkStatus: data.checkStatus ?? "PENDING",
          checkError: data.checkError ?? null,
          checkedAt: data.checkedAt ?? null,
          createdAt: now,
          updatedAt: now,
        };
        agents.push(row);
        return row;
      },
      async update({ where, data }: { where: { id: string }; data: Partial<AgentRow> }) {
        const row = agents.find((agent) => agent.id === where.id);
        if (!row) throw new Error("missing agent");
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
      async delete({ where }: { where: { id: string } }) {
        const index = agents.findIndex((agent) => agent.id === where.id);
        if (index < 0) throw new Error("missing agent");
        return agents.splice(index, 1)[0];
      },
    },
    user: {
      async findUnique({ where, include }: { where: { id: string }; include?: unknown }) {
        const user = users.find((item) => item.id === where.id);
        if (!user) return null;
        if (!include) return user;
        const container = containers.find((item) => item.userId === user.id) ?? null;
        return {
          ...user,
          container,
          agents: assignments
            .filter((assignment) => assignment.userId === user.id)
            .map((assignment) => ({ ...assignment, agent: agents.find((agent) => agent.id === assignment.agentId)! })),
        };
      },
    },
    userAgent: {
      async count({ where }: { where: { agentId: string } }) {
        return assignments.filter((assignment) => assignment.agentId === where.agentId).length;
      },
      async findMany({ where, include }: { where: { userId: string }; include?: unknown }) {
        const result = assignments.filter((assignment) => assignment.userId === where.userId);
        return include
          ? result.map((assignment) => ({ ...assignment, agent: agents.find((agent) => agent.id === assignment.agentId)! }))
          : result.map((assignment) => ({ agentId: assignment.agentId }));
      },
      async deleteMany({ where }: { where: { userId: string; agentId: { notIn: string[] } } }) {
        let count = 0;
        for (let index = assignments.length - 1; index >= 0; index--) {
          const assignment = assignments[index];
          if (assignment.userId === where.userId && !where.agentId.notIn.includes(assignment.agentId)) {
            assignments.splice(index, 1);
            count++;
          }
        }
        return { count };
      },
      async createMany({ data }: { data: Array<{ userId: string; agentId: string }> }) {
        let count = 0;
        for (const item of data) {
          if (!assignments.some((assignment) => assignment.userId === item.userId && assignment.agentId === item.agentId)) {
            assignments.push({ ...item, createdAt: new Date() });
            count++;
          }
        }
        return { count };
      },
    },
    containerInstance: {
      async updateMany({ where, data }: {
        where: { userId?: string; user?: { agents: { some: { agentId: string } } } };
        data: {
          desiredGeneration: { increment: number };
          configApplyStatus: "DRAINING" | "REVOKING";
          configApplyError: null;
          desiredRuntimeHash: null;
        };
      }) {
        const affectedUserIds = where.user?.agents.some.agentId
          ? assignments.filter((item) => item.agentId === where.user!.agents.some.agentId).map((item) => item.userId)
          : [];
        const selected = containers.filter((container) =>
          where.userId ? container.userId === where.userId : affectedUserIds.includes(container.userId),
        );
        for (const container of selected) {
          container.desiredGeneration += data.desiredGeneration.increment;
          container.configApplyStatus = data.configApplyStatus;
          container.configApplyError = data.configApplyError;
          container.desiredRuntimeHash = data.desiredRuntimeHash;
        }
        return { count: selected.length };
      },
    },
    async $transaction<T>(operation: (transaction: typeof client) => Promise<T>) {
      return operation(client);
    },
  };
  return { prisma: client as unknown as PrismaClient, agents, containers, assignments };
}

function validFiles(prompt = "检查目标系统。", mode: AgentRow["mode"] = "all") {
  return {
    "agent.md": [
      "---",
      "name: 网络运维",
      "description: 检查网络状态",
      `mode: ${mode}`,
      "model: fixture/model",
      "tools:",
      "  shell: true",
      "skills:",
      "  - diagnose",
      "scripts:",
      "  - check.sh",
      "---",
      prompt,
      "",
    ].join("\n"),
    "skills/diagnose/SKILL.md": "---\nname: diagnose\ndescription: Diagnose\n---\nUse evidence.\n",
    "scripts/check.sh": "#!/bin/sh\nexit 0\n",
  };
}

async function fixture() {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "opshelper-agent-service-"));
  const fake = createFakePrisma();
  const service = createAgentService({
    prisma: fake.prisma,
    dataRoot,
    dependencyCatalog: {
      models: new Set(["fixture/model"]),
      tools: new Set(["shell"]),
    },
  });
  return { dataRoot, fake, service };
}

test("Agent key rejects traversal and OpenCode reserved names", () => {
  assert.throws(() => assertValidAgentKey("../network"), AgentServiceError);
  assert.throws(() => assertValidAgentKey("1-network"), /小写字母开头/);
  assert.throws(() => assertValidAgentKey("build"), /保留名/);
  assert.equal(assertValidAgentKey("network-ops"), "network-ops");
});

test("create validates dependencies, writes a complete directory, and returns round-trip files", async () => {
  const { dataRoot, service } = await fixture();
  try {
    await service.createAgent({ key: "network", files: validFiles() });
    const detail = await service.getAgent("network");
    assert.equal(detail.checkStatus, "READY");
    assert.equal(detail.displayName, "网络运维");
    assert.deepEqual(Object.keys(detail.filesBase64!).sort(), Object.keys(validFiles()).sort());
    assert.equal(
      Buffer.from(detail.filesBase64!["scripts/check.sh"], "base64").toString("utf8"),
      validFiles()["scripts/check.sh"],
    );
    assert.equal(await readFile(path.join(dataRoot, "agents/network/agent.md"), "utf8"), validFiles()["agent.md"]);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("invalid and missing dependencies never replace the current source", async () => {
  const { dataRoot, service } = await fixture();
  try {
    await service.createAgent({ key: "network", files: validFiles("old prompt") });
    const missingSkill = validFiles("new prompt");
    delete (missingSkill as Partial<typeof missingSkill>)["skills/diagnose/SKILL.md"];
    await assert.rejects(
      service.updateAgent("network", { files: missingSkill }),
      /技能文件缺失/,
    );
    assert.match(await readFile(path.join(dataRoot, "agents/network/agent.md"), "utf8"), /old prompt/);
    await assert.rejects(
      service.updateAgent("network", { files: { ...validFiles(), "scripts/../escape": "bad" } }),
      /路径不安全/,
    );
    const unknownModel = validFiles()["agent.md"].replace("fixture/model", "missing/model");
    await assert.rejects(
      service.updateAgent("network", { files: { ...validFiles(), "agent.md": unknownModel } }),
      /模型未配置/,
    );
    const unknownTool = validFiles()["agent.md"].replace("shell: true", "unknown: true");
    await assert.rejects(
      service.updateAgent("network", { files: { ...validFiles(), "agent.md": unknownTool } }),
      /工具未配置/,
    );
    const mismatchedSkill = {
      ...validFiles(),
      "skills/diagnose/SKILL.md": "---\nname: other\ndescription: Wrong name\n---\nUse evidence.\n",
    };
    await assert.rejects(
      service.updateAgent("network", { files: mismatchedSkill }),
      /name 必须与源目录名一致/,
    );
    await assert.rejects(
      service.updateAgent("network", { files: {
        ...validFiles(),
        "mcp.json": JSON.stringify({ unsafe: { type: "remote", url: "file:///etc/passwd" } }),
      } }),
      /只支持 http 或 https/,
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("scan rejects symlink Agent sources and records a visible failure", async () => {
  const { dataRoot, service } = await fixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), "opshelper-agent-outside-"));
  try {
    await mkdir(path.join(dataRoot, "agents"), { recursive: true });
    await writeFile(path.join(outside, "agent.md"), validFiles()["agent.md"]);
    await symlink(outside, path.join(dataRoot, "agents/network"));
    const result = await service.scanAgentCatalog();
    assert.deepEqual(result, [{ key: "network", ok: false, error: "Agent 源必须是真实目录" }]);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("assignment replacement is transactional, idempotent, and advances one desired generation", async () => {
  const { dataRoot, fake, service } = await fixture();
  try {
    const agent = await service.createAgent({ key: "network", files: validFiles() });
    await service.replaceUserAgentAssignments("user-1", [agent.id, agent.id]);
    assert.equal(fake.assignments.length, 1);
    assert.equal(fake.containers[0].desiredGeneration, 1);
    assert.equal(fake.containers[0].configApplyStatus, "DRAINING");
    await service.replaceUserAgentAssignments("user-1", [agent.id]);
    assert.equal(fake.containers[0].desiredGeneration, 1);
    await service.replaceUserAgentAssignments("user-1", []);
    assert.equal(fake.assignments.length, 0);
    assert.equal(fake.containers[0].desiredGeneration, 2);
    assert.equal(fake.containers[0].configApplyStatus, "REVOKING");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("runtime definition includes only assigned ready sources and detects unscanned edits", async () => {
  const { dataRoot, service } = await fixture();
  try {
    const agent = await service.createAgent({
      key: "network",
      files: {
        ...validFiles(),
        "mcp.json": JSON.stringify({ observer: { type: "remote", url: "https://mcp.example.com/mcp", oauth: false } }),
      },
    });
    await service.replaceUserAgentAssignments("user-1", [agent.id]);
    const definition = await service.getAssignedRuntimeDefinition("user-1");
    assert.equal(definition.desiredGeneration, 1);
    assert.deepEqual(definition.agents.map((item) => item.key), ["network"]);
    assert.equal(definition.agents[0].mode, "all");
    assert.equal(definition.agents[0].mcp.observer.type, "remote");
    await writeFile(path.join(dataRoot, "agents/network/agent.md"), validFiles("changed outside service")["agent.md"]);
    await assert.rejects(service.getAssignedRuntimeDefinition("user-1"), /必须重新检查/);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("subagent mode is persisted and cannot be the user's only assigned agent", async () => {
  const { dataRoot, service } = await fixture();
  try {
    const subagent = await service.createAgent({
      key: "network",
      files: validFiles("协助主智能体检查网络。", "subagent"),
    });
    assert.equal(subagent.mode, "subagent");
    await assert.rejects(
      service.replaceUserAgentAssignments("user-1", [subagent.id]),
      /至少需要分配一个 primary 或 all/,
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("disabling or editing an assigned Agent freezes new work with a new generation", async () => {
  const { dataRoot, fake, service } = await fixture();
  try {
    const agent = await service.createAgent({ key: "network", files: validFiles() });
    await service.replaceUserAgentAssignments("user-1", [agent.id]);
    await service.setAgentEnabled("network", false);
    assert.equal(fake.containers[0].desiredGeneration, 2);
    assert.equal(fake.containers[0].configApplyStatus, "REVOKING");
    await assert.rejects(service.getAssignedRuntimeDefinition("user-1"), /未启用/);
    await service.setAgentEnabled("network", true);
    await service.updateAgent("network", { files: validFiles("updated") });
    assert.equal(fake.containers[0].desiredGeneration, 4);
    assert.equal(fake.containers[0].configApplyStatus, "DRAINING");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("delete refuses assigned Agents and removes an unassigned source without following links", async () => {
  const { dataRoot, service } = await fixture();
  try {
    const agent = await service.createAgent({ key: "network", files: validFiles() });
    await service.replaceUserAgentAssignments("user-1", [agent.id]);
    await assert.rejects(service.deleteAgent("network"), /先撤销分配/);
    await service.replaceUserAgentAssignments("user-1", []);
    await service.deleteAgent("network");
    await assert.rejects(readFile(path.join(dataRoot, "agents/network/agent.md")), /ENOENT/);
    await assert.rejects(service.getAgent("network"), /不存在/);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("assigned legacy personal source stays in the user's directory and retains hash validation", async () => {
  const { dataRoot, service } = await fixture();
  try {
    const key = "personal-0123456789abcdef0123";
    const agent = await service.createAgent({ key, files: validFiles() });
    await service.replaceUserAgentAssignments("user-1", [agent.id]);
    const parent = path.join(dataRoot, "users/user-1/agents");
    await mkdir(parent, { recursive: true });
    const source = path.join(parent, key);
    await rename(path.join(dataRoot, "agents", key), source);
    assert.equal((await service.getAssignedRuntimeDefinition("user-1")).agents[0].sourceDir, source);
    await writeFile(path.join(source, "agent.md"), validFiles("unreviewed change")["agent.md"]);
    await assert.rejects(service.getAssignedRuntimeDefinition("user-1"), /必须重新检查/);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("legacy personal source cannot be resolved through another user's symlink", async () => {
  const { dataRoot, service } = await fixture();
  try {
    const key = "personal-0123456789abcdef0123";
    const agent = await service.createAgent({ key, files: validFiles() });
    await service.replaceUserAgentAssignments("user-1", [agent.id]);
    const foreign = path.join(dataRoot, "users/foreign/agents");
    await mkdir(foreign, { recursive: true });
    await rename(path.join(dataRoot, "agents", key), path.join(foreign, key));
    await assert.rejects(service.getAssignedRuntimeDefinition("user-1"), /目录不存在/);
    await symlink(path.join(dataRoot, "users/foreign"), path.join(dataRoot, "users/user-1"));
    await assert.rejects(service.getAssignedRuntimeDefinition("user-1"), /不是普通目录/);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});
