# Saddle Pages deployment

The site is a static React/Vite application rooted directly in this directory. The repository root owns the package manifest and deployment workflows; this directory owns `index.html`, `main.tsx`, components, pages, public assets and `dist/`. Pages deployments use the root script `npm run web:build:pages` so only `web/dist/public` is published.

## GitHub Pages

The root GitHub workflow uses Node.js 26.7.0, configures Pages, runs `npm run web:check`, builds with the caller-configured `SADDLE_PAGES_BASE_PATH` variable or the repository base path returned by `configure-pages`, uploads `web/dist/public` with `actions/upload-pages-artifact@v5.0.0` and deploys it from a dependent `github-pages` environment with `actions/deploy-pages@v5.0.1`. The repository Pages setting must use GitHub Actions as its source. For `wenathlan/saddle`, the public project URL is `https://wenathlan.github.io/saddle/` and the default asset base path is `/saddle/`.

## Retired forge pipelines

The alternate-forge pipelines (GitLab, Forgejo, Codeberg, Gitea and
Woodpecker) were retired in the grand merge: the GitHub Actions workflow
set under `.github/workflows/` is the single CI authority, and the deploy
knowledge for the static web surface lives in this document and in the
repository workflows. The retired forge directories (`.gitlab`,
`.forgejo`, `.gitea`, `.woodpecker`) stay retired — the flat-structure
gate in `tests/workflow.test.ts` enforces their absence on every run. An
operator who still wants a self-managed runner can reproduce the same
static build (`npm run web:build:pages`) on any host; no pipeline file
for those forges ships in this repository anymore.
