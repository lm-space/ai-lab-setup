import Ajv from "ajv";
import type { BoundTool } from "./mcp.ts";
import type { LabSettings } from "../shared/types.ts";
const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false });

export function authorizeTool(tool: BoundTool, args: Record<string, unknown>, settings: LabSettings, callNumber: number) {
  if (callNumber > 32) return { allowed: false, reason: "Run tool-call budget exceeded (32 calls)." };
  if (JSON.stringify(args).length > 16000) return { allowed: false, reason: "Tool arguments exceed the 16,000-character limit." };
  const selected = settings.mcps.find(s => s.id === tool.serverId && s.enabled);
  const localRead = tool.serverId === "kb" && ["search", "list", "read", "table"].includes(tool.name);
  const demo = tool.serverId === "lab-demo" && ["add", "echo"].includes(tool.name) && selected && !selected.url && !selected.command && !selected.args?.length;
  const granted = selected?.allowedTools?.includes(tool.qualified);
  if (!localRead && !demo && !granted) return { allowed: false, reason: "Tool has not been explicitly allowed in Connections. Model requests and MCP annotations cannot grant permission." };
  try {
    const validate = ajv.compile(tool.inputSchema);
    if (!validate(args)) return { allowed: false, reason: `Invalid tool arguments: ${ajv.errorsText(validate.errors)}` };
  } catch { return { allowed: false, reason: "Tool schema cannot be validated; execution denied." }; }
  return { allowed: true, reason: localRead ? "Built-in read-only knowledge tool" : demo ? "Bundled pure demo tool" : "Explicit tool grant from Connections" };
}
