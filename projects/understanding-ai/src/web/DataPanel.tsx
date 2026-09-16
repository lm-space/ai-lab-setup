import { SourceViewer } from "./SourceViewer";
import { useEffect, useState } from "react";
import type { KbDoc, TraceEvent } from "../shared/types";

type Node = { id: string; docId: string; name: string; i: number; text: string };
type Graph = { docs: KbDoc[]; totalChunks: number; dimensions: number; store: string; nodes: Node[]; edges: { source: string; target: string; similarity: number }[] };
type Hit = Node & { score: number; similarity?: number; vectorRank?: number; keywordRank?: number };
type Props = { request: typeof fetch; onImport: (files: File[]) => Promise<void>; busy: boolean; onEvents: (events: TraceEvent[]) => void; onRefresh: () => Promise<void> };

export function DataPanel({ request, onImport, busy, onEvents, onRefresh }: Props) {
  const [viewId, setViewId] = useState<string | null>(null);
  const [data, setData] = useState<Graph | null>(null);
  const [notice, setNotice] = useState("");
  const [working, setWorking] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [selected, setSelected] = useState<Node | null>(null);
  async function refresh() {
    const res = await request("/api/data");
    if (!res.ok) throw new Error("Could not load stored data");
    setData(await res.json());
  }
  useEffect(() => { void refresh().catch(e => setNotice(String(e))); }, []);
  async function action(fn: () => Promise<void>) {
    setWorking(true); setNotice("");
    try { await fn(); await refresh(); await onRefresh(); }
    catch (e) { setNotice(String(e)); }
    finally { setWorking(false); }
  }
  async function sample(kind: string) {
    await action(async () => {
      const res = await request(`/api/data/sample/${kind}`);
      if (!res.ok) throw new Error("Sample database failed");
      await onImport([new File([await res.blob()], `demo-${kind}.sqlite`)]);
      setNotice("Sample import finished. Inspect its ingestion events in Knowledge.");
    });
  }
  const locked = working || busy;
  const positions = new Map((data?.nodes || []).map((n, i, nodes) => [n.id, { x: 340 + 270 * Math.cos(i * Math.PI * 2 / nodes.length), y: 190 + 140 * Math.sin(i * Math.PI * 2 / nodes.length) }]));
  if (viewId) return <SourceViewer key={viewId} id={viewId} request={request} onClose={() => setViewId(null)} />;
  return <div className="dataPanel">
    <h3>Data & retrieval</h3><p className="sectionIntro">Bring your own documents or a SQLite snapshot. Follow the journey from source to chunks, embeddings, retrieval and model context.</p>
    <div className="dataPipeline" aria-label="Data pipeline">{["Sources", "Parse + chunk", "MiniLM · 384 dimensions", "SQLite · vectors + keywords", "Retrieved context → AI"].map((label, i) => <span key={label}>{i > 0 && <b aria-hidden="true">→ </b>}{label}</span>)}</div>
    <div className="dataColumns">
      <article className="connectionCard"><h4>Import your content</h4><p>Markdown, text, CSV, XLS/XLSX, Word DOC/DOCX, text-based PDF, JSON, and SQLite (.db/.sqlite/.sqlite3).</p>
        <label className="settingField">Choose files<input aria-label="Import data files" type="file" multiple disabled={locked} accept=".md,.txt,.csv,.xls,.xlsx,.doc,.docx,.pdf,.json,.db,.sqlite,.sqlite3" onChange={e => { const files = Array.from(e.target.files || []); e.target.value = ""; if (files.length) void action(() => onImport(files)); }} /></label>
        <small>20 MB per file. SQLite: up to 20 ordinary tables and 500 rows per table. Import a snapshot with WAL changes checkpointed. Scanned PDFs require OCR first.</small>
      </article>
      <article className="connectionCard"><h4>Explore sample SQLite databases</h4><p>Synthetic data, created locally. Each button creates and imports a real SQLite database.</p>
        <div className="connectionActions"><button disabled={locked} onClick={() => void sample("policies")}>Load company policies</button><button disabled={locked} onClick={() => void sample("shop")}>Load shop & orders</button></div>
        <p>Try “What is the learning budget?” or “Which products are in stock?”</p>
      </article>
    </div>
    <p role="status">{locked ? "Processing data… trace events are streaming to Knowledge." : notice}</p>
    <div className="sectionHeading"><h4>Stored sources · {data?.docs.length || 0}</h4><span>{data?.totalChunks || 0} chunks · {data?.store || "Loading storage…"}</span></div>
    <div className="dataSources">{data?.docs.map(doc => <article className="connectionCard" key={doc.id}><strong>{doc.name}</strong><p>{doc.label} · {doc.chunks} chunks · {doc.bytes.toLocaleString()} bytes</p><small>{doc.preview}</small><button onClick={() => setViewId(doc.id)}>View content</button><button disabled={locked} onClick={() => void action(async () => { const res = await request(`/api/kb/${doc.id}`, { method: "DELETE" }); if (!res.ok) throw new Error("Remove failed"); setSelected(null); setHits([]); })}>Remove from index</button></article>)}</div>
    {data?.docs.length === 0 && <p className="infoBox">No sources yet. Import files or load a sample database to begin.</p>}
    <div className="dataColumns">
      <article className="connectionCard"><h4>Test hybrid retrieval</h4><p>Cosine nearest neighbors + keyword search, combined with reciprocal rank fusion. Results carry source and chunk IDs for citations.</p>
        <form onSubmit={e => { e.preventDefault(); void action(async () => { const res = await request("/api/data/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) }); const body = await res.json(); if (!res.ok) throw new Error(body.error || "Search failed"); setHits(body.hits); onEvents(body.events || []); setNotice(`${body.hits.length} chunks retrieved. Search stages are in Knowledge.`); }); }}><label className="settingField">Question<input value={query} onChange={e => setQuery(e.target.value)} placeholder="What is the return policy?" /></label><button disabled={locked || !query.trim()}>Retrieve context</button></form>
        {hits.map(hit => <button className="dataHit" key={hit.id} onClick={() => setSelected(hit)}><strong>{hit.name} · chunk {hit.i + 1}</strong><small>Vector rank {hit.vectorRank || "—"} · keyword rank {hit.keywordRank || "—"} · cosine {hit.similarity?.toFixed(3) || "—"}</small><span>{hit.text.slice(0, 240)}</span></button>)}
      </article>
      <article className="connectionCard"><h4>Vector similarity graph</h4><p>First 100 chunks, arranged in a circle. Lines show up to two later neighbors per chunk with cosine similarity ≥ 0.35. Position is for readability, not a vector projection or an entity knowledge graph.</p>
        <svg className="vectorGraph" viewBox="0 0 680 380" role="img" aria-label="Stored chunk similarity graph">
          {data?.edges.map(e => { const a = positions.get(e.source)!, b = positions.get(e.target)!; return <line key={`${e.source}-${e.target}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--cyan)" opacity={Math.max(.15, e.similarity * .65)}><title>Cosine similarity {e.similarity.toFixed(3)}</title></line>; })}
          {data?.nodes.map(n => { const p = positions.get(n.id)!; return <g key={n.id} role="button" tabIndex={0} aria-label={`${n.name}, chunk ${n.i + 1}`} onClick={() => setSelected(n)} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(n); } }}><circle cx={p.x} cy={p.y} r={selected?.id === n.id ? 9 : 6} fill={selected?.id === n.id ? "#ffd166" : "#41d3e4"} /><title>{n.name} · chunk {n.i + 1}</title></g>; })}
        </svg>
        {selected ? <div className="chunkPreview"><strong>{selected.name} · chunk {selected.i + 1}</strong><small>{selected.id}</small><pre>{selected.text}</pre></div> : <p>Select a node or search result to inspect its stored text.</p>}
      </article>
    </div>
    <div className="infoBox">Original files stay under data/kb/uploads. Document metadata, extracted chunks, embeddings and keyword indexes persist in data/kb/knowledge.sqlite. Embeddings run locally; retrieved text is sent to your selected AI provider when you chat. Connections continues to manage executable MCP tools.</div>
  </div>;
}
