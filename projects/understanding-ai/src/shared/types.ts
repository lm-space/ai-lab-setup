export type ProviderId = "ollama" | "anthropic" | "openai" | "openrouter" | "google";

export type NodeKind = "compute" | "data" | "model" | "actor" | "store" | "external";

export type FlowNode = {
  id: string;
  label: string;
  sub?: string;
  kind: NodeKind;
  col: number;
  row: number;
};

export type FlowEdge = {
  from: string;
  to: string;
  label: string;
  animated?: boolean;
};

export type FlowSnap = {
  nodes: FlowNode[];
  edges: FlowEdge[];
  active: string[];
};

export type ChatRole = "user" | "assistant" | "system";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  attachments?: { name: string; kind: string }[];
};

export type TraceEvent = {
  id: string;
  t: number;
  seq: number;
  round: number;
  kind: string;
  title: string;
  lane: "parent" | "agent" | "llm" | "mcp" | "kb";
  detail?: string;
  payload?: unknown;
  flow: FlowSnap;
};

export type KbDoc = {
  id: string;
  name: string;
  kind: string;
  family: "markdown" | "pdf" | "word" | "sheet" | "json" | "text";
  label: string;
  parser: string;
  shape: "prose" | "table";
  tools: string[];
  path: string;
  bytes: number;
  chars: number;
  chunks: number;
  createdAt: number;
  preview: string;
};

export type McpPreset = {
  id: string;
  name: string;
  blurb: string;
  needsKey?: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
};

export type McpSelection = {
  id: string;
  enabled: boolean;
  apiKey?: string;
  url?: string;
  command?: string;
  args?: string[];
};

export type LabSettings = {
  provider: ProviderId;
  apiKey: string;
  model: string;
  thinking: boolean;
  maxRounds: number;
  skills?: string[];
  mcps: McpSelection[];
};

export type ChatRecord = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  provider: ProviderId;
  model: string;
  messages: ChatMessage[];
  events: TraceEvent[];
};

export type SseFrame =
  | { type: "event"; event: TraceEvent }
  | { type: "chat"; id: string; role: ChatRole; delta?: string; content?: string; done?: boolean }
  | { type: "done"; chatId?: string; doc?: KbDoc }
  | { type: "error"; message: string };
