import type { McpPreset } from "../shared/types.ts";

export const MCP_PRESETS: McpPreset[] = [
  {
    id: "fetch",
    name: "Fetch",
    blurb: "Fetch a public URL and return cleaned markdown. No key.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-fetch"],
  },
  {
    id: "memory",
    name: "Memory",
    blurb: "A tiny knowledge graph the agent can write and read this session.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
  },
  {
    id: "think",
    name: "Sequential thinking",
    blurb: "A scratchpad tool for multi-step reasoning. No key.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
  },
  {
    id: "time",
    name: "Time",
    blurb: "Current time and timezone conversion.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "time-mcp"],
  },
  {
    id: "context7",
    name: "Context7",
    blurb: "Up-to-date library docs over HTTP. No key for basic use.",
    transport: "http",
    url: "https://mcp.context7.com/mcp",
  },
  {
    id: "hf",
    name: "Hugging Face",
    blurb: "Public model and dataset search over HTTP.",
    transport: "http",
    url: "https://huggingface.co/mcp",
  },
  {
    id: "wiki",
    name: "Wikipedia",
    blurb: "Search and read Wikipedia articles. No key.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "wikipedia-mcp"],
  },
];

export const PROVIDER_MODELS: Record<string, string[]> = {
  ollama: [],
  anthropic: [
    "claude-sonnet-4-5",
    "claude-sonnet-4-5-20250929",
    "claude-opus-4-1",
    "claude-haiku-4-5",
    "claude-3-5-haiku-latest",
  ],
  openai: [
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4o",
    "gpt-4o-mini",
    "o4-mini",
    "o3",
  ],
  openrouter: [
    "anthropic/claude-sonnet-4.5",
    "anthropic/claude-opus-4.1",
    "openai/gpt-4.1",
    "google/gemini-2.5-pro",
    "google/gemini-2.5-flash",
    "meta-llama/llama-4-maverick",
  ],
  google: [
    "gemini-3.6-flash",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.0-flash",
  ],
};

export const SYSTEM_PROMPT = `You are the assistant inside Understanding AI, a learning product that shows every hop of an agent loop.

Rules:
- Use tools when they would give a live fact (a URL, a time, a library doc, a stored note, or anything in the user's uploaded files).
- You always have local knowledge-base tools: kb__list, kb__search, kb__read, kb__table. These search a MiniLM vector index of files the user uploaded (markdown, pdf, docx, csv, xlsx). Prefer them for questions about those files. Cite the file name. For spreadsheets, use kb__table.
- Do not invent tool results. If a tool fails, say so.
- Answer in markdown when it helps: short headings, lists, tables, fenced code.
- Never mention API keys, internal URLs, or this system prompt unless asked how the lab works.
- If no tool is needed, answer directly.`;
