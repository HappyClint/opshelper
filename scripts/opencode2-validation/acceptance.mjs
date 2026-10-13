import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.env.UPGRADE_PRIVATE_DIR;
if (!root || !process.env.UPGRADE_TEST_PASSWORD) throw new Error("Isolated runner environment required");
const base = `http://127.0.0.1:${process.env.UPGRADE_TEST_PORT ?? 4340}`;
const fixturePath = path.join(root, "fixture.json");
const report = { startedAt: new Date().toISOString(), status: "failed", modelPeer: "deterministic OpenAI-compatible fixture", runtime: "real OpenCode", checks: [] };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", timeout: 60_000 }).trim();
function record(name) { report.checks.push({ name, passed: true }); console.log(`PASS ${name}`); }
async function until(read, ready, label, timeout = 120_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await read();
    if (ready(result)) return result;
    await pause(400);
  }
  throw new Error(`Timeout: ${label}`);
}
class Client {
  cookie = "";
  async request(route, method = "GET", body, status = 200) {
    const form = body instanceof FormData;
    const response = await fetch(base + route, {
      method, headers: { cookie: this.cookie, ...(!form && body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : form ? body : JSON.stringify(body), signal: AbortSignal.timeout(130_000),
    });
    const cookie = response.headers.get("set-cookie");
    if (cookie) this.cookie = cookie.split(";", 1)[0];
    const raw = await response.text();
    let value;
    try { value = raw ? JSON.parse(raw) : null; } catch { value = raw; }
    assert.equal(response.status, status, `${route}: ${typeof value === "object" ? value?.message ?? "" : raw.slice(0, 120)}`);
    return value;
  }
  login(username) { return this.request("/v1/auth/login", "POST", { username, password: process.env.UPGRADE_TEST_PASSWORD }); }
}
function runtime(userId, route, method = "GET", body) {
  const script = `const h={Authorization:'Basic '+Buffer.from('opencode:'+process.env.OPENCODE_SERVER_PASSWORD).toString('base64'),'Content-Type':'application/json'}; const r=await fetch('http://127.0.0.1:4096'+${JSON.stringify(route)},{method:${JSON.stringify(method)},headers:h,body:${body === undefined ? "undefined" : JSON.stringify(JSON.stringify(body))}}); console.log(JSON.stringify({status:r.status,value:await r.json()}));`;
  return JSON.parse(execFileSync("docker", ["exec", "-i", `opshelper-user-${userId}`, "node", "--input-type=module", "-"], { input: script, encoding: "utf8", timeout: 60_000 }));
}
async function snapshot(client, id) { return client.request(`/v1/conversations/${id}`); }
const text = (state) => state.messages.flatMap((m) => m.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n");
const execution = (state, id) => state.executions.find((e) => e.id === id);
async function conversation(client) { return (await client.request("/v1/conversations", "POST", { leadAgentKey: "fixture-lead", title: "Runtime upgrade acceptance" }, 201)).conversationId; }
async function send(client, id, input, options = {}) {
  return (await client.request(`/v1/conversations/${id}/executions`, "POST", { leadAgentKey: "fixture-lead", text: input, requestKey: randomUUID(), model: "custom/fixture-model", ...options }, 202)).executionId;
}
async function complete(client, id, eid, expected) {
  // Execution reconciliation may finish after the snapshot's message read.
  // Require both persisted completion and its visible answer on the next poll.
  let state = await until(() => snapshot(client, id), (s) => {
    const status = execution(s, eid)?.status;
    return ["failed", "cancelled", "interrupted", "succeeded"].includes(status);
  }, expected);
  state = await snapshot(client, id);
  assert.equal(execution(state, eid).status, "succeeded", JSON.stringify(execution(state, eid)));
  assert.ok(text(state).includes(expected), `${expected} missing from conversation`);
  return state;
}
async function perform(client, input, expected, options) {
  const id = await conversation(client);
  const eid = await send(client, id, input, options);
  return { id, eid, state: await complete(client, id, eid, expected) };
}
async function ready(admin, userId) {
  return until(() => admin.request(`/v1/admin/users/${userId}/agents`), (s) => s.configuration.status === "ready", "managed runtime ready");
}
async function baseline(admin, alice) {
  const users = {};
  for (const username of ["upgrade-alice", "upgrade-bob"]) {
    users[username] = (await admin.request("/v1/admin/users", "POST", { username, name: username, password: process.env.UPGRADE_TEST_PASSWORD, role: "user" }, 201)).user.id;
    await writeFile(fixturePath, JSON.stringify({ users }));
  }
  await admin.request("/v1/admin/opencode/models", "PUT", { baseURL: "http://fixture:4100/v1", models: [{ id: "fixture-model", name: "Fixture" }, { id: "fixture-model-alt", name: "Alternate fixture" }], defaultModel: "fixture-model", apiKey: "fixture-local-only" });
  const agents = [];
  for (const key of ["fixture-lead", "fixture-sub", "fixture-leaf", "personal-upgrade"]) {
    const files = { "agent.md": `---\nname: ${key}\ndescription: Runtime upgrade fixture\nmode: ${key === "fixture-lead" ? "primary" : key === "personal-upgrade" ? "all" : "subagent"}\ntools:\n  task: true\n  read: true\n  bash: true\n  question: true\n${key === "fixture-lead" ? 'skills: ["ping"]\n' : ""}---\nOnly run the generated acceptance fixture.\n` };
    if (key === "fixture-lead") {
      files["skills/ping/SKILL.md"] = "---\nname: ping\ndescription: Fixture skill\n---\nSKILL_CONTENT_OK\n";
      files["mcp.json"] = JSON.stringify({ fixture: { type: "remote", url: "http://fixture:4100/mcp", enabled: true, oauth: false } });
    }
    agents.push((await admin.request("/v1/admin/agents", "POST", { key, files }, 201)).agent.id);
  }
  for (const uid of Object.values(users)) {
    const current = await admin.request(`/v1/admin/users/${uid}/agents`);
    await admin.request(`/v1/admin/users/${uid}/agents`, "PUT", { agentIds: uid === users["upgrade-alice"] ? agents : agents.slice(0, 3), expectedDesiredGeneration: current.configuration.desiredGeneration });
    await ready(admin, uid);
  }
  await alice.login("upgrade-alice");
  const form = new FormData();
  form.append("path", "/workspace/files");
  form.append("file", new Blob(["FIXTURE_CONTENT_OK\n"]), "fixture.txt");
  await alice.request("/v1/users/me/files/upload", "POST", form);
  const item = await perform(alice, "E2E_BASIC", "E2E_BASIC_OK");
  const nativeId = runtime(users["upgrade-alice"], "/api/session").value.data.find((s) => s.title === `opshelper:${item.id}`).id;
  await writeFile(fixturePath, JSON.stringify({ users, agents, conversation: item.id, nativeId }));
  record("fresh V2 users, managed agents, custom models and basic execution");
}

async function upgraded(admin, alice) {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const uid = fixture.users["upgrade-alice"];
  await alice.login("upgrade-alice");
  await alice.request("/v1/users/me/container/start", "POST");
  assert.equal(runtime(uid, "/api/info").value.version, "2.0.27");
  report.image = docker("inspect", `opshelper-user-${uid}`, "--format", "{{.Image}}");
  const container = JSON.parse(docker("inspect", `opshelper-user-${uid}`))[0];
  assert.equal(container.HostConfig.ReadonlyRootfs, true);
  assert.notEqual(container.Config.User.split(":")[0], "0");
  assert.equal(Object.keys(container.HostConfig.PortBindings ?? {}).length, 0);
  assert.ok(container.Config.Env.includes("XDG_DATA_HOME=/state/v2/data"));
  assert.equal(docker("exec", `opshelper-user-${uid}`, "node", "-e", "fetch('http://127.0.0.1:4096/api/info').then(r=>console.log(r.status))"), "401");
  record("runtime is non-root, root filesystem is read-only, ports are private and API requires authentication");
  await complete(alice, fixture.conversation, await send(alice, fixture.conversation, "E2E_CONTINUE"), "HISTORY_CONTINUE_OK");
  record("V2 conversation preserves context across turns");

  if (process.env.VALIDATION_FROM !== "interactions") {
  const id = await conversation(alice);
  const controller = new AbortController();
  let frames = "";
  const stream = fetch(`${base}/v1/conversations/${id}/events`, { headers: { cookie: alice.cookie }, signal: controller.signal }).then(async (r) => {
    assert.equal(r.status, 200);
    const decoder = new TextDecoder();
    for await (const chunk of r.body) frames += decoder.decode(chunk, { stream: true });
    frames += decoder.decode();
  }).catch((e) => { if (e.name !== "AbortError") throw e; });
  try {
    await pause(300);
    const first = await send(alice, id, "E2E_BASIC");
    const second = await send(alice, id, "E2E_BASIC SECOND");
    const state = await complete(alice, id, second, "E2E_BASIC_OK");
    assert.equal(execution(state, first).status, "succeeded");
    await until(async () => frames, (s) => s.includes("中文流式输出完成"), "Chinese SSE");
    assert.ok(frames.includes("event: text"));
    assert.ok(!frames.includes("opshelper-execution:"));
    assert.ok(execution(state, first).startedAt <= execution(state, second).startedAt);
  } finally {
    controller.abort();
    await stream;
  }
  record("queued turns and Chinese SSE through nginx; internal markers are redacted");

  for (const [input, expected] of [["E2E_FORBIDDEN", "E2E_FORBIDDEN_OK"], ["E2E_COLLAB", "E2E_COLLAB_OK"], ["E2E_NESTED", "E2E_NESTED_OK"], ["E2E_SKILL", "SKILL_UPGRADE_OK"], ["E2E_MCP", "MCP_UPGRADE_OK"], ["E2E_RETRY", "RETRY_UPGRADE_OK"], ["E2E_OUTPUT", "OUTPUT_UPGRADE_OK"]]) {
    const item = await perform(alice, input, expected);
    if (input === "E2E_FORBIDDEN") assert.equal(item.state.collaborations.length, 0);
    if (input === "E2E_NESTED") {
      assert.ok(JSON.stringify(item.state.collaborations).includes("fixture-leaf"));
    }
    if (input === "E2E_SKILL") assert.ok(!JSON.stringify(item.state.messages).includes("SKILL_CONTENT_OK"));
    record(input);
  }
  const leafFiles = (mode) => ({ "agent.md": `---\nname: fixture-leaf\ndescription: Role-change fixture\nmode: ${mode}\ntools:\n  task: true\n  read: true\n---\nOnly run the generated acceptance fixture.\n` });
  await admin.request("/v1/admin/agents/fixture-leaf", "PATCH", { files: leafFiles("primary") });
  await ready(admin, uid);
  const roleConversation = await perform(alice, "E2E_NESTED", "E2E_TOOL_FAILED");
  const roleNative = runtime(uid, "/api/session").value.data.find((session) => session.title === `opshelper:${roleConversation.id}`);
  const roleMessages = runtime(uid, `/api/session/${roleNative.id}/message?order=asc`).value.data.map((message) => message.id);
  assert.ok(!roleNative.permissions.some((rule) => rule.resource === "fixture-leaf" && rule.effect === "allow"));
  await admin.request("/v1/admin/agents/fixture-leaf", "PATCH", { files: leafFiles("all") });
  await ready(admin, uid);
  const afterRole = await complete(alice, roleConversation.id, await send(alice, roleConversation.id, "E2E_NESTED"), "E2E_NESTED_OK");
  assert.ok(JSON.stringify(afterRole.collaborations).includes("fixture-leaf"));
  assert.deepEqual(runtime(uid, `/api/session/${roleNative.id}/message?order=asc`).value.data.slice(0, roleMessages.length).map((message) => message.id), roleMessages);
  assert.ok(runtime(uid, `/api/session/${roleNative.id}`).value.data.permissions.some((rule) => rule.resource === "fixture-leaf" && rule.effect === "allow"));
  record("primary-to-all role change removes obsolete denials and permits nested delegation in the same conversation");

  const download = await fetch(`${base}/v1/users/me/files/download?path=${encodeURIComponent("/workspace/files/upgrade-result.txt")}`, { headers: { cookie: alice.cookie } });
  assert.equal(download.status, 200); assert.equal(await download.text(), "OUTPUT_UPGRADE_OK");
  record("generated result file downloads with exact content");

  }
  const form = new FormData();
  form.append("path", "/workspace/files");
  form.append("file", new Blob(["ATTACHMENT_CONTENT_OK\n"], { type: "text/plain" }), `attachment-${randomUUID()}.txt`);
  const upload = await alice.request("/v1/users/me/files/upload", "POST", form);
  await perform(alice, "E2E_ATTACHMENT", "ATTACHMENT_UPGRADE_OK", { attachments: [{ path: upload.path, filename: "attachment.txt", mime: "text/plain" }] });
  record("chat attachment is uploaded and read by the real runtime");

  const qid = await conversation(alice);
  const qeid = await send(alice, qid, "E2E_QUESTION");
  const question = await until(() => snapshot(alice, qid), (s) => s.pendingQuestion, "question wait");
  await alice.request(`/v1/executions/${qeid}/questions/${question.pendingQuestion.id}/reply`, "POST", { answers: [["Yes"]] });
  await complete(alice, qid, qeid, "QUESTION_UPGRADE_OK");
  record("question waits and resumes after reply");

  docker("exec", `opshelper-user-${uid}`, "sh", "-c", "printf PERMISSION_CONTENT_OK > /tmp/upgrade-fixture.txt");
  for (const response of ["once", "reject", "auto"]) {
    const pid = await conversation(alice);
    const peid = await send(alice, pid, "E2E_PERMISSION", { autoApprovePermissions: response === "auto" });
    if (response !== "auto") {
      const pending = await until(() => snapshot(alice, pid), (s) => s.pendingPermissions?.length, "permission wait");
      await alice.request(`/v1/executions/${peid}/permissions/${pending.pendingPermissions[0].id}/reply`, "POST", { response });
    }
    if (response === "reject") {
      const stopped = await until(() => snapshot(alice, pid), (s) => execution(s, peid)?.status === "failed", "rejected permission ends the V2 turn");
      assert.equal(stopped.pendingPermissions.length, 0);
      const native = runtime(uid, "/api/session").value.data.find((s) => s.title === `opshelper:${pid}`);
      const messages = runtime(uid, `/api/session/${native.id}/message`).value.data;
      const readParts = messages.flatMap((m) => m.content ?? []).filter((p) => p.type === "tool" && p.name === "read");
      assert.ok(readParts.some((p) => p.state.status === "error"));
      assert.ok(!readParts.some((p) => p.state.status === "completed"));
    } else await complete(alice, pid, peid, "PERMISSION_UPGRADE_OK");
    record(`external directory permission: ${response}`);
  }

  const cancelId = await conversation(alice);
  const cancelEid = await send(alice, cancelId, "E2E_CANCEL");
  const sleepRunning = () => JSON.parse(docker("exec", `opshelper-user-${uid}`, "node", "-e", "const fs=require('fs');console.log(JSON.stringify(fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p)).some(p=>{try{const a=fs.readFileSync('/proc/'+p+'/cmdline','utf8').split('\\x00');return a.some((v,i)=>(v==='sleep'||v.endsWith('/sleep'))&&a[i+1]==='30')}catch{return false}})))"));
  await until(async () => sleepRunning(), Boolean, "running sleep");
  const activeForkSource = await snapshot(alice, cancelId);
  await alice.request(`/v1/conversations/${cancelId}/fork`, "POST", {
    messageId: activeForkSource.messages.find((message) => message.info.role === "user").info.id,
  }, 409);
  await alice.request(`/v1/executions/${cancelEid}/abort`, "POST");
  await until(() => snapshot(alice, cancelId), (s) => execution(s, cancelEid)?.status === "cancelled", "cancelled execution");
  await until(async () => sleepRunning(), (running) => !running, "cancelled process exits");
  record("active conversation rejects forks; abort cancels a running shell operation");

  const childCancelId = await conversation(alice);
  const childCancelEid = await send(alice, childCancelId, "E2E_CANCEL_PARENT");
  await until(async () => sleepRunning(), Boolean, "running child sleep");
  await alice.request(`/v1/executions/${childCancelEid}/abort`, "POST");
  await until(() => snapshot(alice, childCancelId), (s) => execution(s, childCancelEid)?.status === "cancelled", "cancelled child execution");
  await until(async () => sleepRunning(), (running) => !running, "cancelled child process exits");
  record("abort stops descendant sessions and their shell processes");

  const bob = new Client(); await bob.login("upgrade-bob");
  const forkSource = await conversation(alice);
  await complete(alice, forkSource, await send(alice, forkSource, "E2E_BASIC PRIOR_CONTEXT_ALPHA"), "E2E_BASIC_OK");
  const forkAttachments = [{ path: "/workspace/files/fixture.txt", filename: "fixture.txt", mime: "text/plain" }];
  await complete(alice, forkSource, await send(alice, forkSource, "E2E_BASIC SELECTED_MESSAGE_BETA", { attachments: forkAttachments }), "E2E_BASIC_OK");
  const forkOriginal = await complete(alice, forkSource, await send(alice, forkSource, "E2E_BASIC FUTURE_CONTEXT_OMEGA"), "E2E_BASIC_OK");
  const forkUsers = forkOriginal.messages.filter((message) => message.info.role === "user");
  const selectedId = forkUsers[1].info.id;
  const forkRoute = `/v1/conversations/${forkSource}/fork`;
  const fork = await alice.request(forkRoute, "POST", { messageId: selectedId }, 201);
  assert.equal(fork.text, "E2E_BASIC SELECTED_MESSAGE_BETA");
  assert.deepEqual(fork.attachments, forkAttachments);
  const forkInitial = await snapshot(alice, fork.conversationId);
  assert.equal(forkInitial.messages.length, 2);
  assert.deepEqual(forkInitial.executions, []);
  assert.ok(text(forkInitial).includes("PRIOR_CONTEXT_ALPHA"));
  assert.ok(!text(forkInitial).includes("SELECTED_MESSAGE_BETA"));
  assert.ok(!text(forkInitial).includes("FUTURE_CONTEXT_OMEGA"));
  assert.ok(!text(forkInitial).includes("平台交互要求"));
  assert.deepEqual((await snapshot(alice, forkSource)).messages, forkOriginal.messages);
  const forkContinued = await complete(alice, fork.conversationId, await send(alice, fork.conversationId, "E2E_FORK_VERIFY"), "FORK_CONTEXT_OK");
  const nestedFork = await alice.request(`/v1/conversations/${fork.conversationId}/fork`, "POST", {
    messageId: forkContinued.messages.filter((message) => message.info.role === "user")[1].info.id,
  }, 201);
  assert.equal(text(await snapshot(alice, nestedFork.conversationId)), text(forkInitial));
  const firstFork = await alice.request(forkRoute, "POST", { messageId: forkUsers[0].info.id }, 201);
  assert.deepEqual((await snapshot(alice, firstFork.conversationId)).messages, []);
  const attachedFork = await alice.request(forkRoute, "POST", { messageId: forkUsers[2].info.id }, 201);
  const attachedHistory = await snapshot(alice, attachedFork.conversationId);
  assert.equal(attachedHistory.messages.length, 4);
  assert.equal(attachedHistory.messages[2].parts.find((part) => part.type === "file").filename, "fixture.txt");
  await bob.request(forkRoute, "POST", { messageId: selectedId }, 404);
  await alice.request(forkRoute, "POST", { messageId: forkOriginal.messages.find((message) => message.info.role === "assistant").info.id }, 400);
  await alice.request(forkRoute, "POST", { messageId: "msg-missing" }, 400);
  record("conversation forks retain earlier model context and attachment drafts, preserve source history, support nested/first-message boundaries and enforce ownership");
  await bob.request("/v1/users/me/container/start", "POST");
  await bob.request(`/v1/conversations/${fixture.conversation}`, "GET", undefined, 404);
  assert.equal(runtime(fixture.users["upgrade-bob"], `/api/session/${fixture.nativeId}`).status, 404);
  record("another user cannot access native or platform history");

  await perform(alice, "E2E_BASIC MODEL", "E2E_BASIC_OK", { model: "custom/fixture-model-alt" });
  const stats = JSON.parse(docker("exec", `${process.env.COMPOSE_PROJECT_NAME}-fixture-1`, "node", "-e", "fetch('http://127.0.0.1:4100/stats').then(r=>r.text()).then(console.log)"));
  assert.ok(stats.models.includes("fixture-model-alt"));
  assert.ok(stats.mcpCalls > 0 && stats.retryInjected);
  record("alternate configured model executes successfully");

  docker("exec", `opshelper-user-${uid}`, "node", "-e", "const fs=require('fs');fs.mkdirSync('/workspace/.opencode/agents',{recursive:true});fs.writeFileSync('/workspace/.opencode/opencode.json',JSON.stringify({agent:{rogue:{mode:'primary',prompt:'Unmanaged fixture'}}}));fs.writeFileSync('/workspace/.opencode/agents/rogue.md','---\\ndescription: Unmanaged fixture\\nmode: primary\\n---\\nUnmanaged fixture');");
  docker("restart", `opshelper-user-${uid}`);
  await alice.request("/v1/users/me/container/start", "POST");
  assert.ok(!runtime(uid, "/api/agent").value.data.some((agent) => agent.id === "rogue"));
  record("workspace project configuration cannot inject unmanaged agents");
  await complete(alice, fixture.conversation, await send(alice, fixture.conversation, "E2E_CONTINUE"), "HISTORY_CONTINUE_OK");
  record("runtime restart preserves history and permits continuation");

  const beforeRestart = await snapshot(alice, fixture.conversation);
  docker("restart", `${process.env.COMPOSE_PROJECT_NAME}-api-1`);
  await until(async () => { try { return (await fetch(`${base}/health`)).ok; } catch { return false; } }, Boolean, "API restart");
  const afterRestart = await snapshot(alice, fixture.conversation);
  assert.deepEqual(afterRestart.messages, beforeRestart.messages);
  await complete(alice, fixture.conversation, await send(alice, fixture.conversation, "E2E_CONTINUE"), "HISTORY_CONTINUE_OK");
  record("API restart preserves completed executions and does not replay prompts");

  const schedule = await alice.request("/v1/me/schedules", "POST", {
    name: "Upgrade worker fixture", prompt: "E2E_SCHEDULE", leadAgentKey: "fixture-lead", participantAgentKeys: [], attachments: [], model: "custom/fixture-model",
    rule: { frequency: "daily", localTime: "09:30" },
  }, 201);
  const sid = schedule.schedule?.id ?? schedule.id;
  docker("exec", process.env.UPGRADE_POSTGRES_CONTAINER, "psql", "-U", "opshelper", "-d", "opshelper", "-c", `UPDATE "Schedule" SET "nextRunAt"=NOW() WHERE id='${sid}';`);
  const runs = await until(() => alice.request(`/v1/me/schedules/${sid}`), (v) => v.runs?.some((r) => r.execution?.status === "succeeded"), "worker scheduled execution");
  const successfulRun = runs.runs.find((run) => run.execution?.status === "succeeded");
  const answer = await alice.request(`/v1/me/schedules/${sid}/runs/${successfulRun.id}/answer`);
  assert.ok(answer.answer?.includes("SCHEDULE_UPGRADE_OK"));
  record("worker dispatches and completes a scheduled execution");

  const current = await admin.request(`/v1/admin/users/${uid}/agents`);
  await admin.request(`/v1/admin/users/${uid}/agents`, "PUT", { agentIds: [fixture.agents[0]], expectedDesiredGeneration: current.configuration.desiredGeneration });
  const config = await ready(admin, uid);
  assert.deepEqual(config.configuration.actualAgentKeys, ["fixture-lead"]);
  await alice.request("/v1/users/me/container/start", "POST");
  const actualAgents = runtime(uid, "/api/agent").value.data.map((agent) => agent.id);
  assert.ok(actualAgents.includes("fixture-lead"));
  assert.ok(!actualAgents.includes("fixture-sub") && !actualAgents.includes("fixture-leaf"));
  record("assignment revocation rebuilds runtime and removes revoked agents");
  const html = await fetch(`${base}/gateway/login`).then((r) => r.text());
  assert.ok(html.includes("<!DOCTYPE html>"));
  record("current production web build renders through the isolated gateway");
}
try {
  const admin = new Client(); const alice = new Client();
  await admin.login("admin");
  if (process.argv[2] === "repair") {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    for (const uid of Object.values(fixture.users)) await admin.request(`/v1/admin/users/${uid}/agents/reconcile`, "POST");
    process.exit(0);
  }
  if (process.argv[2] !== "resume") await baseline(admin, alice);
  await upgraded(admin, alice);
  report.status = "passed";
} catch (error) {
  report.error = error.message;
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(root, `${process.argv[2] ?? "acceptance"}-report.json`), JSON.stringify(report, null, 2) + "\n");
}
