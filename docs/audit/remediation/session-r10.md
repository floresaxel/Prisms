# Remediation Session R10 — Sync topology, hardening, docs truth-up, release sign-off

Branch `r10-topology-signoff`, cut from the sequential integration head (`remediation` + R6/R7/R8/R9). Wave 4 (integration finalizer). Findings addressed: **S6-F1/F2/F4** (tier substance, drop `command_results`, publication scope), **S4-F4/F5/F6 + S10-F5** (server hardening), **S3-F7** (`matches` cap), **S2-F2/S6-F5** (additive-schema gate), **S10-F1/F2/F3a** (docs truth-up + isolation test), **S10-F8/D6** (DoF 23 record). Playbook §R10.

## ⚠️ Sequencing note — R5 is NOT done

R10 is "Wave 4, after everything," but **R5 (write-path parity, High S7-F1 offline spawning) was never run** (no `r05` branch; tracker `⬜`). R5 is disjoint from R6/R7/R8 (which only needed R2/R4), so the earlier waves proceeded without it — but R5 is a hard prerequisite for a *complete* release sign-off. R10's own work (topology/hardening/gates/docs) is independent of R5 and is done + verified. **The final `remediation`→`m0-spike` merge is HELD** pending R5 landing (S7-F1) + operator approval; it was not performed.

## What changed

### Topology (`packages/db/sync-streams.yaml`, `infra/postgres/init/02-powersync-publication.sql`)

- **S6-F2 — dropped `command_results`.** It streamed the full 90-day `command_log` (payloads) to every device with no client table to read it; the upload response contract already closes reconciliation. `command_log` is now synced by nothing.
- **S6-F1 — Tier 2 made substantive.** The high-volume tables (`nodes`/`edges`/`schedule_blocks`/`time_entries`/`habit_completions`/`diagram_layouts`) filter `deleted_at IS NULL` in the auto-subscribed tiers, and their soft-deleted tombstones move to the lazily-subscribed `history` tier — so cold-start no longer replicates 90 days of tombstones. **Deferred to Annex A5 (documented in the YAML + SELF_HOSTING):** age-based archival of *live* rows (old closed entries, completed subtrees). PowerSync sync-rule buckets don't re-evaluate a time predicate as rows age (a `now()-interval` filter only bins a row at write time), so that needs a job-maintained `archived` flag + client lazy-subscribe wiring, not a raw time predicate.
- **S6-F4 — scoped publication.** `FOR ALL TABLES` → the explicit 23 synced tables, so auth/session, pg-boss queue, `command_log`, and `command_field_versions` WAL no longer flows to the sync service. Existing deployments get an `ALTER PUBLICATION` upgrade path in SELF_HOSTING.

### Server hardening (`apps/server/src/{env,app,auth}.ts`)

- **S4-F4 + S10-F5 (`env.ts`).** Production now *fails fast* on dev-default secrets (escape hatch `PRISMS_ALLOW_DEV_SECRETS=1`), and when `PS_JWT_K_B64URL` is present it must equal `base64url(POWERSYNC_JWT_SECRET)` or boot fails — otherwise every PowerSync token silently fails validation (app renders, never syncs).
- **S4-F5 (`auth.ts`, `app.ts`).** Explicit better-auth `rateLimit` (on in production, off in test); a dedicated per-user limiter on the heavy endpoints `/api/powersync/token`, `/sync/export`, `/sync/import`.
- **S4-F6 (`app.ts`).** Hono `bodyLimit`: **2 MB** on `/sync/upload`, **32 MB** on `/sync/import` → 413 before buffering.
- **S3-F7 (`packages/core/src/status/predicate.ts`, `rules/validate.ts`, `domain/errors.ts`).** `matches` pattern cap (≤200): rejected at authoring for automation rules (`E_PATTERN_TOO_LONG`) *and* failed-safe to `unknown` at eval time — the latter covers blocker rules + any stored pattern **without touching `dispatcher.ts`** (R10-forbidden; `blocker.create` has no core validator to hook, so the eval-time guard is the ReDoS protection).

### Mechanical gates

- **S2-F2/S6-F5 (`packages/db/test/schema-additive.test.ts` + `schema-baseline.v1.json`).** Derives each domain table's row shape from the Drizzle schema and asserts `isAdditiveSchemaChange` vs a committed per-`ROW_SCHEMA_VERSION` baseline. A breaking change (dropped column, type change, tightened NOT NULL) fails the test; making one is the explicit act of regenerating the baseline (`UPDATE_SCHEMA_BASELINE=1`) + bumping the version.
- **S10-F3a (`apps/server/test/api.integration.test.ts`).** A two-user isolation test: two accounts mint tokens whose `sub` claims are disjoint and which the running PowerSync service accepts → disjoint buckets (the rules scope to `auth.user_id() = sub`, pinned statically in `sync-streams.test.ts`). The full sync-protocol *download-diff* against the booted service stays a staging item (not asserted row-by-row).

### Docs truth-up

- **SECURITY_REVIEW.md (S10-F1):** isolation claim now cites the real static+dynamic tests (not a nonexistent harness assertion); export row = 600k PBKDF2 + mobile-crypto-wired/device-pending; **added** the R9 account-boundary control, the R10 rate/body limits, and boot secret hygiene; checklist rows updated.
- **README.md (S10-F2):** StatusIndex bullet reworded to the *wired* reality — client incremental (R7), server per-batch context cache (R8) — not the unwired primitive.
- **SELF_HOSTING.md:** StatusIndex/verification section truthed up (+ cold-start "not yet measured" note); TLS-termination paragraph (S10-F4); publication `ALTER` upgrade path (S6-F4); D7 client-before-server upgrade note; D4 90-day history-window note.

## Tests

- New: `schema-additive.test.ts` (25 — the additive gate) + `schema-baseline.v1.json`; two-user isolation test in `api.integration.test.ts`; core `matches`-cap tests in `validate.test.ts` (authoring reject + 200-char boundary) and `predicate.test.ts` (eval-time fail-safe). Updated `sync-streams.test.ts` for the dropped `command_results` + tombstone tiering.

## Sign-off evidence (on `r10-topology-signoff` = `remediation` + R6/R7/R8/R9/R10, **missing R5**)

- `pnpm turbo lint typecheck` — **14/14** (2 pre-existing `no-console` warnings in R7/R8 perf tests, not R10).
- `pnpm --filter @prisms/core test` — **559/559** (isolation; +2 S3-F7 tests). `test:coverage` — **90.44 stmts / 94.02 fns / 93.39 lines** (≥90 floor; branches 81.47, not gated).
- `pnpm --filter @prisms/db test` (live PG) — **49/49** (incl. sync-streams parser + additive gate).
- `pnpm --filter @prisms/server test` (live PG) — **125/125**; `api.integration` **14/14** incl. the two-user isolation test hitting the real PowerSync `/sync/stream`; convergence **15/15**.
- `pnpm --filter @prisms/web build` — ✅. ui **84** / web **12** / mobile **3** unchanged (R10 didn't touch them).
- Turbo full `test` flakes on the documented `@prisms/core` fork-worker timeout under 8-way concurrency — passes in isolation (see [[dev-stack-on-this-machine]]).
- e2e (Playwright) = CI / live stack, not run here.

## High-finding status: 5 of 6 closed

S3-F1 `05a3bc6` (R2, server; client mirror = R5) · S3-F2 `3a243c9` (R3) · S7-F2 `a7e7a2b` (R6) · S8-F1 `d8eaecc` (R7) · S9-F1 + S9-F2 `ee02580` (R9). **Outstanding: S7-F1 (offline automation spawning) — R5.**

## Deferred / not done (honest)

- **R5 (S7-F1 High)** — must land before the release merge.
- **100k cold-start sync-down measurement (S6-F1)** — needs a seeded-100k account against a booted stack; method documented in SELF_HOSTING, number to be recorded on staging.
- **Dynamic two-user bucket *content* download-diff** — the token/sub-scoping + service-acceptance half is tested; the row-by-row download parse is a staging soak (sync-protocol harness).
- **Optional prod-compose `docker compose build` CI job** — not added (optional per §R10.5); prod compose stays config-validated.
- **Node-26 dev note (S1-F9 doc half)** — `.nvmrc` pins the supported Node 24; the Node-26 better-sqlite3 rebuild is a dev-box quirk captured in [[dev-stack-on-this-machine]], not a self-hosting concern.

## Integration hand-back (for the operator / R5 runner)

1. Run **R5** (write-path parity). Its R6 handshake (`enqueue(cmd, effects, dependsOn?)`) is already wired.
2. Re-run this R10 sign-off gate on the R5-inclusive head; add the S7-F1 commit to the matrix (`R4`/`V10` client-mirror rows) + AUDIT_PLAN.
3. Catch up the `remediation` label (still at `97038ed`/R6) through R7/R8/R9/R10/R5, then merge `remediation`→`m0-spike`. **Push only on explicit operator say-so.**
