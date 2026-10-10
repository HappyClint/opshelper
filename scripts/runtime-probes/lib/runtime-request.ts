import { z } from "zod";
import type { ManagedRuntime } from "../../../apps/api/src/lib/managed-runtime";

const textPart = z.object({ type: z.literal("text"), text: z.string().min(1).max(100_000) }).strict();
const filePart = z.object({
  type: z.literal("file"), mime: z.string().max(128), filename: z.string().max(255),
  url: z.string().max(4096),
  source: z.object({
    type: z.literal("file"), path: z.string().max(4096),
    text: z.object({ value: z.string().max(512), start: z.number().nonnegative(), end: z.number().nonnegative() }).strict(),
  }).strict().optional(),
}).strict();
const prompt = z.object({
  agent: z.string().min(1), parts: z.array(z.union([textPart, filePart])).min(1).max(20),
  model: z.object({ providerID: z.string(), modelID: z.string() }).strict().optional(),
}).strict();
const sessionId = "[A-Za-z0-9_-]{1,128}";

export class RuntimeRequestError extends Error {
  constructor(message = "此操作不在当前用户运行入口范围内", public statusCode = 403) { super(message); }
}

export function authorizeRuntimeOwner(actorId: string, requestedUserId: string, containerUserId?: string) {
  if (actorId !== requestedUserId || (containerUserId !== undefined && containerUserId !== actorId)) {
    throw new RuntimeRequestError("不能访问其他用户的运行环境");
  }
}

/** Phase-2 controlled adapter. There is no caller-supplied target or config. */
export function validateRuntimeRequest(method: string, url: URL, body: unknown, runtime: Pick<ManagedRuntime, "agentKeys" | "model">, directory = "/workspace") {
  for (const key of url.searchParams.keys()) {
    if (key !== "directory") throw new RuntimeRequestError("不支持的运行参数");
  }
  const directories = url.searchParams.getAll("directory");
  if (directories.length > 1 || (directories[0] && directories[0] !== directory)) {
    throw new RuntimeRequestError("运行目录由平台固定");
  }
  const route = url.pathname;
  if (/%|\\|\.\.|\0/.test(route)) throw new RuntimeRequestError();
  if (method === "GET" && (
    ["/global/health", "/event", "/session", "/session/status", "/agent", "/config", "/question", "/permission"].includes(route) ||
    new RegExp(`^/session/${sessionId}(/children|/message)?$`).test(route)
  )) return { path: `${route}?directory=${encodeURIComponent(directory)}`, body: undefined };

  if (method === "POST" && route === "/session") {
    const parsed = z.object({ title: z.string().max(200).optional() }).strict().safeParse(body ?? {});
    if (!parsed.success) throw new RuntimeRequestError("会话只接受标题，不接受权限或父会话覆盖", 400);
    return { path: `${route}?directory=${encodeURIComponent(directory)}`, body: {
      ...parsed.data,
      permission: [
        { permission: "task", pattern: "*", action: "deny" },
        ...runtime.agentKeys.map((key) => ({ permission: "task", pattern: key, action: "allow" })),
      ],
    } };
  }
  if (method === "POST" && new RegExp(`^/session/${sessionId}/prompt_async$`).test(route)) {
    const parsed = prompt.safeParse(body);
    if (!parsed.success) throw new RuntimeRequestError("消息格式不正确；工具、权限由平台配置", 400);
    if (!runtime.agentKeys.includes(parsed.data.agent)) throw new RuntimeRequestError("智能体未装入当前用户环境");
    if (parsed.data.model && `${parsed.data.model.providerID}/${parsed.data.model.modelID}` !== runtime.model) {
      throw new RuntimeRequestError("模型与已装配配置不一致，请刷新后选择当前模型", 400);
    }
    for (const part of parsed.data.parts) {
      if (part.type !== "file") continue;
      let attachment: URL;
      try { attachment = new URL(part.url); } catch { throw new RuntimeRequestError("附件地址无效", 400); }
      let filePath: string;
      try { filePath = decodeURIComponent(attachment.pathname); } catch { throw new RuntimeRequestError("附件地址无效", 400); }
      if (attachment.protocol !== "file:" || attachment.host || attachment.search || attachment.hash ||
          !filePath.startsWith(`${directory}/`) || filePath.split("/").includes("..") || filePath.includes("\0") || filePath.includes("\\")) {
        throw new RuntimeRequestError("附件必须位于当前用户工作目录");
      }
      if (part.source && part.source.path !== filePath) throw new RuntimeRequestError("附件路径不一致", 400);
    }
    return { path: `${route}?directory=${encodeURIComponent(directory)}`, body: {
      agent: parsed.data.agent,
      parts: parsed.data.parts.map((part) => part.type === "text" ? part : { type: part.type, mime: part.mime, filename: part.filename, url: part.url }),
    } };
  }
  if (method === "POST" && new RegExp(`^/session/${sessionId}/abort$`).test(route)) {
    if (body !== undefined && body !== null && Object.keys(body as object).length) throw new RuntimeRequestError("停止操作不接受附加参数", 400);
    return { path: `${route}?directory=${encodeURIComponent(directory)}`, body: {} };
  }
  // Replies resume existing runtime questions; they cannot mutate configuration.
  if (method === "POST" && new RegExp(`^/question/${sessionId}/reply$`).test(route)) {
    const parsed = z.object({ answers: z.array(z.array(z.string().max(10_000)).max(20)).max(20) }).strict().safeParse(body);
    if (!parsed.success) throw new RuntimeRequestError("回答格式不正确", 400);
    return { path: `${route}?directory=${encodeURIComponent(directory)}`, body: parsed.data };
  }
  if (method === "POST" && new RegExp(`^/session/${sessionId}/permissions/${sessionId}$`).test(route)) {
    const parsed = z.object({ response: z.enum(["once", "reject"]) }).strict().safeParse(body);
    if (!parsed.success) throw new RuntimeRequestError("仅允许本次确认或拒绝", 400);
    return { path: `${route}?directory=${encodeURIComponent(directory)}`, body: parsed.data };
  }
  throw new RuntimeRequestError();
}
