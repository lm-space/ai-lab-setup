import { useEffect, useState } from "react";
import { Markdown } from "./Markdown";
import type { KbDoc } from "../shared/types";
type Source = { doc: KbDoc; mode: string; text: string; tables: { name: string; schema: string; columns: string[]; rows: unknown[][] }[]; chunks: { id: string; i: number; text: string; dimensions: number }[] };
export function SourceViewer({ id, request, onClose }: { id: string; request: typeof fetch; onClose: () => void }) {
  const [source, setSource] = useState<Source | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("content");
  const [tableIndex, setTableIndex] = useState(0);
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => { try {
      const res = await request(`/api/data/source/${id}`, { signal: controller.signal });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSource(data);
    } catch (e) { if (!controller.signal.aborted) setError(String(e)); } })();
    return () => controller.abort();
  }, [id]);
  const table = source?.tables[tableIndex];
  const rows = table?.rows.filter(row => !filter || row.some(cell => String(cell ?? "").toLowerCase().includes(filter.toLowerCase()))) || [];
  return <section className="sourceViewer" aria-label="Source content viewer">
    <header className="sectionHeading"><div><h3>{source?.doc.name || "Loading source…"}</h3><p>Original content and the exact indexed chunks. Read-only.</p></div><button onClick={onClose}>Back to sources</button></header>
    {error && <p role="alert">{error}</p>}
    {source && <>
      <div className="connectionActions"><button aria-pressed={tab === "content"} onClick={() => setTab("content")}>Content</button><button aria-pressed={tab === "text"} onClick={() => setTab("text")}>{source.tables.length ? "Raw table data" : "Extracted text"}</button><button aria-pressed={tab === "chunks"} onClick={() => setTab("chunks")}>Indexed chunks ({source.chunks.length})</button><a href={`/api/data/source/${id}/original`} target="_blank" rel="noreferrer">{source.mode === "pdf" ? "Open original PDF" : "Download original"}</a></div>
      {tab === "chunks" ? <div>{source.chunks.map(chunk => <article className="connectionCard" key={chunk.id}><strong>Chunk {chunk.i + 1} · {chunk.dimensions} dimensions</strong><small>{chunk.id}</small><pre>{chunk.text}</pre></article>)}</div> : source.tables.length ? <>
        <label className="settingField">Table / sheet<select value={tableIndex} onChange={e => { setTableIndex(Number(e.target.value)); setPage(0); setFilter(""); }}>{source.tables.map((t, i) => <option key={i} value={i}>{t.name} ({t.rows.length} rows)</option>)}</select></label>
        <details><summary>Schema / column information</summary><pre>{table?.schema}</pre></details>
        {tab === "text" ? <pre>{JSON.stringify({ columns: table?.columns, rows: table?.rows }, null, 2)}</pre> : <>
          <label className="settingField">Filter rows<input value={filter} onChange={e => { setFilter(e.target.value); setPage(0); }} placeholder="Find a cell value" /></label>
          <p>{rows.length} matching rows · showing {rows.length ? page * 50 + 1 : 0}–{Math.min((page + 1) * 50, rows.length)}</p>
          <div className="sourceTable"><table><thead><tr>{table?.columns.map((col, i) => <th key={i}>{col}</th>)}</tr></thead><tbody>{rows.slice(page * 50, (page + 1) * 50).map((row, i) => <tr key={i}>{table?.columns.map((_, j) => <td key={j}>{row[j] === null ? <em>NULL</em> : String(row[j] ?? "")}</td>)}</tr>)}</tbody></table></div>
          <div className="connectionActions"><button disabled={page === 0} onClick={() => setPage(p => p - 1)}>Previous rows</button><button disabled={(page + 1) * 50 >= rows.length} onClick={() => setPage(p => p + 1)}>Next rows</button></div>
        </>}
      </> : tab === "content" && source.mode === "pdf" ? <iframe className="sourcePdf" title={`PDF: ${source.doc.name}`} src={`/api/data/source/${id}/original`} /> : tab === "content" && source.mode === "markdown" ? <Markdown text={source.text} /> : <pre>{source.text || "No text extracted."}</pre>}
      {(source.doc.kind === "doc" || source.doc.kind === "docx") && <p>Word content is shown as extracted text. Download the original to inspect its page layout.</p>}
    </>}
  </section>;
}
