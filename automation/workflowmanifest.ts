/**
 * workflow manifests describe the same job surface for different forge runtimes.
 */
export const forgeprofiles = Object.freeze(["github", "forgejo", "gitea", "woodpecker", "gitlab"]);

export function workflowmanifest(options = {}) {
  if (!options.name || !options.command) throw new TypeError("workflow manifest requires name and command");
  return {
    name: options.name,
    command: options.command,
    trigger: options.trigger ?? ["manual", "dispatch"],
    inputs: options.inputs ?? {},
    platforms: options.platforms ?? forgeprofiles,
    environment: options.environment ?? {},
    artifacts: options.artifacts ?? ["results/**"],
    timeoutminutes: options.timeoutminutes ?? 30,
    publicrunner: options.publicrunner ?? true
  };
}

export function workflowinputs(manifest) { return { name: manifest.name, command: manifest.command, timeoutminutes: manifest.timeoutminutes, artifacts: manifest.artifacts.join(",") }; }
