/**
 * mcp server implements a small JSON RPC tool surface and remains transport agnostic.
 */
import { crawl } from "../scrape/crawl.js";
import { extractwithschema } from "../scrape/schema.js";
import { jsonencode } from "../api/json.js";
import { browsertools } from "./mcpbrowser.js";

export function mcpserver(options = {}) {
  if (typeof options.scrape !== "function") throw new TypeError("mcp server requires scrape");
  const tools = {
    scrape: async (input) => options.scrape(input.url, input),
    crawl: async (input) => crawl(input.url, { ...input, scrape: (url) => options.scrape(url, input) }),
    batch: async (input) => ({ results: await Promise.all((input.urls ?? []).map((url) => options.scrape(url, input))) }),
    extract: async (input) => extractwithschema(input.html, input.schema, input.url),
    serialize: async (input) => jsonencode(input.value),
    ...(options.browser ? browsertools(options.browser) : {}),
    ...(options.tools ?? {})
  };
  return {
    listtools() { return Object.keys(tools).map((name) => ({ name, description: `saddle ${name} tool` })); },
    async handle(request) {
      if (request.method === "tools/list") return { jsonrpc: "2.0", id: request.id, result: { tools: this.listtools() } };
      if (request.method === "tools/call") { const handler = tools[request.params?.name]; if (!handler) return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "tool not found" } }; try { return { jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: JSON.stringify(await handler(request.params.arguments ?? {})) }] } }; } catch (error) { return { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: error.message } }; } }
      return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "method not found" } };
    }
  };
}
