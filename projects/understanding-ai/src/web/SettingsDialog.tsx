import { DataPanel } from "./DataPanel";
import { useEffect, useRef, useState } from "react";
import type { LabSettings, McpPreset, McpSelection, TraceEvent } from "../shared/types";
import { SKILLS } from "../shared/skills";

type Props = {
  request: typeof fetch;
  settings: LabSettings;
  setSettings: React.Dispatch<React.SetStateAction<LabSettings>>;
  models: string[];
  presets: McpPreset[];
  onModels: () => Promise<void>;
  onEvents: (events: TraceEvent[]) => void;
  onImport: (files: File[]) => Promise<void>;
  onRefresh: () => Promise<void>;
  busy: boolean;
  onClose: () => void;
};
const sections = ["Model", "Skills", "Data", "Connections", "Runtime"] as const;
export function SettingsDialog({ request, settings, setSettings, models, presets, onModels, onEvents, onImport, onRefresh, busy, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [section, setSection] = useState<typeof sections[number]>("Model");
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { connected: boolean; tools: { name: string; description: string }[]; error?: string }>>({});
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  function update(selection: McpSelection) {
    const old = settings.mcps.find(m => m.id === selection.id);
    if (old && (old.url !== selection.url || old.command !== selection.command || JSON.stringify(old.args) !== JSON.stringify(selection.args) || old.apiKey !== selection.apiKey)) selection = { ...selection, allowedTools: [] };
    setSettings((s) => ({ ...s, mcps: [...s.mcps.filter((m) => m.id !== selection.id), selection] }));
    const previous = settings.mcps.find((m) => m.id === selection.id);
    if (previous && (previous.url !== selection.url || previous.command !== selection.command || JSON.stringify(previous.args) !== JSON.stringify(selection.args) || previous.apiKey !== selection.apiKey)) {
      setResults((current) => { const next = { ...current }; delete next[selection.id]; return next; });
    }
  }
  async function test(selection: McpSelection) {
    setTesting(selection.id);
    try {
      const res = await request("/api/mcp/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ selection }) });
      const data = await res.json();
      onEvents(data.events || []);
      setResults((r) => ({ ...r, [selection.id]: { connected: !!data.connected, tools: data.tools || [], error: data.error || (!data.connected ? "Connection failed. Inspect Network and Tools in the console." : undefined) } }));
    } catch (e) { setResults((r) => ({ ...r, [selection.id]: { connected: false, tools: [], error: String(e) } })); }
    finally { setTesting(null); }
  }
  const customs = settings.mcps.filter((m) => !presets.some((p) => p.id === m.id));
  function connection(selection: McpSelection, preset?: McpPreset) {
    const result = results[selection.id];
    const http = !!selection.url || (!selection.command && preset?.transport !== "stdio");
    return <article className="connectionCard" key={selection.id}>
      <div className="connectionTitle">
        <label className="checkLabel"><input type="checkbox" checked={selection.enabled} onChange={(e) => update({ ...selection, enabled: e.target.checked })} /><strong>{preset?.name || selection.id}</strong></label>
        <span className="badge">{http ? "HTTP · external" : "stdio · local process"}</span>
      </div>
      {preset ? <><p>{preset.blurb}</p><code className="endpoint">{preset.url || `${preset.command} ${(preset.args || []).join(" ")}`}</code></> : <div className="connectionFields">
        <label>Transport<select aria-label={`Transport ${selection.id}`} value={http ? "http" : "stdio"} onChange={(e) => update({ ...selection, url: e.target.value === "http" ? "http://" : undefined, command: e.target.value === "stdio" ? "node" : undefined, args: [] })}><option value="http">HTTP / Streamable HTTP</option><option value="stdio">Local process / stdio</option></select></label>
        {http ? <label>Server URL<input aria-label={`URL ${selection.id}`} type="url" placeholder="https://example.com/mcp" value={selection.url || ""} onChange={(e) => update({ ...selection, url: e.target.value })} /></label> : <>
          <label>Command<input value={selection.command || ""} placeholder="node" onChange={(e) => update({ ...selection, command: e.target.value })} /></label>
          <label>Arguments (one per line)<textarea rows={3} value={(selection.args || []).join("\n")} onChange={(e) => update({ ...selection, args: e.target.value.split("\n").filter(Boolean) })} /></label>
        </>}
        <label>{http ? "Bearer token (optional, this session only)" : "API_KEY for process (optional, this session only)"}<input type="password" autoComplete="off" value={selection.apiKey || ""} onChange={(e) => update({ ...selection, apiKey: e.target.value })} /></label>
      </div>}
      <div className="connectionActions"><button type="button" disabled={testing !== null} onClick={() => void test(selection)}>{testing === selection.id ? "Connecting…" : "Test & discover tools"}</button>
        {!preset && <button type="button" className="ghost" onClick={() => setSettings((s) => ({ ...s, mcps: s.mcps.filter((m) => m.id !== selection.id) }))}>Remove</button>}
        {result && <span className={result.connected ? "successText" : "errorText"}>{result.connected ? `${result.tools.length} tools discovered` : "Connection failed"}</span>}
      </div>
      {result && <div className="discovered" role="status">{result.error || result.tools.map((tool) => <div key={tool.name}><code>{tool.name}</code><span>{tool.description}</span><label className="checkLabel"><input type="checkbox" checked={selection.allowedTools?.includes(`${selection.id}__${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, "_")) || false} onChange={e => update({ ...selection, allowedTools: e.target.checked ? [...(selection.allowedTools || []), `${selection.id}__${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, "_")] : (selection.allowedTools || []).filter(name => name !== `${selection.id}__${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, "_")) })} />Allow agent to execute this tool (may have side effects)</label></div>)}</div>}
    </article>;
  }
  return <dialog ref={dialog} className="settingsDialog" aria-labelledby="settings-title" onCancel={onClose} onClick={(e) => { if (e.target === dialog.current) onClose(); }}>
    <div className="settingsShell">
      <header className="settingsHeader"><div><span className="eyebrow">UNDERSTANDING AI</span><h2 id="settings-title">Configure your harness</h2><p>Choose the model, instructions and capabilities behind each run.</p></div><button className="closeButton" aria-label="Close settings" onClick={onClose}>×</button></header>
      <div className="settingsLayout">
        <nav className="settingsNav" aria-label="Settings sections">{sections.map((name, i) => <button key={name} aria-current={section === name ? "page" : undefined} onClick={() => setSection(name)}><span>0{i + 1}</span>{name}</button>)}</nav>
        <section className="settingsContent" aria-label={`${section} settings`}>
          {section === "Model" && <><h3>Model connection</h3><p className="sectionIntro">The harness sends instructions, context and available tools to this model.</p>
            <label className="settingField">Provider<select value={settings.provider} onChange={(e) => { setNotice(""); setSettings((s) => ({ ...s, provider: e.target.value as LabSettings["provider"], model: "", apiKey: "", thinking: false })); }}><option value="ollama">Ollama · local</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="openrouter">OpenRouter</option><option value="google">Google Gemini</option></select></label>
            {settings.provider === "ollama" ? <div className="infoBox">Runs through your local Ollama server. No API key required. Choose an installed model that supports tools.</div> : <label className="settingField">API key<input type="password" autoComplete="off" value={settings.apiKey} placeholder="Enter key for this session" onChange={(e) => setSettings((s) => ({ ...s, apiKey: e.target.value }))} /></label>}
            <div className="modelLoader"><label className="settingField">Model<input aria-label="Model ID" list="settings-models" value={settings.model} placeholder="Load models or enter an ID" onChange={(e) => setSettings((s) => ({ ...s, model: e.target.value }))} /><datalist id="settings-models">{models.map((m) => <option key={m} value={m} />)}</datalist></label><button disabled={loading} onClick={async () => { setLoading(true); try { await onModels(); setNotice("Model list refreshed. The request appears in Network."); } catch (e) { setNotice(String(e)); } finally { setLoading(false); } }}>{loading ? "Loading…" : "Load models"}</button></div>
            <p role="status" className="sectionIntro">{notice}</p>
            {settings.provider === "anthropic" && <label className="checkLabel"><input type="checkbox" checked={settings.thinking} onChange={(e) => setSettings((s) => ({ ...s, thinking: e.target.checked }))} />Request provider-supported extended thinking</label>}
            <div className="infoBox">Keys stay in memory for this page session. Retrieved text and tool results are sent to the selected provider. Known credential fields are redacted in traces.</div>
          </>}
          {section === "Skills" && <><h3>Instruction skills</h3><p className="sectionIntro">Skills add instructions to the system prompt. They do not execute tools or grant permissions.</p>{SKILLS.map((skill) => <label className="skillCard" key={skill.id}><input type="checkbox" checked={settings.skills?.includes(skill.id) || false} onChange={(e) => setSettings((s) => ({ ...s, skills: e.target.checked ? [...new Set([...(s.skills || []), skill.id])] : (s.skills || []).filter((id) => id !== skill.id) }))} /><span><strong>{skill.name}</strong><p>{skill.description}</p><small>{skill.instructions}</small></span></label>)}</>}
          {section === "Data" && <DataPanel request={request} onImport={onImport} onRefresh={onRefresh} busy={busy} onEvents={onEvents} />}
          {section === "Connections" && <><div className="sectionHeading"><div><h3>MCP connections</h3><p className="sectionIntro">Discover tools, enable the connection, and explicitly allow each executable tool for the next run.</p></div><button className="primary" onClick={() => update({ id: `custom-${crypto.randomUUID().slice(0, 8)}`, enabled: false, url: "" })}>+ Add MCP</button></div>
            <div className="infoBox">HTTP traffic is shown in Network. Stdio runs a local process and appears in Tools. Calls made inside a remote server or child process are not visible to this harness. Only enable trusted servers.</div>
            {customs.map((selection) => connection(selection))}
            {presets.map((preset) => connection(settings.mcps.find((m) => m.id === preset.id) || { id: preset.id, enabled: false }, preset))}
          </>}
          {section === "Runtime" && <><h3>Execution boundaries</h3><div className="infoBox">Enforced server-side: built-in knowledge tools are read-only; bundled add/echo tools are allowed. Other MCP tools are denied until explicitly allowed after discovery in Connections. Every call is checked against its JSON schema and a 32-call budget. Prompts and retrieved documents cannot change these permissions. These rules do not sandbox MCP processes: connecting a server starts its configured code.</div><p className="sectionIntro">The harness manages context, executes tool requests and decides when to stop.</p><label className="settingField">Maximum model/tool rounds<input type="number" min={1} max={16} value={settings.maxRounds} onChange={(e) => setSettings((s) => ({ ...s, maxRounds: Math.max(1, Math.min(16, Number(e.target.value) || 1)) }))} /></label><div className="infoBox">Documents are parsed, chunked and embedded locally with MiniLM. Vectors and chunks live in SQLite with sqlite-vec and FTS5 under data/kb. Model assets may download on first use. Import content from Data; follow each stage in Knowledge.</div></>}
        </section>
      </div>
      <footer className="settingsFooter"><span>Changes apply to the next run · credentials are not saved</span><button className="primary" onClick={onClose}>Done</button></footer>
    </div>
  </dialog>;
}
