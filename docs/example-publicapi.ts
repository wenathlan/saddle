/**
 * public api example with an injected fetcher; no network is required to run it.
 */
import { scrapeurl, formatforagent } from "../operations.js";

const result = await scrapeurl("https://example.com", { fetcher: async () => ({ ok: true, status: 200, text: async () => "<title>Example</title><p>Injected content.</p>" }) });
console.log(JSON.stringify(formatforagent(result), null, 2));
