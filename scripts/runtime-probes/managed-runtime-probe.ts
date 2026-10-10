// Exercises the phase-2 production snapshot builder and Docker option builder.
// All data, credentials, agents, and containers are disposable fixtures.
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Docker from "dockerode";

import type { AppConfig } from "../../apps/api/src/lib/config";
import { prepareManagedRuntime } from "../../apps/api/src/lib/managed-runtime";
import { buildContainerCreateOptions, isStaleRuntime } from "../../apps/api/src/lib/opencode-container-runtime";

const image = process.env.OPENCODE_PROBE_IMAGE ?? "opshelper/opencode-runtime:latest";
const socketPath = process.env.DOCKER_SOCKET_PATH ?? "/var/run/docker.sock";
const outputPath = path.resolve(".temp/runtime-probes/runtime-managed-builder.json");
const inContainerProbe = path.resolve("scripts/runtime-probes/container-runtime-probe.mjs");
const agentKeys = ["fixture-lead", "fixture-sub"];
const forbiddenAgents = ["build", "plan", "general", "explore", "workspace-rogue"];
const createdContainers: Array<{ name: string; container: Docker.Container }> = [];

async function sha256File(filename: string) {
  return createHash("sha256").update(await readFile(filename)).digest("hex");
}

function command(args: string[], input?: string, extraEnv: Record<string, string> = {}) {
  return spawnSync(args[0], args.slice(1), {
    input,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function waitHealthy(name: string, password: string) {
  const script = [
    "const h={Authorization:'Basic '+Buffer.from('opshelper:'+process.argv[1]).toString('base64')};",
    "fetch('http://127.0.0.1:4096/global/health',{headers:h})",
    ".then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(2))",
  ].join("");
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const result = command(["docker", "exec", name, "node", "-e", script, password]);
    if (result.status === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function runtimeProbe(name: string, label: string, password: string) {
  const result = command([
    "docker", "exec", "-i",
    "--env", `PROBE_PASSWORD=${password}`,
    "--env", `PROBE_USER_LABEL=${label}`,
    "--env", `PROBE_EXPECTED_AGENTS=${JSON.stringify(agentKeys)}`,
    "--env", `PROBE_FORBIDDEN_AGENTS=${JSON.stringify(forbiddenAgents)}`,
    name, "node", "--input-type=module", "-",
  ], readFileSync(inContainerProbe, "utf8"));
  const lines = result.stdout.trim().split("\n");
  return { ...JSON.parse(lines.at(-1) ?? "{}"), exitCode: result.status };
}

function crossRead(name: string, sessionId: string, password: string) {
  const script = [
    "const h={Authorization:'Basic '+Buffer.from('opshelper:'+process.argv[2]).toString('base64')};",
    "fetch('http://127.0.0.1:4096/session/'+process.argv[1]+'?directory=%2Fworkspace',{headers:h})",
    ".then(async r=>{let v;try{v=await r.json()}catch{v=null};",
    "console.log(JSON.stringify({status:r.status,returnedSessionId:v?.id??null}))})",
  ].join("");
  const result = command(["docker", "exec", name, "node", "-e", script, sessionId, password]);
  return JSON.parse(result.stdout.trim());
}

function childrenRead(name: string, parentId: string, childId: string, password: string) {
  const script = [
    "const h={Authorization:'Basic '+Buffer.from('opshelper:'+process.argv[3]).toString('base64')};",
    "fetch('http://127.0.0.1:4096/session/'+process.argv[1]+'/children?directory=%2Fworkspace',{headers:h})",
    ".then(async r=>{let v;try{v=await r.json()}catch{v=null};",
    "console.log(JSON.stringify({status:r.status,matched:Array.isArray(v)&&v.some(x=>x.id===process.argv[2]&&x.parentID===process.argv[1])}))})",
  ].join("");
  const result = command(["docker", "exec", name, "node", "-e", script, parentId, childId, password]);
  return JSON.parse(result.stdout.trim());
}

function sanitizeOptions(options: Docker.ContainerCreateOptions) {
  const env = options.Env ?? [];
  const binds = options.HostConfig?.Binds ?? [];
  return {
    user: options.User,
    command: options.Cmd,
    workingDirectory: options.WorkingDir,
    hasIndependentBasicAuthPassword: env.some((value) => value.startsWith("OPENCODE_SERVER_PASSWORD=") && value.length > 40),
    requiredEnvironmentPresent: [
      "HOME=/home/node",
      "XDG_CONFIG_HOME=/opt/opshelper/config",
      "XDG_DATA_HOME=/state/data",
      "XDG_CACHE_HOME=/state/cache",
      "XDG_STATE_HOME=/state/state",
      "OPENCODE_DISABLE_PROJECT_CONFIG=true",
      "OPENCODE_DISABLE_EXTERNAL_SKILLS=true",
      "OPENCODE_DISABLE_MODELS_FETCH=true",
      "OPENCODE_DISABLE_AUTOUPDATE=true",
      "OPENCODE_DISABLE_DEFAULT_PLUGINS=true",
      "OPENCODE_PORT=4096",
    ].every((value) => env.includes(value)),
    mountDestinations: binds.map((bind) => bind.split(":").slice(-2).join(":")),
    noDockerSocketMount: binds.every((bind) => !bind.includes("docker.sock")),
    readonlyRootfs: options.HostConfig?.ReadonlyRootfs,
    networkMode: options.HostConfig?.NetworkMode,
    hasPublishedPorts: Boolean(options.HostConfig?.PortBindings && Object.keys(options.HostConfig.PortBindings).length),
    capDrop: options.HostConfig?.CapDrop,
    securityOpt: options.HostConfig?.SecurityOpt,
    tmpfs: options.HostConfig?.Tmpfs,
    memory: options.HostConfig?.Memory,
    nanoCpus: options.HostConfig?.NanoCpus,
    pidsLimit: options.HostConfig?.PidsLimit,
  };
}

async function main() {
  const startedAt = new Date().toISOString();
  const root = await mkdtemp(path.join(os.tmpdir(), "opshelper-phase2-managed-"));
  const temporaryRoots = [root];
  const config: AppConfig = {
    port: 4000,
    opencodeImage: image,
    opencodePort: 4096,
    opencodeDirectory: "/workspace",
    idleTimeoutMinutes: 60,
    dockerNetwork: "none",
    dockerSocketPath: socketPath,
    sessionCookieName: "fixture_session",
    sessionTtlHours: 1,
    chatUploadTtlHours: 1,
    dataRoot: root,
    dataRootHost: root,
    runtimeUid: 1000,
    runtimeGid: 1000,
    runtimeMemoryMb: 2048,
    runtimeCpus: 2,
    opencodeConfigPath: path.join(root, "config", "opencode"),
  };
  const report: Record<string, unknown> = {
    schemaVersion: 1,
    startedAt,
    status: "failed",
    scope: "Production phase-2 builders with disposable fixture data and containers; no model call.",
    modelCalls: 0,
    sourceDigests: {
      dockerfileSha256: await sha256File(path.resolve("deploy/opencode-runtime/Dockerfile")),
      managedRuntimeBuilderSha256: await sha256File(path.resolve("apps/api/src/lib/managed-runtime.ts")),
      containerOptionsBuilderSha256: await sha256File(path.resolve("apps/api/src/lib/opencode-container-runtime.ts")),
      backupScriptSha256: await sha256File(path.resolve("scripts/runtime-probes/user-backup.sh")),
      backupValidatorSha256: await sha256File(path.resolve("scripts/runtime-probes/user-backup-validate.py")),
      probeSha256: await sha256File(path.resolve("scripts/runtime-probes/managed-runtime-probe.ts")),
    },
    users: [],
    checks: [],
  };
  try {
    await mkdir(path.join(root, "config"), { recursive: true });
    await writeFile(path.join(root, "config", "phase2-runtime.json"), JSON.stringify({
      version: 1,
      model: "fixture/no-model",
      provider: {},
      users: { alice: agentKeys, bob: agentKeys },
    }));
    for (const key of agentKeys) {
      await mkdir(path.join(root, "agents", key), { recursive: true });
      await writeFile(path.join(root, "agents", key, "agent.md"), `Synthetic ${key}; never call a model in this probe.\n`);
    }
    const docker = new Docker({ socketPath });
    const imageInfo = await docker.getImage(image).inspect();
    report.image = image;
    report.imageId = imageInfo.Id;
    report.imageDefaultUser = imageInfo.Config?.User || "root (implicit)";
    const users: Record<string, { runtime: Awaited<ReturnType<typeof prepareManagedRuntime>>; options: Docker.ContainerCreateOptions; probe: any }> = {};
    for (const label of ["alice", "bob"]) {
      const runtime = await prepareManagedRuntime(label, config);
      const workspace = path.join(root, "users", label, "workspace");
      await writeFile(path.join(workspace, "fixture.txt"), `${label.toUpperCase()}_OWN_WORKSPACE_MARKER\n`);
      await writeFile(path.join(workspace, "opencode.json"), JSON.stringify({
        agent: { "workspace-rogue": { description: "must not load", mode: "all" } },
      }));
      await mkdir(path.join(workspace, ".opencode", "agents"), { recursive: true });
      await writeFile(path.join(workspace, ".opencode", "agents", "workspace-rogue.md"), "---\ndescription: must not load\nmode: all\n---\nNever load.\n");
      for (const directory of [workspace, path.join(root, "users", label, "state")]) {
        await chmod(directory, 0o777);
        for (const child of ["data", "cache", "state"]) {
          await chmod(path.join(directory, child), 0o777).catch(() => undefined);
        }
      }
      const options = buildContainerCreateOptions({
        record: { name: `opshelper-p2-builder-${label}-${randomBytes(5).toString("hex")}`, image, userId: label },
        runtime,
        config,
      });
      const container = await docker.createContainer(options);
      createdContainers.push({ name: options.name as string, container });
      await container.start();
      if (!await waitHealthy(options.name as string, runtime.password)) {
        throw new Error(`${label} builder-created container did not become healthy`);
      }
      const probe = runtimeProbe(options.name as string, label, runtime.password);
      const actualInspect = await container.inspect();
      const actualContainerMatchesExpected = !isStaleRuntime(actualInspect, options, imageInfo.Config?.Env ?? []);
      users[label] = { runtime, options, probe };
      const configPath = path.join(root, "users", label, "managed", "releases", runtime.generation, "config", "opencode", "opencode.json");
      const generated = JSON.parse(await readFile(configPath, "utf8"));
      (report.users as unknown[]).push({
        label,
        generation: runtime.generation,
        agentKeys: runtime.agentKeys,
        generatedConfig: {
          shareDisabled: generated.share === "disabled",
          defaultAgentIsAssigned: runtime.agentKeys.includes(generated.default_agent),
          onlyAssignedBusinessAgents: Object.entries(generated.agent).filter(([, value]) => !(value as { disable?: boolean }).disable).map(([key]) => key).sort(),
          allAssignedAgentsUseModeAll: runtime.agentKeys.every((key) => generated.agent[key]?.mode === "all"),
          taskRulesDenyUnknownAndAllowAssigned: runtime.agentKeys.every((key) => generated.agent[key]?.permission?.task?.["*"] === "deny"
            && runtime.agentKeys.every((target) => generated.agent[key]?.permission?.task?.[target] === "allow")),
          gitignorePreseeded: await readFile(path.join(path.dirname(configPath), ".gitignore"), "utf8").then((value) => value.includes("node_modules")),
        },
        containerOptions: sanitizeOptions(options),
        actualContainerMatchesExpected,
        runtimeProbe: probe,
      });
    }
    const cross = crossRead(users.bob.options.name as string, users.alice.probe.sessionId, users.bob.runtime.password);
    const wrongAuth = crossRead(users.bob.options.name as string, users.alice.probe.sessionId, users.alice.runtime.password);
    const restartPersistence: Record<string, unknown> = {};
    for (const label of ["alice", "bob"] as const) {
      const item = createdContainers.find((entry) => entry.name === users[label].options.name);
      if (!item) throw new Error(`missing ${label} fixture container`);
      await item.container.restart({ t: 1 });
      const healthy = await waitHealthy(item.name, users[label].runtime.password);
      const session = healthy
        ? crossRead(item.name, users[label].probe.sessionId, users[label].runtime.password)
        : { status: 0, returnedSessionId: null };
      const children = healthy
        ? childrenRead(item.name, users[label].probe.sessionId, users[label].probe.childSessionId, users[label].runtime.password)
        : { status: 0, matched: false };
      const file = command(["docker", "exec", item.name, "node", "-e",
        "require('fs').readFile('/workspace/fixture.txt','utf8',(e,v)=>{console.log(JSON.stringify({readable:!e,matched:!!v&&v.toLowerCase().includes(process.argv[1])}))})",
        label]);
      restartPersistence[label] = {
        healthyAfterRestart: healthy,
        sessionReadAfterRestart: session,
        childSessionTreeAfterRestart: children,
        workspaceFileAfterRestart: JSON.parse(file.stdout.trim()),
      };
    }
    const aliceContainer = createdContainers.find((entry) => entry.name === users.alice.options.name);
    if (!aliceContainer) throw new Error("missing alice fixture container before backup");
    await aliceContainer.container.stop({ t: 1 });
    const backupDirectory = await mkdtemp(path.join(os.tmpdir(), "opshelper-phase2-backup-"));
    await rm(backupDirectory, { recursive: true });
    temporaryRoots.push(backupDirectory);
    const restoreRoot = await mkdtemp(path.join(os.tmpdir(), "opshelper-phase2-restore-"));
    temporaryRoots.push(restoreRoot);
    const backupScript = path.resolve("scripts/runtime-probes/user-backup.sh");
    const backup = command(["bash", backupScript, "backup", "alice", aliceContainer.name, backupDirectory], undefined, {
      DATA_ROOT_HOST: root,
    });
    if (backup.status !== 0) throw new Error(`real user backup failed: ${backup.stderr}`);
    const restore = command(["bash", backupScript, "restore", "alice", aliceContainer.name, backupDirectory, restoreRoot], undefined, {
      DATA_ROOT_HOST: root,
    });
    if (restore.status !== 0) throw new Error(`real user restore failed: ${restore.stderr}`);
    await cp(path.join(root, "config"), path.join(restoreRoot, "config"), { recursive: true });
    await cp(path.join(root, "agents"), path.join(restoreRoot, "agents"), { recursive: true });
    const restoreConfig = { ...config, dataRoot: restoreRoot, dataRootHost: restoreRoot };
    const restoredRuntime = await prepareManagedRuntime("alice", restoreConfig);
    for (const directory of [
      path.join(restoreRoot, "users", "alice", "workspace"),
      path.join(restoreRoot, "users", "alice", "state"),
    ]) {
      await chmod(directory, 0o777);
      for (const child of ["data", "cache", "state"]) {
        await chmod(path.join(directory, child), 0o777).catch(() => undefined);
      }
    }
    const restoredOptions = buildContainerCreateOptions({
      record: {
        name: `opshelper-p2-restored-alice-${randomBytes(5).toString("hex")}`,
        image,
        userId: "alice",
      },
      runtime: restoredRuntime,
      config: restoreConfig,
    });
    const restoredContainer = await docker.createContainer(restoredOptions);
    createdContainers.push({ name: restoredOptions.name as string, container: restoredContainer });
    await restoredContainer.start();
    const restoredHealthy = await waitHealthy(restoredOptions.name as string, restoredRuntime.password);
    const restoredSession = restoredHealthy
      ? crossRead(restoredOptions.name as string, users.alice.probe.sessionId, restoredRuntime.password)
      : { status: 0, returnedSessionId: null };
    const restoredChildren = restoredHealthy
      ? childrenRead(restoredOptions.name as string, users.alice.probe.sessionId, users.alice.probe.childSessionId, restoredRuntime.password)
      : { status: 0, matched: false };
    const restoredFileResult = command(["docker", "exec", restoredOptions.name as string, "node", "-e",
      "require('fs').readFile('/workspace/fixture.txt','utf8',(e,v)=>console.log(JSON.stringify({readable:!e,matched:!!v&&v.includes('ALICE_OWN_WORKSPACE_MARKER')})))"]);
    const restoredFile = JSON.parse(restoredFileResult.stdout.trim());
    report.backupRestore = {
      sourceContainerWasStopped: true,
      backupCommandPassed: backup.status === 0,
      restoreCommandPassed: restore.status === 0,
      archiveHashesVerifiedByRestore: restore.status === 0,
      restoredIntoIndependentDataRoot: true,
      restoredContainerHealthy: restoredHealthy,
      rootSessionAfterRestore: restoredSession,
      childSessionTreeAfterRestore: restoredChildren,
      workspaceFileAfterRestore: restoredFile,
      managedSnapshotReassembledSeparately: restoredRuntime.generation === users.alice.runtime.generation,
    };
    const sanitized = (report.users as Array<any>);
    const checks = [
      {
        name: "production snapshot builder emits the fixture-only managed agent set",
        passed: sanitized.every((user) => JSON.stringify(user.generatedConfig.onlyAssignedBusinessAgents) === JSON.stringify(agentKeys)
          && user.generatedConfig.allAssignedAgentsUseModeAll
          && user.generatedConfig.taskRulesDenyUnknownAndAllowAssigned
          && user.generatedConfig.shareDisabled
          && user.generatedConfig.gitignorePreseeded),
      },
      {
        name: "production Docker option builder emits the hardened per-user contract",
        passed: sanitized.every((user) => user.containerOptions.user === "1000:1000"
          && user.containerOptions.requiredEnvironmentPresent
          && user.containerOptions.noDockerSocketMount
          && user.containerOptions.readonlyRootfs
          && !user.containerOptions.hasPublishedPorts
          && user.containerOptions.capDrop?.includes("ALL")
          && user.containerOptions.securityOpt?.includes("no-new-privileges:true")
          && user.actualContainerMatchesExpected),
      },
      {
        name: "containers created from production builders pass runtime checks",
        passed: sanitized.every((user) => user.runtimeProbe.status === "passed"),
      },
      {
        name: "builder-created runtimes isolate sessions and BasicAuth credentials",
        passed: cross.status === 404 && cross.returnedSessionId === null
          && wrongAuth.status === 401 && wrongAuth.returnedSessionId === null,
      },
      {
        name: "sessions and workspace survive container restart",
        passed: Object.values(restartPersistence).every((entry: any) => entry.healthyAfterRestart
          && entry.sessionReadAfterRestart.status === 200
          && entry.sessionReadAfterRestart.returnedSessionId
          && entry.childSessionTreeAfterRestart.status === 200
          && entry.childSessionTreeAfterRestart.matched
          && entry.workspaceFileAfterRestart.readable
          && entry.workspaceFileAfterRestart.matched),
      },
      {
        name: "stopped-user backup restores native session tree and workspace into an independent runtime",
        passed: restoredHealthy
          && restoredSession.status === 200
          && restoredSession.returnedSessionId === users.alice.probe.sessionId
          && restoredChildren.status === 200
          && restoredChildren.matched
          && restoredFile.readable
          && restoredFile.matched
          && restoredRuntime.generation === users.alice.runtime.generation,
      },
    ];
    report.crossUser = { sessionReadThroughOtherRuntime: cross, credentialAgainstOtherRuntime: wrongAuth };
    report.restartPersistence = restartPersistence;
    report.checks = checks;
    report.status = checks.every((check) => check.passed) ? "passed" : "failed";
  } catch (error) {
    report.error = String(error instanceof Error ? error.stack ?? error.message : error);
  } finally {
    const cleanup = [];
    for (const item of createdContainers.reverse()) {
      try {
        await item.container.remove({ force: true });
        cleanup.push({ label: item.name.includes("alice") ? "alice" : "bob", removed: true });
      } catch {
        cleanup.push({ label: item.name.includes("alice") ? "alice" : "bob", removed: false });
      }
    }
    report.cleanup = cleanup;
    report.cleanupSucceeded = cleanup.every((item) => item.removed);
    report.containersCreatedCount = createdContainers.length;
    report.containersRemovedCount = cleanup.filter((item) => item.removed).length;
    let allTemporaryRootsRemoved = true;
    for (const temporaryRoot of temporaryRoots) {
      try {
        await rm(temporaryRoot, { recursive: true, force: true });
      } catch {
        allTemporaryRootsRemoved = false;
      }
    }
    report.temporaryDirectoriesRemoved = allTemporaryRootsRemoved;
    report.finishedAt = new Date().toISOString();
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
  }
  process.exitCode = report.status === "passed" && report.cleanupSucceeded ? 0 : 1;
}

void main();
