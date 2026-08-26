/**
 * platform adapters expose only the operations a bot needs.
 */
export function platformadapter(methods) {
  const required = ["authenticate", "listrepos", "createwebhook", "executebot"];
  for (const name of required) if (typeof methods?.[name] !== "function") throw new TypeError(`platform adapter requires ${name}`);
  return methods;
}
