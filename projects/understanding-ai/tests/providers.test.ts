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
