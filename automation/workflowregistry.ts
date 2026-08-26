/**
 * workflow registry stores generated manifests and templates for later dispatch.
 */
import { forgeprofiles } from "./workflowmanifest.js";
import { forgejoworkflow, giteaworkflow, githubworkflow, gitlabworkflow, woodpeckerworkflow } from "./workflowtemplates.js";

export function workflowregistry() {
  const manifests = new Map();
  const renderers = { github: githubworkflow, forgejo: forgejoworkflow, gitea: giteaworkflow, woodpecker: woodpeckerworkflow, gitlab: gitlabworkflow };
  return {
    register(manifest) { manifests.set(manifest.name, manifest); return manifest; },
    get(name) { return manifests.get(name) ?? null; },
    render(name, forge) { if (!renderers[forge] || !forgeprofiles.includes(forge)) throw new TypeError(`unsupported forge: ${forge}`); const manifest = manifests.get(name); if (!manifest) throw new Error(`workflow not found: ${name}`); return renderers[forge](manifest); },
    list() { return [...manifests.values()]; }
  };
}
