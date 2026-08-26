/**
 * file session persistence writes one validated JSON document per session.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { validatesession } from "../core/sessions.js";

export function filesessions(root) {
  return {
    async save(session) { const valid = validatesession(session); const path = join(root, `${valid.id}.json`); await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(valid, null, 2)); return valid; },
    async load(id) { const value = JSON.parse(await readFile(join(root, `${id}.json`), "utf8")); return validatesession(value); }
  };
}
