// Deterministic model/MCP peers; the execution runtime itself is real OpenCode.
import http from "node:http";
import { randomUUID } from "node:crypto";

const statistics = { models: [], mcpCalls: 0, requests: 0 };
const server = http.createServer(async (req, res) => {
  if (req.url === "/health") return res.end("ok");
  if (req.url === "/stats") return res.end(JSON.stringify(statistics));
  if (req.method !== "POST") { res.writeHead(405); return res.end(); }
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (req.url === "/mcp") {
      if (body.id === undefined) { res.writeHead(202); return res.end(); }
      let result;
      if (body.method === "initialize") result = {
        protocolVersion: body.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "upgrade-fixture", version: "1.0.0" },
      };
      else if (body.method === "tools/list") result = { tools: [{
        name: "echo", description: "Return the upgrade test marker",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      }] };
      else if (body.method === "tools/call") {
        statistics.mcpCalls++;
        result = { content: [{ type: "text", text: "MCP_UPGRADE_OK" }] };
      } else result = {};
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    }
    if (!req.url.endsWith("/chat/completions")) { res.writeHead(404); return res.end(); }
    statistics.requests++;
    statistics.models.push(body.model);
    const messages = body.messages ?? [];
    const lastUserIndex = messages.findLastIndex((item) => item.role === "user");
    const prompt = JSON.stringify(messages[lastUserIndex]?.content ?? "");
    const turn = messages.slice(lastUserIndex + 1);
    const tools = turn.filter((item) => item.role === "tool");
    const requested = body.tools?.map((item) => item.function.name) ?? [];
    let call;
    let text = "E2E_BASIC_OK 中文流式输出完成";
    if (!tools.length) {
      if (prompt.includes("E2E_FORBIDDEN")) call = ["task", { description: "Forbidden primary", subagent_type: "fixture-lead", prompt: "E2E_SUB_READ" }];
      else if (prompt.includes("E2E_NESTED_MID")) call = ["task", { description: "Nested fixture", subagent_type: "fixture-leaf", prompt: "E2E_SUB_READ" }];
      else if (prompt.includes("E2E_NESTED")) call = ["task", { description: "Nested fixture", subagent_type: "fixture-sub", prompt: "E2E_NESTED_MID" }];
      else if (prompt.includes("E2E_COLLAB")) call = ["task", { description: "Fixture read", subagent_type: "fixture-sub", prompt: "E2E_SUB_READ" }];
      else if (prompt.includes("E2E_SUB_READ")) call = ["read", { filePath: "/workspace/files/fixture.txt" }];
      else if (prompt.includes("E2E_MCP")) call = [requested.find((name) => name.endsWith("fixture_echo")), {}];
      else if (prompt.includes("E2E_SKILL")) call = ["skill", { name: "fixture-lead-ping" }];
      else if (prompt.includes("E2E_QUESTION")) call = ["question", { questions: [{ header: "Upgrade", question: "Continue?", options: [{ label: "Yes", description: "Continue the fixture" }, { label: "No", description: "Stop the fixture" }] }] }];
      else if (prompt.includes("E2E_PERMISSION")) call = ["read", { filePath: "/tmp/upgrade-fixture.txt" }];
      else if (prompt.includes("E2E_OUTPUT")) call = ["bash", { command: "printf OUTPUT_UPGRADE_OK > /workspace/files/upgrade-result.txt", description: "Write the fixture result" }];
      else if (prompt.includes("E2E_CANCEL")) call = ["bash", { command: "sleep 30", description: "Wait for cancellation" }];
      else if (prompt.includes("E2E_ATTACHMENT")) {
        const match = prompt.match(/\/workspace\/(?:files|\.chat-uploads)[^\s"\\]+\.txt/);
        call = ["read", { filePath: match?.[0] ?? "/workspace/files/fixture.txt" }];
      }
    }
    if (tools.length) {
      const outputs = JSON.stringify(tools.map((item) => item.content));
      if (prompt.includes("E2E_FORBIDDEN")) text = outputs.includes("FIXTURE_CONTENT_OK") ? "E2E_UNAUTHORIZED" : "E2E_FORBIDDEN_OK";
      else if (prompt.includes("E2E_NESTED")) text = outputs.includes("FIXTURE_CONTENT_OK") ? "E2E_NESTED_OK FIXTURE_CONTENT_OK" : "E2E_TOOL_FAILED";
      else if (prompt.includes("E2E_COLLAB") || prompt.includes("E2E_SUB_READ")) text = outputs.includes("FIXTURE_CONTENT_OK") ? "E2E_COLLAB_OK FIXTURE_CONTENT_OK" : "E2E_TOOL_FAILED";
      else if (prompt.includes("E2E_MCP")) text = outputs.includes("MCP_UPGRADE_OK") ? "MCP_UPGRADE_OK" : "E2E_TOOL_FAILED";
      else if (prompt.includes("E2E_SKILL")) text = outputs.includes("SKILL_CONTENT_OK") ? "SKILL_UPGRADE_OK" : "E2E_TOOL_FAILED";
      else if (prompt.includes("E2E_QUESTION")) text = outputs.includes("Yes") ? "QUESTION_UPGRADE_OK" : "E2E_TOOL_FAILED";
      else if (prompt.includes("E2E_PERMISSION")) text = outputs.includes("PERMISSION_CONTENT_OK") ? "PERMISSION_UPGRADE_OK" : "PERMISSION_REJECTED_OK";
      else if (prompt.includes("E2E_OUTPUT")) text = "OUTPUT_UPGRADE_OK";
      else if (prompt.includes("E2E_ATTACHMENT")) text = outputs.includes("ATTACHMENT_CONTENT_OK") ? "ATTACHMENT_UPGRADE_OK" : "E2E_TOOL_FAILED";
    }
    if (prompt.includes("E2E_SCHEDULE")) text = "SCHEDULE_UPGRADE_OK";
    if (prompt.includes("E2E_CONTINUE")) text = JSON.stringify(messages).includes("E2E_BASIC_OK") ? "HISTORY_CONTINUE_OK" : "E2E_HISTORY_FAILED";
    if (prompt.includes("E2E_FORK_VERIFY")) {
      const history = JSON.stringify(messages.slice(0, lastUserIndex));
      text = history.includes("PRIOR_CONTEXT_ALPHA") && !history.includes("FUTURE_CONTEXT_OMEGA") && !history.includes("SELECTED_MESSAGE_BETA")
        ? "FORK_CONTEXT_OK" : "FORK_CONTEXT_FAILED";
    }
    if (prompt.includes("E2E_RETRY") && !tools.length && !messages.some((m) => m.role === "assistant")) {
      // One transient response exercises the runtime's provider retry path.
      if (!statistics.retryInjected) { statistics.retryInjected = true; res.writeHead(503); return res.end('{"error":{"message":"fixture temporary unavailable"}}'); }
      text = "RETRY_UPGRADE_OK";
    }
    const id = `chatcmpl-${randomUUID()}`;
    const chunk = (delta, finish = null) => ({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    send(chunk({ role: "assistant", content: "" }));
    if (call) {
      if (!call[0] || !requested.includes(call[0])) {
        console.error(`Fixture tool unavailable: ${call[0]}; available: ${requested.join(",")}`);
        send(chunk({ content: "E2E_TOOL_UNAVAILABLE" }, "stop"));
        return res.end("data: [DONE]\n\n");
      }
      send(chunk({ tool_calls: [{ index: 0, id: `call_${randomUUID()}`, type: "function", function: { name: call[0], arguments: JSON.stringify(call[1]) } }] }));
      send(chunk({}, "tool_calls"));
    } else {
      for (const part of text.match(/.{1,4}/gu) ?? []) {
        if (res.destroyed) break;
        send(chunk({ content: part }));
        await new Promise((resolve) => setTimeout(resolve, 35));
      }
      send(chunk({}, "stop"));
    }
    res.end("data: [DONE]\n\n");
  } catch (error) {
    console.error(error.message);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});
server.listen(4100, "0.0.0.0");
