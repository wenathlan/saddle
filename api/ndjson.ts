/**
 * ndjson supports append only records and incremental parsing.
 */
import { jsondecode, jsonencode } from "./json.js";

export async function* ndjsonencode(values) { for await (const value of values) yield `${jsonencode(value)}\n`; }

export async function* ndjsondecode(input) {
  let buffer = "";
  for await (const chunk of input) {
    buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) yield jsondecode(line);
  }
  if (buffer.trim()) yield jsondecode(buffer);
}
