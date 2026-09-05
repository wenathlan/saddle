/**
 * intelligence.ts — AI planning, provenance, retrieval and observable metrics.
 *
 * This file is the v2.0.0 grand-merge consolidation of the former nested
 * folders of the repository (ai) into the single
 * root-level domain file of the e2ugh family standard: one optimized
 * TypeScript file per correlated domain, ordinal sections, JSDoc on every
 * block, intra-domain imports dissolved, cross-domain imports rewritten to
 * ./<domain>.js. Every capability of every source file is preserved here;
 * the pure re-export barrels (none in this domain) folded their surface into this file directly.
 */



/* ════════════════════════════════════════════════════════════════════ */
/* Section 1: ai/provenance.ts — context provenance links retrieved chunks to source, query and transformation metadata. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * context provenance links retrieved chunks to source, query and transformation metadata.
 */

/** Creates a serializable retrieval record for an agent context result. */
export function provenance(input = {}) {
  if (!input.source && !input.sourceurl) throw new TypeError("provenance requires a source");
  return { version: 1, source: input.source ?? input.sourceurl, sourceurl: input.sourceurl, documentid: input.documentid, query: input.query, retrievedat: Number(input.retrievedat ?? Date.now()), chunks: Array.isArray(input.chunks) ? input.chunks.map((chunk, index) => ({ id: String(chunk.id ?? index), contenthash: chunk.contenthash, score: chunk.score === undefined ? undefined : Number(chunk.score), headingpath: chunk.headingpath, tokencount: chunk.tokencount, citation: chunk.citation ?? input.sourceurl })) : [], metadata: { ...(input.metadata ?? {}) } };
}

/** Merges provenance records while deduplicating chunk identifiers. */
export function mergeprovenance(records = []) {
  const valid = records.filter(Boolean);
  const chunks = [];
  const seen = new Set();
  for (const record of valid) for (const chunk of record.chunks ?? []) { const key = `${record.documentid ?? record.source}:${chunk.id}`; if (seen.has(key)) continue; seen.add(key); chunks.push({ ...chunk, source: record.source, documentid: record.documentid }); }
  return { version: 1, sources: [...new Set(valid.map((record) => record.source))], chunks, mergedat: Date.now() };
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 2: ai/tokens.ts — token helpers use configurable model ratios and never require a provider tokenizer. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * token helpers use configurable model ratios and never require a provider tokenizer.
 */
const ratios = Object.freeze({ default: 4, gpt: 3.5, claude: 3.2, gemini: 3.5 });

export function estimatetokens(text, model = "default") { const ratio = ratios[model] ?? ratios.default; return Math.ceil(String(text ?? "").length / ratio); }
export function fitscontext(text, context, model = "default") { return estimatetokens(text, model) <= context; }
export function tokenbudget(text, options = {}) { const tokens = estimatetokens(text, options.model); return { tokens, context: options.context ?? null, fits: options.context == null ? true : tokens <= options.context, remaining: options.context == null ? null : Math.max(0, options.context - tokens) }; }
export function settokenratios(values = {}) { Object.assign(ratios, values); return { ...ratios }; }

/* ════════════════════════════════════════════════════════════════════ */
/* Section 3: ai/chunk.ts — markdown chunking preserves heading paths and uses paragraph boundaries before hard cuts. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * markdown chunking preserves heading paths and uses paragraph boundaries before hard cuts.
 */

export function chunkmarkdown(markdown, options = {}) {
  const maxtokens = options.maxtokens ?? 512;
  const overlap = options.overlaptokens ?? 50;
  const lines = String(markdown ?? "").split(/\r?\n/);
  const chunks = [];
  let headingpath = [];
  let buffer = [];
  function flush() { if (!buffer.length) return; const content = buffer.join("\n").trim(); if (content) chunks.push({ content, headingpath: [...headingpath], tokencount: estimatetokens(content, options.model) }); buffer = []; }
  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) { flush(); const level = heading[1].length; headingpath = headingpath.slice(0, level - 1); headingpath[level - 1] = heading[2].trim(); buffer.push(line); continue; }
    buffer.push(line);
    if (estimatetokens(buffer.join("\n"), options.model) > maxtokens) { const last = buffer.pop(); flush(); const overlaptext = buffer.slice(-overlap).join("\n"); buffer = overlaptext ? [overlaptext, last] : [last]; }
  }
  flush();
  return chunks.map((chunk, index) => ({ ...chunk, id: `chunk${index}` }));
}

/* ════════════════════════════════════════════════════════════════════ */
/* Section 4: ai/rag.ts — rag manifests connect chunks to embedding stores without forcing a vendor client. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * rag manifests connect chunks to embedding stores without forcing a vendor client.
 */
export async function ragmanifest(input = {}) {
  const chunks = input.chunks ?? [];
  const unique = [];
  const hashes = new Set();
  for (const chunk of chunks) { const hash = await hashtext(chunk.content); if (hashes.has(hash)) continue; hashes.add(hash); unique.push({ ...chunk, contenthash: hash, documentid: hash.slice(0, 16), metadata: { ...(input.metadata ?? {}), ...(chunk.metadata ?? {}) } }); }
  return { documentid: (await hashtext(input.source ?? unique.map((chunk) => chunk.content).join("\n"))).slice(0, 16), source: input.source, chunks: unique, embeddingmodel: input.embeddingmodel, embeddingdimensions: input.embeddingdimensions, createdat: Date.now() };
}

export function vectorrecord(chunk, vector, options = {}) { return { id: `${chunk.documentid}-${chunk.id}`, vector, metadata: { headingpath: chunk.headingpath, contenthash: chunk.contenthash, sourceurl: options.sourceurl, tokencount: chunk.tokencount, contenttype: options.contenttype ?? "text", language: options.language ?? "en", embeddingmodel: options.embeddingmodel, embeddingdimensions: vector?.length } }; }

async function hashtext(text) { const bytes = new TextEncoder().encode(String(text)); if (globalThis.crypto?.subtle) { const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes); return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join(""); } return Array.from(bytes).map((value) => value.toString(16).padStart(2, "0")).join("").slice(0, 64).padEnd(64, "0"); }

/* ════════════════════════════════════════════════════════════════════ */
/* Section 5: ai/llmstxt.ts — llms text generation creates compact absolute links for agent consumption. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * llms text generation creates compact absolute links for agent consumption.
 */
export function llmstxt(options = {}) {
  const title = options.title ?? "saddle";
  const description = options.description ?? "binary computing engine and browser automation library";
  const pages = (options.pages ?? []).filter((page) => page?.url && /^https:\/\//.test(page.url)).slice(0, options.limit ?? 100);
  const lines = [`# ${title}`, `> ${description}`, "", "## pages", "", ...pages.map((page) => `- [${page.title ?? page.url}](${page.url}): ${(page.description ?? "").slice(0, 100)}`)];
  return `${lines.join("\n")}\n`;
}

export function llmsfull(options = {}) { return (options.pages ?? []).filter((page) => page?.url && /^https:\/\//.test(page.url)).map((page) => `# ${page.title ?? page.url}\n\nsource: ${page.url}\n\n${page.content ?? ""}`).join("\n\n---\n\n"); }

/* ════════════════════════════════════════════════════════════════════ */
/* Section 6: ai/metrics.ts — metrics keeps low-cardinality counters and durations without requiring a telemetry vendor. */
/* ════════════════════════════════════════════════════════════════════ */
/**
 * metrics keeps low-cardinality counters and durations without requiring a telemetry vendor.
 */

/** Creates an in-memory metric collector with bounded names and labels. */
export function metricstore(options = {}) {
  const maxnames = Number(options.maxnames ?? 256);
  const values = new Map();
  const durations = new Map();
  function key(name, labels = {}) { const sorted = Object.entries(labels).slice(0, 8).sort(([left], [right]) => left.localeCompare(right)); return `${String(name)}|${JSON.stringify(sorted)}`; }
  function count(name, amount = 1, labels = {}) { if (values.size >= maxnames && !values.has(key(name, labels))) throw new Error("metric cardinality limit reached"); const metric = key(name, labels); values.set(metric, (values.get(metric) ?? 0) + Number(amount)); return values.get(metric); }
  function observe(name, milliseconds, labels = {}) { const metric = key(name, labels); const list = durations.get(metric) ?? []; if (list.length < 1000) list.push(Number(milliseconds)); durations.set(metric, list); return Number(milliseconds); }
  function snapshot() { return { counters: Object.fromEntries(values), durations: Object.fromEntries([...durations].map(([name, list]) => [name, { count: list.length, total: list.reduce((sum, value) => sum + value, 0), max: Math.max(0, ...list) }])) }; }
  function reset() { values.clear(); durations.clear(); }
  return { count, observe, snapshot, reset };
}
