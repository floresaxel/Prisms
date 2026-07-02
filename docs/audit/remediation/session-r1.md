# Remediation Session R1 — Hygiene sweep + spec reconciliation

Branch `r01-hygiene-spec` (cut from `remediation` @ `3e830c5`, the playbook commit). Executed 2026-07-02. **No runtime behavior change** (Dockerfile/nginx affect packaging only).

**Starting state note:** steps 1–4, 5a, 6 (code half), and 10a arrived in this session's working tree already implemented but uncommitted (a prior session's start). Each was re-verified line-by-line against the playbook step and the audit finding it fixes before being adopted; the remaining steps (5b, 6-docs, 7, 8, 9, 10b) were implemented fresh.

## Findings addressed

| Finding | Fix | File(s) |
|---|---|---|
| S1-F1 | turbo `test` task now keys its cache on `PRISMS_DB_TEST_URL` + `PRISMS_POWERSYNC_URL` | `turbo.json` |
| S1-F4 | §15 root aliases: `test:integration`, `test:e2e`, `test:perf`, `build` | `package.json` |
| S1-F2 | web `passWithNoTests: false` (it has real tests); mobile/desktop keep `true` with intent comments | `apps/{web,mobile,desktop}/vitest.config.ts` |
| S1-F3 | `db` removed from web/mobile/desktop boundary allow-lists (server keeps it) | `eslint.config.mjs` |
| S1-F5 | `@types/node` aligned on `^24.13.2` in core/ui/server (db already there); lockfile resynced | 3 manifests + `pnpm-lock.yaml` |
| S1-F9 | `.nvmrc` = 24 (matches CI + prod) | `.nvmrc` |
| S9-F4 | web PowerSync default `:8081` → `:8080` (matches compose); CI e2e port remap + workaround comment deleted; README dev note for machines that remap | `apps/web/src/config.ts`, `.github/workflows/ci.yml`, `README.md` |
| S10-F4 | nginx: `nosniff`, `Referrer-Policy`, SPA/WS/wasm-compatible CSP, HSTS commented with enable-once-TLS note, immutable `/assets/` caching, `no-cache` shell + SW. nginx `add_header`-inheritance quirk handled: security headers repeated in every location that sets its own headers (esp. `index.html`, the document CSP applies to) | `infra/nginx/web.conf` |
| S10-F6 | Dockerfile: 3 stages — `deps` (lockfile-only `pnpm fetch`; cache survives source changes) → `build` (all 7 workspace manifests for `--frozen-lockfile` validation + core/db/server sources, `--offline` filtered install) → `runtime` (server subtree only, no pnpm store). New root `.dockerignore` so COPY layers can't drag host `node_modules` | `apps/server/Dockerfile`, `.dockerignore` |
| S10-F7 | PWA manifest icons (192/512 + maskable-512, generated placeholder prism/P design under `apps/web/public/`), `png` added to the precache glob, `/^\/powersync/` added to `navigateFallbackDenylist` | `apps/web/vite.config.ts`, 3 PNGs |
| S10-F9 | dev-compose stale `TODO(s23)` comment corrected (prod compose is the real deploy) | `docker-compose.yml` |
| restore hardening | `restore.sh` stops the api before `pg_restore` and starts it after (no command applies mid-restore) | `scripts/restore.sh` |

## Spec reconciliation (step 10b — all marked `> Amended post-audit (R1, 2026-07):`)

- **§7.10b (D1 / audit S2-F1):** latest-wins survivor blessed; `superseded`-marker requirement dropped (union spans `min(started_at)` regardless — hours unchanged).
- **§7.10a (D2 / audit S6-F3+S8-F4):** display tiebreak `(sort_order, id)` blessed (total + deterministic → same order on every device); canonical key stays `(sort_order, hlc)`; `layout.renormalize_order` documented maintenance-only.
- **§8 retype (D5 / audit S3-F6):** rejection-only; cascade-plan payload dropped; workaround documented.
- **New §3.3 accepted-deviations table (AD1–AD8):** no `packages/adapters` (S1-F8); no FKs onto `command_log` (S5-F7/S6-F6); export-manifest field omissions (S5-F9); **D4** history window = 90 days (SELF_HOSTING doc half → R10); **D8** `E_NOT_FOUND`/`E_OWNERSHIP` stay distinct (S4-F10).

## Gate evidence

- `pnpm install` — lockfile resynced (1 pkg removed: the @types/node@25 instance), no new downloads.
- `pnpm turbo lint typecheck test` **with `PRISMS_DB_TEST_URL` set + compose PG up** (the run this session makes meaningful):
  ```
  Tasks:    21 successful, 21 total
  Cached:    12 cached, 21 total
  Time:    51.558s
  ```
- Direct integration runs (per §0.3.5 — never trust a cached replay):
  ```
  @prisms/db     Test Files  3 passed (3)   Tests  23 passed (23)
  @prisms/server Test Files 13 passed (13)  Tests 114 passed (114)   (integration suites RAN, 0 skipped)
  ```
- **Flake note:** the first full-gate run failed `core:test → architecture-lint.test.ts` under 7-way vitest concurrency (import phase 118 s); isolated re-run: 15/15 in 2.2 s. This is the known turbo fork-worker contention flake (documented in the audit environment notes), not a regression — the failing test doesn't even exercise the changed allow-list rows.
- `ci.yml` parses as valid YAML (pyyaml check).
- Dockerfile verification: `docker compose -f docker-compose.prod.yml build api` — first attempt failed on compose interpolation (`PS_JWT_K_B64URL :?` is required even for `build`; noted for R10's CI job), re-run with dummy values for the four required secrets: **`prisms-prod-api:latest` built successfully** through all three stages (`deps` fetch → offline filtered install → runtime export; final export 54.7 s).
- `pnpm --filter @prisms/web build` green — PWA generates with the new manifest (32 precache entries incl. icons), `sw.js` + workbox emitted.

## Deviations from the playbook step list (all additive)

1. **`.dockerignore` added** (not explicitly listed): without it, the new stage-scoped `COPY packages/core …` layers would still ingest host `node_modules`; it is load-bearing for S10-F6's goal.
2. **All seven workspace manifests copied in the build stage:** `pnpm install --frozen-lockfile` validates the lockfile against the *entire* workspace project set; copying only the server subtree's manifests fails validation. Manifests-only (no sources) keeps the layer cache-friendly.
3. **nginx headers repeated per-location:** nginx drops server-level `add_header` in any location that sets its own — the naive version would have shipped `index.html` (the actual document) without a CSP.

## Out-of-scope observations (not fixed here)

- `pnpm install` reports 10 deprecated subdependencies (glob@7, rimraf@3, inflight, …) — transitive noise, no action.
- The four `:?`-required prod compose variables make even `build` need secrets; R10 may want a `--build-arg`-style or documented dummy-var invocation for CI prod-build validation (noted for R10's optional CI job).

## Batch-0 decisions consumed

D1 ✅ (spec), D2 ✅ (spec), D4 ✅ (spec half; SELF_HOSTING → R10), D5 ✅ (spec), D8 ✅ (recorded AD5).
