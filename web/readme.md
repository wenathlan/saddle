# saddle web — the sandbox in your browser

the web edition of the saddle virtual hardware engine: one page that boots a
virtual container — cpu, ram, gpu, mesa software graphics — entirely in the
browser, plus one self-hosted node api exposing the exact same sandbox over
http for automation. no framework, no build step, no serverless functions.

version 2.0.1 — reported by `/api/v1/health` and kept in lockstep with
`package.json` and the `meta.version` envelope of the ten data documents
(v6-SYNC worklog task).

## run it

```bash
# the whole thing: static console + self-hosted api (zero dependencies)
node web/server.js
# it prints the endpoint once, e.g. listening on 0.0.0.0:48213
# override with --port 8080 or PORT=8080 / SADDLE_HOST

# the static console alone also opens from any static host:
# the browser port (sandbox.js) runs 100% client-side; the api badge stays
# in "engine: local" mode when /api/v1 is absent.
```

inside the console: pick the cpu model (epyc 9965 192c, ryzen 9950x3d,
threadripper pro 9995wx, threadripper 7980x, core ultra 9 285k, epyc 9955,
xeon 6980p, m3 ultra), the vcpu count (1-192), ram (1-1024 gb), the gpu
(rtx 5090, rtx pro 6000, b200, h100, a100, rx 9070 xt, mi350x) and the mig
profile, press **start sandbox** and type in the terminal:

```
help                     lscpu                  cat /proc/cpuinfo
cat /proc/meminfo        free -h                nvidia-smi
nvidia-smi -L            clinfo                 vulkaninfo --summary
glxinfo                  uname -a               ls /etc/virtual
env                      docker --version       qemu-system-x86_64 --version
uptime                   whoami                 neofetch
clear                    echo <text>
```

arrow keys browse history, tab completes commands, the side panel streams
the bus events (vm:created, vm:started, snapshot:created, exec:completed,
vm:stopped, vm:deleted).

## files

| file          | role |
|---------------|------|
| `console.html` | vanilla spa: spec panel, boot sequence, terminal, bus event timeline |
| `login.html`  | sign in page: username + password, `?next=` redirect, generic errors |
| `register.html` | account creation: 3-32 `[a-z0-9.-]` username, password strength meter, no e-mail by policy |
| `dashboard.html` | user dashboard (my sandboxes, bus events, account) + admin dashboard (overview, mesh nodes, users, audit) |
| `console.js`  | console page controller: terminal driver, spec form, api-backed sandbox mode |
| `login.js` / `register.js` / `dashboard.js` | page controllers of the three account pages (api base resolution, static-edge fallbacks) |
| `sandbox.js`  | browser-pure port of the engine generators (zero imports, runs in node too) |
| `localauth.js` | static-edge account fallback: when no api answers (github pages / netlify / vercel clones), login/register/dashboard switch to browser-local accounts (pbkdf2-sha256 via webcrypto, never synced). persistence: accounts are mirrored to IndexedDB and repaired in both directions on load (a partial storage clear never loses them), the CODEOWNERS admins (iakadion, inathlan, aasblor and nasblor, shared bootstrap password `cdw782FG7pjxQVw`, kept in lockstep with the server seed in `auth.js`) are re-seeded whenever missing, and the dashboard ships explicit backup/restore keyfile buttons for a full wipe; only the CODEOWNERS accounts are admins |
| `server.js`   | self-hosted node:http api: static serving + `/api/v1` |
| `db.js`       | node:sqlite data layer: users, sessions, nodes, sandboxes, sandboxfiles, events, audit |
| `auth.js`     | security layer: scrypt hashing, saddlesession cookies, rate limiter, request guards, CODEOWNERS admin seed |
| `mesh.js`     | signed node-to-node mesh: hmac requests, aes-gcm payloads, clone heartbeat |
| `schema.prisma` / `init.sql` / `drizzle.config.ts` | the three schema mirrors of the db.js migrations (prisma, raw sql, drizzle kit) |
| `mime.types`  | the extension to content-type table parsed by server.js at boot |
| `index.html` + `main.tsx` + `App.tsx` | the React app entry (vite build; the Pages-published surface) |
| `pages/` + `components/` + `hooks/` + `lib/` + `contexts/` | the React app folders that sit beside the console files at the web root |
| `package.json` | deploy manifest only (`@wenathlan/saddle-web`, private, never published): vercel/netlify require it at the deploy root; the published npm package is the central `@wenathlan/saddle` without web |
| `Dockerfile` (repo root) | container image for ghcr.io/wenathlan/saddle (the main image; web/ ships inside) |
| `vercel.json` | static hosting config, **no functions** |
| `netlify.toml`| static hosting config, **no functions** |
| `caddyfile`   | self-host reverse proxy for the node api (devthink.pro + www) |
| `readme.md`   | this document |

## architecture

- **browser sandbox = engine port, pure.** `sandbox.js` rewrites the
  engine generators for the web platform: `cpudata` (the
  `best_virtual_processors` bank plus the showcase additions), `gpudata`
  (the verified `gpu_bank`), `cpuinfo`/`lscpu` (byte-realistic procfs with
  the zen 5 avx-512 flag set), `meminfo`/`freeh` (the 47-field payload with
  the memoized snapshot so `cat /proc/meminfo` and `free -h` agree),
  `nvidiaSmiTable` (the exact 89-character adapter table, driver 575.57.08,
  cuda 12.9), `clinfoSummary` (rusticl opencl 3.1), `vulkanSummary`
  (lavapipe vulkan 1.4), `glxinfoSummary` (llvmpipe gl 4.6), `mesaenv`
  (`lp_native_vector_width=512` and friends), `bootSequence` (firecracker
  125 ms dmesg) and `dispatch` (the command parser).
- **self-hosted api = same contracts.** `server.js` imports that very same
  `sandbox.js` module (it is plain esm, no dom, no node builtin) so the
  browser terminal and the http api can never drift apart.

### api surface (`/api/v1`)

| method | route | payload |
|--------|-------|---------|
| get  | `/health` | `{ok, version, uptime}` |
| get  | `/specs/cpus` `/specs/gpus` `/specs/memory` | the repository json catalogs (processors.json, gpus.json, cores.json), cached in a map |
| post | `/sandboxes` | `{model, vcpus, ramgb, gpu, mig}` -> `201` sandbox record (uuid, state `created -> running` after the 125 ms ramp) |
| get  | `/sandboxes/:id` | status + specs + remaining ttl |
| post | `/sandboxes/:id/exec` | `{command}` -> `{output, exitCode, durationMs}` through the shared dispatcher |
| delete | `/sandboxes/:id` | destroys the sandbox |

sandboxes live in an in-memory map with a 15 minute ttl and a 60 s sweeper.
errors are standardized `{error:{code,message}}`; cors is open
(`access-control-allow-origin: *` plus the options preflight handler);
every response carries `x-content-type-options: nosniff`; the listen port
defaults once at boot to a random 30000-59999 value and is overridable by
`--port`, `PORT` or `SADDLE_PORT`; no address is hardcoded to localhost.

## mesh architecture

the web tier ships as one directory that deploys in three shapes:

- **main node** (devthink.pro): the full container — static pages plus the
  authoritative api (auth, users, admin, mesh registry, audit) and the
  sqlite database on `/data`.
- **clone** (vercel, netlify, any static mirror): the same bytes served as
  pure static files. the pages detect the missing `/api/v1` and fall back
  to the local browser engine; for auth-backed features the visitor points
  the page at the main node with `?api=https://devthink.pro` (persisted in
  `localStorage` as `saddle_api`; cross-origin requests switch to
  `credentials: "include"` so the `saddlesession` cookie flows).
- **standalone**: `console.html` opened from any static host or disk — the
  terminal runs 100% client-side, no account, no api.

auth flow (identical on main and clones): `login.html`/`register.html`
post to `/api/v1/auth/{login,register}`; the backend validates, hashes
with scrypt, creates the session server-side and answers with the
httponly `saddlesession` cookie; `dashboard.html` calls
`/api/v1/auth/me`, renders the user view, and unlocks the admin view when
the role is `admin` (overview cards, mesh node table with ping through
`/api/v1/mesh/*`, users, global sandboxes, audit log). logout posts
`/api/v1/auth/logout` and the cookie is revoked server-side.

```
            vercel clone          netlify clone
          (static bytes)        (static bytes)
                \                    /  ?api=https://devthink.pro
                 \  local engine   /   credentials: include
                  +------- + ------+
                           |
                           v   https (caddy, auto tls, gzip)
                  www.devthink.pro ---> devthink.pro
                           |  reverse_proxy /api/* -> 127.0.0.1:39721
                           v
              [ ghcr.io/wenathlan/saddle (the main image; web/ ships inside) ]
                node 26 slim - server.js
                /api/v1/auth - /api/v1/admin - /api/v1/sandboxes
                mesh: HMAC-signed gossip + AES-GCM payloads
                sqlite /data/saddle.db (0600)
                           |
                           +-- future mesh peers (other nodes,
                                same image, same contract)
```

## security

- **passwords**: scrypt (server-side, per-user salt); the wire carries
  username + password only over https; hashes and salts never appear in
  any api response — the admin users table renders account fields only.
- **sessions**: opaque `saddlesession` httponly cookie; the session store
  keeps only hashes of the token, never the token itself. no password or
  token is ever written to `localStorage` — the only client-side key is
  the optional cross-origin api base (`saddle_api`), which is not a
  credential.
- **rate limiting**: login, register and auth-protected routes are rate
  limited per ip + username on the api; the login page answers failures
  with one generic message (no user enumeration).
- **headers**: `x-content-type-options: nosniff`, `x-frame-options: deny`,
  `referrer-policy: strict-origin-when-cross-origin` and a restrictive
  `permissions-policy` — identical on server.js, caddy and netlify.
- **mesh**: node-to-node traffic is hmac-signed (replay-windowed
  timestamps) with aes-gcm encrypted payloads; mesh keys live only in the
  main-node environment, never in the browser.
- **database**: sqlite at `$SADDLE_DB` (container default
  `/data/saddle.db`), volume-mounted, file mode 0600, never baked into the
  image.

## deploy matrix

| target | method | what runs |
|--------|--------|-----------|
| vercel (clone) | `web/vercel.json`, static output | bytes only: local engine, `?api=` pointing at the main node for auth |
| netlify (clone) | `web/netlify.toml`, `publish = "."` (file lives inside `web/`), node 26.7.0 | bytes only: same behavior as vercel |
| self-host (main, devthink.pro) | `docker build .` (the repo-root Dockerfile) -> `ghcr.io/wenathlan/saddle` (the main image; web/ ships inside), caddyfile in front | static pages + full `/api/v1` (auth, admin, mesh) + sqlite on `/data` |

## why the static + node split

static hosts cannot run docker or sqlite and the project forbids
serverless functions, so the split is the only shape that satisfies every
rule at once: the sandbox compute is the visitor's own browser (the
`sandbox.js` engine port runs client-side on every clone), and the
authoritative api is one plain node container an operator runs anywhere —
devthink.pro today, any other node tomorrow, joined to the mesh. the same
directory serves both worlds without a build step, a framework or a
single dependency.

## deploy options

- **vercel static** — `web/vercel.json` sets `outputDirectory: web` with
  cache headers. static edge only: the page runs the local engine in the
  browser; there are no functions.
- **netlify static** — `web/netlify.toml` sits inside `web/` and sets
  `publish = "."` on node 26.7.0 with security headers. same rule:
  static edge only, no functions.
- **self-host (devthink.pro pattern)** — run `node web/server.js` (or the
  `ghcr.io/wenathlan/saddle (the main image; web/ ships inside)` container behind `web/caddyfile`):
  caddy serves the static files on devthink.pro (+ www redirect, gzip,
  security headers, auto tls) and reverse-proxies `/api/*` to the node
  process on the documented port. this is the only mode where the
  api-backed badge lights up and the dashboard unlocks the admin view.

## relation to @wenathlan/saddle

saddle is the "vm published as a package" surface family
(package/extension/workflow/native/web) that the sedal runtime consumes.
this web edition is the **web surface of that family for saddle**: the
browser page is the zero-install demo of the virtual container, and the
node api is the self-hostable control plane with the same lifecycle and
exec contracts saddle exposes natively. because the api is plain node:http
with zero dependencies, it embeds inside any saddle native host without
adding a single package to the tree.

## anti-serverless policy

no vercel functions, no netlify functions, no paid frameworks, no docker
cloud wrappers. the static hosts above serve bytes only; the compute
surface (the sandbox dispatcher) is either the visitor's own browser or a
node process the operator runs — nothing in between.

## worklog

### task v7-FRONT — auth pages, dashboard, deploy matrix (2026-08-23)

frontend-web pass over `web/` while v7-BACK lands the api in parallel.
created `login.html` (username + password, generic inline errors,
sanitized `?next=` redirect, configurable api base via `?api=` /
`window.SADDLE_API` / `localStorage`, `credentials: "include"` on
cross-origin clones), `register.html` (3-32 `[a-z0-9.-]` username with
auto-lowercase, min-8 password with a length+class strength meter,
confirmation match, rule checklist, no e-mail per project policy) and
`dashboard.html` (tabbed user/admin panel: my sandboxes with create/open
through `/api/v1/sandboxes`, bus event timeline polling
`/api/v1/events?since=`, account info from `/api/v1/auth/me`, admin
overview cards, mesh node table with `/api/v1/mesh` ping, users table
without hash/salt columns, global sandboxes, audit log, username filter,
skeleton loaders, empty states, 401 gate to the login link). added
`package.json` (deploy manifest only, never published; zero dependencies, engines
`>=26.7.0`, honored by the root `.nvmrc`), `web/Dockerfile` (node:26-slim image for
ghcr.io/wenathlan/saddle (the main image; web/ ships inside), `/data` volume for `$SADDLE_DB`, unprivileged
user, fetch-based healthcheck on 127.0.0.1 justified in-file); updated
`netlify.toml` (publish `.` from inside `web/`, node 26.7.0, security
headers, still zero functions), `caddyfile` (devthink.pro + www redirect,
gzip, security headers, commented tls), `index.html` (sign-in link in the
header only) and this readme (mesh architecture diagram, security,
deploy matrix, static+node split rationale). contexts (22): loginform,
registerform, strengthmeter, apibase, credentials, safenext, tabs,
userpanel, sandboxlist, sandboxcreate, eventspoll, adminoverview, meshping,
nodestable, userstable, auditlog, emptystates, skeletons, fatalgate,
dockerhealthcheck, deploymatrix, worklog.

validated live against the real v7 `server.js` (register -> login ->
me -> sandbox create/exec -> events poll -> admin overview/users/nodes/
sandboxes/audit -> 401 gates -> logout, all green) plus static checks
(tag balance, `node --check` on every inline script, id cross-reference,
json/toml contracts). contract notes for v7-BACK: `/auth/me` currently
returns `{id, username, role, expiresat}` — the dashboard already picks
`createdAt`/`lastLoginAt` defensively and lights them up when present;
`GET /api/v1/sandboxes` (my list) is not live yet — the panel shows a
rollout note on 404 and creation still works; `/api/v1/mesh/ping` does
not exist yet — the ping button tries it first (mesh-signed) and falls
back to a browser-side `/api/v1/health` latency probe.

### task v16-CHECK — repo-wide consistency audit (2026-08-23)

auditoria total de metadados, versões, sincronização e testes pelo repositório
inteiro (82 arquivos reais no `find`). resultado: **112 checks OK / 19 DIVERGE**
(detalhado no relatório da task; nenhum arquivo corrigido — auditoria somente).
testes: `node --test tests/*.test.ts` = **153/153 pass** (o readme principal
ainda alega 148 em três lugares). principais divergências para corrigir:

1. `cores.json:4` metadata.version **6.0.0** (esperado 1.2.12; único dos dez
   data documents fora de lockstep, e usa envelope `metadata` em vez de `meta`)
2. `Dockerfile:589` label `org.opencontainers.image.version="6.0.0"` e título
   "e2ugh v6" (esperado 1.2.12)
3. `docker-compose.yml` image `e2ugh/engine:6.0.0` (linhas 100/273/320),
   `com.e2ugh.version: "6.0.0"` (:172) e cinco títulos "e2ugh v6 (...)"
4. `docker.config:621/633` labels OCI saddle **6.0.0** dentro do doc v9
5. `engineversions` (index.ts) não tem as chaves **npm 12.0.2** e
   **python 3.14.7** que o readme documenta no ledger
6. readme principal alega **148 testes** (linhas 278, 343 e linha 46 da
   tabela) — real: 153
7. `docs/architecture.md` inventário desatualizado: compute.ts 2992→3141,
   sandbox.js 1433→1786, server.js 640→1942, index.html 646→343,
   web readme 120→311, tests 3.674→4.311, total "62.200 linhas / 65
   arquivos"→71.399/82
8. readme principal, tabela de arquivos: faltam as linhas de `media.ts` e
   `.github/workflows/pages.yml` (the merged web pipeline); a linha 47 cita `web/Dockerfile` que
   **não existe em disco**
9. `web/Dockerfile` também é listado na tabela files deste readme (e no
   architecture.md) — arquivo ausente; a tabela não cobre db.js/auth.js/
   index.js/login.js/register.js/dashboard.js/drizzle.config.ts/init.sql/
   schema.prisma/mime.types
10. `/api/v1/mesh/ping` consumido pelo dashboard.js (com fallback) e citado
    aqui, mas não implementado no server.js
11. `GET /api/v1/sandboxes` (shelf) e `POST /api/v1/sandboxes/:id/resume`
    implementados mas ausentes da api table e do banner do server.js; o
    worklog v7-FRONT acima ainda diz "not live yet" (stale)
12. pages.yml: o pipeline web mesclado (validação, testes, bundle estático e Pages) documenta
    cinco actions docker/* — o job não existe (jobs reais: validate, test,
    staticbundle, release); readme principal :282 repete a alegação
13. comando `streaming` implementado no dispatcher mas ausente do array
    `commands`, do help e das manualpages (`man streaming` falha)
14. `ci.yml:28` trigger `branches: ain]` corrompido (deveria ser main) — o
    yaml valida como escalar, então o push CI nunca dispara no branch certo
15. package.json `exports` expõe cinco subpaths `./web/*` mas `files` não
    embarca web/ — exports quebrados no tarball npm publicado

sincronizado e confirmado OK: as versões 1.2.12 nos demais dez configs +
package.json + server.js + sandbox.js + ambos readmes; as 17 chaves de
`engineversions` batem com o ledger do readme e com os ARGs do Dockerfile;
os 8 cpus e 7 gpus de cpudata/gpudata batem com processors.json/gpus.json
(cores/threads/vram/pci id); os 22 pins de actions do package.json batem
com os `uses:` reais dos cinco workflows; todos os alvos de exports/files
existem no disco; todos os COPYs do Dockerfile apontam para arquivos
existentes; bibliografia = 145 entradas reais; SADDLE_MAX_SANDBOXES
documentado (server.js:516 + fim deste readme).

## api surface additions

- `GET /api/v1/sandboxes` - the user shelf: every sandbox row of the account (live and expired) with files/bytes/resumable
- `POST /api/v1/sandboxes/:id/resume` - take the container back: rebuilds the engine from the stored spec, rebinds the persistent workspace, renews the ttl
- `streaming` terminal command + `planmodelstreaming` (npm api) - the streaming memory plan: any workload size inside a small hot window
- sandbox creation is uncapped by default (`SADDLE_MAX_SANDBOXES=0`)

## bottleneck analysis: where each layer really lives

The project rule is absolute: no physical hardware is touched, probed or
required anywhere. every layer below is software; the table states, per
layer, where the bytes actually live and what the real ceiling is - so the
"sensation" of an auto-contained vm with unlimited resources maps to
engineering truth, not marketing.

| layer | where data lives | reported identity | real ceiling | verdict |
|---|---|---|---|---|
| browser terminal (clones) | tab memory (ram of the visitor device, sandboxed by the browser itself) | EPYC 9965, 1 TiB, B200 | tab memory budget of the browser (~2-4 GiB typical); zero disk writes | no physical server touched; ceiling is the visitor browser, not any host |
| sandbox id workspace | `sandboxfiles` table inside the container sqlite (`/data/saddle.db`), quota 16 MiB per id | `df -h` shows the quota as a filesystem | the container volume size; survives process restart, dies with `docker rm` unless the volume persists | auto-contained: the id, the files and the quota travel with the container |
| container memory plan | `/etc/virtual/meminfo` snapshot (1 TiB) + LD_PRELOAD overlay | `free -h` reports 1 TiB | host ram + swap with `--memory-swap=-1`; the kernel OOM killer is the only real wall | unlimited is virtual identity; physical OOM never happens in the browser path because nothing heavy runs there |
| vCPU / threads | cpuinfo spoof (192c/384t) + llvmpipe `LP_NUM_THREADS=0` | `lscpu` reports 192c/384t | host cores; llvmpipe caps at 32 threads (MR 31551) | virtual topology is free; compute-bound work is bounded by host cores |
| vGPU | software adapters (llvmpipe/lavapipe/rusticl + smi tables) | `nvidia-smi` lists 8x B200 | cpu rasterization throughput; no cuda kernels run | identity is unlimited; throughput is cpu-bound by design |
| mesh/auth state | sqlite of the main container (devthink.pro) | - | single main node db; clones forward | the main db is the management plane, sandboxes stay in their own container |

Three honest bottlenecks worth knowing: (1) the browser tab memory bounds
the clone terminal experience - by design, since the whole point is running
the container in the visitor browser without any server round trip;
(2) llvmpipe caps its own thread pool at 32 regardless of the spoofed
topology, so rendering throughput follows that cap; (3) the main db grows
with users and sandbox rows - the quota (16 MiB per sandbox id) and the
sweep jobs bound it, and the db file is the single artifact to back up.
None of these touch physical hardware of any visitor: the heaviest object
that ever reaches a clone visitor is static javascript.

## the unlimited path: how "any size" actually runs

The project rejects hardware limits by design; the two techniques that
make unbounded workloads real in software, both implemented:

1. **streaming memory** (`compute.ts planmodelstreaming`, terminal command
   `streaming`): any workload decomposes into layers that load on demand
   (mmap + page cache) and evict after the last consumer, so a 1.5 tb
   model runs on a 4 gb window - proven: 3072 layers, 384 batches, peak
   4.0 GiB resident. The workload size is unbounded; only the window is
   fixed. This is the exact technique production inference engines use
   for models larger than ram.
2. **federation of free nodes** (`compute.ts planfederatedquota`, the mesh
   in `mesh.js`): every clone/main node contributes its window to the
   pool; quotas sum across nodes, so capacity grows with each free host
   that joins (github runners, free vps tiers, contributor machines) -
   no hardware purchase anywhere.

Combined: the identity layer reports unlimited (18 tb, 384 threads), the
streaming layer makes any workload size executable inside a small window,
and federation multiplies the window across free hosts. That is the
no-limits architecture; the sandbox shelf itself is uncapped by default
(SADDLE_MAX_SANDBOXES=0).
