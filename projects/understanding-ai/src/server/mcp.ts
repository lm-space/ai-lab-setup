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
    try {
      const client = new Client({ name: "understanding-ai", version: "0.1.0" });
      if (transportKind === "http") {
        const url = sel.url || preset?.url;
        if (!url) throw new Error(`No URL for MCP ${sel.id}`);
        onLog(`MCP connect (HTTP) ${name}`, { url });
        const headers: Record<string, string> = {};
        if (sel.apiKey) headers.Authorization = `Bearer ${sel.apiKey}`;
        try {
          const t = new StreamableHTTPClientTransport(new URL(url), {
            requestInit: { headers },
          });
          await client.connect(t);
        } catch (err) {
          onLog(`HTTP transport failed, trying legacy SSE for ${name}`, {
            error: String(err),
          });
          const t = new SSEClientTransport(new URL(url), {
            requestInit: { headers },
          });
          const retry = new Client({ name: "understanding-ai", version: "0.1.0" });
          await retry.connect(t);
          handles.push({ id: sel.id, name, client: retry, transport: "http" });
          const listed = await retry.listTools();
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
        await client.connect(t);
      }
      handles.push({ id: sel.id, name, client, transport: transportKind });
      const listed = await client.listTools();
      onLog(`MCP tools/list ${name}`, listed);
      for (const tool of listed.tools) tools.push(bind(sel.id, tool));
    } catch (err) {
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
