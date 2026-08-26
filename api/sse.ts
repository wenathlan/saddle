/**
 * sse helpers encode typed events without requiring a web framework.
 */
import { jsondecode, jsonencode } from "./json.js";

export function sseencode(event) {
  const lines = [];
  if (event.id !== undefined) lines.push(`id: ${event.id}`);
  if (event.event) lines.push(`event: ${event.event}`);
  for (const line of jsonencode(event.data ?? {}).split("\n")) lines.push(`data: ${line}`);
  return `${lines.join("\n")}\n\n`;
}

export function ssedecode(chunk) {
  const fields = {};
  for (const line of String(chunk).split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index < 0) continue;
    fields[line.slice(0, index)] = line.slice(index + 1).trimStart();
  }
  return { id: fields.id, event: fields.event, data: fields.data ? jsondecode(fields.data) : undefined };
}
