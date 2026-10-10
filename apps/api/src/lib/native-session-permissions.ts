import { randomUUID } from "node:crypto";
import { z } from "zod";

const rule = z.object({
  permission: z.string(),
  pattern: z.string(),
  action: z.enum(["allow", "ask", "deny"]),
});
type Rule = z.infer<typeof rule>;
const rules = z.array(rule);
const migrationKey = "opshelperTaskPermissionMigrationV1";
const migration = z.object({
  version: z.literal(1),
  messageID: z.string().startsWith("msg_opshelper_permissions_"),
  nonTaskPermissions: rules.refine((items) => items.every((item) => item.permission !== "task")),
});
interface Session {
  permission?: unknown;
  metadata?: Record<string, unknown>;
}
type Request = <T>(method: "GET" | "POST" | "PATCH" | "DELETE", route: string, body?: unknown) => Promise<T>;

function taskPolicyMatches(actual: Rule[], desired: Rule[]) {
  const task = actual.filter((item) => item.permission === "task");
  // Last-rule evaluation alone is insufficient: OpenCode's child-session
  // inheritance copies EVERY deny, including denies superseded by an allow.
  if (task.some((item) => !desired.some((wanted) =>
    item.pattern === wanted.pattern && item.action === wanted.action,
  ))) return false;
  const last = new Map<string, number>();
  task.forEach((item, index) => last.set(item.pattern, index));
  const compact = task.filter((item, index) => last.get(item.pattern) === index);
  return JSON.stringify(compact) === JSON.stringify(desired);
}

/** Replace task rules without replacing native session/message IDs.
 * OpenCode 1.18 PATCH appends permissions. Its synchronous noReply/tools path
 * actually replaces them; it does not invoke a model. A durable metadata intent
 * preserves unrelated permissions across failures between these HTTP calls.
 */
export async function refreshNativeTaskPermissions(input: {
  sessionID: string;
  agent: string;
  permission: Array<{ permission: string; pattern: string; action: string }>;
  request: Request;
  inherited?: boolean;
}) {
  const desired = rules.parse(input.permission);
  if (desired.some((item) => item.permission !== "task")) throw new Error("Invalid managed task policy");
  const route = `/session/${input.sessionID}`;
  const session = await input.request<Session>("GET", route);
  const current = rules.parse(session.permission ?? []);
  const metadata = session.metadata ?? {};
  const recorded = metadata[migrationKey];
  const inheritedDenialsOnly = input.inherited && current
    .filter((item) => item.permission === "task")
    .every((item) => item.action === "deny" && desired.some((wanted) =>
      wanted.action === "deny" && wanted.pattern === item.pattern,
    ));
  if (recorded === undefined && (taskPolicyMatches(current, desired) || inheritedDenialsOnly)) return;

  const statuses = await input.request<Record<string, { type?: string }>>("GET", "/session/status");
  if (statuses[input.sessionID]?.type && statuses[input.sessionID].type !== "idle") {
    throw new Error("Cannot refresh permissions while the native session is active");
  }
  const intent = recorded === undefined ? {
    version: 1 as const,
    messageID: `msg_opshelper_permissions_${randomUUID().replaceAll("-", "")}`,
    nonTaskPermissions: current.filter((item) => item.permission !== "task"),
  } : migration.parse(recorded);
  if (recorded === undefined) {
    await input.request("PATCH", route, { metadata: { ...metadata, [migrationKey]: intent } });
  }
  // This creates only our empty maintenance message, using a known ID so that
  // a lost response or restart can recover and remove precisely that message.
  await input.request("POST", `${route}/message`, {
    messageID: intent.messageID,
    agent: input.agent,
    noReply: true,
    tools: { task: true },
    parts: [],
  });
  await input.request("PATCH", route, { permission: [...intent.nonTaskPermissions, ...desired] });
  const verified = await input.request<Session>("GET", route);
  const applied = rules.parse(verified.permission ?? []);
  if (!taskPolicyMatches(applied, desired) ||
    JSON.stringify(applied.filter((item) => item.permission !== "task")) !== JSON.stringify(intent.nonTaskPermissions)) {
    throw new Error("Native session permission refresh could not be verified");
  }
  await input.request("DELETE", `${route}/message/${intent.messageID}`);
  const { [migrationKey]: _intent, ...remainingMetadata } = verified.metadata ?? {};
  await input.request("PATCH", route, { metadata: remainingMetadata });
}

// Existing descendants can also contain inherited legacy denies and may be
// resumed by task_id. Refresh only this conversation's tree, never other roots.
export async function refreshNativeSessionTreeTaskPermissions(
  input: Parameters<typeof refreshNativeTaskPermissions>[0],
) {
  const seen = new Set<string>();
  const queue = [input.sessionID];
  for (let index = 0; index < queue.length; index++) {
    const sessionID = queue[index];
    if (seen.has(sessionID)) continue;
    seen.add(sessionID);
    await refreshNativeTaskPermissions({ ...input, sessionID, inherited: sessionID !== input.sessionID });
    // /session defaults to the 100 most recently updated sessions. The children
    // endpoint has no list limit, so older stored descendants are not missed.
    const children = await input.request<Array<{ id: string }>>("GET", `/session/${sessionID}/children`);
    queue.push(...children.map((child) => child.id));
  }
}
