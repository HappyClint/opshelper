// Authorized phase-2 probe for native OpenCode cooperation with one real model.
// It only uses generated fixture content and never reads a repository credential file.
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Docker from "dockerode";

import { loadConfig, type AppConfig } from "../../apps/api/src/lib/config";
import { prepareManagedRuntime } from "../../apps/api/src/lib/managed-runtime";
import { buildContainerCreateOptions, isStaleRuntime } from "../../apps/api/src/lib/opencode-container-runtime";
import { validateRuntimeRequest } from "./lib/runtime-request";

const image = process.env.OPENCODE_PROBE_IMAGE ?? "opshelper/opencode-runtime:1.18.34";
const socketPath = process.env.DOCKER_SOCKET_PATH ?? "/var/run/docker.sock";
const outputPath = path.resolve(process.env.OPENCODE_PROBE_REPORT ?? ".temp/runtime-probes/runtime-real-model.json");
const expectedVersion = process.env.OPENCODE_PROBE_VERSION ?? "1.18.34";
const providerID = "opshelper-ollama";
const modelID = "gpt-oss:120b";
const modelRef = `${providerID}/${modelID}`;
const endpoint = "https://ollama.com/v1";
const agentKeys = ["fixture-lead", "fixture-sub"];
const maximumModelDurationMs = 5 * 60_000;

type ApiResult = { status: number; value: any };
type Message = { info?: Record<string, any>; parts?: Array<Record<string, any>> };

function dockerCommand(args: string[], input?: string) {
  return spawnSync("docker", args, {
    input,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function basicRequest(container: string, password: string, route: string, method = "GET", body?: unknown): ApiResult {
  const client = [
    "const b=process.env.PROBE_BODY_B64?Buffer.from(process.env.PROBE_BODY_B64,'base64').toString():'';",
    "const h={Authorization:'Basic '+Buffer.from('opshelper:'+process.env.PROBE_PASSWORD).toString('base64')};",
    "if(b)h['Content-Type']='application/json';",
    "fetch('http://127.0.0.1:4096'+process.env.PROBE_ROUTE,{method:process.env.PROBE_METHOD,headers:h,body:b||undefined,signal:AbortSignal.timeout(20000)})",
    ".then(async r=>{const t=await r.text();let v=null;try{v=t?JSON.parse(t):null}catch{};console.log(JSON.stringify({status:r.status,value:v}))})",
    ".catch(()=>{console.log(JSON.stringify({status:0,value:null}));process.exitCode=2})",
  ].join("");
  const encoded = body === undefined ? "" : Buffer.from(JSON.stringify(body)).toString("base64");
  const result = dockerCommand([
    "exec", "-i",
    "--env", `PROBE_PASSWORD=${password}`,
    "--env", `PROBE_ROUTE=${route}`,
    "--env", `PROBE_METHOD=${method}`,
    "--env", `PROBE_BODY_B64=${encoded}`,
    container, "node", "--input-type=module", "-",
  ], client);
  if (result.status !== 0) throw new Error("RuntimeApiTransportError");
  try {
    return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}");
  } catch {
    throw new Error("RuntimeApiResponseError");
  }
}

function route(pathname: string) {
  return `${pathname}${pathname.includes("?") ? "&" : "?"}directory=%2Fworkspace`;
}

function requireApi(result: ApiResult, expected: number, stage: string) {
  if (result.status !== expected) throw new Error(`${stage}Http${result.status}`);
  return result.value;
}

async function waitHealthy(container: string, password: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const result = basicRequest(container, password, "/global/health");
      if (result.status === 200 && result.value?.version === expectedVersion) return true;
    } catch { /* The server socket is not ready during the first startup polls. */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function messages(container: string, password: string, sessionID: string): Message[] {
  const value = requireApi(basicRequest(container, password, route(`/session/${sessionID}/message`)), 200, "Messages");
  return Array.isArray(value) ? value : [];
}

function children(container: string, password: string, sessionID: string): any[] {
  const value = requireApi(basicRequest(container, password, route(`/session/${sessionID}/children`)), 200, "Children");
  return Array.isArray(value) ? value : [];
}

function toolParts(items: Message[], tool?: string) {
  return items.flatMap((item) => item.parts ?? []).filter((part) => part.type === "tool" && (!tool || part.tool === tool));
}

function assistantText(items: Message[]) {
  return items.filter((item) => item.info?.role === "assistant")
    .flatMap((item) => item.parts ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string).join("\n");
}

function answerMatches(text: string, marker: string, sum: number) {
  return text.includes(marker) && new RegExp(`\\bsum\\s*=\\s*${sum}(?![\\d.])`, "i").test(text);
}

function completedAssistant(items: Message[]) {
  return items.some((item) => item.info?.role === "assistant"
    && (item.info?.error || (typeof item.info?.time?.completed === "number"
      && typeof item.info?.finish === "string" && item.info.finish !== "tool-calls")));
}

function assistantModels(items: Message[]) {
  return items.filter((item) => item.info?.role === "assistant").map((item) => ({
    providerID: item.info?.providerID ?? null,
    modelID: item.info?.modelID ?? null,
    agent: item.info?.agent ?? null,
  }));
}

function assistantErrorNames(items: Message[]) {
  return items.filter((item) => item.info?.role === "assistant" && item.info?.error)
    .map((item) => String(item.info?.error?.name ?? "unknown"));
}

function inputMentions(part: Record<string, any>, expected: string) {
  return JSON.stringify(part.state?.input ?? {}).includes(expected);
}

function isBusy(statuses: any, sessionID: string) {
  return statuses?.[sessionID]?.type === "busy";
}

async function waitForCompletion(container: string, password: string, sessionID: string, deadline: number) {
  while (Date.now() < deadline) {
    const current = messages(container, password, sessionID);
    const statuses = requireApi(basicRequest(container, password, route("/session/status")), 200, "SessionStatus");
    const activeTools = toolParts(current).some((part) => ["pending", "running"].includes(part.state?.status));
    if (!statuses?.[sessionID] && !activeTools && completedAssistant(current)) return current;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error("ModelPhaseDeadlineExceeded");
}

async function captureEvents(container: string, password: string, durationMs: number) {
  const client = [
    "const out={connected:false,status:0,events:[]};const c=new AbortController();setTimeout(()=>c.abort(),Number(process.env.PROBE_DURATION));",
    "const sid=x=>x?.properties?.sessionID??x?.properties?.part?.sessionID??x?.properties?.info?.sessionID??null;",
    "try{const h={Authorization:'Basic '+Buffer.from('opshelper:'+process.env.PROBE_PASSWORD).toString('base64')};",
    "const r=await fetch('http://127.0.0.1:4096/event?directory=%2Fworkspace',{headers:h,signal:c.signal});out.connected=r.ok;out.status=r.status;",
    "const d=new TextDecoder();let q='';for await(const chunk of r.body){q+=d.decode(chunk,{stream:true});let i;while((i=q.indexOf('\\n\\n'))>=0){const block=q.slice(0,i);q=q.slice(i+2);",
    "for(const line of block.split('\\n'))if(line.startsWith('data: ')){try{const e=JSON.parse(line.slice(6));if(out.events.length<100)out.events.push({type:String(e.type??'unknown'),sessionID:sid(e)})}catch{}}}}}catch{}",
    "console.log(JSON.stringify(out));",
  ].join("");
  const child = spawn("docker", [
    "exec", "-i", "--env", `PROBE_PASSWORD=${password}`, "--env", `PROBE_DURATION=${durationMs}`,
    container, "node", "--input-type=module", "-",
  ], { stdio: ["pipe", "pipe", "ignore"] });
  child.stdin.end(client);
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  return await new Promise<{ connected: boolean; status: number; events: Array<{ type: string; sessionID: string | null }> }>((resolve) => {
    child.on("close", () => {
      try { resolve(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}")); }
      catch { resolve({ connected: false, status: 0, events: [] }); }
    });
    child.on("error", () => resolve({ connected: false, status: 0, events: [] }));
  });
}

function createSession(container: string, password: string, title: string) {
  const validated = validateRuntimeRequest("POST", new URL("http://runtime.local/session"), { title }, { agentKeys, model: modelRef });
  const value = requireApi(basicRequest(container, password, validated.path, "POST", validated.body), 200, "CreateSession");
  if (typeof value?.id !== "string") throw new Error("CreateSessionMissingId");
  return value.id as string;
}

function sendPrompt(container: string, password: string, sessionID: string, agent: string, text: string) {
  requireApi(basicRequest(container, password, route(`/session/${sessionID}/prompt_async`), "POST", {
    agent,
    model: { providerID, modelID },
    parts: [{ type: "text", text }],
  }), 204, "PromptAsync");
}

async function approveExactSleep(container: string, password: string, allowedSessions: Set<string>) {
  const pending = requireApi(basicRequest(container, password, route("/permission")), 200, "PermissionList");
  if (!Array.isArray(pending)) return 0;
  let approved = 0;
  for (const item of pending) {
    if (!allowedSessions.has(item?.sessionID)) continue;
    const command = item?.metadata?.command;
    if (item?.permission !== "bash" || command !== "sleep 120") throw new Error("UnexpectedPermissionRequest");
    requireApi(basicRequest(container, password, route(`/session/${item.sessionID}/permissions/${item.id}`), "POST", {
      response: "once",
    }), 200, "PermissionReply");
    approved += 1;
  }
  return approved;
}

async function waitForSleep(container: string, password: string, parentID: string, deadline: number) {
  let childID: string | undefined;
  let approvals = 0;
  while (Date.now() < deadline) {
    childID = childID ?? children(container, password, parentID).find((item) => item.parentID === parentID)?.id;
    approvals += await approveExactSleep(container, password, new Set([parentID, ...(childID ? [childID] : [])]));
    if (childID) {
      const childMessages = messages(container, password, childID);
      const sleep = toolParts(childMessages, "bash").find((part) => part.state?.status === "running"
        && part.state?.input?.command === "sleep 120");
      if (sleep) return { childID, approvals };
      const statuses = requireApi(basicRequest(container, password, route("/session/status")), 200, "SessionStatus");
      if (!statuses?.[childID] && completedAssistant(childMessages)) throw new Error("SleepEndedBeforeAbort");
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("ModelPhaseDeadlineExceeded");
}

async function waitAfterAbort(container: string, password: string, parentID: string, childID: string, deadline: number) {
  while (Date.now() < deadline) {
    const statuses = requireApi(basicRequest(container, password, route("/session/status")), 200, "SessionStatus");
    const parentMessages = messages(container, password, parentID);
    const childMessages = messages(container, password, childID);
    if (!isBusy(statuses, parentID) && !isBusy(statuses, childID)
      && completedAssistant(parentMessages) && completedAssistant(childMessages)) {
      return { statuses, parentMessages, childMessages };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("ModelPhaseDeadlineExceeded");
}

function assertReportSafe(value: unknown, environmentValue: string) {
  const serialized = JSON.stringify(value);
  if (serialized.includes(environmentValue)) throw new Error("ReportContainsEnvironmentValue");
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) return item.forEach(visit);
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      if (/api.?key|password|authorization|token|secret/i.test(key)) throw new Error("ReportContainsSensitiveFieldName");
      visit(child);
    }
  };
  visit(value);
}

async function sha256File(filename: string) {
  return createHash("sha256").update(await readFile(filename)).digest("hex");
}

function sleepProcesses(container: string): number[] {
  // amd64 emulation can prefix argv with the emulator and absolute binary path.
  const code = "const fs=require('node:fs');const pids=fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x)).filter(x=>{try{const a=fs.readFileSync('/proc/'+x+'/cmdline','utf8').split('\\x00');return a.some((v,i)=>(v==='sleep'||v.endsWith('/sleep'))&&a[i+1]==='120')}catch{return false}});console.log(JSON.stringify(pids.map(Number)))";
  const result = dockerCommand(["exec", container, "node", "-e", code]);
  if (result.status !== 0) throw new Error("ProcessObservationFailed");
  return JSON.parse(result.stdout.trim());
}

async function main() {
  const environmentValue = process.env.OLLAMA_API_KEY;
  if (!environmentValue) throw new Error("OLLAMA_API_KEY must be set in the process environment");
  const startedAt = new Date().toISOString();
  const nonce = randomBytes(6).toString("hex").toUpperCase();
  const marker = `P2REAL_${nonce}`;
  const left = 10 + Number.parseInt(nonce.slice(0, 2), 16) % 80;
  const right = 10 + Number.parseInt(nonce.slice(2, 4), 16) % 80;
  const expectedSum = left + right;
  const root = await mkdtemp(path.join(os.tmpdir(), "opshelper-phase2-real-model-"));
  const networkName = `opshelper-p2-real-${randomBytes(5).toString("hex")}`;
  const containerName = `opshelper-p2-real-${randomBytes(5).toString("hex")}`;
  const docker = new Docker({ socketPath });
  let network: Docker.Network | undefined;
  let container: Docker.Container | undefined;
  let stage = "bootstrap";
  const checks: Array<{ name: string; passed: boolean }> = [];
  const report: Record<string, any> = {
    schemaVersion: 1,
    startedAt,
    status: "failed",
    scope: "Authorized Ollama Cloud call using only generated phase-2 fixture text in one disposable runtime.",
    provider: { id: providerID, model: modelID, endpoint, environmentReferenceUsed: true },
    fixture: { marker, left, right, expectedSum },
    promptContainsFixtureAnswer: false,
    checks,
    sourceDigests: {
      managedRuntimeBuilderSha256: await sha256File(path.resolve("apps/api/src/lib/managed-runtime.ts")),
      containerOptionsBuilderSha256: await sha256File(path.resolve("apps/api/src/lib/opencode-container-runtime.ts")),
      probeSha256: await sha256File(path.resolve("scripts/runtime-probes/real-model-probe.ts")),
    },
  };
  try {
    stage = "network";
    network = await docker.createNetwork({
      Name: networkName,
      Driver: "bridge",
      Internal: false,
      Labels: { "opshelper.probe": "phase2-real-model" },
    });
    const config: AppConfig = {
      ...loadConfig(),
      port: 4000,
      opencodeImage: image,
      opencodePort: 4096,
      opencodeDirectory: "/workspace",
      idleTimeoutMinutes: 60,
      dockerNetwork: networkName,
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
    await mkdir(path.join(root, "config"), { recursive: true });
    await writeFile(path.join(root, "config", "phase2-runtime.json"), JSON.stringify({
      version: 1,
      model: modelRef,
      provider: {
        [providerID]: {
          npm: "@ai-sdk/openai-compatible",
          name: "Ollama Cloud phase-2 fixture",
          options: { baseURL: endpoint, apiKey: "{env:OLLAMA_API_KEY}" },
          models: {
            [modelID]: {
              name: modelID,
              limit: { context: 131072, output: 8192 },
              tool_call: true,
            },
          },
        },
      },
      users: { fixture: agentKeys },
    }));
    const prompts: Record<string, string> = {
      "fixture-lead": [
        "You are the phase-2 fixture lead.",
        "For a cooperation request, first use the read tool on the exact requested fixture file.",
        "Then use the task tool exactly once with subagent_type fixture-sub and foreground execution.",
        "Use the subagent result to answer in plain text: marker=<the marker> sum=<the arithmetic sum>.",
        "For a cancellation request, only delegate fixture-sub to run the requested safe sleep command.",
      ].join(" "),
      "fixture-sub": [
        "You are the phase-2 fixture subagent.",
        "For a data request, use the read tool on the exact requested fixture file and return plain text: marker=<the marker> sum=<the arithmetic sum>.",
        "For a cancellation request, invoke the bash tool with exactly `sleep 120` and no other shell command.",
      ].join(" "),
    };
    for (const key of agentKeys) {
      await mkdir(path.join(root, "agents", key), { recursive: true });
      await writeFile(path.join(root, "agents", key, "agent.md"), `${prompts[key]}\n`);
    }
    stage = "managed-runtime";
    // Current managed configuration comes from DB-backed assignments. Supply
    // explicit fixture services instead of relying on the retired JSON source.
    const definition = JSON.parse(await readFile(path.join(root, "config", "phase2-runtime.json"), "utf8"));
    const runtime = await prepareManagedRuntime("fixture", config, {
      assignedRuntime: async () => ({
        desiredGeneration: 1,
        appliedGeneration: 0,
        applyStatus: "APPLYING",
        agents: agentKeys.map((key) => ({
          id: key,
          key,
          displayName: key,
          description: `Real model fixture ${key}`,
          mode: "all",
          model: null,
          contentHash: createHash("sha256").update(prompts[key]).digest("hex"),
          tools: key === "fixture-lead" ? ["read", "task"] : ["read", "bash"],
          skills: [],
          scripts: [],
          mcp: {},
          sourceDir: path.join(root, "agents", key),
        })),
      }),
      modelConfiguration: async () => ({ model: modelRef, configuredModels: [modelRef], provider: definition.provider }),
      globalInstructions: async () => "",
    });
    const workspace = path.join(root, "users", "fixture", "workspace");
    const state = path.join(root, "users", "fixture", "state");
    await writeFile(path.join(workspace, "fixture-input.txt"), `marker=${marker}\nleft=${left}\nright=${right}\n`);
    for (const directory of [workspace, state]) {
      await chmod(directory, 0o777);
      for (const child of ["data", "cache", "state"]) await chmod(path.join(directory, child), 0o777).catch(() => undefined);
    }
    const managedPath = path.join(root, "users", "fixture", "managed", "releases", runtime.generation, "config", "opencode", "opencode.json");
    const generated = JSON.parse(await readFile(managedPath, "utf8"));
    checks.push({ name: "production snapshot pins model and small_model to the authorized model", passed: generated.model === modelRef && generated.small_model === modelRef });
    checks.push({ name: "managed provider references the environment rather than embedding its value", passed: generated.provider?.[providerID]?.options?.apiKey === "{env:OLLAMA_API_KEY}" && !JSON.stringify(generated).includes(environmentValue) });

    stage = "container";
    const options = buildContainerCreateOptions({
      record: { name: containerName, image, userId: "fixture" },
      runtime,
      config,
    });
    options.Env = [...(options.Env ?? []), `OLLAMA_API_KEY=${environmentValue}`];
    container = await docker.createContainer(options);
    await container.start();
    if (!await waitHealthy(containerName, runtime.password)) throw new Error("RuntimeHealthTimeout");
    const imageInfo = await docker.getImage(image).inspect();
    const inspect = await container.inspect();
    report.image = { name: image, id: imageInfo.Id, opencodeVersion: expectedVersion };
    report.container = {
      actualMatchesBuilderWithProbeEnvironment: !isStaleRuntime(inspect, options, imageInfo.Config?.Env ?? []),
      user: inspect.Config.User,
      readonlyRootfs: inspect.HostConfig.ReadonlyRootfs,
      networkDriver: "bridge",
      publishedPortCount: Object.keys(inspect.HostConfig.PortBindings ?? {}).length,
      containerCount: 1,
    };

    const deadline = Date.now() + maximumModelDurationMs;
    stage = "top-level-sub";
    console.log(JSON.stringify({ stage }));
    const directSubID = createSession(containerName, runtime.password, "PHASE2_REAL_TOP_LEVEL_SUB");
    const directSubPrompt = "Use the read tool on /workspace/fixture-input.txt. Reply in the exact format: DIRECT_SUB marker=<read marker> sum=<left+right as an integer>. The prompt does not contain those values.";
    sendPrompt(containerName, runtime.password, directSubID, "fixture-sub", directSubPrompt);
    const directSubMessages = await waitForCompletion(containerName, runtime.password, directSubID, deadline);
    const directSubRead = toolParts(directSubMessages, "read").find((part) => part.state?.status === "completed" && inputMentions(part, "fixture-input.txt"));
    const directSubText = assistantText(directSubMessages);
    const directSubModels = assistantModels(directSubMessages);
    checks.push({ name: "fixture-sub completes a top-level real-model session and reads the fixture", passed: Boolean(directSubRead) && answerMatches(directSubText, marker, expectedSum) && directSubModels.some((item) => item.agent === "fixture-sub") });

    stage = "native-cooperation";
    console.log(JSON.stringify({ stage }));
    const leadID = createSession(containerName, runtime.password, "PHASE2_REAL_NATIVE_COOPERATION");
    const firstEventCapture = captureEvents(containerName, runtime.password, 10_000);
    const leadPrompt = "Use the read tool on /workspace/fixture-input.txt, then delegate fixture-sub through the task tool to independently read the same file and calculate left+right. Compare its result and reply with RESULT, the marker, and sum. The prompt does not contain the file values.";
    sendPrompt(containerName, runtime.password, leadID, "fixture-lead", leadPrompt);
    const firstEvents = await firstEventCapture;
    const leadMessages = await waitForCompletion(containerName, runtime.password, leadID, deadline);
    const leadChildren = children(containerName, runtime.password, leadID);
    const cooperationChild = leadChildren.find((item) => item.parentID === leadID && item.agent === "fixture-sub") ?? leadChildren.find((item) => item.parentID === leadID);
    if (!cooperationChild?.id) throw new Error("NativeTaskChildMissing");
    const childMessages = messages(containerName, runtime.password, cooperationChild.id);
    const leadRead = toolParts(leadMessages, "read").find((part) => part.state?.status === "completed" && inputMentions(part, "fixture-input.txt"));
    const childRead = toolParts(childMessages, "read").find((part) => part.state?.status === "completed" && inputMentions(part, "fixture-input.txt"));
    const task = toolParts(leadMessages, "task").find((part) => part.state?.status === "completed");
    const taskChildID = task?.state?.metadata?.sessionId ?? task?.metadata?.sessionId;
    const leadText = assistantText(leadMessages);
    const childText = assistantText(childMessages);
    const allCooperationModels = [...assistantModels(leadMessages), ...assistantModels(childMessages)];
    checks.push({ name: "fixture-lead completes a top-level real-model session", passed: assistantModels(leadMessages).some((item) => item.agent === "fixture-lead") });
    checks.push({ name: "lead and delegated subagent both read the same workspace fixture", passed: Boolean(leadRead) && Boolean(childRead) });
    checks.push({ name: "native task tool completed with a real child parentID and the requested subagent", passed: Boolean(task) && taskChildID === cooperationChild.id && cooperationChild.parentID === leadID && task?.state?.input?.subagent_type === "fixture-sub" && assistantModels(childMessages).every((item) => item.agent === "fixture-sub") });
    checks.push({ name: "lead summary and subagent result contain the independently read fixture answer", passed: answerMatches(leadText, marker, expectedSum) && answerMatches(childText, marker, expectedSum) });
    checks.push({ name: "all cooperation assistant messages use the authorized model", passed: allCooperationModels.length >= 2 && allCooperationModels.every((item) => item.providerID === providerID && item.modelID === modelID) });
    report.nativeCooperation = {
      topLevelSessionID: leadID,
      childSessionID: cooperationChild.id,
      childParentIDMatched: cooperationChild.parentID === leadID,
      taskToolState: task?.state?.status ?? null,
      taskMetadataChildMatched: taskChildID === cooperationChild.id,
      taskTarget: task?.state?.input?.subagent_type ?? null,
      leadReadState: leadRead?.state?.status ?? null,
      childReadState: childRead?.state?.status ?? null,
      leadAnswerMatched: answerMatches(leadText, marker, expectedSum),
      childAnswerMatched: answerMatches(childText, marker, expectedSum),
      answerCheckFormat: "marker plus exact sum=<integer>",
      assistantModels: allCooperationModels,
    };

    stage = "event-reconnect";
    const reconnectEvents = await captureEvents(containerName, runtime.password, 2_000);
    const reconciledMessages = messages(containerName, runtime.password, leadID);
    const reconciledChildren = children(containerName, runtime.password, leadID);
    const reconciledStatuses = requireApi(basicRequest(containerName, runtime.password, route("/session/status")), 200, "SessionStatus");
    checks.push({ name: "event stream disconnect and reconnect are reconciled without a repeated prompt", passed: firstEvents.connected && firstEvents.events.some((item) => item.sessionID === leadID) && reconnectEvents.connected && completedAssistant(reconciledMessages) && reconciledChildren.some((item) => item.id === cooperationChild.id) && !isBusy(reconciledStatuses, leadID) });
    report.eventRecovery = {
      firstConnectionStatus: firstEvents.status,
      firstEventTypes: [...new Set(firstEvents.events.map((item) => item.type))].sort(),
      firstObservedSessionIDs: [...new Set(firstEvents.events.map((item) => item.sessionID).filter(Boolean))].sort(),
      reconnectStatus: reconnectEvents.status,
      reconnectEventTypes: [...new Set(reconnectEvents.events.map((item) => item.type))].sort(),
      restMessageCountAfterReconnect: reconciledMessages.length,
      restChildMatchedAfterReconnect: reconciledChildren.some((item) => item.id === cooperationChild.id),
      promptRequestCountForCooperationSession: 1,
    };

    stage = "abort";
    console.log(JSON.stringify({ stage }));
    const abortParentID = createSession(containerName, runtime.password, "PHASE2_REAL_ABORT");
    const abortPrompt = "Delegate fixture-sub through the task tool in foreground mode. Tell it to run the bash tool with exactly `sleep 120` and no other command. Wait for its result.";
    sendPrompt(containerName, runtime.password, abortParentID, "fixture-lead", abortPrompt);
    const running = await waitForSleep(containerName, runtime.password, abortParentID, deadline);
    let sleepingBeforeAbort = sleepProcesses(containerName);
    for (let attempt = 0; attempt < 20 && !sleepingBeforeAbort.length; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      sleepingBeforeAbort = sleepProcesses(containerName);
    }
    const abortResponse = basicRequest(containerName, runtime.password, route(`/session/${abortParentID}/abort`), "POST", {});
    requireApi(abortResponse, 200, "Abort");
    const aborted = await waitAfterAbort(containerName, runtime.password, abortParentID, running.childID, deadline);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const sleepingAfterAbort = sleepProcesses(containerName);
    const parentTask = toolParts(aborted.parentMessages, "task").at(-1);
    const childSleep = toolParts(aborted.childMessages, "bash").at(-1);
    const parentStatus = aborted.statuses?.[abortParentID]?.type ?? "idle";
    const childStatus = aborted.statuses?.[running.childID]?.type ?? "idle";
    checks.push({ name: "aborting a foreground task stops both parent and child", passed: parentStatus === "idle" && childStatus === "idle" && Boolean(parentTask) && Boolean(childSleep) && ["error", "completed"].includes(parentTask?.state?.status) && ["error", "completed"].includes(childSleep?.state?.status) });
    checks.push({ name: "the observed sleep process exits after cancellation", passed: sleepingBeforeAbort.length > 0 && sleepingAfterAbort.length === 0 });
    report.abort = {
      parentSessionID: abortParentID,
      childSessionID: running.childID,
      childParentIDMatched: children(containerName, runtime.password, abortParentID).some((item) => item.id === running.childID && item.parentID === abortParentID),
      exactSleepPermissionApprovals: running.approvals,
      abortHttpStatus: abortResponse.status,
      parentStatusAfterAbort: parentStatus,
      childStatusAfterAbort: childStatus,
      parentTaskStateAfterAbort: parentTask?.state?.status ?? null,
      childSleepStateAfterAbort: childSleep?.state?.status ?? null,
      parentAssistantErrorNames: assistantErrorNames(aborted.parentMessages),
      childAssistantErrorNames: assistantErrorNames(aborted.childMessages),
      parentToolStillRunning: parentTask?.state?.status === "running",
      childToolStillRunning: childSleep?.state?.status === "running",
      sleepProcessCountBeforeAbort: sleepingBeforeAbort.length,
      sleepProcessCountAfterAbort: sleepingAfterAbort.length,
    };

    stage = "restart";
    console.log(JSON.stringify({ stage }));
    await container.restart({ t: 1 });
    if (!await waitHealthy(containerName, runtime.password)) throw new Error("RuntimeRestartHealthTimeout");
    const restoredLead = requireApi(basicRequest(containerName, runtime.password, route(`/session/${leadID}`)), 200, "RestartLeadSession");
    const restoredLeadMessages = messages(containerName, runtime.password, leadID);
    const restoredLeadChildren = children(containerName, runtime.password, leadID);
    const restoredChildMessages = messages(containerName, runtime.password, cooperationChild.id);
    const restoredDirectSubMessages = messages(containerName, runtime.password, directSubID);
    const restoredAbortChildren = children(containerName, runtime.password, abortParentID);
    checks.push({ name: "real top-level and child sessions, messages, and parentID survive restart", passed: restoredLead?.id === leadID && completedAssistant(restoredLeadMessages) && completedAssistant(restoredChildMessages) && completedAssistant(restoredDirectSubMessages) && restoredLeadChildren.some((item) => item.id === cooperationChild.id && item.parentID === leadID) && restoredAbortChildren.some((item) => item.id === running.childID && item.parentID === abortParentID) });
    report.restartRecovery = {
      runtimeHealthy: true,
      leadSessionMatched: restoredLead?.id === leadID,
      directSubMessagesReadable: restoredDirectSubMessages.length > 0,
      leadMessagesReadable: restoredLeadMessages.length > 0,
      childMessagesReadable: restoredChildMessages.length > 0,
      cooperationChildParentIDMatched: restoredLeadChildren.some((item) => item.id === cooperationChild.id && item.parentID === leadID),
      abortChildParentIDMatched: restoredAbortChildren.some((item) => item.id === running.childID && item.parentID === abortParentID),
    };
    report.topLevelAgentsObserved = [...new Set([
      ...assistantModels(directSubMessages).map((item) => item.agent),
      ...assistantModels(leadMessages).map((item) => item.agent),
    ])].filter(Boolean).sort();
    report.assistantTurnsObserved = directSubModels.length + allCooperationModels.length + assistantModels(aborted.parentMessages).length + assistantModels(aborted.childMessages).length;
    checks.push({ name: "direct and cancellation sessions also use the authorized model", passed: [...directSubModels, ...assistantModels(aborted.parentMessages), ...assistantModels(aborted.childMessages)].every((item) => item.providerID === providerID && item.modelID === modelID) });
    const restoredFixture = await readFile(path.join(workspace, "fixture-input.txt"), "utf8");
    checks.push({ name: "shared workspace fixture survives restart", passed: restoredFixture === `marker=${marker}\nleft=${left}\nright=${right}\n` });
  } catch (error) {
    report.failure = { stage, category: error instanceof Error ? error.name : "UnknownError",
      reason: error instanceof Error && /^[A-Za-z0-9]+$/.test(error.message) ? error.message : "DetailsOmitted" };
  } finally {
    const cleanup = { containerRemoved: false, networkRemoved: false, temporaryDirectoryRemoved: false };
    if (container) {
      try { await container.remove({ force: true }); cleanup.containerRemoved = true; } catch {}
    }
    if (network) {
      try { await network.remove(); cleanup.networkRemoved = true; } catch {}
    }
    try { await rm(root, { recursive: true, force: true }); cleanup.temporaryDirectoryRemoved = true; } catch {}
    report.cleanup = { ...cleanup, containersCreatedCount: container ? 1 : 0, networksCreatedCount: network ? 1 : 0 };
    report.cleanupSucceeded = cleanup.containerRemoved && cleanup.networkRemoved && cleanup.temporaryDirectoryRemoved;
    report.finishedAt = new Date().toISOString();
    report.status = !report.failure && checks.length >= 11 && checks.every((check) => check.passed) && report.cleanupSucceeded ? "passed" : "failed";
    report.environmentValueAbsent = true;
    assertReportSafe(report, environmentValue);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === "passed" ? 0 : 1;
  }
}

void main();
