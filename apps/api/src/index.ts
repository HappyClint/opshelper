import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import Fastify from "fastify";

import { requestLoggerOptions } from "./lib/request-logger";
import { loadConfig } from "./lib/config";
import {
  ContainerLifecycleLockError,
  WakeAttemptCoolingDownError,
} from "./lib/container-lifecycle";
import { retireBrowserMcpConfig } from "./lib/admin-config-service";
import { registerEmptyJsonBodyParser } from "./lib/empty-json-body-parser";
import { pruneChatUploads } from "./lib/file-service";
import { registerHealthRoutes } from "./routes/health";
import { registerAppRoutes } from "./routes/app";
import { registerAuthRoutes } from "./routes/auth";
import { registerFileRoutes } from "./routes/files";
import { registerAdminConfigRoutes } from "./routes/admin-config";
import { registerAgentRoutes } from "./routes/agents";
import { resumeRuntimeConfigurationApplications } from "./lib/runtime-configuration-service";
import { registerConversationRoutes } from "./routes/conversations";
import {
  pruneEmptyExecutionOutputDirectories,
  startExecutionLoop,
} from "./lib/conversation-service";
import { registerScheduleRoutes } from "./routes/schedules";

const config = loadConfig();

const app = Fastify({
  logger: requestLoggerOptions,
});

registerEmptyJsonBodyParser(app);

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof WakeAttemptCoolingDownError) {
    return reply.code(429).send({
      message: "Container wake attempt is cooling down, please retry shortly.",
    });
  }

  if (error instanceof ContainerLifecycleLockError) {
    return reply.code(503).send({
      message: "Container lifecycle operation is already in progress.",
    });
  }

  return reply.send(error);
});

async function bootstrap() {
  let stopExecutionLoop: (() => void) | null = null;
  app.addHook("onClose", async () => stopExecutionLoop?.());

  await retireBrowserMcpConfig()
    .then((changed) => {
      if (changed) {
        app.log.info("Removed retired browser MCP entries from shared opencode config.");
      }
    })
    .catch((error) => {
      app.log.warn({ error }, "Failed to remove retired browser MCP config entries.");
    });

  await app.register(cookie);
  await app.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024 },
  });

  await registerHealthRoutes(app);
  await registerAuthRoutes(app);
  await registerAppRoutes(app);
  await registerFileRoutes(app);
  await registerAdminConfigRoutes(app);
  await registerAgentRoutes(app);
  await registerConversationRoutes(app);
  await registerScheduleRoutes(app);

  await resumeRuntimeConfigurationApplications()
    .then((result) => {
      if (result.resumed > 0 || result.frozen > 0) {
        app.log.info(result, "Recovered user runtime configuration states.");
      }
    })
    .catch((error) => app.log.warn({ error }, "Failed to resume runtime configuration updates."));

  await pruneEmptyExecutionOutputDirectories()
    .then((removed) => {
      if (removed > 0) app.log.info({ removed }, "Removed empty execution output directories.");
    })
    .catch((error) => app.log.warn({ error }, "Failed to prune empty execution output directories."));

  startChatUploadSweep();

  await app.listen({
    host: config.apiHost,
    port: config.port,
  });

  stopExecutionLoop = startExecutionLoop(app.log);
}

// Periodically prune stale chat-composer uploads (`.chat-uploads/`). The api
// is the natural home for this: it's the process that bind-mounts the user data
// path. Disabled when the TTL is 0.
function startChatUploadSweep() {
  if (config.chatUploadTtlHours <= 0) {
    return;
  }
  const intervalMs = 60 * 60 * 1000; // hourly
  const sweep = () => {
    pruneChatUploads(config.chatUploadTtlHours)
      .then((removed) => {
        if (removed > 0) {
          app.log.info(`[chat-uploads] pruned ${removed} stale upload(s)`);
        }
      })
      .catch((error) => app.log.warn({ error }, "[chat-uploads] prune failed"));
  };
  sweep();
  const timer = setInterval(sweep, intervalMs);
  // Don't keep the event loop alive solely for the sweep timer.
  timer.unref?.();
  app.addHook("onClose", async () => clearInterval(timer));
}

bootstrap().catch(async (error) => {
  app.log.error(error);
  await app.close();
  process.exit(1);
});
