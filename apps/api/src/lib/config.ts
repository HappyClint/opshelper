import path from "node:path";

import { z } from "zod";

const absolutePath = z.string().refine((value) => path.isAbsolute(value), {
  message: "must be an absolute path",
});

const configSchema = z.object({
  apiHost: z.string().default("0.0.0.0"),
  port: z.coerce.number().int().positive().default(4000),
  opencodeImage: z.string().default("opshelper/opencode-runtime:2.0.27"),
  opencodePort: z.coerce.number().int().positive().default(4096),
  opencodeDirectory: z.literal("/workspace").default("/workspace"),
  idleTimeoutMinutes: z.coerce.number().nonnegative().default(60),
  dockerNetwork: z.string().default("opshelper-runtime"),
  dockerSocketPath: absolutePath.default("/var/run/docker.sock"),
  sessionCookieName: z.string().default("opshelper_session"),
  sessionTtlHours: z.coerce.number().positive().default(168),
  chatUploadTtlHours: z.coerce.number().nonnegative().default(0),
  dataRoot: absolutePath.default("/data"),
  dataRootHost: absolutePath.default(path.resolve("data")),
  runtimeUid: z.coerce.number().int().positive().default(1000),
  runtimeGid: z.coerce.number().int().nonnegative().default(1000),
  runtimeMemoryMb: z.coerce.number().int().positive().default(2048),
  runtimeCpus: z.coerce.number().finite().positive().default(2),
  executionPollMs: z.coerce.number().int().min(250).default(1000),
  executionTimeoutMinutes: z.coerce.number().positive().default(30),
  interactionTimeoutMinutes: z.coerce.number().positive().default(30),
});

export type AppConfig = z.infer<typeof configSchema> & {
  opencodeConfigPath: string;
};

function envValue(value: string | undefined) {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  return value;
}

export function loadConfig(): AppConfig {
  const parsed = configSchema.parse({
    apiHost: envValue(process.env.OPSHELPER_API_HOST),
    port: envValue(process.env.OPSHELPER_API_PORT),
    opencodeImage: envValue(process.env.OPENCODE_DOCKER_IMAGE),
    opencodePort: envValue(process.env.OPENCODE_DOCKER_PORT),
    opencodeDirectory: envValue(process.env.OPENCODE_WORKING_DIR),
    idleTimeoutMinutes: envValue(process.env.OPSHELPER_IDLE_TIMEOUT_MINUTES),
    dockerNetwork: envValue(process.env.OPSHELPER_DOCKER_NETWORK),
    dockerSocketPath: envValue(process.env.DOCKER_SOCKET_PATH),
    sessionCookieName: envValue(process.env.OPSHELPER_SESSION_COOKIE_NAME),
    sessionTtlHours: envValue(process.env.OPSHELPER_SESSION_TTL_HOURS),
    chatUploadTtlHours: envValue(process.env.OPSHELPER_CHAT_UPLOAD_TTL_HOURS),
    dataRoot: envValue(process.env.DATA_ROOT),
    dataRootHost: envValue(process.env.DATA_ROOT_HOST),
    runtimeUid: envValue(process.env.OPENCODE_RUNTIME_UID),
    runtimeGid: envValue(process.env.OPENCODE_RUNTIME_GID),
    runtimeMemoryMb: envValue(process.env.OPENCODE_RUNTIME_MEMORY_MB),
    runtimeCpus: envValue(process.env.OPENCODE_RUNTIME_CPUS),
    executionPollMs: envValue(process.env.OPSHELPER_EXECUTION_POLL_MS),
    executionTimeoutMinutes: envValue(process.env.OPSHELPER_EXECUTION_TIMEOUT_MINUTES),
    interactionTimeoutMinutes: envValue(process.env.OPSHELPER_INTERACTION_TIMEOUT_MINUTES),
  });

  return {
    ...parsed,
    // The API keeps the shared model connection here. User runtimes receive
    // an immutable per-user projection and never mount this directory.
    opencodeConfigPath: path.join(parsed.dataRoot, "config", "opencode"),
  };
}
