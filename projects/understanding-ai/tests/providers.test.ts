import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { listModels, runLlm } from "../src/server/providers.ts";
import { resolveSkills } from "../src/shared/skills.ts";

test("skills deduplicate selections and reject unknown instructions", () => {
  assert.equal(resolveSkills(["explain-simply", "explain-simply"]).length, 1);
  assert.throws(() => resolveSkills(["unknown"]), /Unknown skill/);
});

test("Ollama discovers models and streams through the local adapter without a key", async () => {
  let request: any;
  const server = createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "fixture-model" }] })); return;
    }
    let raw = ""; for await (const chunk of req) raw += chunk;
    request = JSON.parse(raw);
    res.setHeader("content-type", "text/event-stream");
    res.end('data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const previous = process.env.OLLAMA_BASE_URL;
  process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    assert.deepEqual(await listModels("ollama", ""), ["fixture-model"]);
    const chunks: string[] = [];
    const result = await runLlm({ settings: { provider: "ollama", apiKey: "", model: "fixture-model", thinking: false, maxRounds: 2, mcps: [] }, system: "Test instructions", messages: [{ role: "user", content: "Hi" }], tools: [], onChunk: (_, delta) => chunks.push(delta), log: () => {} });
    assert.equal(result.text, "Hello"); assert.equal(chunks.join(""), "Hello");
    assert.equal(request.messages[0].content, "Test instructions"); assert.equal(request.model, "fixture-model");
  } finally {
    if (previous === undefined) delete process.env.OLLAMA_BASE_URL; else process.env.OLLAMA_BASE_URL = previous;
    server.close(); await once(server, "close");
  }
});

test("Ollama capability preflight distinguishes chat, tools, embeddings and missing models", async () => {
  const { modelCapabilities } = await import("../src/server/providers.ts");
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const { model } = JSON.parse(raw);
    assert.equal(req.url, "/api/show");
    if (model === "missing") { res.writeHead(404); res.end(); return; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ capabilities: model === "chat" ? ["completion"] : model === "tools" ? ["completion", "tools"] : ["embedding"] }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const previous = process.env.OLLAMA_BASE_URL;
  process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${(server.address() as any).port}`;
  const settings = { provider: "ollama" as const, apiKey: "", model: "chat", thinking: false, maxRounds: 2, mcps: [] };
  try {
    assert.deepEqual(await modelCapabilities(settings), ["completion"]);
    assert.deepEqual(await modelCapabilities({ ...settings, model: "tools" }), ["completion", "tools"]);
    await assert.rejects(modelCapabilities({ ...settings, model: "embedding" }), /not a chat model/);
    await assert.rejects(modelCapabilities({ ...settings, model: "missing" }), /HTTP 404/);
    assert.equal(await modelCapabilities({ ...settings, provider: "openai" }), null);
  } finally {
    if (previous === undefined) delete process.env.OLLAMA_BASE_URL; else process.env.OLLAMA_BASE_URL = previous;
    server.close(); await once(server, "close");
  }
});

test("provider metrics use reported tokens and reject errors or truncated streams", async () => {
  let mode = "success";
  const server = createServer(async (_req, res) => {
    res.setHeader("content-type", "text/event-stream");
    if (mode === "error") { res.end('data: {"error":{"message":"model unavailable"}}\n\n'); return; }
    res.write('data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n');
    if (mode === "success") res.write('data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\ndata: [DONE]\n\n');
    res.end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const previous = process.env.OLLAMA_BASE_URL;
  process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${(server.address() as any).port}`;
  const logs: { title: string; payload: any }[] = [];
  const call = () => runLlm({ settings: { provider: "ollama", apiKey: "", model: "test", thinking: false, maxRounds: 1, mcps: [] }, system: "", messages: [], tools: [], onChunk: () => {}, log: (title, payload) => { logs.push({ title, payload }); } });
  try {
    await call();
    const metric = logs.find(l => l.title === "Model request metrics")!.payload;
    assert.equal(metric.outputTokens, 3); assert.equal(metric.inputTokens, 12);
    assert.ok(metric.durationMs > 0); assert.ok(metric.firstTextMs >= 0);
    assert.equal(metric.tokensPerSecond, 3 / (metric.durationMs / 1000));
    mode = "truncated"; await assert.rejects(call(), /incomplete/);
    mode = "error"; await assert.rejects(call(), /model unavailable/);
    assert.equal(logs.filter(l => l.title === "Model request failed").length, 2);
  } finally {
    if (previous === undefined) delete process.env.OLLAMA_BASE_URL; else process.env.OLLAMA_BASE_URL = previous;
    server.close(); await once(server, "close");
  }
});
