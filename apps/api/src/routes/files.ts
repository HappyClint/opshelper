import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import mime from "mime-types";
import { z } from "zod";

import {
  BinaryFileError,
  createDirectory,
  createEmptyFile,
  deleteItem,
  getItemDownloadStream,
  listDirectory,
  moveItem,
  PathTraversalError,
  PayloadTooLargeError,
  readTextFile,
  saveUploadedFile,
  StaleFileError,
  writeTextFile,
} from "../lib/file-service";
import { requireSession } from "../lib/session";

const listQuerySchema = z.object({
  path: z.string().optional().default(""),
  showHidden: z
    .union([z.literal("0"), z.literal("1"), z.literal("true"), z.literal("false")])
    .optional(),
});

const downloadQuerySchema = z.object({
  path: z.string().min(1),
  inline: z
    .union([z.literal("0"), z.literal("1"), z.literal("true"), z.literal("false")])
    .optional(),
});

const contentQuerySchema = z.object({
  path: z.string().min(1),
});

const TEXT_CONTENT_LIMIT_BYTES = 2 * 1024 * 1024;
const TEXT_CONTENT_LIMIT_CHARS = 4 * 1024 * 1024;

const contentBodySchema = z.object({
  path: z.string().min(1),
  content: z.string().max(TEXT_CONTENT_LIMIT_CHARS),
  expectedModifiedAt: z.number().int().nonnegative().optional(),
});

const deleteBodySchema = z.object({
  path: z.string().min(1),
});

const mkdirBodySchema = z.object({
  path: z.string().min(1),
});

const moveBodySchema = z.object({
  sourcePath: z.string().min(1),
  targetDir: z.string(),
  targetName: z.string().min(1).optional(),
});

type UserIdResolver = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<string | undefined>;

function handleFileError(error: unknown, reply: FastifyReply) {
  if (error instanceof PathTraversalError) {
    return reply.code(403).send({ message: "Path traversal denied" });
  }
  if (error instanceof PayloadTooLargeError) {
    return reply
      .code(413)
      .send({ message: "File too large to preview", limit: error.limit, size: error.actual });
  }
  if (error instanceof BinaryFileError) {
    return reply
      .code(415)
      .send({ message: "Binary or non-UTF8 file is not supported for text preview" });
  }
  if (error instanceof StaleFileError) {
    return reply
      .code(409)
      .send({ message: "File has been modified by another process", currentModifiedAt: error.currentModifiedAt });
  }

  const err = error as NodeJS.ErrnoException;
  if (err.code === "ENOENT") {
    return reply.code(404).send({ message: "File or directory not found" });
  }
  if (err.code === "ENOTDIR") {
    return reply.code(400).send({ message: "Not a directory" });
  }
  if (err.code === "ENOTEMPTY") {
    return reply.code(409).send({ message: "Directory is not empty" });
  }
  if (err.code === "EEXIST") {
    return reply.code(409).send({ message: "Destination already exists" });
  }

  throw error;
}

function getMultipartTargetDir(
  fields: NonNullable<Awaited<ReturnType<FastifyRequest["file"]>>>["fields"],
) {
  return (fields.path as { value?: string } | undefined)?.value || "";
}

async function sendDownload(
  reply: FastifyReply,
  userId: string,
  itemPath: string,
  inline = false,
) {
  const {
    stream,
    stat,
    filename,
    contentType: fallbackContentType,
  } = await getItemDownloadStream(userId, itemPath);
  const contentType = mime.lookup(filename) || fallbackContentType;
  const disposition = inline ? "inline" : "attachment";

  const response = reply
    .header("X-Content-Type-Options", "nosniff")
    .header("Content-Type", contentType)
    .header(
      "Content-Disposition",
      `${disposition}; filename="${encodeURIComponent(filename)}"`,
    );

  if (inline && /^(text\/html|application\/xhtml\+xml|image\/svg\+xml)$/i.test(contentType)) {
    response.header("Content-Security-Policy", "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'");
  }

  if (stat) {
    response.header("Content-Length", stat.size);
  }

  return response.send(stream);
}

function registerScopedFileRoutes(
  app: FastifyInstance,
  prefix: string,
  resolveUserId: UserIdResolver,
) {
  app.get(`${prefix}/list`, async (request, reply) => {
    const userId = await resolveUserId(request, reply);
    if (!userId) return;

    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid query parameters" });
    }

    const showHidden =
      parsed.data.showHidden === "1" || parsed.data.showHidden === "true";

    try {
      return {
        files: await listDirectory(userId, parsed.data.path, showHidden),
      };
    } catch (error) {
      return handleFileError(error, reply);
    }
  });

  app.post(`${prefix}/upload`, async (request, reply) => {
    const userId = await resolveUserId(request, reply);
    if (!userId) return;

    try {
      const data = await request.file();
      if (!data) {
        return reply.code(400).send({ message: "No file uploaded" });
      }

      const filePath = await saveUploadedFile(
        userId,
        getMultipartTargetDir(data.fields),
        data.filename,
        data.file,
      );
      return { success: true, path: filePath };
    } catch (error) {
      return handleFileError(error, reply);
    }
  });

  app.get(`${prefix}/download`, async (request, reply) => {
    const userId = await resolveUserId(request, reply);
    if (!userId) return;

    const parsed = downloadQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ message: "Missing path parameter" });
    }

    const inline = parsed.data.inline === "1" || parsed.data.inline === "true";

    try {
      return await sendDownload(reply, userId, parsed.data.path, inline);
    } catch (error) {
      return handleFileError(error, reply);
    }
  });

  app.get(`${prefix}/content`, async (request, reply) => {
    const userId = await resolveUserId(request, reply);
    if (!userId) return;

    const parsed = contentQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ message: "Missing path parameter" });
    }

    try {
      const result = await readTextFile(userId, parsed.data.path, TEXT_CONTENT_LIMIT_BYTES);
      return result;
    } catch (error) {
      return handleFileError(error, reply);
    }
  });

  app.put(`${prefix}/content`, async (request, reply) => {
    const userId = await resolveUserId(request, reply);
    if (!userId) return;

    const parsed = contentBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid request body" });
    }

    const byteSize = Buffer.byteLength(parsed.data.content, "utf-8");
    if (byteSize > TEXT_CONTENT_LIMIT_BYTES) {
      return reply.code(413).send({
        message: "Content too large",
        limit: TEXT_CONTENT_LIMIT_BYTES,
        size: byteSize,
      });
    }

    try {
      const result = await writeTextFile(
        userId,
        parsed.data.path,
        parsed.data.content,
        parsed.data.expectedModifiedAt,
      );
      return { success: true, ...result };
    } catch (error) {
      return handleFileError(error, reply);
    }
  });

  app.post(`${prefix}/delete`, async (request, reply) => {
    const userId = await resolveUserId(request, reply);
    if (!userId) return;

    const parsed = deleteBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid request body" });
    }

    try {
      await deleteItem(userId, parsed.data.path);
      return { success: true };
    } catch (error) {
      return handleFileError(error, reply);
    }
  });

  app.post(`${prefix}/mkdir`, async (request, reply) => {
    const userId = await resolveUserId(request, reply);
    if (!userId) return;

    const parsed = mkdirBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid request body" });
    }

    try {
      await createDirectory(userId, parsed.data.path);
      return { success: true };
    } catch (error) {
      return handleFileError(error, reply);
    }
  });

  app.post(`${prefix}/touch`, async (request, reply) => {
    const userId = await resolveUserId(request, reply);
    if (!userId) return;

    const parsed = mkdirBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid request body" });
    }

    try {
      await createEmptyFile(userId, parsed.data.path);
      return { success: true };
    } catch (error) {
      return handleFileError(error, reply);
    }
  });

  app.post(`${prefix}/move`, async (request, reply) => {
    const userId = await resolveUserId(request, reply);
    if (!userId) return;

    const parsed = moveBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid request body" });
    }

    try {
      await moveItem(
        userId,
        parsed.data.sourcePath,
        parsed.data.targetDir,
        parsed.data.targetName,
      );
      return { success: true };
    } catch (error) {
      return handleFileError(error, reply);
    }
  });
}

export async function registerFileRoutes(app: FastifyInstance) {
  registerScopedFileRoutes(
    app,
    "/v1/users/me/files",
    async (request, reply) => {
      const user = await requireSession(request, reply);
      return user?.id;
    },
  );

  // Private workspace access always follows the logged-in user.
}
