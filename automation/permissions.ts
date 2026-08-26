/**
 * command permissions keep bot actions explicit and platform neutral.
 */

/** Creates a command guard from caller supplied command and scope policies. */
export function commandguard(options = {}) {
  const policies = options.policies ?? {};
  function check(input = {}) {
    const command = String(input.command ?? "");
    const policy = policies[command] ?? { scopes: [] };
    const scopes = input.scopes ?? [];
    const missing = (policy.scopes ?? []).filter((scope) => !scopes.includes(scope));
    return { allowed: missing.length === 0, command, missing, platform: input.platform };
  }
  return { check };
}
