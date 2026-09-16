import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
const server = new Server({ name: "understanding-ai-demo", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: "add", description: "Add two numbers accurately using the local demo tool.", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } },
  { name: "echo", description: "Echo a message through the MCP process to demonstrate tool execution.", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } },
] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const args = params.arguments || {};
  let result;
  if (params.name === "add" && typeof args.a === "number" && typeof args.b === "number") result = args.a + args.b;
  else if (params.name === "echo" && typeof args.message === "string") result = args.message;
  else return { isError: true, content: [{ type: "text", text: "Invalid tool or arguments" }] };
  return { content: [{ type: "text", text: JSON.stringify({ result }) }] };
});
await server.connect(new StdioServerTransport());
