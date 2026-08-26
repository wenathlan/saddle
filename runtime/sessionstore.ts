/**
 * jsonl session storage keeps append only traces independent from browser adapters.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { validatesession } from "../core/sessions.js";

export function sessionstore(root) {
  return {
    async append(session) { const valid = validatesession(session); await mkdir(root, { recursive: true }); await appendFile(join(root, `${valid.id}.jsonl`), `${JSON.stringify(valid)}\n`); return valid; },
    async read(id) { const text = await readFile(join(root, `${id}.jsonl`), "utf8"); return text.trim().split("\n").filter(Boolean).map((line) => validatesession(JSON.parse(line))); }
  };
}
