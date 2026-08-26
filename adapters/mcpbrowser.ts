/**
 * browser MCP tools expose snapshots and actions only through an injected browser adapter.
 */

/** Creates optional browser tools for an MCP server without selecting Playwright or another vendor. */
export function browsertools(browser) {
  if (typeof browser?.snapshot !== "function" || typeof browser?.action !== "function") throw new TypeError("browser MCP tools require snapshot and action");
  return {
    browser_snapshot: async (input = {}) => browser.snapshot(input),
    browser_action: async (input = {}) => browser.action(input)
  };
}
