/**
 * mcp transport keeps JSON RPC framing separate from the tool server.
 */
import { jsondecode, jsonencode } from "../api/json.js";

/** Creates JSONL and HTTP handlers for the transport agnostic MCP server. */
export function mcptransport(server) {
  if (typeof server?.handle !== "function") throw new TypeError("mcp transport requires server");
  return {
    async handleline(line) { const request = jsondecode(line); return jsonencode(await server.handle(request)); },
    async *stream(lines) { for await (const line of lines) if (String(line).trim()) yield await this.handleline(line); },
    async handlehttp(request) { const body = await request.text(); const response = await server.handle(jsondecode(body)); return new Response(jsonencode(response), { status: 200, headers: { "content-type": "application/json" } }); }
  };
}
