// Runs inside a disposable OpenCode runtime container. It never calls a model.
import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";

const password = process.env.PROBE_PASSWORD;
const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
const port = Number(process.env.OPENCODE_PORT ?? "4096");
const expectedAgents = JSON.parse(process.env.PROBE_EXPECTED_AGENTS ?? "[]");
const forbiddenAgents = JSON.parse(process.env.PROBE_FORBIDDEN_AGENTS ?? "[]");
const expectedVersion = process.env.OPENCODE_PROBE_VERSION ?? "1.18.34";
const checks = [];

function check(name, passed, details = {}) {
  checks.push({ name, passed: Boolean(passed), ...details });
}

async function request(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers ?? {}) };
  if (options.auth !== false) {
    headers.Authorization = `Basic ${Buffer.from(`${options.username ?? username}:${options.password ?? password}`).toString("base64")}`;
  }
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(20_000),
  });
  const raw = await response.text();
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    value = raw.slice(0, 1_000);
  }
  return { status: response.status, value };
}

async function expectWritable(directory, label) {
  const file = `${directory}/probe-write-${process.pid}`;
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(file, label);
    check(`${label} is writable`, (await readFile(file, "utf8")) === label, { directory });
  } catch (error) {
    check(`${label} is writable`, false, { directory, error: String(error?.code ?? error) });
  }
}

async function expectReadOnly(path, label) {
  try {
    await writeFile(path, "must-not-write");
    check(`${label} is read-only`, false, { path, error: "write unexpectedly succeeded" });
  } catch (error) {
    check(`${label} is read-only`, ["EACCES", "EROFS", "ENOENT"].includes(error?.code), {
      path,
      error: String(error?.code ?? error),
    });
  }
}

const uid = Number(execFileSync("id", ["-u"], { encoding: "utf8" }).trim());
const gid = Number(execFileSync("id", ["-g"], { encoding: "utf8" }).trim());
const version = execFileSync("opencode", ["--version"], { encoding: "utf8" }).trim();
check("fixed OpenCode version", version === expectedVersion, { version });
check("runtime uid and gid", uid === 1000 && gid === 1000, { uid, gid });

for (const [key, label] of [
  ["XDG_DATA_HOME", "XDG data"],
  ["XDG_CACHE_HOME", "XDG cache"],
  ["XDG_STATE_HOME", "XDG state"],
]) {
  await expectWritable(process.env[key], label);
}
await expectWritable("/workspace", "workspace");
await expectReadOnly(`/root/probe-${process.pid}`, "root filesystem");
await expectReadOnly(`${process.env.HOME}/probe-${process.pid}`, "home");
await expectReadOnly(`${process.env.XDG_CONFIG_HOME}/opencode/opencode.json`, "managed config");

try {
  await access(`${process.env.HOME}/.opencode`, constants.F_OK);
  check("home has no user-controlled .opencode discovery directory", false, { home: process.env.HOME });
} catch (error) {
  check("home has no user-controlled .opencode discovery directory", error?.code === "ENOENT", {
    home: process.env.HOME,
    error: String(error?.code ?? error),
  });
}

const health = await request("/global/health");
check("authenticated health endpoint", health.status === 200 && health.value?.version === expectedVersion, {
  status: health.status,
  value: health.value,
});
const unauthenticated = await request("/session", { auth: false });
check("BasicAuth rejects missing credentials", unauthenticated.status === 401, { status: unauthenticated.status });
const wrongPassword = await request("/session", { password: "wrong-fixture-password" });
check("BasicAuth rejects wrong credentials", wrongPassword.status === 401, { status: wrongPassword.status });

const agentResponse = await request("/agent?directory=%2Fworkspace");
const agentNames = Array.isArray(agentResponse.value) ? agentResponse.value.map((entry) => entry.name) : [];
check("only managed business fixture agents are discoverable", agentResponse.status === 200
  && expectedAgents.every((name) => agentNames.includes(name))
  && forbiddenAgents.every((name) => !agentNames.includes(name)), {
  status: agentResponse.status,
  agentNames,
  expectedAgents,
  forbiddenAgents,
});

const skillResponse = await request("/skill?directory=%2Fworkspace");
const skillNames = Array.isArray(skillResponse.value) ? skillResponse.value.map((entry) => entry.name) : [];
check("external home skills are not discovered", skillResponse.status === 200
  && !skillNames.includes("home-agents-rogue")
  && !skillNames.includes("home-claude-rogue"), {
  status: skillResponse.status,
  skillNames,
});

const created = await request("/session?directory=%2Fworkspace", {
  body: { title: `PHASE2_FIXTURE_${process.env.PROBE_USER_LABEL ?? "user"}` },
});
check("creates a session in isolated state", created.status === 200 && typeof created.value?.id === "string", {
  status: created.status,
  sessionId: created.value?.id ?? null,
});
const child = created.value?.id ? await request("/session?directory=%2Fworkspace", {
  body: {
    title: `PHASE2_CHILD_FIXTURE_${process.env.PROBE_USER_LABEL ?? "user"}`,
    parentID: created.value.id,
  },
}) : { status: 0, value: null };
const children = created.value?.id
  ? await request(`/session/${created.value.id}/children?directory=%2Fworkspace`)
  : { status: 0, value: null };
check("native parent-child session relation is queryable", child.status === 200
  && typeof child.value?.id === "string"
  && children.status === 200
  && Array.isArray(children.value)
  && children.value.some((entry) => entry.id === child.value.id && entry.parentID === created.value.id), {
  createStatus: child.status,
  childrenStatus: children.status,
  childSessionId: child.value?.id ?? null,
});

const workspaceMarker = await readFile("/workspace/fixture.txt", "utf8");
const markerMatched = workspaceMarker.toLowerCase().includes(process.env.PROBE_USER_LABEL.toLowerCase());
check("reads own workspace fixture", markerMatched, {
  markerMatched,
});

const report = {
  status: checks.every((entry) => entry.passed) ? "passed" : "failed",
  modelCalls: 0,
  version,
  uid,
  gid,
  agentNames,
  skillNames,
  sessionId: created.value?.id ?? null,
  childSessionId: child.value?.id ?? null,
  checks,
};
console.log(JSON.stringify(report));
process.exitCode = report.status === "passed" ? 0 : 1;
