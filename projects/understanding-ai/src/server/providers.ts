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
  if (opts.settings.provider === "anthropic") {
    return anthropic(opts);
  }
  return openaiCompat(opts);
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
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers,
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
          if (json.usage) turn.usage = json.usage;
        } else if (json.type === "message_start" && json.message?.usage) {
          turn.usage = json.message.usage;
        }
      }
    }
  }
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
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
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
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n");
    buf = parts.pop() || "";
    for (const line of parts) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
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
      if (json.usage) turn.usage = json.usage;
    }
  }
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
      const res = await fetch("https://api.anthropic.com/v1/models", {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      });
      if (!res.ok) return [];
      const json = (await res.json()) as { data?: { id: string }[] };
      return (json.data || []).map((m) => m.id);
    }
    const base = openaiBase(provider);
    const res = await fetch(`${base}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: { id: string }[] };
    return (json.data || []).map((m) => m.id).slice(0, 80);
  } catch {
    return [];
  }
}
