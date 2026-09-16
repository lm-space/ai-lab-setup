import type { TraceCategory, TraceEvent } from "./types";
export function categoryOf(event: TraceEvent): TraceCategory {
  if (event.category) return event.category;
  if (event.lane === "parent" || event.lane === "user-app") return "user-app";
  if (event.kind.startsWith("kb_")) return "knowledge";
  if (event.kind.startsWith("tool_") || event.kind.startsWith("mcp_")) return "tools";
  return "agent";
}
export function explanationOf(event: TraceEvent): string {
  const category = categoryOf(event);
  if (category === "network") return `${event.callType === "ai-provider" ? "Model provider traffic" : event.callType === "local" ? "User App and local API traffic" : "External connection traffic"}. Request, headers and body completion share a correlation ID. Duration on completion includes body consumption.`;
  if (event.kind === "tool_use") return "The model requested a tool. This is a request for action; execution happens in a separate harness step.";
  if (event.kind === "tool_results_appended") return "The harness adds tool outputs to the conversation and sends them back to the model for the next round.";
  if (category === "tools") return "Tool discovery or execution performed by the harness. Local stdio is process communication, not an HTTP request. Related network requests carry the initiating operation ID.";
  if (category === "knowledge") return "Local content processing: parsing, chunking, embedding, vector storage or retrieval. The index is a JSON-backed cosine vector index, not a remote vector database.";
  return "An observable agent/runtime step: preparing context, processing model output, controlling the loop or saving history. This is not private model reasoning.";
}
