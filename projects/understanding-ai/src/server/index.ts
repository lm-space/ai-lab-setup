import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { randomUUID } from "node:crypto";
import { Graph, runSession } from "./agent.ts";
import { MCP_PRESETS, PROVIDER_MODELS } from "./catalog.ts";
import { deleteDoc, ingestFile, kbTools, listDocs } from "./kb.ts";
import { listModels } from "./providers.ts";
import { redact } from "./redact.ts";
import { listChats, loadChat } from "./store.ts";
import type { LabSettings, TraceEvent } from "../shared/types.ts";

const PORT = Number(process.env.API_PORT || 4188);
const ALLOWED = new Set(["md", "txt", "pdf", "doc", "docx", "csv", "xls", "xlsx", "json"]);

const app = new Hono();
app.use("/api/*", cors({ origin: [`http://127.0.0.1:${process.env.PORT || 4186}`, `http://localhost:${process.env.PORT || 4186}`] }));

app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/api/catalog", (c) =>
  c.json({
    mcps: MCP_PRESETS,
    models: PROVIDER_MODELS,
    kbTools: kbTools().map((t) => ({
      qualified: t.qualified,
      name: t.name,
      description: t.description,
    })),
  }),
);

app.post("/api/models", async (c) => {
  const body = await c.req.json<{ provider: string; apiKey: string }>();
  const live = (body.apiKey || body.provider === "ollama") ? await listModels(body.provider, body.apiKey) : [];
  const fallback = PROVIDER_MODELS[body.provider] || [];
  const ids = [...new Set([...live, ...fallback])];
  return c.json({ models: ids, live: live.length > 0 });
});

app.get("/api/chats", async (c) => {
  const rows = await listChats();
  return c.json(
    rows.map((r) => ({
      id: r.id,
      title: r.title,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      provider: r.provider,
      model: r.model,
      preview: r.messages.find((m) => m.role === "user")?.content?.slice(0, 80) || "",
    })),
  );
});

app.get("/api/chats/:id", async (c) => {
  if (!/^[0-9a-f-]{36}$/i.test(c.req.param("id"))) return c.json({ error: "invalid chat ID" }, 400);
  const rec = await loadChat(c.req.param("id"));
  if (!rec) return c.json({ error: "not found" }, 404);
  return c.json(rec);
});

app.get("/api/kb", async (c) => c.json({ docs: await listDocs() }));

app.delete("/api/kb/:id", async (c) => {
  await deleteDoc(c.req.param("id"));
  return c.json({ ok: true, docs: await listDocs() });
});

app.post("/api/kb/upload", async (c) => {
  const form = await c.req.parseBody();
  const file = form.file;
  if (!file || typeof file === "string") return c.json({ error: "missing file" }, 400);
  const name = file.name || "upload.bin";
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (!ALLOWED.has(ext)) {
    return c.json({ error: `unsupported type .${ext}. Use md, pdf, doc, docx, csv, xls, xlsx.` }, 400);
  }
  const buf = Buffer.from(await file.arrayBuffer());

  return streamSSE(c, async (stream) => {
    const g = new Graph();
    let seq = 0;
    const emit = async (
      kind: string,
      title: string,
      lane: TraceEvent["lane"],
      payload?: unknown,
    ) => {
      const ev: TraceEvent = {
        id: randomUUID(),
        t: Date.now(),
        seq: seq++,
        round: 0,
        kind,
        title,
        lane,
        payload: payload === undefined ? undefined : redact(payload),
        flow: g.snap(),
      };
      await stream.writeSSE({ data: JSON.stringify({ type: "event", event: ev }) });
    };

    try {
      g.add("user", "Chat", "actor", 0, "upload", 0);
      g.add("agent", "Ingest", "compute", 1, "parse + chunk", 0);
      g.add("embed", "MiniLM", "model", 2, "all-MiniLM-L6-v2", 0);
      g.add("kb", "Local KB", "store", 3, "cosine index", 0);
      g.add("tools", "KB tools", "data", 4, "kb__search", 0);
      g.edge("user", "agent", "multipart");
      g.highlight(["user", "agent"]);
      await emit("kb_receive", "File received for local ingest", "kb", {
        name,
        bytes: buf.length,
        type: file.type,
      });

      g.highlight(["agent"]);
      await emit("kb_parse_start", "Detect type and extract text / rows", "agent", { name, ext });

      const doc = await ingestFile(name, buf, async (title, payload) => {
        if (String(title).startsWith("kb_embed")) {
          g.highlight(["embed", "agent"]);
          g.edge("agent", "embed", "embed");
        } else if (String(title) === "kb_upsert") {
          g.highlight(["kb", "embed"]);
          g.edge("embed", "kb", "vectors");
        } else {
          g.highlight(["agent"]);
        }
        await emit(String(title), humanIngest(String(title)), ingestLane(String(title)), payload);
      });

      g.edge("kb", "tools", "register");
      g.highlight(["kb", "tools"]);
      await emit("kb_tools_ready", "KB tools now available to the agent on the next question", "kb", {
        doc,
        tools: kbTools().map((t) => t.qualified),
      });
      await stream.writeSSE({ data: JSON.stringify({ type: "done", doc }) });
    } catch (err) {
      await stream.writeSSE({
        data: JSON.stringify({ type: "error", message: String(err) }),
      });
    }
  });
});

app.post("/api/chat", async (c) => {
  const body = await c.req.json<{
    chatId?: string;
    text: string;
    settings: LabSettings;
  }>();
  if (body.chatId && !/^[0-9a-f-]{36}$/i.test(body.chatId)) return c.json({ error: "invalid chat ID" }, 400);
  const chatId = body.chatId || randomUUID();
  const existing = body.chatId ? await loadChat(body.chatId) : null;
  if (!body.text?.trim()) return c.json({ error: "empty text" }, 400);

  return streamSSE(c, async (stream) => {
    try {
      await runSession({
        chatId,
        existing,
        userText: body.text.trim(),
        settings: body.settings,
        emit: async (frame) => {
          await stream.writeSSE({ data: JSON.stringify(frame) });
        },
      });
    } catch (err) {
      await stream.writeSSE({
        data: JSON.stringify({ type: "error", message: String(err) }),
      });
    }
  });
});

function humanIngest(kind: string): string {
  const map: Record<string, string> = {
    kb_saved: "Wrote original file under data/kb/uploads",
    kb_classify: "Classified type → parser + agent tools",
    kb_extracted: "Extracted plain text / table rows",
    kb_chunked: "Split into overlapping chunks",
    kb_embed_start: "Loading local MiniLM embedder (first run downloads the model)",
    kb_embed_done: "Embedded chunks into 384-d vectors",
    kb_upsert: "Upserted vectors into the on-disk cosine index",
    kb_parse_csv: "Parsed CSV header + rows",
    kb_parse_xlsx: "Parsed Excel sheets to row chunks",
    kb_parse_docx: "Extracted Word document text",
    kb_parse_pdf: "Extracted PDF pages",
    kb_parse_doc_failed: "Legacy .doc parse failed",
  };
  return map[kind] || kind;
}

function ingestLane(kind: string): TraceEvent["lane"] {
  if (kind.startsWith("kb_embed") || kind === "kb_upsert") return "kb";
  if (kind.startsWith("kb_parse") || kind === "kb_extracted" || kind === "kb_chunked") return "agent";
  return "kb";
}

serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, (info) => {
  console.log(`[lab-api] http://127.0.0.1:${info.port}`);
});
