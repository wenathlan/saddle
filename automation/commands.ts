/**
 * command parsing keeps the bot surface serializable and platform neutral.
 */
export function parsecommand(input) {
  const tokens = tokenize(String(input ?? ""));
  const command = tokens.shift() ?? "help";
  const flags = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2).toLowerCase();
    const value = tokens[index + 1]?.startsWith("--") ? true : tokens[++index] ?? true;
    flags[key] = value;
  }
  return { command: command.toLowerCase(), flags };
}

function tokenize(input) { return input.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((value) => value.replace(/^"|"$/g, "")) ?? []; }
