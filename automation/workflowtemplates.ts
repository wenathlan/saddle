/**
 * workflow templates use explicit environment names and keep provider secrets external.
 */
import { workflowinputs } from "./workflowmanifest.js";

export function githubworkflow(manifest) {
  const input = workflowinputs(manifest);
  return `name: ${manifest.name}\non:\n  workflow_dispatch:\n    inputs:\n      jobid:\n        required: true\n        type: string\n      command:\n        required: true\n        type: string\n        default: ${manifest.command}\n  repository_dispatch:\n    types: [saddle-job]\npermissions:\n  contents: read\njobs:\n  process:\n    runs-on: ubuntu-latest\n    timeout-minutes: ${input.timeoutminutes}\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 26.7.0\n      - run: npm ci\n      - run: \${{ github.event.inputs.command || '${manifest.command}' }}\n        env:\n          SBOT_JOB_ID: \${{ github.event.inputs.jobid || github.event.client_payload.jobid }}\n      - uses: actions/upload-artifact@v4\n        with:\n          name: saddle-results\n          path: ${manifest.artifacts.join("\n            ")}\n          if-no-files-found: ignore\n`;
}

export function forgejoworkflow(manifest) { return genericworkflow(manifest, "forgejo"); }
export function giteaworkflow(manifest) { return genericworkflow(manifest, "gitea"); }
export function woodpeckerworkflow(manifest) { return `when:\n  - event: push\n  - event: manual\nsteps:\n  process:\n    image: node:26.7.0\n    commands:\n      - npm ci\n      - ${manifest.command}\n`;
}
export function gitlabworkflow(manifest) { return `stages:\n  - process\nprocess:\n  stage: process\n  image: node:26.7.0\n  script:\n    - npm ci\n    - ${manifest.command}\n  artifacts:\n    when: always\n    paths:\n${manifest.artifacts.map((item) => `      - ${item}`).join("\n")}\n`; }

function genericworkflow(manifest, name) { return `name: ${manifest.name}\non:\n  workflow_dispatch:\njobs:\n  process:\n    runs-on: ubuntu-latest\n    timeout-minutes: ${manifest.timeoutminutes}\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 26.7.0\n      - run: npm ci\n      - run: ${manifest.command}\n`;
}
