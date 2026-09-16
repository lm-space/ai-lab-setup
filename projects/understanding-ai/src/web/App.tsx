import { useEffect, useMemo, useRef, useState } from "react";
import { Flow } from "./Flow";
import { SettingsDialog } from "./SettingsDialog";
import { browserFetch } from "./network";
import { TraceConsole } from "./TraceConsole";
import { IconHistory, IconLibrary, IconNewChat, IconSettings, IconUpload } from "./Icons";
import { Markdown } from "./Markdown";
import type {
  ChatMessage,
  ChatRecord,
  KbDoc,
  LabSettings,
  McpPreset,
  SseFrame,
  TraceEvent,
} from "../shared/types";

const SETTINGS_KEY = "understanding-ai-settings";
const ACCEPT = ".md,.txt,.pdf,.doc,.docx,.csv,.xls,.xlsx,.json";

const emptySettings = (): LabSettings => ({
  provider: "ollama",
  apiKey: "",
  model: "",
  thinking: false,
  skills: [],
  maxRounds: 8,
  mcps: [],
});

async function readSse(
  res: Response,
  onFrame: (frame: SseFrame) => void,
) {
  if (!res.body) throw new Error("No stream");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const chunks = buf.split("\n\n");
    buf = chunks.pop() || "";
    for (const chunk of chunks) {
      const line = chunk.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      try {
        onFrame(JSON.parse(line.slice(5).trim()) as SseFrame);
      } catch {
        /* skip truncated json */
      }
    }
  }
}

export function App() {
  const [settings, setSettings] = useState<LabSettings>(() => {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      return raw ? { ...emptySettings(), ...JSON.parse(raw) } : emptySettings();
    } catch {
      return emptySettings();
    }
  });
  const [catalog, setCatalog] = useState<{ mcps: McpPreset[]; models: Record<string, string[]> }>({
    mcps: [],
    models: {},
  });
  const [liveModels, setLiveModels] = useState<Record<string, string[]>>({});
  const [chatId, setChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [openStep, setOpenStep] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [histOpen, setHistOpen] = useState(false);
  const [setOpen, setSetOpen] = useState(false);
  const [libOpen, setLibOpen] = useState(false);
  const [docs, setDocs] = useState<KbDoc[]>([]);
  const [drag, setDrag] = useState(false);
  const [history, setHistory] = useState<{ id: string; title: string; updatedAt: number; model: string; preview: string }[]>([]);
  const bottom = useRef<HTMLDivElement>(null);

  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, apiKey: "", mcps: settings.mcps.map((m) => ({ ...m, apiKey: undefined })) }));
  }, [settings]);

  useEffect(() => {
    request("/api/catalog")
      .then((r) => r.json())
      .then((c) => {
        setCatalog(c);
        setSettings((s) => {
          if (s.mcps.length) return s;
          return {
            ...s,
            mcps: (c.mcps as McpPreset[]).map((m) => ({
              id: m.id,
              enabled: false,
            })),
          };
        });
      })
      .catch(() => {});
    refreshDocs();
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);


  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setLibOpen(false);
      setHistOpen(false);
      setSetOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const flow = (events.find((event) => event.id === openStep && event.flow.nodes.length) || [...events].reverse().find((event) => event.flow.nodes.length))?.flow || null;
  const models = useMemo(() => {
    const fb = catalog.models[settings.provider] || [];
    return [...new Set([...(liveModels[settings.provider] || []), ...fb])];
  }, [catalog, liveModels, settings.provider]);

  const request = browserFetch(pushEvent);

  function pushEvent(ev: TraceEvent) {
    setEvents((cur) => [...cur, ev].sort((a, b) => a.t - b.t));

  }

  function applyFrame(frame: SseFrame) {
    if (frame.type === "event") pushEvent(frame.event);
    else if (frame.type === "chat") {
      if (frame.role === "user" && frame.content) {
        setMessages((m) =>
          m.some((x) => x.id === frame.id)
            ? m
            : [...m, { id: frame.id, role: "user", content: frame.content || "", createdAt: Date.now() }],
        );
      } else if (frame.role === "assistant") {
        setMessages((m) => {
          const idx = m.findIndex((x) => x.id === frame.id);
          if (idx === -1) {
            return [
              ...m,
              {
                id: frame.id,
                role: "assistant",
                content: frame.content || frame.delta || "",
                createdAt: Date.now(),
              },
            ];
          }
          const copy = m.slice();
          const cur = copy[idx];
          copy[idx] = {
            ...cur,
            content: frame.done && frame.content ? frame.content : cur.content + (frame.delta || ""),
          };
          return copy;
        });
      }
    } else if (frame.type === "done") {
      if (frame.chatId) setChatId(frame.chatId);
    } else if (frame.type === "error") {
      setErr(frame.message);
    }
  }

  async function refreshDocs() {
    try {
      const r = await request("/api/kb").then((x) => x.json());
      setDocs(r.docs || []);
    } catch {
      /* api not up yet */
    }
  }

  function newChat() {
    setChatId(null);
    setMessages([]);
    setEvents([]);
    setOpenStep(null);
    setErr("");
  }

  async function loadHistoryList() {
    const rows = await request("/api/chats").then((r) => r.json());
    setHistory(rows);
  }

  async function openChat(id: string) {
    const rec = (await request(`/api/chats/${id}`).then((r) => r.json())) as ChatRecord;
    setChatId(rec.id);
    setMessages(rec.messages);
    setEvents(rec.events);
    setOpenStep(rec.events.at(-1)?.id || null);
    setHistOpen(false);
  }

  async function fetchModels() {
    const res = await request("/api/models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: settings.provider, apiKey: settings.apiKey }),
    });
    const json = await res.json();
    for (const event of json.events || []) pushEvent(event);
    setLiveModels((current) => ({ ...current, [settings.provider]: json.models || [] }));
    if (json.models?.[0] && !json.models.includes(settings.model)) {
      setSettings((s) => ({ ...s, model: json.models[0] }));
    }
  }

  async function ingestFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (!list.length) return;
    setBusy(true);
    setErr("");
    setOpenStep(null);
    try {
      for (const file of list) {
        const body = new FormData();
        body.append("file", file);
        const res = await request("/api/kb/upload", { method: "POST", body });
        if (!res.ok && !res.headers.get("content-type")?.includes("text/event-stream")) {
          const j = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(j.error || "upload failed");
        }
        await readSse(res, applyFrame);
      }
      await refreshDocs();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function removeDoc(id: string) {
    await request(`/api/kb/${id}`, { method: "DELETE" });
    await refreshDocs();
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    if (!settings.apiKey && settings.provider !== "ollama") {
      setSetOpen(true);
      setErr("Paste a provider API key in Settings first.");
      return;
    }
    if (!settings.model.trim()) { setSetOpen(true); setErr("Choose a model in Settings first."); return; }
    setInput("");
    setOpenStep(null);
    setBusy(true);
    setErr("");
    try {
      const res = await request("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chatId,
          text:
            docs.length > 0
              ? `${text}\n\n[Local KB files available via kb__search / kb__list / kb__table: ${docs.map((d) => d.name).join(", ")}]`
              : text,
          settings,
        }),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Request failed");
      }
      await readSse(res, applyFrame);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="app"
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        if (e.dataTransfer.files?.length) void ingestFiles(e.dataTransfer.files);
      }}
    >
      {drag && (
        <div className="dropMask">
          Drop md, pdf, docx, csv, xlsx — they land in the local vector index
        </div>
      )}
      <header className="top">
        <span className="brand">Understanding AI</span>
        <h1>Under the hood</h1>
        <span className="model">
          {settings.provider} / {settings.model || "no model"}
          {docs.length ? ` · ${docs.length} docs` : ""}
        </span>
        <span className="sp" />
        <nav className="topNav" aria-label="App">
          <button
            type="button"
            className={`topIcon${histOpen ? " on" : ""}`}
            title="Chat history"
            aria-label="Chat history"
            onClick={() => { loadHistoryList(); setHistOpen(true); }}
          >
            <IconHistory />
          </button>
          <button
            type="button"
            className={`topIcon${libOpen ? " on" : ""}`}
            title="Document library — local files for the agent"
            aria-label="Document library"
            onClick={() => { refreshDocs(); setLibOpen(true); }}
          >
            <IconLibrary />
            {docs.length > 0 ? <span className="topBadge">{docs.length}</span> : null}
          </button>
          <button
            type="button"
            className="topIcon"
            title="New chat"
            aria-label="New chat"
            onClick={newChat}
          >
            <IconNewChat />
          </button>
          <button
            type="button"
            className={`topIcon accent${setOpen ? " on" : ""}`}
            title="Provider, API key, and MCPs"
            aria-label="Settings"
            onClick={() => setSetOpen(true)}
          >
            <IconSettings />
          </button>
        </nav>
      </header>

      <details className="harness" open={messages.length === 0 ? true : undefined}>
        <summary>Explore the harness · what surrounds the model</summary>
        <p>This is a working educational agent platform. Inspect this app’s real execution, not ChatGPT’s private implementation or hidden reasoning.</p>
        <div className="harnessGrid">
          <div><strong>Instructions & skills</strong><span>System instructions plus {settings.skills?.length || 0} selected skill(s) shape the request.</span></div>
          <div><strong>Context & memory</strong><span>{docs.length} documents and {messages.length} chat messages. Local retrieval supplies relevant text.</span></div>
          <div><strong>Model connection</strong><span>{settings.provider} · {settings.model || "Choose an installed model in Settings"}</span></div>
          <div><strong>Tools & connections</strong><span>4 built-in knowledge tools · {settings.mcps.filter((m) => m.enabled).length} MCP connections selected. Actual discovery appears in the trace.</span></div>
          <div><strong>Agent loop</strong><span>The model requests a tool; the harness executes it and returns the result. Limit: {settings.maxRounds} rounds.</span></div>
          <div><strong>Trace & storage</strong><span>Inspect requests and results; reopen chat history. Chat and knowledge data stay in local files.</span></div>
        </div>
        <button onClick={() => setSetOpen(true)}>Configure model, skills & connections</button>
      </details>
      <div className="split">
        <section className="pane left">
          <div className="paneHead">
            Chat
            {busy ? <span className="busy">running</span> : <span>{messages.length} messages</span>}
          </div>
          <div className="msgs">
            {messages.length === 0 && (
              <div className="empty">
                Ask anything, or drop a file. Answers render as markdown. The right side traces every hop:
                network calls, agent steps, tool execution, content ingestion, vector retrieval, and the loop back.
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`bubble ${m.role}`}>
                <div className="who">{m.role}</div>
                {m.role === "assistant" ? <Markdown text={m.content} /> : <Markdown text={m.content} />}
              </div>
            ))}
            <div ref={bottom} />
          </div>
          {err ? <div className="err">{err}</div> : null}
          {docs.length > 0 && (
            <div className="chips">
              {docs.slice(0, 8).map((d) => (
                <span className="chip" key={d.id} title={d.preview}>
                  {d.name}
                  <em>{d.chunks} chunks</em>
                </span>
              ))}
            </div>
          )}
          <div className="dock">
            <div className="dockBox">
              <textarea
                ref={taRef}
                value={input}
                rows={1}
                placeholder="Message — Shift+Enter for a new line. Attach md, pdf, docx, csv, xlsx."
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              <div className="dockBar">
                <input
                  ref={fileRef}
                  type="file"
                  hidden
                  multiple
                  accept={ACCEPT}
                  onChange={(e) => {
                    if (e.target.files) void ingestFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  className="iconBtn"
                  title="Attach files"
                  onClick={() => fileRef.current?.click()}
                  disabled={busy}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
                    <path
                      d="M9.2 4.3 4.4 9.1a2.4 2.4 0 1 0 3.4 3.4l5.3-5.3a3.2 3.2 0 0 0-4.5-4.5L3.4 7.9"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
                <span className="hint">md · pdf · docx · csv · xlsx → local MiniLM index</span>
                <button type="button" className="sendBtn" disabled={busy || !input.trim()} onClick={send}>
                  {busy ? "…" : "Send"}
                </button>
              </div>
            </div>
          </div>
        </section>

        <section className="pane right">
          <div className="paneHead">
            Execution console
            <span>{events.length} steps</span>
          </div>
          <Flow snap={flow} />
          <TraceConsole events={events} selectedId={openStep} onSelect={setOpenStep} />
        </section>
      </div>

      {histOpen && (
        <div className="drawer" onClick={() => setHistOpen(false)}>
          <aside className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>History</h2>
            <p className="empty" style={{ padding: "0 0 12px" }}>
              Open a past chat to restore the left transcript and the full right-side trace.
            </p>
            {history.map((h) => (
              <button key={h.id} className="histItem" onClick={() => openChat(h.id)}>
                <div className="t">{h.title}</div>
                <div className="s">
                  {h.model} · {new Date(h.updatedAt).toLocaleString()}
                </div>
              </button>
            ))}
            {history.length === 0 && <div className="empty">No saved chats yet.</div>}
          </aside>
        </div>
      )}

      {libOpen && (
        <div className="drawer" onClick={() => setLibOpen(false)}>
          <aside className="sheet libSheet" onClick={(e) => e.stopPropagation()}>
            <h2>Document library</h2>
            <p className="libLead">
              Add files here. They stay on this Mac and become agent tools automatically.
            </p>
            <ol className="libHow">
              <li>Paperclip in the chat box, or drop a file on this window</li>
              <li>We classify by type, pick a parser, chunk, embed with MiniLM</li>
              <li>Stored under <code>data/kb/</code> — originals, catalog, vectors</li>
            </ol>
            <div className="storeMap">
              <div><code>uploads/</code> original files</div>
              <div><code>docs.json</code> classified catalog</div>
              <div><code>chunks.json</code> 384-d cosine index</div>
              <div><code>models/</code> MiniLM weights (local)</div>
            </div>
            <button className="primary libUpload" onClick={() => fileRef.current?.click()}>
              <IconUpload /> Add documents
            </button>
            <p className="libHint">md · pdf · doc · docx · csv · xls · xlsx · json</p>
            {docs.map((d) => (
              <div className="docCard" key={d.id}>
                <div className="docTop">
                  <span className={`fam fam-${d.family || "text"}`}>{d.label || d.kind}</span>
                  <span className="fam dim">{d.shape || "prose"}</span>
                  <button className="ghost tiny" onClick={() => removeDoc(d.id)}>Remove</button>
                </div>
                <div className="t">{d.name}</div>
                <div className="s">
                  parser {d.parser || d.kind} · {d.chunks} chunks · {(d.bytes / 1024).toFixed(1)} KB
                </div>
                <div className="s">tools {(d.tools || ["kb__search"]).join(" · ")}</div>
                {d.path ? <div className="s path">data/kb/{d.path}</div> : null}
                <div className="s preview">{d.preview}</div>
              </div>
            ))}
            {docs.length === 0 && (
              <div className="empty">Nothing stored yet. Drop a file anywhere on this window.</div>
            )}
          </aside>
        </div>
      )}

      {setOpen && <SettingsDialog settings={settings} setSettings={setSettings} models={models} presets={catalog.mcps} onModels={fetchModels} onEvents={(rows) => setEvents((current) => [...current, ...rows].sort((a, b) => a.t - b.t))} request={request} onClose={() => setSetOpen(false)} />}
    </div>
  );
}
