import { randomUUID } from "node:crypto";
import { resolveSkills } from "../shared/skills.ts";
import { SYSTEM_PROMPT } from "./catalog.ts";
import { kbTools, listDocs, runKbTool } from "./kb.ts";
import { callMcp, closeMcps, connectMcps, type BoundTool, type McpHandle } from "./mcp.ts";
import { runLlm } from "./providers.ts";
import { redact } from "./redact.ts";
import { saveChat } from "./store.ts";
import type {
  ChatMessage,
  ChatRecord,
  FlowEdge,
  FlowNode,
  FlowSnap,
  LabSettings,
  SseFrame,
  TraceEvent,
} from "../shared/types.ts";

type Emit = (frame: SseFrame) => Promise<void>;

export class Graph {
  nodes: FlowNode[] = [];
  edges: FlowEdge[] = [];
  active: string[] = [];
  row = 0;

  snap(): FlowSnap {
    return {
      nodes: this.nodes.map((n) => ({ ...n })),
      edges: this.edges.map((e) => ({ ...e })),
      active: [...this.active],
    };
  }

  add(id: string, label: string, kind: FlowNode["kind"], col: number, sub?: string, row?: number) {
    if (this.nodes.some((n) => n.id === id)) {
      const n = this.nodes.find((n) => n.id === id)!;
      if (sub) n.sub = sub;
      return;
    }
    this.nodes.push({ id, label, kind, col, row: row ?? this.row, sub });
  }

  edge(from: string, to: string, label: string, animated = true) {
    if (this.edges.some((e) => e.from === from && e.to === to && e.label === label)) return;
    this.edges.push({ from, to, label, animated });
  }

  highlight(ids: string[]) {
    this.active = ids;
  }
}

export async function runSession(opts: {
  chatId: string;
  existing?: ChatRecord | null;
  userText: string;
  settings: LabSettings;
  emit: Emit;
}) {
  const g = new Graph();
  let seq = opts.existing?.events.length || 0;
  let round = 0;
  const events: TraceEvent[] = [...(opts.existing?.events || [])];
  const messages: ChatMessage[] = [...(opts.existing?.messages || [])];

  const emitEvent = async (
    kind: string,
    title: string,
    lane: TraceEvent["lane"],
    payload?: unknown,
    detail?: string,
  ) => {
    const ev: TraceEvent = {
      id: randomUUID(),
      t: Date.now(),
      seq: seq++,
      round,
      kind,
      title,
      lane,
      detail,
      payload: payload === undefined ? undefined : redact(payload),
      flow: g.snap(),
    };
    events.push(ev);
    await opts.emit({ type: "event", event: ev });
  };

  const userMsg: ChatMessage = {
    id: randomUUID(),
    role: "user",
    content: opts.userText,
    createdAt: Date.now(),
  };
  messages.push(userMsg);
  await opts.emit({ type: "chat", id: userMsg.id, role: "user", content: opts.userText, done: true });

  g.add("user", "Chat", "actor", 0, "user message", 0);
  g.add("agent", "Agent Code", "compute", 1, "TypeScript loop", 0);
  g.add("llm", "LLM API", "model", 2, opts.settings.model, 0);
  g.add("mcp", "MCP bus", "data", 3, "connecting", 0);
  g.add("kb", "Local KB", "store", 4, "MiniLM index", 0);
  g.edge("user", "agent", "POST /chat");
  g.edge("agent", "kb", "kb tools");
  g.highlight(["user", "agent"]);
  await emitEvent("user_in", "User message received", "parent", {
    chatId: opts.chatId,
    text: opts.userText,
  });

  if (!opts.settings.apiKey && opts.settings.provider !== "ollama") {
    throw new Error("Add an API key in Settings before chatting.");
  }
  if (!opts.settings.model) {
    throw new Error("Pick a model in Settings.");
  }

  g.highlight(["agent"]);
  await emitEvent("settings", "Resolved provider settings", "agent", {
    provider: opts.settings.provider,
    model: opts.settings.model,
    thinking: opts.settings.thinking,
    maxRounds: opts.settings.maxRounds,
    mcpIds: opts.settings.mcps.filter((m) => m.enabled).map((m) => m.id),
  });

  const selectedSkills = resolveSkills(opts.settings.skills || []);
  const systemPrompt = [SYSTEM_PROMPT, ...selectedSkills.map((skill) => `Skill: ${skill.name}\n${skill.instructions}`)].join("\n\n");
  g.add("skills", "Skills", "data", 1, `${selectedSkills.length} selected`, 1);
  g.edge("skills", "agent", "instructions");
  await emitEvent("skills_resolved", "Selected skills added to the harness instructions", "agent", {
    skills: selectedSkills,
    explanation: "Skills are reusable instructions. Tools are executable capabilities. Selecting a skill does not create a tool.",
  });

  let handles: McpHandle[] = [];
  let tools: BoundTool[] = [];
  try {
    g.add("mcp", "MCP bus", "data", 3, "connecting", 0);
    g.edge("agent", "mcp", "connect");
    g.highlight(["agent", "mcp"]);
    await emitEvent("mcp_connect_start", "Connecting selected MCP servers", "mcp", {
      enabled: opts.settings.mcps.filter((m) => m.enabled),
    });

    const connected = await connectMcps(opts.settings.mcps, async (title, payload) => {
      await emitEvent("mcp_log", title, "mcp", payload);
    });
    handles = connected.handles;
    tools = connected.tools;

    for (const h of handles) {
      const nid = `mcp_${h.id}`;
      g.add(nid, h.name, "store", 3, h.transport, 0);
      g.edge("mcp", nid, "session");
    }

    const localKb = kbTools();
    tools = [...tools, ...localKb];
    const docs = await listDocs();
    g.highlight(["kb", "mcp", ...handles.map((h) => `mcp_${h.id}`)]);
    await emitEvent("kb_attached", "Local vector index attached as MCP-like tools", "kb", {
      store: "data/kb MiniLM cosine index",
      docs: docs.map((d) => ({ id: d.id, name: d.name, kind: d.kind, chunks: d.chunks })),
      tools: localKb.map((t) => ({
        qualified: t.qualified,
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });

    await emitEvent("mcp_tools_merged", "Merged MCP + KB tool registry for the model", "mcp", {
      servers: [...handles.map((h) => h.id), "kb"],
      tools: tools.map((t) => ({
        qualified: t.qualified,
        server: t.serverId,
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });

    await emitEvent("system_prompt", "System prompt packed", "agent", { system: systemPrompt });

    type AnthMsg = { role: string; content: unknown };
    type OaiMsg = Record<string, unknown>;
    const anth: AnthMsg[] = [];
    const oai: OaiMsg[] = [];

    const prior = messages.slice(0, -1);
    for (const m of prior) {
      anth.push({ role: m.role, content: m.content });
      oai.push({ role: m.role, content: m.content });
    }
    anth.push({ role: "user", content: opts.userText });
    oai.push({ role: "user", content: opts.userText });

    g.highlight(["agent", "llm"]);
    await emitEvent("messages_packed", "Packed conversation for the provider", "agent", {
      provider: opts.settings.provider,
      anthropicMessages: anth,
      openaiMessages: [{ role: "system", content: systemPrompt }, ...oai],
      toolCount: tools.length,
    });

    const assistantId = randomUUID();
    let assistantText = "";
    await opts.emit({ type: "chat", id: assistantId, role: "assistant", content: "", done: false });

    const maxRounds = Math.max(1, Math.min(opts.settings.maxRounds || 8, 16));
    let stop = false;

    for (let r = 1; r <= maxRounds && !stop; r++) {
      round = r;
      g.row = r;
      g.add(`llm_r${r}`, `LLM round ${r}`, "model", 2, opts.settings.model, r);
      g.add(`agent_r${r}`, `Agent round ${r}`, "compute", 1, "messages.create", r);
      g.edge("agent", `agent_r${r}`, `loop ${r}`);
      g.edge(`agent_r${r}`, `llm_r${r}`, "HTTP");
      g.highlight([`agent_r${r}`, `llm_r${r}`]);
      await emitEvent("loop_start", `Agent loop round ${r} of ${maxRounds}`, "agent", {
        round: r,
        historyLen: opts.settings.provider === "anthropic" ? anth.length : oai.length,
      });

      const packed = opts.settings.provider === "anthropic" ? anth : oai;
      const turn = await runLlm({
        settings: opts.settings,
        system: systemPrompt,
        messages: packed,
        tools,
        onChunk: (kind, delta) => {
          if (kind === "text") {
            assistantText += delta;
            void opts.emit({ type: "chat", id: assistantId, role: "assistant", delta, done: false });
          }
        },
        log: (title, payload) => {
          void emitEvent("llm_wire", title, "llm", payload);
        },
      });

      if (turn.thinking) {
        g.add(`think_r${r}`, "Thinking", "model", 2, `${turn.thinking.length} chars`, r);
        g.edge(`llm_r${r}`, `think_r${r}`, "scratchpad");
        g.highlight([`think_r${r}`]);
        await emitEvent("llm_thinking", "Model thinking block (hidden from chat)", "llm", {
          thinking: turn.thinking,
        });
      }
      if (turn.text) {
        g.add(`text_r${r}`, "Text block", "data", 2, `${turn.text.length} chars`, r);
        g.edge(`llm_r${r}`, `text_r${r}`, "visible");
        await emitEvent("llm_text", "Model text block (streamed to chat)", "llm", { text: turn.text });
      }
      await emitEvent("llm_stop", `stop_reason: ${turn.stopReason}`, "llm", {
        stopReason: turn.stopReason,
        usage: turn.usage,
        toolCalls: turn.toolCalls,
        rawEventCount: turn.rawEvents.length,
        rawTail: turn.rawEvents.slice(-8),
      });

      const needsTools =
        turn.toolCalls.length > 0 &&
        (turn.stopReason === "tool_use" ||
          turn.stopReason === "tool_calls" ||
          turn.stopReason === "function_call");

      if (!needsTools) {
        g.add("out", "Reply", "actor", 0, "end_turn", r);
        g.edge(`llm_r${r}`, "out", "end_turn");
        g.highlight(["out", "user"]);
        await emitEvent("loop_stop", "Loop stop: model finished with text", "agent", {
          round: r,
          stopReason: turn.stopReason,
        });
        stop = true;
        break;
      }

      if (opts.settings.provider === "anthropic") {
        anth.push({
          role: "assistant",
          content: Array.isArray(turn.nativeAssistant) ? turn.nativeAssistant : turn.text,
        });
      } else {
        oai.push((turn.nativeAssistant as Record<string, unknown>) || {
          role: "assistant",
          content: turn.text || null,
        });
      }

      const toolResults: { tc: ToolCallLike; result: unknown; isError: boolean }[] = [];
      for (const tc of turn.toolCalls) {
        const callNode = `call_${tc.id}`;
        g.add(callNode, tc.name.replace(/__/g, " / "), "data", 1, "tool_use", r);
        g.edge(`llm_r${r}`, callNode, "tool_use");
        g.highlight([callNode, "agent"]);
        await emitEvent("tool_use", `Model requested tool ${tc.name}`, "llm", {
          id: tc.id,
          name: tc.name,
          input: tc.input,
        });

        const known = tools.find((t) => t.qualified === tc.name);
        if (!known) {
          const err = { error: `Unknown tool ${tc.name}. Not in the advertised registry.` };
          await emitEvent("tool_unknown", "Tool name not in registry — denied", "agent", err);
          toolResults.push({ tc, result: err, isError: true });
          continue;
        }

        await emitEvent("tool_validate", "Matched tool against the advertised registry", "agent", {
          qualified: known.qualified,
          server: known.serverId,
          originalName: known.name,
          input: tc.input,
        });

        const isKb = known.serverId === "kb";
        const targetNode = isKb ? "kb" : `mcp_${known.serverId}`;
        g.edge(callNode, targetNode, isKb ? "kb tool" : "tools/call");
        g.highlight([callNode, targetNode]);
        const rpc = { name: known.name, arguments: tc.input, server: known.serverId };
        await emitEvent(
          isKb ? "kb_call" : "mcp_call",
          isKb
            ? `KB ${known.name} over local vector index`
            : `MCP tools/call ${known.serverId}.${known.name}`,
          isKb ? "kb" : "mcp",
          rpc,
        );

        let result: unknown;
        try {
          result = isKb
            ? await runKbTool(known.name, tc.input)
            : await callMcp(handles, tools, tc.name, tc.input);
        } catch (err) {
          result = { error: String(err) };
        }
        const resultNode = `res_${tc.id}`;
        g.add(resultNode, "Tool result", "data", isKb ? 4 : 3, known.serverId, r);
        g.edge(targetNode, resultNode, isKb ? "chunks" : "JSON");
        g.edge(resultNode, `agent_r${r}`, "append");
        g.highlight([resultNode, "agent"]);
        await emitEvent(
          isKb ? "kb_result" : "mcp_result",
          isKb
            ? `KB result ${known.name}`
            : `MCP result ${known.serverId}.${known.name}`,
          isKb ? "kb" : "mcp",
          result,
        );
        toolResults.push({ tc, result, isError: false });
      }

      if (opts.settings.provider === "anthropic") {
        anth.push({
          role: "user",
          content: toolResults.map(({ tc, result }) => ({
            type: "tool_result",
            tool_use_id: tc.id,
            content: stringifyResult(result),
          })),
        });
      } else {
        for (const { tc, result } of toolResults) {
          oai.push({
            role: "tool",
            tool_call_id: tc.id,
            content: stringifyResult(result),
          });
        }
      }
      await emitEvent("tool_results_appended", "Tool results appended; looping back to the model", "agent", {
        count: toolResults.length,
      });
    }

    if (!stop) {
      await emitEvent("loop_cap", "Hit maxRounds cap — stopping", "agent", { maxRounds });
    }

    const final: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: assistantText || "(no text block — see the trace for tool activity)",
      createdAt: Date.now(),
    };
    messages.push(final);
    await opts.emit({
      type: "chat",
      id: assistantId,
      role: "assistant",
      content: final.content,
      done: true,
    });

    const rec: ChatRecord = {
      id: opts.chatId,
      title: titleFrom(messages),
      createdAt: opts.existing?.createdAt || Date.now(),
      updatedAt: Date.now(),
      provider: opts.settings.provider,
      model: opts.settings.model,
      messages,
      events,
    };
    await saveChat(rec);
    g.highlight(["user", "agent"]);
    await emitEvent("persist", "Chat + full trace saved locally", "agent", {
      chatId: rec.id,
      eventCount: events.length,
      messageCount: messages.length,
    });
    await opts.emit({ type: "done", chatId: rec.id });
  } finally {
    await closeMcps(handles);
  }
}

type ToolCallLike = { id: string; name: string; input: Record<string, unknown> };

function stringifyResult(result: unknown): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

function titleFrom(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  const t = (first?.content || "New chat").replace(/\s+/g, " ").trim();
  return t.length > 48 ? t.slice(0, 45) + "..." : t;
}
