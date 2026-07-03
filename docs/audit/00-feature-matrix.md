# Feature-Compliance Matrix

Central register: intended feature → implementation evidence → audit status. Updated by each session (owner column). Statuses: ✅ verified · 🔎 pending verification · ⚠️ verified with finding(s) · ❌ gap · ➖ not in v1.4 scope.

Baseline: commit `2ab3bf7`, branch `m0-spike`, 2026-07-01.

**FINAL (Synthesis, 2026-07-02):** all 10 sessions complete. R1–R20: **12 ✅ · 8 ⚠️ · 0 ❌** · V1–V12: **6 ✅ · 6 ⚠️** · DoF 1–23: **12 ✅ · 11 ⚠️ · 0 ❌**. Findings: **0 Critical · 6 High** (all re-verified at synthesis) · consolidated register + remediation backlog in [FINAL_REPORT.md](FINAL_REPORT.md).

**REMEDIATION (R1–R10, 2026-07-03; see [AUDIT_PLAN.md](AUDIT_PLAN.md) → Remediation).** 5 of 6 High findings closed with commits: S3-F1 `05a3bc6` (R2) · S3-F2 `3a243c9` (R3) · S7-F2 `a7e7a2b` (R6) · S8-F1 `d8eaecc` (R7) · S9-F1 + S9-F2 `ee02580` (R9). **Outstanding: S7-F1 offline spawning (R5 not done).** R10 `r10-topology-signoff`: V8 tier substance + `command_results` dropped + scoped publication, server hardening (S4-F4/F5/F6, S3-F7, S10-F5), the additive-schema gate (S2-F2) and two-user isolation test (S10-F3a), docs truth-up. Rows below re-verdicted where a fix flipped them.

## Hard requirements (ARCHITECTURE_1.3 §2)

| ID | Requirement (short) | Evidence (coarse) | Status | Owner |
|----|--------------------|-------------------|--------|-------|
| R1 | Platforms: web, Win, macOS, Android, iOS | `apps/web` (Vite/PWA), `apps/desktop` (Tauri v2 = web build), `apps/mobile` (Expo) | ⚠️→ **R9 `ee02580`**: React pairing fixed (mobile pinned to Expo 53's 19.0.0 + metro dedup, S9-F3), mobile crypto wired (S9-F2); expo-doctor accepts react@19.0.0. Runtime device run still BLOCKED (no emulator) — DoF 23 exception stands, acceptance = operator (D6/S10-F8) | S9/S10 → R9 |
| R2 | Local SQLite first; UI never waits on network | wa-sqlite/OPFS (web), quick-sqlite (mobile); PowerSync live queries | ✅ S8 (provider + SWR reads all local; hydration gating prevents network-wait UX); app sweep → S9 | S7/S8 |
| R3 | Offline operation + multi-device convergence | convergence harness 13 scenarios `apps/server/test/convergence.integration.test.ts` | ✅ S10: all 13 scenarios green vs live Postgres (114/114 server integration); every §15-named scenario present; assertion-depth caveats S10-F3 | S5/S10 |
| R4 | Spawning, unblocking, clock-in/out, agenda edits, suggestion accept/reject offline | optimistic effect builders `packages/ui/src/powersync/effects.ts` | ⚠️ **S7-F1 High: offline spawning does not exist** (no client rules engine); soft-delete closure degraded (S7-F7); other verbs ✅ | S7 |
| R5 | Vanilla Postgres server / vanilla SQLite client | `docker-compose.yml`, `packages/db` | ✅ S6 (vanilla PG + `wal_level=logical`; PowerSync loose SQLite schema client-side) | S6 |
| R6 | No arbitrary SQL upload; named commands only | connector loud-guard + envelope upload `packages/ui/src/powersync/{connector,upload-commands}.ts` | ✅ end-to-end (S4 no generic endpoint + S7 loud guard, envelope-only upload) | S7 |
| R7 | Server improves, never required offline | client-side status/aggregates in core | ✅ (S2+S3: status, aggregates, greedy scheduler all pure/offline-computable; S3-F2 affects correctness of hour values, not offline capability) | S2/S3 |
| R8 | LLM-friendly: strict TS, contracts, pure fns, high core coverage | `tsconfig.base.json` (strict + noUncheckedIndexedAccess), core-purity lint bans (`eslint.config.mjs:132-179`), CI coverage gate ≥90% | ✅ (S1) | S1 |
| R9 | Command history is product data (explain "why") | provenance cols + `explainProvenance` + WhyButton | ⚠️ S4: row-level provenance ✅; `command_log.effects`/`parent_command_id`/`triggering_command_id` never written (S4-F3); UI → S8 | S4/S8 |
| R10 | Local-first backup/export/import, no managed service | `packages/ui/src/portability/*`, `GET /sync/export`, `POST /sync/import`, `scripts/{backup,restore}.sh` | ✅ (S5 server data-only import + global-id guard; S8 client crypto/floor; S10 scripts + docs verified against prod compose) | S5/S8/S10 |
| R11 | Versioned payloads + exports; old clients fail gracefully | `client_too_old` path, export version gate | ⚠️ export side ✅ (S2 strict versioned manifest + S8 envelope errors); command side vacuous end-to-end — clients never send versions and the server skips the floor when absent (S7-F3 + S4-F1, coupled fix) | S4/S8/S10 |
| R12 | Conflicts/rejections → durable review inbox | `sync_review_items` + Review screens (web/mobile) | ✅ (S4 server + S9 UI present/e2e-covered; lifecycle caveat S5-F1) | S4/S9 |
| R13 | Secure storage + optional DB encryption adapters | `packages/ui/src/adapters/{secure-storage,db-encryption}.ts`, `apps/mobile/src/secure-storage.ts` | ⚠️ web ✅; mobile impl present, runtime-unverified; shared-device logout gap S9-F1 | S8/S9 |
| R14 | Providers behind adapters; nothing leaks into core | core deps = fractional-indexing, rrule, uuid, zod only (`packages/core/package.json:26-31`); zero workspace imports in core src | ✅ (S1, re-check S3) | S1/S3 |
| R15 | Two-layer store: read-only replica + disposable overlay; UI reads merge | `overlay-store.ts`, `data-provider.tsx` merged read | ✅ S7 (atomic enqueue, local-only overlay tables, loud guard; read-path half → S8) | S7 |
| R16 | Synced-row schema versioning separate from command versioning | `schema_version` col, floor check in dispatcher; core primitives (two axes + `isClientTooOld`) ✅ S2 | ⚠️ S4-F1: absent `schema_version` bypasses the floor (latent until floor>1); enforcement otherwise ✅ | S4/S6 |
| R17 | Trust fields server-assigned; client values ignored | dispatcher trust-strip | ✅ S4 (strip-before-parse; strict schemas reject unlisted trust fields) | S4 |
| R18 | Idempotency dedup retained ≥ MAX_OFFLINE_HORIZON (90d) | `retention-purge.ts` dedup guard | ✅ (read side S4 + write side S5; history side-effect noted S5-F7) | S5 |
| R19 | External facts advisory only; never gate/diverge | weather badge display-only; engine ignores weather in convergent outcomes | ✅ **S3-F1 fixed (R2 `05a3bc6`)**: weather no longer causes `E_BLOCKED_TASK`; jobs side ✅ S5 (automations reject weather conditions, S5-F10). ⚠️ client pre-flight mirror = R5 (not done) | S5/S3 → R2 |
| R20 | Import restores data (no replay) + HLC monotonicity | `import-restore.ts` (data-only, FK-ordered), client HLC floor | ✅ (S5 server + S7 client floor: shared module, persisted, dominates every tick) | S5/S8 |

## v1.3 mandatory revisions (§3.2)

| ID | Revision (short) | Status | Owner |
|----|------------------|--------|-------|
| V1 | Split store, rollback drops overlay only | ✅ S7 (rollback = drop effects + mark rejected; review item server-owned); reconcile timing deviates — drops on ack not canonical arrival (S7-F6) | S7 |
| V2 | `command_log.id` == client command id; optimistic provenance matches server | ✅ end-to-end (S4 server + S7 client: write-time UUIDv7+HLC minting, verbatim upload, predicted source_kind='user') | S4+S7 |
| V3 | HLC-order apply; park/reject on missing precondition, linked review item | ✅ S4 (in-batch HLC sort + user-scoped causal gate + `dependency_rejected`/`unknown_target` + review item; cross-batch device floor = hardening S4-F7) | S4 |
| V4 | Trust fields server-assigned | ✅ S4 (strip-before-parse + strict schemas + server `sys`/`born` stamps) | S4 |
| V5 | Additive-only synced schema; old clients ignore unknown columns | ✅ S6 (0008 verified additive: all adds nullable/defaulted, live-DB-safe sentinel backfill); mechanical gate still absent (S2-F2/S6-F5) | S6 |
| V6 | Automation template versioning; backstop checks content, raises drift review item | ⚠️ content-comparison half verified in core (S3); `template_version` read-but-never-written (S3-F4); backstop behavior → S5 | S5 |
| V7 | Incremental fact-keyed StatusIndex; no stored status; no full scan | ✅ **wired (R7 `d8eaecc`)**: client provider seeds once + applies row-diffs; fan-out scoped (S2-F4/F5). Server write path uses a per-batch context cache, not O(table)-per-command (R8 `63c284e`). Primitive 100k gate unchanged (touch<100, ~0.02ms) | S2 → R7/R8 |
| V8 | Tier 0/1/2 streams before 100k load test | ⚠️ S6: security airtight (auth.user_id() everywhere, no client params ✅); tier substance nominal — Tier 0 = whole tree, Tier 2 ≈ empty (S6-F1); command_results = unreadable full 90d log (S6-F2); 100k cold-start unmeasured (S10) | S6/S10 |
| V9 | LWW default; explicit merges for sort_order + timer intervals | ⚠️ implemented + property-tested; double clock-in survivor rule deviates from §7.10b letter (S2-F1); UI sibling order deterministic+convergent via `(sort_order, id)` — spec's hlc tiebreak deviation only (S6-F3 downgraded by S8-F4) | S2 |
| V10 | External-fact state never gates rejection/convergence | ✅ **server (R2 `05a3bc6`)**: `isBlockedForAcceptance` excludes weather-reading rules so the clock-in gate no longer rejects on weather; weather-conditioned automations rejected at authoring (S3-F8). ⚠️ client pre-flight mirror = **R5 (not done)** | S3/S5 → R2 |
| V11 | Retention purge never deletes dedup inside horizon | ✅ S5 (strict-`<` boundary on 90d constants, not env-forgeable) | S5 |
| V12 | Import = data restore; encrypted export default on installed targets | ✅ server S5; web/desktop installed-default S9; **mobile crypto wired (R9 `ee02580`)** via react-native-quick-crypto (S9-F2) — device runtime verify pending (DoF 23) | S5/S9 → R9 |

## Definition of Finished (§16) — final verdicts (Synthesis)

| DoF | Item (short) | Verdict |
|-----|--------------|---------|
| 1–3 | all writes via executeCommand; no generic update endpoint; envelopes not row patches | ✅ (S4 routes + S7 loud guard + S9 screen sweep) |
| 4–6 | two-layer store; reconcile-to-identical + rollback-to-review; command id end-to-end | ✅ (S7; DoF 5 carries the S7-F6 drop-on-ack timing note) |
| 7 | HLC order + causal depends_on | ⚠️ server exact (S4); real clients never send `depends_on` (S7-F5) |
| 8 | offline feature set (spawning, unblocking, timer, agenda, suggestions) | ⚠️ **spawning absent offline (S7-F1 High)**; delete-closure degraded (S7-F7); rest ✅ |
| 9 | two-device convergence incl. sort_order/double clock-in/mixed schema/external facts | ✅ (13 scenarios green vs live PG; assertion-depth caveats S10-F3) |
| 10–11 | jobs: consistent snapshots, no clobber; client aggregates local-only, server aggregates synced with provenance | ✅ (S5; snapshot isolation nit S5-F5; hour-value correctness S5-F4) |
| 12 | suggestion batch lifecycle + stale rejection | ⚠️ batches/supersession/stale ✅; `replaces_block_id` never stamped → accept double-books (S5-F2) |
| 13 | soft-delete recreate | ✅ (S6 partial uniques + S4 write-site arbiters) |
| 14 | FS/SS/FF/SF tested | ⚠️ placement gates exact + property-tested; SF completion lag + SS availability lag dropped (S3-F5) |
| 15 | command vs schema version enforced at upload + export/import | ⚠️ export ✅; envelope side vacuous (S7-F3 + S4-F1) |
| 16 | incremental status at 100k budget; no stored status column | ⚠️ no stored column ✅; budget met by the primitive only — no runtime path uses the index (S2-F3/S4-F2/S8-F1) |
| 17 | server-assigned provenance | ✅ (S4) |
| 18 | automation drift surfaced, never silently overwritten | ✅ decision table (S5); version attribution missing (S3-F4) |
| 19 | durable review inbox | ✅ (S4 server + S9 UI; lifecycle unwired S5-F1) |
| 20 | export/import round-trip guarantees | ✅ (S5 + S8 + m13 tests) |
| 21 | secure storage; encrypted-by-default installed export; documented limits | ⚠️ web/desktop ✅; mobile export statically broken (S9-F2); logout boundary (S9-F1) |
| 22 | adapters contain vendors; external facts never gate | ⚠️ adapters ✅ (S1/S3/S5); weather gates clock-in acceptance (S3-F1 High) |
| 23 | platform smoke tests or documented exception | ⚠️ web ✅ in CI; mobile/desktop exception documented but unaccepted; mobile flow would fail today (S10-F8) |

## Annex A recommendations (A1–A8) — NOT adopted into v1.4

Verified S1: `CHANGE_SPEC_v1.0_to_v1.4.md` contains no reference to Annex A; the migration plan (M0–M15) implemented the change-spec only. These are a candidate backlog, to be prioritized in Session 10:

| ID | Feature | Status (S10 prioritization) |
|----|---------|--------|
| A1 | Device registry | ➖ defer — post-v1 multi-device value; S4-F7's per-device HLC floor would ride on it |
| A2 | Clock-skew guard | ➖ **adopt next** — small; closes S7-F8's restart-regression class + a documented residual risk |
| A3 | Optimistic mismatch reconciliation | ➖ adopt soon — S7-F6's proper fix (reconcile on canonical arrival) builds 80% of it |
| A4 | Command queue crash recovery | ➖ **adopt next** — the designed umbrella for the S7-F2/S7-F9 upload fixes; enqueue atomicity already done |
| A5 | Command-history compaction/redaction | ➖ adopt when deciding history retention (the S5-F7 vehicle) |
| A6 | Import modes (merge/replace) | ➖ defer — current restore+skip is safe, tested, honestly documented |
| A7 | Local-first search & derived indexes | ➖ defer — product feature; real per-platform FTS cost; no gate depends on it |
| A8 | Sync/debug diagnostics screen | ➖ adopt soon — cheap; would have made S7-F2's silent wedge user-visible |

## Structural conformance (§5 stack, §6 layout) — Session 1 verdicts

| Item | Verdict |
|------|---------|
| Stack table §5 (TS strict, pnpm+turbo, Vite/React, Tauri v2, Expo, PowerSync Sync Streams, PG, Hono, Drizzle, Zod-in-core, pg-boss, Better Auth, React Flow, elkjs, rrule, Zustand, Vitest/fast-check/Playwright) | ✅ all present in manifests; runtime checks in later sessions |
| §6 layout | ⚠️ matches except `packages/adapters` does not exist — ports live in `packages/ui/src/adapters/` (accepted deviation, see S1-F8) |
| §6 dependency rules via lint | ⚠️ enforced by eslint-plugin-boundaries, but web/mobile/desktop are over-permitted to import `db` (S1-F3) |
| §15 verification commands | ⚠️ equivalents exist but several lack root aliases (S1-F4) |
