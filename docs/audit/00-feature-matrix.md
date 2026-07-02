# Feature-Compliance Matrix

Central register: intended feature → implementation evidence → audit status. Updated by each session (owner column). Statuses: ✅ verified · 🔎 pending verification · ⚠️ verified with finding(s) · ❌ gap · ➖ not in v1.4 scope.

Baseline: commit `2ab3bf7`, branch `m0-spike`, 2026-07-01.

## Hard requirements (ARCHITECTURE_1.3 §2)

| ID | Requirement (short) | Evidence (coarse) | Status | Owner |
|----|--------------------|-------------------|--------|-------|
| R1 | Platforms: web, Win, macOS, Android, iOS | `apps/web` (Vite/PWA), `apps/desktop` (Tauri v2 = web build), `apps/mobile` (Expo) | 🔎 | S9 |
| R2 | Local SQLite first; UI never waits on network | wa-sqlite/OPFS (web), quick-sqlite (mobile); PowerSync live queries | 🔎 | S7/S8 |
| R3 | Offline operation + multi-device convergence | convergence harness 13 scenarios `apps/server/test/convergence.integration.test.ts` | 🔎 | S5/S10 |
| R4 | Spawning, unblocking, clock-in/out, agenda edits, suggestion accept/reject offline | optimistic effect builders `packages/ui/src/powersync/effects.ts` | 🔎 | S7 |
| R5 | Vanilla Postgres server / vanilla SQLite client | `docker-compose.yml`, `packages/db` | 🔎 | S6 |
| R6 | No arbitrary SQL upload; named commands only | connector loud-guard + envelope upload `packages/ui/src/powersync/{connector,upload-commands}.ts` | 🔎 | S7 |
| R7 | Server improves, never required offline | client-side status/aggregates in core | ✅ (S2+S3: status, aggregates, greedy scheduler all pure/offline-computable; S3-F2 affects correctness of hour values, not offline capability) | S2/S3 |
| R8 | LLM-friendly: strict TS, contracts, pure fns, high core coverage | `tsconfig.base.json` (strict + noUncheckedIndexedAccess), core-purity lint bans (`eslint.config.mjs:132-179`), CI coverage gate ≥90% | ✅ (S1) | S1 |
| R9 | Command history is product data (explain "why") | provenance cols + `explainProvenance` + WhyButton | 🔎 | S4/S8 |
| R10 | Local-first backup/export/import, no managed service | `packages/ui/src/portability/*`, `GET /sync/export`, `POST /sync/import`, `scripts/{backup,restore}.sh` | 🔎 | S5/S8/S10 |
| R11 | Versioned payloads + exports; old clients fail gracefully | `client_too_old` path, export version gate | 🔎 | S4/S8 |
| R12 | Conflicts/rejections → durable review inbox | `sync_review_items` + Review screens (web/mobile) | 🔎 | S4/S9 |
| R13 | Secure storage + optional DB encryption adapters | `packages/ui/src/adapters/{secure-storage,db-encryption}.ts`, `apps/mobile/src/secure-storage.ts` | 🔎 | S8/S9 |
| R14 | Providers behind adapters; nothing leaks into core | core deps = fractional-indexing, rrule, uuid, zod only (`packages/core/package.json:26-31`); zero workspace imports in core src | ✅ (S1, re-check S3) | S1/S3 |
| R15 | Two-layer store: read-only replica + disposable overlay; UI reads merge | `overlay-store.ts`, `data-provider.tsx` merged read | 🔎 | S7 |
| R16 | Synced-row schema versioning separate from command versioning | `schema_version` col, floor check in dispatcher; core primitives (two axes + `isClientTooOld`) ✅ S2 | 🔎 enforcement | S4/S6 |
| R17 | Trust fields server-assigned; client values ignored | dispatcher trust-strip | 🔎 | S4 |
| R18 | Idempotency dedup retained ≥ MAX_OFFLINE_HORIZON (90d) | `retention-purge.ts` dedup guard | 🔎 | S5 |
| R19 | External facts advisory only; never gate/diverge | weather badge display-only; engine ignores weather in convergent outcomes | ⚠️ S3-F1 (High): weather can cause `E_BLOCKED_TASK` rejection; jobs side → S5 | S5/S3 |
| R20 | Import restores data (no replay) + HLC monotonicity | `import-restore.ts` (data-only, FK-ordered), client HLC floor | 🔎 | S5/S8 |

## v1.3 mandatory revisions (§3.2)

| ID | Revision (short) | Status | Owner |
|----|------------------|--------|-------|
| V1 | Split store, rollback drops overlay only | 🔎 | S7 |
| V2 | `command_log.id` == client command id; optimistic provenance matches server | 🔎 | S4+S7 |
| V3 | HLC-order apply; park/reject on missing precondition, linked review item | 🔎 | S4 |
| V4 | Trust fields server-assigned | 🔎 | S4 |
| V5 | Additive-only synced schema; old clients ignore unknown columns | 🔎 (S2-F2: additive guard exists but gates nothing — S6 to enforce) | S6 |
| V6 | Automation template versioning; backstop checks content, raises drift review item | ⚠️ content-comparison half verified in core (S3); `template_version` read-but-never-written (S3-F4); backstop behavior → S5 | S5 |
| V7 | Incremental fact-keyed StatusIndex; no stored status; no full scan | ⚠️ primitive verified + 100k gate (touch<100, ~0.02ms); **unused by any runtime path** (S2-F3, fan-out gaps S2-F4) | S2 |
| V8 | Tier 0/1/2 streams before 100k load test | 🔎 | S6 |
| V9 | LWW default; explicit merges for sort_order + timer intervals | ⚠️ implemented + property-tested; double clock-in survivor rule deviates from §7.10b letter (S2-F1) | S2 |
| V10 | External-fact state never gates rejection/convergence | ⚠️ **S3-F1 High**: dispatcher `E_BLOCKED_TASK` gate consumes weather-derived blocking; automation-condition tension (S3-F8); unknown-weather→unverified correct | S3/S5 |
| V11 | Retention purge never deletes dedup inside horizon | 🔎 | S5 |
| V12 | Import = data restore; encrypted export default on installed targets | 🔎 | S5/S9 |

## Definition of Finished (§16) → owning session

| DoF | Item (short) | Owner |
|-----|--------------|-------|
| 1–3 | all writes via executeCommand; no generic update endpoint; envelopes not row patches | S4, S7 |
| 4–6 | two-layer store; reconcile-to-identical + rollback-to-review; command id end-to-end | S7 |
| 7 | HLC order + causal depends_on | S4 |
| 8–9 | offline feature set; two-device convergence incl. sort_order/double clock-in/mixed schema/external facts | S7, S10 |
| 10–11 | jobs: consistent snapshots, no clobber; client aggregates local-only, server aggregates synced with provenance | S5 |
| 12–14 | suggestion batch lifecycle + stale rejection; soft-delete recreate; FS/SS/FF/SF tested | S3, S5, S6 |
| 15 | command vs schema version enforced at upload + export/import | S4, S8 |
| 16 | incremental status at 100k budget; no stored status column | S2, S10 |
| 17–19 | server-assigned provenance; drift surfaced; durable review inbox | S4, S5, S9 |
| 20 | export/import round-trip guarantees | S5, S8 |
| 21 | secure storage; encrypted-by-default installed export; documented limits | S9 |
| 22 | adapters contain vendors; external facts never gate | S3, S5 |
| 23 | platform smoke tests or documented exception | S9, S10 |

## Annex A recommendations (A1–A8) — NOT adopted into v1.4

Verified S1: `CHANGE_SPEC_v1.0_to_v1.4.md` contains no reference to Annex A; the migration plan (M0–M15) implemented the change-spec only. These are a candidate backlog, to be prioritized in Session 10:

| ID | Feature | Status |
|----|---------|--------|
| A1 | Device registry | ➖ backlog |
| A2 | Clock-skew guard | ➖ backlog |
| A3 | Optimistic mismatch reconciliation (checksum) | ➖ backlog |
| A4 | Command queue crash recovery | ➖ backlog |
| A5 | Command-history compaction/redaction | ➖ backlog |
| A6 | Import modes (merge/replace) | ➖ backlog |
| A7 | Local-first search & derived indexes | ➖ backlog |
| A8 | Sync/debug diagnostics screen | ➖ backlog |

## Structural conformance (§5 stack, §6 layout) — Session 1 verdicts

| Item | Verdict |
|------|---------|
| Stack table §5 (TS strict, pnpm+turbo, Vite/React, Tauri v2, Expo, PowerSync Sync Streams, PG, Hono, Drizzle, Zod-in-core, pg-boss, Better Auth, React Flow, elkjs, rrule, Zustand, Vitest/fast-check/Playwright) | ✅ all present in manifests; runtime checks in later sessions |
| §6 layout | ⚠️ matches except `packages/adapters` does not exist — ports live in `packages/ui/src/adapters/` (accepted deviation, see S1-F8) |
| §6 dependency rules via lint | ⚠️ enforced by eslint-plugin-boundaries, but web/mobile/desktop are over-permitted to import `db` (S1-F3) |
| §15 verification commands | ⚠️ equivalents exist but several lack root aliases (S1-F4) |
