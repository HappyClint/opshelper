// Verifies runtime/control network separation with disposable internal networks.
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Docker from "dockerode";

import type { AppConfig } from "../../apps/api/src/lib/config";
import { prepareManagedRuntime } from "../../apps/api/src/lib/managed-runtime";
import { buildContainerCreateOptions } from "../../apps/api/src/lib/opencode-container-runtime";

const image = process.env.OPENCODE_PROBE_IMAGE ?? "opshelper/phase2-runtime:validation";
const socketPath = process.env.DOCKER_SOCKET_PATH ?? "/var/run/docker.sock";
const outputPath = path.resolve(".temp/runtime-probes/runtime-network-isolation.json");
const suffix = randomBytes(5).toString("hex");
const runtimeNetworkName = `opshelper-p2-runtime-${suffix}`;
const controlNetworkName = `opshelper-p2-control-${suffix}`;
const containerNames = [`opshelper-p2-net-alice-${suffix}`, `opshelper-p2-net-bob-${suffix}`, `opshelper-p2-net-db-${suffix}`];

function command(args: string[]) {
  return spawnSync(args[0], args.slice(1), {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
}

async function sha256File(filename: string) {
  return createHash("sha256").update(await readFile(filename)).digest("hex");
}

async function waitHealthy(name: string, password: string) {
  const script = "const h={Authorization:'Basic '+Buffer.from('opshelper:'+process.argv[1]).toString('base64')};fetch('http://127.0.0.1:4096/global/health',{headers:h,signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(2))";
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const result = command(["docker", "exec", name, "node", "-e", script, password]);
    if (result.status === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function httpStatusFromContainer(source: string, host: string, port: number, password: string) {
  const script = [
    "const h={Authorization:'Basic '+Buffer.from('opshelper:'+process.argv[3]).toString('base64')};",
    "fetch('http://'+process.argv[1]+':'+process.argv[2]+'/global/health',{headers:h,signal:AbortSignal.timeout(3000)})",
    ".then(r=>console.log(JSON.stringify({connected:true,status:r.status})))",
    ".catch(e=>console.log(JSON.stringify({connected:false,status:null,errorClass:e.name||'Error'})))",
  ].join("");
  const result = command(["docker", "exec", source, "node", "-e", script, host, String(port), password]);
  return JSON.parse(result.stdout.trim());
}

function portReachabilityFromContainer(source: string, host: string, port: number) {
  const script = [
    "fetch('http://'+process.argv[1]+':'+process.argv[2]+'/',{signal:AbortSignal.timeout(3000)})",
    ".then(r=>console.log(JSON.stringify({connected:true,status:r.status})))",
    ".catch(e=>console.log(JSON.stringify({connected:false,status:null,errorClass:e.name||'Error'})))",
  ].join("");
  const result = command(["docker", "exec", source, "node", "-e", script, host, String(port)]);
  return JSON.parse(result.stdout.trim());
}

async function main() {
  const docker = new Docker({ socketPath });
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "opshelper-phase2-network-"));
  const containers: Docker.Container[] = [];
  const networks: Docker.Network[] = [];
  const report: Record<string, any> = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    status: "failed",
    scope: "Disposable internal Docker networks and synthetic services; no published ports, model calls, production data, or existing Compose resources.",
    modelCalls: 0,
    sourceDigests: {
      dockerfileSha256: await sha256File(path.resolve("deploy/opencode-runtime/Dockerfile")),
      managedRuntimeBuilderSha256: await sha256File(path.resolve("apps/api/src/lib/managed-runtime.ts")),
      containerOptionsBuilderSha256: await sha256File(path.resolve("apps/api/src/lib/opencode-container-runtime.ts")),
      probeSha256: await sha256File(path.resolve("scripts/runtime-probes/runtime-network-probe.ts")),
    },
  };
  try {
    const runtimeNetwork = await docker.createNetwork({ Name: runtimeNetworkName, Driver: "bridge", Internal: true });
    networks.push(runtimeNetwork);
    const controlNetwork = await docker.createNetwork({ Name: controlNetworkName, Driver: "bridge", Internal: true });
    networks.push(controlNetwork);
    await mkdir(path.join(dataRoot, "config"), { recursive: true });
    await writeFile(path.join(dataRoot, "config", "phase2-runtime.json"), JSON.stringify({
      version: 1,
      model: "fixture/no-model",
      provider: {},
      users: { alice: ["fixture-agent"], bob: ["fixture-agent"] },
    }));
    await mkdir(path.join(dataRoot, "agents", "fixture-agent"), { recursive: true });
    await writeFile(path.join(dataRoot, "agents", "fixture-agent", "agent.md"), "Synthetic network fixture. Never call a model.\n");
    const config: AppConfig = {
      port: 4000,
      opencodeImage: image,
      opencodePort: 4096,
      opencodeDirectory: "/workspace",
      idleTimeoutMinutes: 60,
      dockerNetwork: runtimeNetworkName,
      dockerSocketPath: socketPath,
      sessionCookieName: "fixture_session",
      sessionTtlHours: 1,
      chatUploadTtlHours: 1,
      dataRoot,
      dataRootHost: dataRoot,
      runtimeUid: 1000,
      runtimeGid: 1000,
      runtimeMemoryMb: 2048,
      runtimeCpus: 2,
      opencodeConfigPath: path.join(dataRoot, "config", "opencode"),
    };
    const users: Record<string, { runtime: Awaited<ReturnType<typeof prepareManagedRuntime>>; container: Docker.Container }> = {};
    for (const [index, label] of ["alice", "bob"].entries()) {
      const runtime = await prepareManagedRuntime(label, config);
      for (const directory of [
        path.join(dataRoot, "users", label, "workspace"),
        path.join(dataRoot, "users", label, "state"),
      ]) {
        await chmod(directory, 0o777);
        for (const child of ["data", "cache", "state"]) {
          await chmod(path.join(directory, child), 0o777).catch(() => undefined);
        }
      }
      const options = buildContainerCreateOptions({
        record: { name: containerNames[index], image, userId: label },
        runtime,
        config,
      });
      const container = await docker.createContainer(options);
      containers.push(container);
      await container.start();
      if (!await waitHealthy(containerNames[index], runtime.password)) throw new Error(`${label} runtime did not become healthy`);
      users[label] = { runtime, container };
    }
    const database = await docker.createContainer({
      name: containerNames[2],
      Image: image,
      User: "1000:1000",
      Cmd: ["node", "-e", "require('http').createServer((_,r)=>r.end('fixture-db')).listen(5432,'0.0.0.0')"],
      HostConfig: { NetworkMode: controlNetworkName, ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"] },
      ExposedPorts: { "5432/tcp": {} },
      Labels: { "opshelper.probe": "phase2-network" },
    });
    containers.push(database);
    await database.start();
    const aliceInspect = await users.alice.container.inspect();
    const bobInspect = await users.bob.container.inspect();
    const dbInspect = await database.inspect();
    const bobIp = bobInspect.NetworkSettings.Networks[runtimeNetworkName].IPAddress;
    const dbIp = dbInspect.NetworkSettings.Networks[controlNetworkName].IPAddress;
    const wrongCredential = httpStatusFromContainer(containerNames[0], bobIp, 4096, users.alice.runtime.password);
    const correctCredential = httpStatusFromContainer(containerNames[0], bobIp, 4096, users.bob.runtime.password);
    const databaseReachability = portReachabilityFromContainer(containerNames[0], dbIp, 5432);
    const runtimeNetworkInfo = await runtimeNetwork.inspect();
    const controlNetworkInfo = await controlNetwork.inspect();
    const runtimeMembership = Object.keys(aliceInspect.NetworkSettings.Networks);
    const liMembership = Object.keys(bobInspect.NetworkSettings.Networks);
    const dbMembership = Object.keys(dbInspect.NetworkSettings.Networks);
    const checks = [
      { name: "both fixture networks are internal", passed: runtimeNetworkInfo.Internal && controlNetworkInfo.Internal },
      { name: "runtime users are attached only to runtime network", passed: JSON.stringify(runtimeMembership) === JSON.stringify([runtimeNetworkName]) && JSON.stringify(liMembership) === JSON.stringify([runtimeNetworkName]) },
      { name: "database fixture is attached only to control network", passed: JSON.stringify(dbMembership) === JSON.stringify([controlNetworkName]) },
      { name: "runtime-to-runtime direct request requires target BasicAuth", passed: wrongCredential.connected && wrongCredential.status === 401 && correctCredential.connected && correctCredential.status === 200 },
      { name: "runtime cannot reach control-network database fixture", passed: databaseReachability.connected === false },
      { name: "no container publishes a host port", passed: [aliceInspect, bobInspect, dbInspect].every((item) => Object.keys(item.HostConfig.PortBindings ?? {}).length === 0) },
    ];
    const imageInfo = await docker.getImage(image).inspect();
    report.image = image;
    report.imageId = imageInfo.Id;
    report.runtimeNetwork = { internal: runtimeNetworkInfo.Internal, memberRoles: ["alice", "bob"] };
    report.controlNetwork = { internal: controlNetworkInfo.Internal, memberRoles: ["database-fixture"] };
    report.directRuntimeAuth = {
      wrongUserCredentialStatus: wrongCredential.status,
      targetUserCredentialStatus: correctCredential.status,
    };
    report.databaseIsolation = { reachableFromRuntime: databaseReachability.connected };
    report.checks = checks;
    report.status = checks.every((check) => check.passed) ? "passed" : "failed";
  } catch (error) {
    report.error = String(error instanceof Error ? error.stack ?? error.message : error);
  } finally {
    const containerCleanup = [];
    for (const container of containers.reverse()) {
      try {
        await container.remove({ force: true });
        containerCleanup.push(true);
      } catch {
        containerCleanup.push(false);
      }
    }
    const networkCleanup = [];
    for (const network of networks.reverse()) {
      try {
        await network.remove();
        networkCleanup.push(true);
      } catch {
        networkCleanup.push(false);
      }
    }
    await rm(dataRoot, { recursive: true, force: true });
    report.cleanup = {
      containersCreatedCount: containers.length,
      containersRemovedCount: containerCleanup.filter(Boolean).length,
      networksCreatedCount: networks.length,
      networksRemovedCount: networkCleanup.filter(Boolean).length,
      temporaryDirectoryRemoved: true,
    };
    report.cleanupSucceeded = containerCleanup.every(Boolean) && networkCleanup.every(Boolean);
    report.finishedAt = new Date().toISOString();
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === "passed" && report.cleanupSucceeded ? 0 : 1;
  }
}

void main();
