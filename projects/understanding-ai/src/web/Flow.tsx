import { useEffect, useRef, useState } from "react";
import type { FlowSnap, TraceEvent } from "../shared/types";
import { categoryOf } from "../shared/trace-view";

const lanes = ["User App", "Agent", "AI provider", "Tools / MCP", "Knowledge", "Local / external HTTP"];
function lane(event: TraceEvent) {
  if (event.category === "network") return event.callType === "ai-provider" ? 2 : 5;
  if (event.lane === "llm") return 2;
  const category = categoryOf(event);
  return category === "user-app" ? 0 : category === "tools" ? 3 : category === "knowledge" ? 4 : 1;
}

export function Flow({ snap, events, selectedId, onSelect }: { snap: FlowSnap | null; events: TraceEvent[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [filter, setFilter] = useState("");
  const [inspect, setInspect] = useState<TraceEvent | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (expanded) dialog.current?.showModal(); else dialog.current?.close(); }, [expanded]);
  const selected = events.find(e => e.id === selectedId);
  const latest = [...events].reverse().find(e => e.flow.nodes.length);
  const runId = selected?.runId || latest?.runId;
  const rows = events.filter(e => !runId || e.runId === runId).filter(e => !filter || `${e.title} ${e.target || ""} ${e.detail || ""}`.toLowerCase().includes(filter.toLowerCase()));
  const first = rows[0]?.t || 0;
  function sequence() {
    return <div className="sequenceScroll"><div className="sequenceDiagram" style={{ minWidth: `${1120 * zoom / 100}px` }}>
      <div className="sequenceHeader"><span>Elapsed</span>{lanes.map(name => <strong key={name}>{name}</strong>)}</div>
      {rows.map((event, index) => <div className={`sequenceRow ${event.id === selectedId ? "selected" : ""}`} key={event.id}>
        <div className="sequenceTime"><span>{index + 1}</span><small>+{((event.t - first) / 1000).toFixed(3)}s</small></div>
        {lanes.map((name, column) => <div className="sequenceCell" key={name}>{column === lane(event) && <button className={`sequenceEvent ${event.phase === "error" ? "failed" : ""}`} onClick={() => { onSelect(event.id); setInspect(event); }}>
          <small>{event.callType || categoryOf(event)} · {event.phase || event.kind}{event.round > 0 ? ` · round ${event.round}` : ""}</small>
          <strong>{event.title}</strong>{event.target && <span>{event.target}</span>}
          {event.durationMs != null && <small>{event.durationMs.toFixed(1)} ms{event.status ? ` · ${event.status}` : ""}</small>}
        </button>}</div>)}
      </div>)}
      {!rows.length && <p className="empty">Send a question or import data to see observed execution stages.</p>}
    </div></div>;
  }
  return <>
    <div className="flowWrap sequencePreview">
      <div className="flowToolbar"><strong>Execution flow · {rows.length} events</strong><button onClick={() => setExpanded(true)}>⛶ Fullscreen flow</button></div>
      {sequence()}
    </div>
    <dialog ref={dialog} className="flowDialog" aria-labelledby="flow-title" onCancel={() => setExpanded(false)}>
      <header className="flowToolbar"><div><h2 id="flow-title">Execution flow</h2><p>Read top to bottom. Each row is an observed event; columns identify the responsible layer.</p></div><button aria-label="Close fullscreen flow" onClick={() => setExpanded(false)}>Close ×</button></header>
      <div className="flowToolbar"><input aria-label="Filter flow events" placeholder="Filter events or endpoints…" value={filter} onChange={e => setFilter(e.target.value)} /><label>Diagram width <select value={zoom} onChange={e => setZoom(Number(e.target.value))}><option value={80}>Compact</option><option value={100}>Normal</option><option value={140}>Wide</option></select></label><span>{rows.length} events · {snap?.nodes.find(n => n.id === "llm")?.sub || "Observed run"}</span></div>
      {sequence()}
      {inspect && <aside className="flowDetails"><div className="flowToolbar"><strong>{inspect.title}</strong><button onClick={() => setInspect(null)}>Close details</button></div><p>Run: {inspect.runId || "legacy"} · Call: {inspect.correlationId || "—"} · Parent: {inspect.parentId || "—"}</p><pre>{JSON.stringify(inspect.payload, null, 2)}</pre></aside>}
    </dialog>
  </>;
}
