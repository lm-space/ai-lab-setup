import { KnowledgeStore } from "./knowledge-store.ts";
import { DatabaseSync } from "node:sqlite";
import { trace, tracedOperation } from "./trace.ts";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BoundTool } from "./mcp.ts";
import type { KbDoc } from "../shared/types.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "kb");
const UP = join(ROOT, "uploads");
const DOCS = join(ROOT, "docs.json");
const CHUNKS = join(ROOT, "chunks.json");

export type { KbDoc };

export type KbChunk = {
  id: string;
  docId: string;
  name: string;
  i: number;
  text: string;
  vector: number[];
  cols?: string[];
};

type Log = (title: string, payload: unknown) => void | Promise<void>;

let cache: { docs: KbDoc[]; chunks: KbChunk[] } | null = null;
let extractor: any = null;
let store: KnowledgeStore;
let loading: Promise<{ docs: KbDoc[]; chunks: KbChunk[] }> | undefined;

async function ensure() {
  await mkdir(UP, { recursive: true });
  await mkdir(join(ROOT, "models"), { recursive: true });
}

async function load() {
  if (cache) return cache;
  return loading ||= (async () => {
    await ensure();
    store = new KnowledgeStore(join(ROOT, "knowledge.sqlite"));
    if (!store.db.prepare("SELECT name FROM migrations WHERE name='json-v1'").get()) {
      const oldDocs = existsSync(DOCS) ? JSON.parse(await readFile(DOCS, "utf8")) : [];
      const oldChunks = existsSync(CHUNKS) ? JSON.parse(await readFile(CHUNKS, "utf8")) : [];
      store.write(oldDocs, oldChunks);
      store.db.prepare("INSERT INTO migrations VALUES ('json-v1')").run();
    }
    cache = store.read();
    return cache;
  })();
}
async function persist() {
  if (cache) store.write(cache.docs, cache.chunks);
}

export async function listDocs(): Promise<KbDoc[]> {
  const rows = (await load()).docs.slice().sort((a, b) => b.createdAt - a.createdAt);
  return rows.map((d) => {
    if (d.family && d.label) return d;
    return { ...d, ...classifyKind(d.kind), path: d.path || "" };
  });
}

export function kbTools(): BoundTool[] {
  return [
    {
      qualified: "kb__search",
      serverId: "kb",
      name: "search",
      description:
        "Semantic search over files the user uploaded (pdf, md, docx, csv, xlsx). Use this before answering questions about their documents. Returns top chunks with file names and scores.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural language query" },
          k: { type: "integer", description: "How many chunks, 1-12", default: 6 },
        },
        required: ["query"],
      },
    },
    {
      qualified: "kb__list",
      serverId: "kb",
      name: "list",
      description: "List uploaded documents in the local knowledge base with kinds and chunk counts.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      qualified: "kb__read",
      serverId: "kb",
      name: "read",
      description: "Read one stored chunk by id from kb__search. Use when you need the full chunk text.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
    {
      qualified: "kb__table",
      serverId: "kb",
      name: "table",
      description:
        "For CSV/Excel uploads: return column names and sample rows. Optional query matches a cell substring.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "File name or substring" },
          query: { type: "string" },
          limit: { type: "integer", default: 20 },
        },
      },
    },
  ];
}

export async function runKbTool(name: string, input: Record<string, unknown>): Promise<unknown> {
  if (name === "search") {
    const query = String(input.query || "");
    const k = Math.max(1, Math.min(Number(input.k) || 6, 12));
    return search(query, k);
  }
  if (name === "list") return listDocs();
  if (name === "read") {
    const { chunks } = await load();
    const hit = chunks.find((c) => c.id === input.id);
    if (!hit) return { error: "chunk not found" };
    return { id: hit.id, name: hit.name, text: hit.text };
  }
  if (name === "table") return tableQuery(String(input.name || ""), String(input.query || ""), Number(input.limit) || 20);
  return { error: `unknown kb tool ${name}` };
}

export function classifyKind(kind: string): Pick<KbDoc, "family" | "label" | "parser" | "shape" | "tools"> {
  const e = kind.toLowerCase().replace(/^\./, "");
  if (["sqlite", "sqlite3", "db"].includes(e)) return { family: "sheet", label: "SQLite", parser: "SQLite read-only tables", shape: "table", tools: ["kb__table", "kb__search"] };
  if (e === "csv" || e === "xlsx" || e === "xls") {
    return {
      family: "sheet",
      label: "Spreadsheet",
      parser: e === "csv" ? "csv rows" : "xlsx sheets",
      shape: "table",
      tools: ["kb__table", "kb__search"],
    };
  }
  if (e === "pdf") {
    return { family: "pdf", label: "PDF", parser: "unpdf pages", shape: "prose", tools: ["kb__search"] };
  }
  if (e === "docx" || e === "doc") {
    return {
      family: "word",
      label: "Word",
      parser: e === "docx" ? "mammoth" : "word-extractor",
      shape: "prose",
      tools: ["kb__search"],
    };
  }
  if (e === "md") {
    return { family: "markdown", label: "Markdown", parser: "utf-8", shape: "prose", tools: ["kb__search"] };
  }
  if (e === "json") {
    return { family: "json", label: "JSON", parser: "utf-8", shape: "prose", tools: ["kb__search"] };
  }
  return { family: "text", label: "Text", parser: "utf-8", shape: "prose", tools: ["kb__search"] };
}

export async function ingestFile(
  fileName: string,
  bytes: Buffer,
  log: Log,
): Promise<KbDoc> {
  await ensure();
  const kind = extname(fileName).toLowerCase().replace(".", "") || "bin";
  const cls = classifyKind(kind);
  const id = randomUUID();
  const rel = `uploads/${id}_${safe(fileName)}`;
  const abs = join(ROOT, rel);
  await writeFile(abs, bytes);
  await log("kb_saved", { id, fileName, bytes: bytes.length, path: abs, kind });
  await log("kb_classify", {
    fileName,
    family: cls.family,
    label: cls.label,
    parser: cls.parser,
    shape: cls.shape,
    tools: cls.tools,
    note: cls.shape === "table" ? "tabular → kb__table + semantic search" : "prose → kb__search",
  });

  const extracted = await tracedOperation("Parse uploaded content", { fileName, parser: cls.parser }, { category: "knowledge", callType: "local" }, () => extractText(fileName, bytes, log));
  await log("kb_extracted", {
    fileName,
    chars: extracted.text.length,
    tables: extracted.tables?.length || 0,
    preview: extracted.text.slice(0, 400),
  });

  const pieces = chunkText(extracted.text, extracted.tables);
  await log("kb_chunked", { fileName, chunks: pieces.length, avgChars: Math.round(pieces.reduce((a, p) => a + p.length, 0) / Math.max(1, pieces.length)) });

  if (!pieces.length) throw new Error("No readable text found. Scanned PDFs need OCR before import.");
  const vectors = await embedAll(pieces, log);
  const { docs, chunks } = await load();
  const chunkRows: KbChunk[] = pieces.map((text, i) => ({
    id: `${id}_${i}`,
    docId: id,
    name: fileName,
    i,
    text,
    vector: vectors[i],
    cols: extracted.cols,
  }));
  const doc: KbDoc = {
    id,
    name: fileName,
    kind,
    ...cls,
    path: rel,
    bytes: bytes.length,
    chars: extracted.text.length,
    chunks: chunkRows.length,
    createdAt: Date.now(),
    preview: extracted.text.replace(/\s+/g, " ").slice(0, 180),
  };
  docs.push(doc);
  chunks.push(...chunkRows);
  await tracedOperation("Write vectors and metadata", { store: "data/kb/knowledge.sqlite", chunks: chunkRows.length, dimensions: vectors[0]?.length || 0 }, { category: "knowledge", callType: "local" }, persist);
  await log("kb_upsert", {
    id,
    fileName,
    chunks: chunkRows.length,
    dim: vectors[0]?.length || 0,
    store: "SQLite + sqlite-vec + FTS5 under data/kb",
  });
  return doc;
}

export async function deleteDoc(id: string): Promise<void> {
  const { docs, chunks } = await load();
  cache = {
    docs: docs.filter((d) => d.id !== id),
    chunks: chunks.filter((c) => c.docId !== id),
  };
  await persist();
}

export async function search(query: string, k: number) {
  const { chunks } = await load();
  if (!chunks.length) return { hits: [], note: "knowledge base is empty — upload files first" };
  const [q] = await embedAll([query], (title, payload) => trace(title, payload, { category: "knowledge", callType: "local" }));
  const started = performance.now();
  const scored = store.retrieve(query, q, k);
  await trace("Hybrid retrieval: vector + keyword rank fusion", { query, k, hits: scored, algorithm: "sqlite-vec cosine KNN + SQLite FTS5, reciprocal rank fusion (60)", store: "data/kb/knowledge.sqlite" }, { category: "knowledge", callType: "local", phase: "complete", durationMs: Math.round(performance.now() - started) });
  return { hits: scored };
}

async function tableQuery(name: string, query: string, limit: number) {
  const { chunks, docs } = await load();
  const doc = docs.find(
    (d) =>
      ["csv", "xlsx", "xls", "sqlite", "sqlite3", "db"].includes(d.kind) &&
      (!name || d.name.toLowerCase().includes(name.toLowerCase())),
  );
  const pool = chunks.filter((c) => (doc ? c.docId === doc.id : ["csv", "xlsx", "xls", "sqlite", "sqlite3", "db"].some((k) => c.name.toLowerCase().endsWith(k))));
  const q = query.toLowerCase();
  const rows = pool.filter((c) => !q || c.text.toLowerCase().includes(q)).slice(0, limit);
  return {
    file: doc?.name || name || "(all tables)",
    columns: rows[0]?.cols || [],
    rows: rows.map((c) => c.text),
    shown: rows.length,
  };
}

function safe(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}

function chunkText(text: string, tables?: string[]): string[] {
  const out: string[] = [];
  for (const part of [...(tables || []), text]) {
    const clean = part.replace(/\r/g, "").trim();
    for (let i = 0; i < clean.length; i += 760) out.push(clean.slice(i, i + 900));
  }
  const chunks = out.filter((s) => s.trim().length > 0);
  if (chunks.length > 400) throw new Error("Content exceeds the 400-chunk demo limit. Split the source into smaller files.");
  return chunks;
}

export async function extractText(
  fileName: string,
  bytes: Buffer,
  log: Log,
): Promise<{ text: string; tables?: string[]; cols?: string[] }> {
  const ext = extname(fileName).toLowerCase();
  if ([".sqlite", ".sqlite3", ".db"].includes(ext)) {
    if (bytes.subarray(0, 16).toString() !== "SQLite format 3\0") throw new Error("Not a SQLite database");
    const path = join(UP, `inspect-${randomUUID()}.sqlite`);
    await writeFile(path, bytes);
    try { return inspectSqlite(path); }
    finally { await (await import("node:fs/promises")).unlink(path); }
  }
  if (ext === ".md" || ext === ".txt" || ext === ".json") {
    return { text: bytes.toString("utf8") };
  }
  if (ext === ".csv" || ext === ".xlsx" || ext === ".xls") {
    const XLSX = await import("xlsx");
    const wb = XLSX.read(bytes, { type: "buffer" });
    const tables: string[] = [];
    let cols: string[] = [];
    const parts: string[] = [];
    for (const sheet of wb.SheetNames) {
      const ws = wb.Sheets[sheet];
      const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "" });
      const headers = (rows[0] || []).map(String);
      if (!cols.length) cols = headers;
      parts.push(`Sheet ${sheet}: ${Math.max(0, rows.length - 1)} rows`);
      for (let i = 1; i < rows.length; i += 10) {
        tables.push(`Spreadsheet ${fileName} / ${sheet}\nColumns: ${JSON.stringify(headers)}\nRows: ${JSON.stringify(rows.slice(i, i + 10))}`);
      }
    }
    await log("kb_parse_xlsx", { sheets: wb.SheetNames, cols });
    return { text: parts.join("\n\n"), tables, cols };
  }
  if (ext === ".docx") {
    const mammoth = await import("mammoth");
    const r = await mammoth.extractRawText({ buffer: bytes });
    await log("kb_parse_docx", { messages: r.messages?.length || 0 });
    return { text: r.value || "" };
  }
  if (ext === ".doc") {
    try {
      const WordExtractor = (await import("word-extractor")).default;
      const extractor = new WordExtractor();
      const doc = await extractor.extract(bytes);
      return { text: doc.getBody() };
    } catch (e) {
      await log("kb_parse_doc_failed", { error: String(e) });
      throw new Error(`Cannot parse Word document: ${String(e)}`);
    }
  }
  if (ext === ".pdf") {
    const { extractText } = await import("unpdf");
    const r = await extractText(new Uint8Array(bytes));
    const pages = Array.isArray(r.text) ? r.text : [String(r.text || "")];
    const text = pages.join("\n\n");
    await log("kb_parse_pdf", { pages: r.totalPages ?? pages.length, chars: text.length });
    return { text };
  }
  return { text: bytes.toString("utf8") };
}

async function embedAll(texts: string[], log: Log): Promise<number[][]> {
  if (!texts.length) return [];
  await log("kb_embed_start", {
    model: "Xenova/all-MiniLM-L6-v2",
    n: texts.length,
    note: "local embeddings, no extra API key",
  });
  const started = performance.now();
  const { pipeline, env } = await import("@xenova/transformers");
  env.cacheDir = join(ROOT, "models");
  env.allowRemoteModels = true;
  if (!extractor) {
    extractor = await tracedOperation("Load local embedding model", { model: "Xenova/all-MiniLM-L6-v2", cache: "data/kb/models", note: "On a cache miss the library downloads model assets. Asset lifecycle below is library-reported, not an HTTP packet capture." }, { category: "knowledge", callType: "local" }, async () => pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
      progress_callback: (progress: any) => {
        if (["initiate", "download", "done", "ready"].includes(progress.status)) void log("kb_model_asset", { ...progress, observation: "Embedding library asset lifecycle; cached files may skip downloading" });
      },
    }));
  }
  const out: number[][] = [];
  for (const t of texts) {
    const tensor = await extractor(t.slice(0, 4000), { pooling: "mean", normalize: true });
    out.push(Array.from(tensor.data as Float32Array));
  }
  await trace("Local embedding computation complete", { model: "MiniLM", count: texts.length, dimensions: out[0]?.length || 0 }, { category: "knowledge", callType: "local", phase: "complete", durationMs: Math.round(performance.now() - started) });
  await log("kb_embed_done", { n: out.length, dim: out[0]?.length || 0, hash: createHash("sha1").update(texts[0] || "").digest("hex").slice(0, 8) });
  return out;
}

function cosine(a: number[], b: number[]) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export function inspectSqlite(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;");
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE '%VIRTUAL TABLE%' ORDER BY name LIMIT 21").all();
    if (names.length > 20) throw new Error("SQLite import supports up to 20 tables; export a smaller database.");
    const tables: string[] = [];
    for (const entry of names) {
      const name = String(entry.name);
      const rows = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" LIMIT 501`).all();
      if (rows.length > 500) throw new Error(`Table ${name} exceeds 500 rows. Export a smaller dataset for this lab.`);
      for (const row of rows) tables.push(`Table: ${name}\n${JSON.stringify(row, (_, value) => typeof value === "bigint" ? String(value) : value instanceof Uint8Array ? "[binary data]" : value)}`);
    }
    return { text: `SQLite tables: ${names.map(r => r.name).join(", ")}`, tables };
  } finally { db.close(); }
}

export async function knowledgeGraph() {
  const { docs, chunks } = await load();
  const sample = chunks.slice(0, 100);
  const edges: { source: string; target: string; similarity: number }[] = [];
  for (let i = 0; i < sample.length; i++) {
    const nearest = sample.map((c, j) => ({ j, similarity: cosine(sample[i].vector, c.vector) })).filter(r => r.j > i && r.similarity >= .35).sort((a,b) => b.similarity-a.similarity).slice(0, 2);
    for (const row of nearest) edges.push({ source: sample[i].id, target: sample[row.j].id, similarity: row.similarity });
  }
  return { docs, totalChunks: chunks.length, dimensions: 384, store: "SQLite + sqlite-vec + FTS5", nodes: sample.map(c => ({ id: c.id, docId: c.docId, name: c.name, i: c.i, text: c.text })), edges };
}

export async function sourceDetails(id: string) {
  const { docs, chunks } = await load();
  const doc = docs.find(d => d.id === id);
  if (!doc) return null;
  const { resolve, sep } = await import("node:path");
  const path = resolve(ROOT, doc.path);
  if (!path.startsWith(resolve(UP) + sep)) throw new Error("Invalid stored source path");
  return { doc, path, chunks: chunks.filter(c => c.docId === id).map(({ vector, ...chunk }) => ({ ...chunk, dimensions: vector.length })) };
}
