import { tracedFetch } from "./trace.ts";
const providerFetch = tracedFetch("ai-provider");
import type { LabSettings } from "../shared/types.ts";
import type { BoundTool } from "./mcp.ts";
import { headersForLog, redact } from "./redact.ts";

export type ToolCall = { id: string; name: string; input: Record<string, unknown> };

export type LlmTurn = {
  text: string;
  thinking: string;
  toolCalls: ToolCall[];
  stopReason: string;
  usage?: unknown;
  rawEvents: unknown[];
  nativeAssistant: unknown;
};

type EmitChunk = (kind: "text" | "thinking", delta: string) => void;
type Log = (title: string, payload: unknown) => void | Promise<void>;

export async function runLlm(opts: {
  settings: LabSettings;
  system: string;
  messages: unknown[];
  tools: BoundTool[];
  onChunk: EmitChunk;
  log: Log;
}): Promise<LlmTurn> {
  const started = performance.now();
  let firstOutputMs: number | null = null;
  let firstTextMs: number | null = null;
  const onChunk: EmitChunk = (kind, delta) => {
    if (delta && firstOutputMs === null) firstOutputMs = performance.now() - started;
    if (delta && kind === "text" && firstTextMs === null) firstTextMs = performance.now() - started;
    opts.onChunk(kind, delta);
  };
  try {
    const turn = await (opts.settings.provider === "anthropic" ? anthropic({ ...opts, onChunk }) : openaiCompat({ ...opts, onChunk }));
    const durationMs = performance.now() - started;
    const usage = turn.usage as Record<string, number> | undefined;
    const inputTokens = usage?.input_tokens ?? usage?.prompt_tokens ?? null;
    const outputTokens = usage?.output_tokens ?? usage?.completion_tokens ?? null;
    await opts.log("Model request metrics", { durationMs, firstOutputMs, firstTextMs, inputTokens, outputTokens,
      tokensPerSecond: outputTokens === null ? null : outputTokens / (durationMs / 1000),
      rateDefinition: "Provider-reported output tokens divided by full model request seconds, including initial wait. Not a decoder-only speed.",
      textCharacters: turn.text.length, status: "complete" });
    return turn;
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") error = new Error("The model did not complete within 120 seconds. It may be loading, overloaded, or unreachable. Check the provider and retry.");
    await opts.log("Model request failed", { durationMs: performance.now() - started, firstOutputMs, firstTextMs, status: "error", error: String(error) });
    throw error;
  }
}

function anthropicTools(tools: BoundTool[]) {
  return tools.map((t) => ({
    name: t.qualified,
    description: `[${t.serverId}] ${t.description}`,
    input_schema: t.inputSchema?.type ? t.inputSchema : { type: "object", properties: {} },
  }));
}

async function anthropic(opts: {
  settings: LabSettings;
  system: string;
  messages: unknown[];
  tools: BoundTool[];
  onChunk: EmitChunk;
  log: Log;
}): Promise<LlmTurn> {
  const body: Record<string, unknown> = {
    model: opts.settings.model,
    max_tokens: 8192,
    stream: true,
    system: opts.system,
    messages: opts.messages,
  };
  if (opts.tools.length) body.tools = anthropicTools(opts.tools);
  if (opts.settings.thinking) {
    body.thinking = { type: "enabled", budget_tokens: 4096 };
  }
  const headers = {
    "content-type": "application/json",
    "x-api-key": opts.settings.apiKey,
    "anthropic-version": "2023-06-01",
  };
  await opts.log("LLM HTTP request", {
    method: "POST",
    url: "https://api.anthropic.com/v1/messages",
    headers: headersForLog(headers),
    body: redact(body),
  });
  const res = await providerFetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const errText = await res.text();
    throw new Error(`Anthropic ${res.status}: ${errText.slice(0, 800)}`);
  }
  await opts.log("LLM HTTP response opened", { status: res.status, stream: true });
  return readAnthropicStream(res, opts.onChunk, opts.log);
}

async function readAnthropicStream(
  res: Response,
  onChunk: EmitChunk,
  log: Log,
): Promise<LlmTurn> {
  const turn: LlmTurn = {
    text: "",
    thinking: "",
    toolCalls: [],
    stopReason: "end_turn",
    rawEvents: [],
    nativeAssistant: null,
  };
  const blocks: Record<number, Record<string, unknown>> = {};
  const tools: Record<number, { id: string; name: string; json: string }> = {};
  let blockType = "";
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let completed = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n");
    buf = parts.pop() || "";
    let event = "";
    for (const line of parts) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        if (!data) continue;
        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        if (json.type === "error") throw new Error(`Provider stream error: ${JSON.stringify(json.error)}`);
        if (json.type === "message_stop") completed = true;
        turn.rawEvents.push({ event, data: json });
        if (json.type === "content_block_start") {
          blockType = json.content_block?.type || "";
          blocks[json.index] = { ...(json.content_block || {}) };
          if (blockType === "tool_use") {
            tools[json.index] = {
              id: json.content_block.id,
              name: json.content_block.name,
              json: "",
            };
          }
        } else if (json.type === "content_block_delta") {
          const d = json.delta || {};
          const blk = blocks[json.index] || (blocks[json.index] = {});
          if (d.type === "thinking_delta" && d.thinking) {
            turn.thinking += d.thinking;
            blk.thinking = String(blk.thinking || "") + d.thinking;
            onChunk("thinking", d.thinking);
          }
          if (d.type === "signature_delta" && d.signature) {
            blk.signature = d.signature;
          }
          if (d.type === "text_delta" && d.text) {
            turn.text += d.text;
            blk.text = String(blk.text || "") + d.text;
            onChunk("text", d.text);
          }
          if (d.type === "input_json_delta" && d.partial_json) {
            const slot = tools[json.index];
            if (slot) slot.json += d.partial_json;
          }
        } else if (json.type === "message_delta") {
          turn.stopReason = json.delta?.stop_reason || turn.stopReason;
          if (json.usage) turn.usage = { ...(turn.usage as object || {}), ...json.usage };
        } else if (json.type === "message_start" && json.message?.usage) {
          turn.usage = json.message.usage;
        }
      }
    }
  }
  if (!completed) throw new Error("Provider stream ended before message_stop. The response is incomplete.");
  for (const [idx, slot] of Object.entries(tools)) {
    let input: Record<string, unknown> = {};
    try {
      input = slot.json ? JSON.parse(slot.json) : {};
    } catch {
      input = { _unparsed: slot.json };
    }
    turn.toolCalls.push({ id: slot.id, name: slot.name, input });
    const blk = blocks[Number(idx)];
    if (blk) {
      blk.type = "tool_use";
      blk.id = slot.id;
      blk.name = slot.name;
      blk.input = input;
    }
  }
  turn.nativeAssistant = Object.keys(blocks)
    .map(Number)
    .sort((a, b) => a - b)
    .map((i) => blocks[i]);
  await log("LLM stream complete", {
    stopReason: turn.stopReason,
    textChars: turn.text.length,
    thinkingChars: turn.thinking.length,
    toolCalls: turn.toolCalls,
    usage: turn.usage,
  });
  return turn;
}

function openaiTools(tools: BoundTool[]) {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.qualified,
      description: `[${t.serverId}] ${t.description}`,
      parameters: t.inputSchema?.type ? t.inputSchema : { type: "object", properties: {} },
    },
  }));
}

function openaiBase(provider: string): string {
  if (provider === "ollama") return `${(process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, "")}/v1`;
  if (provider === "openrouter") return "https://openrouter.ai/api/v1";
  if (provider === "google") return "https://generativelanguage.googleapis.com/v1beta/openai";
  return "https://api.openai.com/v1";
}

async function openaiCompat(opts: {
  settings: LabSettings;
  system: string;
  messages: unknown[];
  tools: BoundTool[];
  onChunk: EmitChunk;
  log: Log;
}): Promise<LlmTurn> {
  const base = openaiBase(opts.settings.provider);
  const url = `${base}/chat/completions`;
  const messages = [
    { role: "system", content: opts.system },
    ...(opts.messages as object[]),
  ];
  const body: Record<string, unknown> = {
    model: opts.settings.model,
    stream: true,
    stream_options: { include_usage: true },
    messages,
  };
  if (opts.tools.length) {
    body.tools = openaiTools(opts.tools);
    body.tool_choice = "auto";
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${opts.settings.apiKey}`,
  };
  if (opts.settings.provider === "openrouter") {
    headers["HTTP-Referer"] = "http://127.0.0.1:4176";
    headers["X-Title"] = "Understanding AI";
  }
  await opts.log("LLM HTTP request", {
    method: "POST",
    url,
    headers: headersForLog(headers),
    body: redact(body),
  });
  const res = await providerFetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  if (!res.ok || !res.body) {
    const errText = await res.text();
    throw new Error(`${opts.settings.provider} ${res.status}: ${errText.slice(0, 800)}`);
  }
  await opts.log("LLM HTTP response opened", { status: res.status, stream: true });
  return readOpenAiStream(res, opts.onChunk, opts.log);
}

async function readOpenAiStream(res: Response, onChunk: EmitChunk, log: Log): Promise<LlmTurn> {
  const turn: LlmTurn = { text: "", thinking: "", toolCalls: [], stopReason: "stop", rawEvents: [], nativeAssistant: null };
  const tools: Record<number, { id: string; name: string; json: string }> = {};
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let completed = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n");
    buf = parts.pop() || "";
    for (const line of parts) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") { completed = true; continue; }
      if (!data) continue;
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json.error) throw new Error(`Provider stream error: ${JSON.stringify(json.error)}`);
      turn.rawEvents.push(json);
      const choice = json.choices?.[0];
      const delta = choice?.delta || {};
      if (delta.content) {
        turn.text += delta.content;
        onChunk("text", delta.content);
      }
      if (delta.reasoning_content) {
        turn.thinking += delta.reasoning_content;
        onChunk("thinking", delta.reasoning_content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!tools[idx]) tools[idx] = { id: tc.id || `call_${idx}`, name: "", json: "" };
          if (tc.id) tools[idx].id = tc.id;
          if (tc.function?.name) tools[idx].name += tc.function.name;
          if (tc.function?.arguments) tools[idx].json += tc.function.arguments;
        }
      }
      if (choice?.finish_reason) turn.stopReason = choice.finish_reason;
      if (json.usage) turn.usage = { ...(turn.usage as object || {}), ...json.usage };
    }
  }
  if (!completed) throw new Error("Provider stream ended before [DONE]. The response is incomplete.");
  for (const slot of Object.values(tools)) {
    let input: Record<string, unknown> = {};
    try {
      input = slot.json ? JSON.parse(slot.json) : {};
    } catch {
      input = { _unparsed: slot.json };
    }
    turn.toolCalls.push({ id: slot.id, name: slot.name, input });
  }
  if (turn.toolCalls.length && (turn.stopReason === "stop" || !turn.stopReason)) {
    turn.stopReason = "tool_calls";
  }
  turn.nativeAssistant = {
    role: "assistant",
    content: turn.text || null,
    tool_calls: turn.toolCalls.length
      ? turn.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.input) },
        }))
      : undefined,
  };
  await log("LLM stream complete", {
    stopReason: turn.stopReason,
    textChars: turn.text.length,
    thinkingChars: turn.thinking.length,
    toolCalls: turn.toolCalls,
    usage: turn.usage,
  });
  return turn;
}

export async function listModels(provider: string, apiKey: string): Promise<string[]> {
  try {
    if (provider === "anthropic") {
      const res = await providerFetch("https://api.anthropic.com/v1/models", {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      });
      if (!res.ok) return [];
      const json = (await res.json()) as { data?: { id: string }[] };
      return (json.data || []).map((m) => m.id);
    }
    const base = openaiBase(provider);
    const res = await providerFetch(`${base}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: { id: string }[] };
    return (json.data || []).map((m) => m.id).slice(0, 80);
  } catch {
    return [];
  }
}

/** Inspect the installed model, rather than guessing capabilities from its name. */
export async function modelCapabilities(settings: LabSettings): Promise<string[] | null> {
  if (settings.provider !== "ollama") return null;
  const base = (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
  const res = await providerFetch(`${base}/api/show`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: settings.model }), signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Cannot inspect Ollama model ${settings.model}: HTTP ${res.status}. Load an installed chat model in Settings.`);
  const data = await res.json() as { capabilities?: string[] };
  if (!Array.isArray(data.capabilities)) throw new Error("Ollama did not report model capabilities. Update Ollama and try again.");
  if (!data.capabilities.includes("completion")) throw new Error(`${settings.model} is not a chat model. Choose a model with completion support.`);
  return data.capabilities;
}
