import { useEffect, useMemo, useRef, useState } from "react";
import type { TraceCategory, TraceEvent } from "../shared/types";
import { categoryOf, explanationOf } from "../shared/trace-view";
const tabs = ["all", "user-app", "network", "agent", "tools", "knowledge"] as const;
export function TraceConsole({ events, selectedId, onSelect }: { events: TraceEvent[]; selectedId: string | null; onSelect: (id: string | null) => void }) {
  const [tab, setTab] = useState<"all" | TraceCategory>("all");
  const [query, setQuery] = useState("");
  const [follow, setFollow] = useState(true);
  const [source, setSource] = useState("all");
  const scroll = useRef<HTMLDivElement>(null);
  const visible = useMemo(() => events.filter((event) => (tab === "all" || categoryOf(event) === tab) && (source === "all" || event.callType === source) && `${event.title} ${event.target || ""} ${event.kind}`.toLowerCase().includes(query.toLowerCase())), [events, tab, query, source]);
  const selected = visible.find((e) => e.id === selectedId);
  useEffect(() => { if (follow) scroll.current?.scrollTo({ top: scroll.current.scrollHeight }); }, [visible.length, follow]);
  return <div className="traceConsole">
    <div className="consoleTabs" role="tablist" aria-label="Trace categories">{tabs.map((name) => <button role="tab" aria-selected={tab === name} tabIndex={tab === name ? 0 : -1} onKeyDown={(e) => { const index = tabs.indexOf(name); const next = e.key === "ArrowRight" ? (index + 1) % tabs.length : e.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1; if (next >= 0) { e.preventDefault(); setTab(tabs[next]); onSelect(null); document.getElementById(`trace-tab-${tabs[next]}`)?.focus(); } }} id={`trace-tab-${name}`} aria-controls="trace-panel" key={name} onClick={() => { setTab(name); onSelect(null); }}>{name === "user-app" ? "User App" : name}<span>{name === "all" ? events.length : events.filter((e) => categoryOf(e) === name).length}</span></button>)}</div>
    <div className="consoleToolbar"><input aria-label="Filter trace" placeholder="Filter events or endpoints…" value={query} onChange={(e) => setQuery(e.target.value)} /><select aria-label="Call type" value={source} onChange={(e) => setSource(e.target.value)}><option value="all">All call types</option><option value="ai-provider">AI provider</option><option value="external">External</option><option value="local">Local</option></select><label><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />Follow</label></div>
    <div className="consoleHint">{tab === "all" ? "Chronological events across all observed layers. Select a row to inspect its payload and graph." : tab === "network" ? "Actual HTTP requests from provider and MCP transports. Local tool execution appears in Tools." : tab === "knowledge" ? "Import → parse → chunk → embed → store → retrieve. Embedding asset events are reported by the library." : tab === "tools" ? "Discovery and execution, separate from the model’s request to use a tool." : "Context, instructions, model responses and runtime decisions."}</div>
    <div className="consoleBody" id="trace-panel" role="tabpanel" aria-labelledby={`trace-tab-${tab}`}>
      <div className="consoleRows" ref={scroll}>
        <table><thead><tr><th># / UTC</th><th>Layer / Type</th><th>Event</th><th>Status</th><th>Duration</th></tr></thead><tbody>{visible.map((event) => <tr key={event.id} className={selectedId === event.id ? "selected" : ""}>
          <td>{events.indexOf(event) + 1}<small>{new Date(event.t).toISOString().slice(11, 23)}</small></td>
          <td><span className={`eventCategory ${categoryOf(event)}`}>{categoryOf(event) === "user-app" ? "User App" : categoryOf(event)}</span><small>{event.lane === "parent" || event.lane === "user-app" ? "User App · " : ""}{event.callType || "runtime"}</small></td>
          <td><button className="eventButton" aria-expanded={selectedId === event.id} onClick={() => { onSelect(selectedId === event.id ? null : event.id); setFollow(false); }}>{event.title}</button>{event.target && <small className="eventTarget">{event.target}</small>}</td>
          <td><span className={`eventStatus ${event.phase || "info"}`}>{event.status || event.phase || "info"}</span></td>
          <td>{event.durationMs === undefined ? "—" : `${event.durationMs} ms`}</td>
        </tr>)}</tbody></table>
        {!visible.length && <div className="consoleEmpty">{events.length ? "No matching events." : "Send a message, import a document, load models, or test an MCP connection to see real events."}</div>}
      </div>
      {selected && <aside className="eventInspector"><header><strong>{selected.title}</strong><button aria-label="Close event details" onClick={() => onSelect(null)}>×</button></header><p>{explanationOf(selected)}</p><dl><dt>Run</dt><dd>{selected.runId || "Legacy trace"}</dd>{selected.correlationId && <><dt>Call ID</dt><dd>{selected.correlationId}</dd></>}{selected.parentId && <><dt>Initiating operation</dt><dd>{selected.parentId}</dd></>}</dl><pre>{JSON.stringify(selected.payload ?? {}, null, 2)}</pre></aside>}
    </div>
  </div>;
}
