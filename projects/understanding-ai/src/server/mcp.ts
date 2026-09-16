import { tracedFetch, tracedOperation } from "./trace.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { MCP_PRESETS } from "./catalog.ts";
import type { McpSelection } from "../shared/types.ts";

export type BoundTool = {
  qualified: string;
  serverId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type McpHandle = {
  id: string;
  name: string;
  client: Client;
  transport: "stdio" | "http";
};

function presetOf(sel: McpSelection) {
  return MCP_PRESETS.find((p) => p.id === sel.id);
}

export async function connectMcps(
  selections: McpSelection[],
  onLog: (title: string, payload: unknown) => void,
): Promise<{ handles: McpHandle[]; tools: BoundTool[] }> {
  const handles: McpHandle[] = [];
  const tools: BoundTool[] = [];

  for (const sel of selections.filter((s) => s.enabled)) {
    const preset = presetOf(sel);
    const name = preset?.name ?? sel.id;
    const transportKind = sel.url ? "http" : (preset?.transport ?? (sel.command ? "stdio" : "http"));
    const clients: Client[] = [];
    try {
      const client = new Client({ name: "understanding-ai", version: "0.1.0" });
      clients.push(client);
      if (transportKind === "http") {
        const url = sel.url || preset?.url;
        if (!url) throw new Error(`No URL for MCP ${sel.id}`);
        onLog(`MCP connect (HTTP) ${name}`, { url });
        const headers: Record<string, string> = {};
        if (sel.apiKey) headers.Authorization = `Bearer ${sel.apiKey}`;
        try {
          const t = new StreamableHTTPClientTransport(new URL(url), {
            requestInit: { headers },
            fetch: tracedFetch("external"),
          });
          await tracedOperation(`MCP connect ${name}`, { transport: transportKind }, { category: "tools", callType: transportKind === "http" ? "external" : "local", target: name }, () => client.connect(t, { timeout: 15000 }));
        } catch (err) {
          await client.close().catch(() => {});
          onLog(`HTTP transport failed, trying legacy SSE for ${name}`, {
            error: String(err),
          });
          const t = new SSEClientTransport(new URL(url), {
            requestInit: { headers },
            fetch: tracedFetch("external"),
          });
          const retry = new Client({ name: "understanding-ai", version: "0.1.0" });
          clients.push(retry);
          await tracedOperation(`MCP connect ${name} (SSE)`, {}, { category: "tools", callType: "external", target: name }, () => retry.connect(t, { timeout: 15000 }));
          handles.push({ id: sel.id, name, client: retry, transport: "http" });
          const listed = await tracedOperation(`MCP tools/list ${name}`, {}, { category: "tools", callType: "external", target: name }, () => retry.listTools());
          for (const tool of listed.tools) {
            tools.push(bind(sel.id, tool));
          }
          onLog(`MCP tools/list ${name}`, listed);
          continue;
        }
      } else {
        const command = sel.command || preset?.command || "npx";
        const args = sel.args?.length ? sel.args : preset?.args || [];
        onLog(`MCP connect (stdio) ${name}`, { command, args });
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) {
          if (typeof v === "string") env[k] = v;
        }
        if (sel.apiKey) env.API_KEY = sel.apiKey;
        const t = new StdioClientTransport({ command, args, env, stderr: "pipe" });
        await tracedOperation(`MCP connect ${name}`, { transport: transportKind }, { category: "tools", callType: "local", target: name }, () => client.connect(t, { timeout: 15000 }));
      }
      handles.push({ id: sel.id, name, client, transport: transportKind });
      const listed = await tracedOperation(`MCP tools/list ${name}`, {}, { category: "tools", callType: transportKind === "http" ? "external" : "local", target: name }, () => client.listTools());
      onLog(`MCP tools/list ${name}`, listed);
      for (const tool of listed.tools) tools.push(bind(sel.id, tool));
    } catch (err) {
      for (const client of clients) await client.close().catch(() => {});
      const index = handles.findIndex((handle) => handle.id === sel.id);
      if (index >= 0) handles.splice(index, 1);
      onLog(`MCP connect failed: ${name}`, { error: String(err) });
    }
  }

  return { handles, tools };
}

function bind(serverId: string, tool: { name: string; description?: string; inputSchema?: unknown }): BoundTool {
  const qualified = `${serverId}__${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  return {
    qualified,
    serverId,
    name: tool.name,
    description: tool.description || tool.name,
    inputSchema: (tool.inputSchema as Record<string, unknown>) || { type: "object" },
  };
}

export async function callMcp(
  handles: McpHandle[],
  tools: BoundTool[],
  qualified: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const meta = tools.find((t) => t.qualified === qualified);
  if (!meta) throw new Error(`Unknown tool ${qualified}`);
  const handle = handles.find((h) => h.id === meta.serverId);
  if (!handle) throw new Error(`MCP ${meta.serverId} is not connected`);
  const result = await handle.client.callTool({ name: meta.name, arguments: args });
  return result;
}

export async function closeMcps(handles: McpHandle[]) {
  for (const h of handles) {
    try {
      await h.client.close();
    } catch {
      /* ignore */
    }
  }
}
