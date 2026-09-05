/**
 * server.ts — the Node HTTP server surface.
 *
 * This file is the v2.0.0 grand-merge consolidation of the former nested
 * folders of the repository (server) into the single
 * root-level domain file of the saddle family standard: one optimized
 * TypeScript file per correlated domain, ordinal sections, JSDoc on every
 * block, intra-domain imports dissolved, cross-domain imports rewritten to
 * ./<domain>.js. Every capability of every source file is preserved here;
 * the pure re-export barrels (none in this domain) folded their surface into this file directly.
 */

import { createServer } from "node:http";

/* ════════════════════════════════════════════════════════════════════ */
/* Section 1: server/node.ts — node server is an optional adapter around the universal service contract. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * node server is an optional adapter around the universal service contract.
 */

/** Creates a Node HTTP adapter with explicit host, port, and request handler. */
export function nodeserver(options = {}) {
  if (!options.host || !Number.isInteger(options.port) || options.port < 1) throw new TypeError("node server requires host and port");
  if (typeof options.handle !== "function") throw new TypeError("node server requires handle");
  /* Request translation stays inside the Node adapter. */
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString("utf8");
      const headers = new Headers(request.headers);
      const webrequest = new Request(new URL(request.url ?? "/", `http://${options.host}:${options.port}`), { method: request.method, headers, body: body || undefined });
      const result = await options.handle(webrequest);
      response.statusCode = result.status;
      result.headers.forEach((value, key) => response.setHeader(key, value));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      response.statusCode = 500;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  /* Lifecycle methods keep the server optional for library consumers. */
  return {
    server,
    listen() { return new Promise((resolve, reject) => { server.once("error", reject); server.listen(options.port, options.host, () => resolve({ host: options.host, port: options.port })); }); },
    close() { return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  };
}
