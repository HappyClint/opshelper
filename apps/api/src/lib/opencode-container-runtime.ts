import type Docker from "dockerode";
import type { ContainerInstance } from "@prisma/client";
import path from "node:path";

import { loadConfig, type AppConfig } from "./config";
import { getHostUserPaths } from "./data-paths";
import type { ManagedRuntime } from "./managed-runtime";

export interface BuildContainerCreateOptionsInput {
  record: Pick<ContainerInstance, "name" | "image" | "userId">;
  runtime: ManagedRuntime;
  config?: AppConfig;
}

/** One reusable user container. Agents deliberately share its files and state. */
export function buildContainerCreateOptions(input: BuildContainerCreateOptionsInput): Docker.ContainerCreateOptions {
  const config = input.config ?? loadConfig();
  const user = getHostUserPaths(input.record.userId, config);
  if (!/^[a-f0-9]{24}$/.test(input.runtime.generation)) throw new Error("Invalid managed generation");
  return {
    name: input.record.name,
    Image: input.record.image,
    User: `${config.runtimeUid}:${config.runtimeGid}`,
    Cmd: ["dumb-init", "--", "opencode2", "serve", "--hostname", "0.0.0.0", "--port", String(config.opencodePort)],
    Env: [
      "HOME=/home/node",
      "XDG_CONFIG_HOME=/opt/opshelper/config",
      "XDG_DATA_HOME=/state/v2/data",
      "XDG_CACHE_HOME=/state/v2/cache",
      "XDG_STATE_HOME=/state/v2/state",
      "OPENCODE_DISABLE_PROJECT_CONFIG=true",
      "OPENCODE_DISABLE_EXTERNAL_SKILLS=true",
      "OPENCODE_DISABLE_MODELS_FETCH=true",
      "OPENCODE_DISABLE_AUTOUPDATE=true",
      "OPENCODE_DISABLE_DEFAULT_PLUGINS=true",
      `OPENCODE_PORT=${config.opencodePort}`,
      `OPENCODE_WORKING_DIR=${config.opencodeDirectory}`,
      "OPENCODE_SERVER_USERNAME=opencode",
      `OPENCODE_SERVER_PASSWORD=${input.runtime.password}`,
    ],
    WorkingDir: config.opencodeDirectory,
    ExposedPorts: { [`${config.opencodePort}/tcp`]: {} },
    Labels: {
      "opshelper.managed": "true",
      "opshelper.userId": input.record.userId,
      "opshelper.generation": input.runtime.generation,
    },
    HostConfig: {
      Binds: [
        `${user.workspace}:${config.opencodeDirectory}:rw`,
        `${user.state}:/state:rw`,
        `${path.join(user.managed, "releases", input.runtime.generation)}:/opt/opshelper:ro`,
      ],
      NetworkMode: config.dockerNetwork,
      ExtraHosts: ["host.docker.internal:host-gateway"],
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Tmpfs: { "/tmp": "rw,nosuid,nodev,size=256m,mode=1777" },
      Memory: config.runtimeMemoryMb * 1024 * 1024,
      NanoCpus: Math.round(config.runtimeCpus * 1e9),
      PidsLimit: 256,
      RestartPolicy: { Name: "unless-stopped" },
    },
  };
}

export function isStaleRuntime(inspect: Docker.ContainerInspectInfo, expected: Docker.ContainerCreateOptions, imageEnvironment: string[] = []) {
  const sorted = (values: string[] | null | undefined) => [...(values ?? [])].sort();
  const environment = (values: string[]) => Object.fromEntries(values.map((value) => {
    const at = value.indexOf("=");
    return [value.slice(0, at), value.slice(at + 1)];
  }));
  const expectedEnvironment = environment([...imageEnvironment, ...(expected.Env ?? [])]);
  const actualEnvironment = environment(inspect.Config?.Env ?? []);
  const envDiffers = Object.keys(expectedEnvironment).length !== Object.keys(actualEnvironment).length ||
    Object.entries(expectedEnvironment).some(([key, value]) => actualEnvironment[key] !== value);
  return JSON.stringify(inspect.Config?.Cmd ?? []) !== JSON.stringify(expected.Cmd ?? []) ||
    JSON.stringify(sorted(inspect.HostConfig?.Binds)) !== JSON.stringify(sorted(expected.HostConfig?.Binds)) ||
    envDiffers ||
    inspect.Config?.User !== expected.User ||
    inspect.HostConfig?.ReadonlyRootfs !== expected.HostConfig?.ReadonlyRootfs ||
    inspect.HostConfig?.NetworkMode !== expected.HostConfig?.NetworkMode ||
    inspect.HostConfig?.Memory !== expected.HostConfig?.Memory ||
    inspect.HostConfig?.NanoCpus !== expected.HostConfig?.NanoCpus ||
    JSON.stringify(sorted(inspect.HostConfig?.CapDrop)) !== JSON.stringify(sorted(expected.HostConfig?.CapDrop)) ||
    JSON.stringify(sorted(inspect.HostConfig?.SecurityOpt)) !== JSON.stringify(sorted(expected.HostConfig?.SecurityOpt)) ||
    JSON.stringify(sorted(inspect.HostConfig?.ExtraHosts)) !== JSON.stringify(sorted(expected.HostConfig?.ExtraHosts)) ||
    JSON.stringify(inspect.HostConfig?.Tmpfs ?? {}) !== JSON.stringify(expected.HostConfig?.Tmpfs ?? {}) ||
    inspect.HostConfig?.PidsLimit !== expected.HostConfig?.PidsLimit ||
    inspect.HostConfig?.RestartPolicy?.Name !== expected.HostConfig?.RestartPolicy?.Name ||
    Object.keys(inspect.HostConfig?.PortBindings ?? {}).length > 0 ||
    (inspect.HostConfig?.Mounts?.length ?? 0) > 0 ||
    Object.keys(inspect.NetworkSettings?.Networks ?? {}).some((name) => name !== expected.HostConfig?.NetworkMode);
}
