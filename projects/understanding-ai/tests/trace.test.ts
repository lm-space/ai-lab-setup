import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import type { TraceMeta, TraceEvent } from "../src/shared/types.ts";
import { tracedFetch, tracedOperation, withTrace } from "../src/server/trace.ts";
import { connectMcps, callMcp, closeMcps } from "../src/server/mcp.ts";
import { categoryOf } from "../src/shared/trace-view.ts";

type Row = { title: string; payload: any; meta: TraceMeta };
function collector(rows: Row[]) { return async (title: string, payload: unknown, meta: TraceMeta) => { rows.push({ title, payload, meta }); }; }

test("HTTP trace correlates headers/body completion, redacts credentials and preserves usage", async () => {
  const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const rows: Row[] = [];
  try {
    await withTrace(collector(rows), async () => {
      const response = await tracedFetch("ai-provider")(`http://127.0.0.1:${(server.address() as any).port}/chat?key=private`, { method: "POST", headers: { authorization: "Bearer private-provider-key" }, body: JSON.stringify({ apiKey: "private-provider-key", total_tokens: 42 }) });
      assert.deepEqual(await response.json(), { ok: true });
    });
    assert.deepEqual(rows.map((r) => r.meta.phase), ["start", "response", "complete"]);
    assert.equal(new Set(rows.map((r) => r.meta.correlationId)).size, 1);
    assert.ok(rows[2].meta.durationMs! >= 0);
    assert.equal(rows[0].payload.request.body.total_tokens, 42);
    assert.ok(!JSON.stringify(rows).includes("private-provider-key"));
    assert.ok(!rows[0].meta.target?.includes("key=private"));
  } finally { server.close(); await once(server, "close"); }
});

test("HTTP failures are recorded separately from successful tool completion", async () => {
  const rows: Row[] = [];
  await withTrace(collector(rows), async () => {
    await assert.rejects(tracedFetch("external")("http://127.0.0.1:1"));
    await tracedOperation("bad tool", {}, { category: "tools", callType: "local" }, async () => ({ isError: true }));
  });
  assert.equal(rows.filter((r) => r.meta.phase === "error").length, 2);
});

test("bundled stdio MCP discovers and executes a real tool without claiming HTTP traffic", async () => {
  const rows: Row[] = [];
  await withTrace(collector(rows), async () => {
    const connected = await connectMcps([{ id: "lab-demo", enabled: true }], () => {});
    try {
      assert.equal(connected.tools.length, 2);
      const result = await tracedOperation("Execute lab-demo__add", {}, { category: "tools", callType: "local" }, () => callMcp(connected.handles, connected.tools, "lab-demo__add", { a: 12, b: 30 }));
      assert.ok(JSON.stringify(result).includes('42'));
    } finally { await closeMcps(connected.handles); }
  });
  assert.ok(rows.some((r) => r.title === "Execute lab-demo__add · complete"));
  assert.ok(rows.every((r) => r.meta.category !== "network"));
});

test("HTTP MCP discovery and execution generate external network events with operation parent", async () => {
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
    let raw = ""; for await (const part of req) raw += part;
    const msg = JSON.parse(raw);
    if (msg.id === undefined) { res.writeHead(202); res.end(); return; }
    const result = msg.method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } : msg.method === "tools/list" ? { tools: [{ name: "echo", description: "Test echo", inputSchema: { type: "object", properties: {} } }] } : { content: [{ type: "text", text: "fixture result" }] };
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const rows: Row[] = [];
  try {
    await withTrace(collector(rows), async () => {
      const connected = await connectMcps([{ id: "fixture", enabled: true, url: `http://127.0.0.1:${(server.address() as any).port}/mcp` }], () => {});
      try {
        assert.equal(connected.tools.length, 1);
        await tracedOperation("Execute echo", {}, { category: "tools", callType: "external" }, () => callMcp(connected.handles, connected.tools, "fixture__echo", {}));
      } finally { await closeMcps(connected.handles); }
    });
    const requests = rows.filter((r) => r.meta.category === "network" && r.meta.phase === "start");
    assert.ok(requests.length >= 3);
    assert.ok(requests.every((r) => r.meta.callType === "external"));
    const call = requests.find((r) => r.payload.request.body?.method === "tools/call");
    assert.ok(call?.meta.parentId);
  } finally { server.close(); await once(server, "close"); }
});

test("historical parent lane is displayed as User App", () => {
  assert.equal(categoryOf({ lane: "parent", kind: "user_in" } as TraceEvent), "user-app");
});
