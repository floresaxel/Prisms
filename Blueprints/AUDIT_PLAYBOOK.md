# Prisms Audit Playbook — 10 Parallel Sessions + 1 Synthesis

This document is a **self-contained work order**. Each numbered session below can be handed to a separate LLM (or run sequentially) with no other context than this file and the repository. A final **Synthesis** run consumes all session reports and produces the consolidated conclusion.

---

## 0. Shared context (read this whole section before running any session)

### 0.1 What is being audited

Prisms is a local-first, multi-device task/planning app: web (Vite + React + PWA), desktop (Tauri v2 wrapping the identical web build), mobile (Expo React Native), and a Hono/Node server over Postgres. Sync is PowerSync (Sync Streams). All user mutations are **named commands** (Zod-validated envelopes) — never generic row updates. The client store has **two layers**: a read-only canonical replica synced down from Postgres plus a local-only optimistic overlay of pending commands; the UI reads their deterministic merge. Status is always derived (never a stored column) via an incremental index. Conflicts/rejections become durable review-inbox items. Time ordering uses HLCs (hybrid logical clocks).

### 0.2 Normative sources ("intended features")

- `Blueprints/other/ARCHITECTURE_1.3.md` — the spec. Hard requirements **R1–R20** (§2), mandatory revisions **V1–V12** (§3.2), normative sections §§4–13, CI gates §15, Definition of Finished **DoF 1–23** (§16).
- `Blueprints/other/CHANGE_SPEC_v1.0_to_v1.4.md` — the v1.4 delta, including Fix A (persistent client read layer, §7.14) and Fix C (loading-aware/SWR reads, §7.15).
- **Not requirements:** `Blueprints/other/ARCHITECTURE_1.3_ANNEX_A_RECOMMENDATIONS.md` (A1–A8 were never adopted into the change-spec — treat as candidate backlog; only the Synthesis run prioritizes them).
- Historical context (do not audit against, may explain decisions): `Blueprints/other/MIGRATION_PLAN_v1.0_to_v1.4.md`, `BUILD_PLAN_REVISED_v1.4.md`.

### 0.3 Repository map

```
packages/core    pure domain logic (zero IO, zero workspace imports — lint-enforced)
packages/db      Drizzle schema, migrations/0000..0008, seed, sync-rules check CLI
packages/ui      shared React hooks, two-layer PowerSync store, portability, adapter ports
apps/server      Hono API, Better Auth, command dispatcher, pg-boss jobs
apps/web         React SPA (13 screens), Playwright e2e in apps/web/e2e/
apps/mobile      Expo RN app
apps/desktop     Tauri v2 shell (loads the web build)
infra/           powersync yaml (dev+prod), postgres init SQL, nginx
docs/audit/      audit outputs (plan, feature matrix, session reports)
```

### 0.4 Ground rules (every session)

1. **Report-only.** Do not modify source code, tests, or configs. Your only write is your own report file.
2. **One file per session.** Write exactly `docs/audit/session-NN-<slug>.md` (slugs fixed below). Do **not** edit `docs/audit/00-feature-matrix.md`, `docs/audit/AUDIT_PLAN.md`, or another session's report — in parallel execution those edits collide; the Synthesis run owns shared files.
3. **Pin your baseline.** Record the commit you audited (`git log --oneline -1`). Code baseline for this audit: `2ab3bf7` (branch `m0-spike`; later commits only add `docs/audit/`).
4. **Static analysis first.** Read code; you do not need to run the app. If you do run tests: unit tests are safe anywhere; server/db *integration* tests silently self-skip unless `PRISMS_DB_TEST_URL` points at a running Postgres (dev machine: WSL docker compose, port **5434**, connect via `127.0.0.1`; Node 26 needs `better-sqlite3` rebuilt from source). Never trust a green `pnpm turbo test` alone — it may be a cache replay with integration suites skipped (known finding S1-F1).
5. **Finding format.** ID `S<session>-F<n>`, severity, evidence as `path:line`, a concrete failure scenario (inputs/state → wrong outcome), and a specific suggested change. Severities: **Critical** = data loss / divergence between devices / security hole; **High** = spec violation with user-visible effect; **Medium** = correctness risk or real footgun; **Low** = hygiene, hardening, efficiency; **Info** = observation or accepted deviation.
6. **Verify before you assert.** Every Critical/High claim must be traced through the actual code path (not inferred from names or comments). If you cannot confirm, downgrade and say "unverified — needs X".
7. **Stay in scope.** If you spot a cross-boundary issue (e.g., client effect builder disagrees with a server handler you didn't read), record it under **Handoff items** with the session that owns the other side — do not audit outside your scope.
8. **Efficiency is part of the job.** For your scope, ask: does anything scan when it could index, rebuild when it could increment, subscribe twice when once suffices, copy when it could reference, or hand-roll what core/a dependency already provides? Complexity claims need the loop/query cited.

### 0.5 Report template (all sessions)

```markdown
# Audit Session N — <title>
Audited at commit `<hash>` (branch, tree state), <date>.
**Scope examined:** <files actually read>
**Verdict:** <2–4 sentence summary: compliant? efficient? biggest risk?>

## Findings
### SN-F1 · <Severity> — <one-line defect>
**Evidence:** path:line, path:line
**Failure mode:** <concrete scenario>
**Suggested change:** <specific, minimal>
(…repeat…)

## Compliance checklist results
<one line per checklist item from the playbook: PASS / FAIL(→finding) / PARTIAL / NOT-VERIFIABLE-STATICALLY>

## Positive observations
## Proposed matrix updates   ← proposals only; Synthesis applies them
## Handoff items             ← questions routed to other sessions / Synthesis
```

### 0.6 Already done

**Session 1 (foundation/tooling) is complete** — `docs/audit/session-01-foundation.md`, commit `baa6fc4`. Its open hooks for other sessions: **S2** confirm the actual perf-test filename for the §15 `test:perf` alias (F4); **S9** must resolve **F6** (workspace pnpm override pins React 19.2.7 while Expo 53/RN 0.79 pair with React 19.0.x — potential renderer mismatch; mobile has never been runtime-verified) and **F7** (web PowerSync default port 8081 vs compose 8080).

---

## Session 2 — Core primitives: time, merge, sync contracts, status index

**Report:** `docs/audit/session-02-core-primitives.md`
**Objective:** prove the deterministic-convergence foundation: HLC correctness, per-field LWW plus the explicit merge exceptions (V9), the overlay/replica merge contract, version policy, and the incremental StatusIndex (V7) with its no-full-scan guarantee.
**Scope:** `packages/core/src/{time,merge,sync,status}/**` + their tests in `packages/core/test/**`.
**Read first:** ARCHITECTURE_1.3 §7.9–§7.12, §9.1, §4 principles 6/14/15; CHANGE_SPEC §D.1, §D.4.

**Checklist:**
- HLC (`time/hlc.ts`): encoding sorts lexicographically == causally; counter overflow handling; device-id tiebreak total order; monotonicity under equal wall-clock; no wall-clock reads (Clock injected).
- LWW (`merge/lww.ts`): per-field (not per-row); HLC comparison + deterministic tiebreak; deleted-vs-updated resolution stated and tested.
- `merge/sort-order.ts`: concurrent fractional-index collision → deterministic, convergent resolution on all devices (V9); renormalize (`merge/renormalize.ts`) cannot fight concurrent inserts.
- `merge/time-entries.ts`: double clock-in merges by the documented rule (interval union, not sum) and drives effective-hours; idempotent and commutative.
- `sync/overlay.ts`: merge contract is pure + deterministic; overlay entries carry command id; contract makes rollback = delete-overlay-entry (V1) with no replica mutation possible from this layer.
- `sync/version.ts`: command-version floor and synced-schema-version policy are **separate** (R16); `client_too_old` semantics.
- `sync/manifest.ts`: table/column manifest — note columns for S6 to cross-check against the Drizzle schema and PowerSync client schema (handoff item).
- Status (`status/*`): no stored status anywhere; StatusIndex is fact-keyed, invalidates only affected nodes, and has a test proving per-command recompute cost is O(affected), not O(all nodes); locate the 100k perf test and record its actual budget numbers + filename (→ S1-F4 hook).
- Tests: fast-check property tests exist for commutativity/idempotency/determinism of **each** merge exception (§15 gate); every invariant has a rejecting test.
**Efficiency lens:** StatusIndex data-structure choice and invalidation fan-out; merge functions allocating per-field copies in hot paths; HLC parse/format cost if called per row.

---

## Session 3 — Core engines: commands, rules, scheduler, aggregates, graph

**Report:** `docs/audit/session-03-core-engines.md`
**Objective:** verify the command catalog matches spec §8, invariants reject what they must, and the rules/scheduler/aggregates engines are deterministic, external-fact-safe (V10), and correctly factored as pure core.
**Scope:** `packages/core/src/{commands,rules,scheduler,aggregates,graph,domain}/**` + tests.
**Read first:** ARCHITECTURE_1.3 §7.4–§7.6, §8, §9.2, §10 (pure parts), §11; CHANGE_SPEC §E/§F/§G.

**Checklist:**
- Catalog: enumerate every command in `commands/payloads.ts` (expect 59 incl. `review.resolve`/`review.dismiss`) vs the §8 list; each has a Zod schema, invariant checks (`commands/invariants.ts`), and minimal-field semantics (§4.7 — payload names only the fields it writes).
- Envelope (`commands/envelope.ts`): client-generated UUIDv7 id, HLC, command version, device id — matches §7.2b identity rule (command id becomes `command_log.id`).
- Rules engine (`rules/engine.ts`): spawned ids are UUIDv5(rule id, trigger id, action slot) (§4.6); uses triggering-fact timestamps, never wall clock; fixpoint terminates (depth limit) and reports depth-limited state; drift/content helpers used by the backstop (V6) — pure side lives here.
- External facts: prove no rule/scheduler/aggregate output depends on weather (or any provider fact) in a way that changes convergent state (V10/R19) — grep fact kinds and trace usage.
- Scheduler (`scheduler/*`): greedy + optimize are deterministic given the same inputs (injected Rng/Clock); property tests cover overlap, anchoring, dependency respect, idempotency (§15).
- Dependency semantics: FS/SS/FF/SF defined separately for status vs scheduling vs completion gates (§7.6) and each has tests (DoF 14).
- Aggregates (`aggregates/*`): pure; match §9.2 definitions; note which are client-local vs server-canonical for S5 cross-check.
- Graph (`graph/*`): cycle detection on edge insert; cascade semantics; `elk.ts` must not import `elkjs` (core purity — it should build the layout-graph JSON only).
- `domain/ids.ts`: id generation uses injected randomness only.
**Efficiency lens:** rules fixpoint re-evaluation scope per iteration (full rule set vs affected); scheduler complexity vs input size; graph algorithms recomputing from scratch where incremental would matter (note if only used server-side/off-hot-path).

---

## Session 4 — Server: dispatcher, trust boundary, auth

**Report:** `docs/audit/session-04-server-dispatcher.md`
**Objective:** the server's command path is the security and convergence choke point. Verify the §7.5 transactional apply, causal ordering (V3), trust-strip (V4/R17), idempotency (R18 read side), version floors (§7.11), the response contract, and the in-transaction automation fixpoint (§10.1).
**Scope:** `apps/server/src/{dispatcher.ts,app.ts,auth.ts,env.ts,rate-limit.ts,request-log.ts,main.ts,index.ts}` (+ dispatcher-adjacent helpers), server tests `apps/server/test/{dispatcher,m5-*,api}.integration.test.ts` as evidence of covered behavior.
**Read first:** ARCHITECTURE_1.3 §7.2b–e, §7.5, §7.8, §7.11, §10.1; CHANGE_SPEC P5.

**Checklist:**
- Envelope validation: Zod parse before any DB touch; unknown command → typed rejection; payload size limits.
- Idempotency: dedup lookup by client command id; re-upload of an applied command returns the original outcome (no re-apply); dedup record content sufficient to answer duplicates for 90 days (retention itself = S5).
- Causal ordering (V3): same-device commands apply in HLC order; command depending on unapplied/rejected predecessor is parked or rejected `dependency_rejected` **with a linked review item**; ordering state is user-scoped (cannot be poisoned cross-user).
- Trust strip (V4/R17): list the exact fields stripped/overwritten (`user_id`, `source_kind`, `source_id`, `created_by_command_id`, `computed_by`, `applied_at`, all server `*_at`); confirm strip happens for **every** command path including automation spawns and review commands.
- §7.5 transaction shape: revalidate invariants against canonical state in-txn → apply minimal-field writes → run automation to fixpoint **inside the same txn** (spawn validation, SAVEPOINT so a bad rule can't poison the command, per-spawn provenance stamped, depth-limit → sync_warning) → write `command_log` with **id = client id** (V2) and command version → single commit; response contract `{applied|rejected, …}` never leaks internal errors.
- `accept_suggestion` transactional rules: stale/superseded suggestion → typed rejection + review item; promote + soft-delete replaced + supersede siblings atomically.
- Schema floor (§7.11): device schema_version below floor → `schema_version_block` behavior; floor configuration location.
- Auth (`auth.ts`): Better Auth session → JWT for PowerSync (aud/iss/exp verified by the PowerSync config — note claims for S6 cross-check); JWKS/shared-secret handling via `env.ts` (no hardcoded secrets); rate limiting on auth + command endpoints; `request-log.ts` redacts tokens/payload PII.
- HTTP surface: confirm **no** generic update endpoint exists (DoF 2) — enumerate all routes in `app.ts`.
**Efficiency lens:** per-command query count (N+1 risks in revalidation/automation); indexes assumed by dedup + ordering lookups (handoff to S6); response building copying large rows.

---

## Session 5 — Server jobs

**Report:** `docs/audit/session-05-server-jobs.md`
**Objective:** verify every §12 job: consistent snapshots, no clobbering of later command writes (DoF 10), drift detection (V6), retention vs the offline horizon (V11), suggestion lifecycle (§7.5), advisory-only external facts (V10), and data-only import (R20/V12).
**Scope:** `apps/server/src/jobs/**` (`boss.ts`, `clock.ts`, `automation-backstop.ts`, `aggregates-recompute.ts`, `retention-purge.ts`, `schedule-optimize.ts`, `pastdue-scan.ts`, `review-expire.ts`, `weather-poll.ts`, `notify-dispatch.ts`, `push.ts`, `layout-precompute.ts`, `backup-snapshot.ts`, `import-restore.ts`, `import-validate.ts`, `scheduler-context.ts`), tests `jobs*.integration.test.ts`, `m13-portability.integration.test.ts`.
**Read first:** ARCHITECTURE_1.3 §7.4, §7.5, §10.2, §10.3, §12, §13.1.

**Checklist:**
- `boss.ts`/`clock.ts`: every job idempotent under pg-boss retry (at-least-once); singleton/throttle keys where re-entrancy would corrupt; schedules match §12.
- `automation-backstop.ts` (§10.2/V6): checks **content equivalence** (not just row existence) using the rule version visible at trigger time; drift → informational review item, never silent overwrite (DoF 18); replay uses engine determinism.
- `aggregates-recompute.ts`: reads a consistent txn snapshot; **no-clobber guard** — never overwrites a row a later command touched; writes `computed_at` + server provenance (DoF 11); only server-canonical aggregates (client caches must not sync — cross-check list with S3).
- `retention-purge.ts` (V11/R18): purge horizon ≥ `MAX_OFFLINE_HORIZON` (default 90d) for idempotency-dedup records; verify boundary is `>=` not `>`, uses server clock, and cannot be config-forced below the floor.
- `schedule-optimize.ts` + `pastdue-scan.ts`: suggestion **batches** with replacement links; new batch supersedes prior open batch; suggestions carry scheduler provenance; suggestions are proposals — no fact tables written.
- `review-expire.ts`: only resolved/dismissed items expire; open items are durable (R12).
- `weather-poll.ts` (V10/R19): writes provider-neutral external-fact rows only; nothing convergent derives from them; provider API contained (R14).
- `notify-dispatch.ts`/`push.ts`: adapters at the edge; failure of a provider cannot fail a job batch permanently (poison-message handling).
- `backup-snapshot.ts` + `scripts/{backup,restore}.sh`: §13.1 format, versioned.
- `import-restore.ts` (R20/V12): explicit txn; restores rows as **data** (no command replay); server forces `user_id` + `source_kind='import'`; FK-ordered upsert (nodes parent-first); HLC-LWW keeps newer local rows; command history lands non-replayable; **global-id guard** — importing rows whose ids exist under another account must not steal/overwrite them; `import-validate.ts` dry-run parity with real run.
**Efficiency lens:** jobs scanning whole tables per tick vs incremental watermarks; per-user loops issuing per-row queries; batch sizes; `layout-precompute.ts` ELK invocation cost and caching.

---

## Session 6 — DB schema, migrations, sync topology, compose

**Report:** `docs/audit/session-06-db-sync.md`
**Objective:** verify the physical layer: §7.1 tables + base/provenance columns, §7.7 partial unique indexes, additive-only migrations (V5), Sync Streams tiers 0/1/2 (V8) with airtight per-user scoping, and dev/prod compose correctness.
**Scope:** `packages/db/**` (schema.ts, auth-schema.ts, migrations/0000–0008, seed.ts, migrate.ts, url.ts, cli/*, type-assertions.ts), `infra/powersync/powersync{,.prod}.yaml`, `infra/postgres/init/*`, `docker-compose.yml`, `docker-compose.prod.yml`.
**Read first:** ARCHITECTURE_1.3 §7.1, §7.3, §7.7, §7.8, §7.11; CHANGE_SPEC §C, §D.3.

**Checklist:**
- Schema vs CHANGE_SPEC §C: every synced table has the C.1 base columns (hlc, schema_version, …); C.2 provenance columns on user-visible fact tables; C.3 new tables (suggestion batches, `sync_review_items`, `command_log`, dedup store); C.4 extensions present.
- §7.7: partial unique indexes (`WHERE deleted_at IS NULL`) on every soft-deletable uniqueness — enumerate and diff against tables having `deleted_at` (DoF 13).
- Migrations: forward-only; 0008 is additive + backfills (V5 — an old client reading during/after migration sees no required-new-column); no destructive statement anywhere; `migrate.ts` transactional + ordered.
- Drizzle schema ↔ `packages/core/src/sync/manifest.ts` ↔ `packages/ui/src/powersync/schema.ts` (client, v22): three-way column diff — any drift is a finding (coordinate with S2/S7 handoffs).
- Sync Streams (edition 3): Tier 0/1/2 split exists (V8) and matches §7.3 table assignments; `history` stream is Tier 2/lazy (TTL); **security:** every stream filters by the authenticated user parameter; stream parameters cannot widen scope (a client-supplied param must not select другой user's buckets) — §15 gate; verify `sync_review_items` and `computed_aggregates` sync down, `command_log`/dedup do **not** sync to clients.
- `check-sync-rules.ts` actually validates the yaml the containers load (dev **and** prod variants; note the known PS_-prefix env convention in prod).
- Compose: postgres `wal_level=logical` + publication init scripts cover exactly the synced tables; healthchecks; prod compose parity (versions, volumes, restart policies); PowerSync storage bootstrap (`01-powersync-storage.sql`).
- Indexes: are the dispatcher's hot lookups (dedup by command id, causal ordering by user+device+hlc, review items by user+status, status facts by node) index-backed? Enumerate missing ones (coordinate with S4 handoff).
**Efficiency lens:** over-wide streams (Tier 0 carrying rarely-read tables), unindexed FKs on hot joins, JSONB vs TEXT choices on large payload columns.

---

## Session 7 — Client write path: two-layer store, effects, upload

**Report:** `docs/audit/session-07-client-write-path.md`
**Objective:** verify R15/V1/V2 end-to-end on the client: overlay is disposable and never uploads; effects mirror server semantics; envelopes are the only upload; reconcile/rollback are lossless; offline verbs (R4) all work.
**Scope:** `packages/ui/src/powersync/{overlay-store.ts,effects.ts,execute.ts,commands.ts,connector.ts,upload-commands.ts,client-runtime.ts,schema.ts,rows.ts,streams.ts}` + ui tests covering them.
**Read first:** ARCHITECTURE_1.3 §7.2 (all subsections), §7.3 client side; CHANGE_SPEC §I.1.

**Checklist:**
- `execute.ts`: one generic `executeCommand` — envelope (UUIDv7 id, HLC, version, device id) + overlay effects written atomically (same SQLite txn? if not, what happens on crash between them — relate to un-adopted A4 and record residual risk explicitly).
- `effects.ts`: `buildOptimisticEffects` covers **all** commands (a coverage test should prove every CommandName has a writer — locate it); sample ≥8 representative verbs (create, rename, complete, retype, clock-in/out, accept_suggestion, review.resolve, reorder) and diff their effect semantics against the server handler outcomes (minimal fields, JSON-as-TEXT, bool-as-0/1, timestamps) — parity drift = the top bug class here; `buildAcceptSuggestionEffects` mirrors the §7.5 txn (promote + soft-delete replaced + supersede siblings) reading **merged** state.
- Optimistic provenance: locally predicted provenance (`source_kind='user'`, `created_by_command_id`= command id) matches what the server will assign (V2) so reconciliation is byte-identical.
- `overlay-store.ts`: overlay keyed by command id; **reconcile** = canonical row arrives → overlay entry dropped, merged read now serves replica (verify the trigger: sync-down event? row equality? command_log confirmation?); **rollback** = rejection → entry dropped + review item visible; overlay rows never written to synced tables.
- `connector.ts`: `uploadData` is a loud guard (throws on any CRUD batch) — confirm nothing can enqueue CRUD ops in production paths; `upload-commands.ts`: watcher drives envelope POST in HLC order per device, sequential (no concurrent uploads racing causality), retry/backoff, applies the response contract (applied → drop overlay; rejected → drop overlay + surface review item; `client_too_old` → block + banner path), offline queue survives restart.
- `schema.ts` (client, v22): includes provenance + suggestion-lifecycle columns; `sync_review_items` present; **no** upload-triggering local mutations on synced tables outside the overlay design.
- `streams.ts`: Tier 2 `history` lazy subscribe (TTL/priority) — degrade gracefully if the SDK call is unavailable (it's alpha API).
- R4 offline verbs: spawning, dependency unblocking, clock-in/out, agenda edits, suggestion accept/reject — each has an optimistic path (no server round-trip required).
**Efficiency lens:** merged-read cost per query (overlay join strategy), watcher wake-up mechanism (event vs poll), effect builders re-serializing whole rows, upload batching.

---

## Session 8 — Client read path, shared UI, portability client, adapter ports

**Report:** `docs/audit/session-08-client-read-path.md`
**Objective:** verify Fix A (§7.14: one persistent read layer per session) and Fix C (§7.15: loading-aware SWR reads with no cold flash), plus provenance explanation (R9 client side), export/import client boundary (§13.1), crypto quality, and provider-neutral adapter ports (§13.2/§13.3).
**Scope:** `packages/ui/src/{hooks.ts,provenance.ts,worklist-grouping.ts,index.ts}`, `packages/ui/src/powersync/data-provider.tsx`, `packages/ui/src/components/**`, `packages/ui/src/portability/{crypto.ts,export-import.ts}`, `packages/ui/src/adapters/{secure-storage.ts,db-encryption.ts}` + ui tests (`read-layer`, `loading-aware`, `portability`, `data-provider` in apps/web/test).
**Read first:** CHANGE_SPEC §I.2/§I.3; ARCHITECTURE_1.3 §7.8, §13.1–§13.3.

**Checklist:**
- `data-provider.tsx` (Fix A): subscribes exactly once per session to the 9 shared base tables + one overlay read; FactContext/TreeIndex built once and reused across navigation (mounted above the router — verify with S9 that both App.tsx mount it there); `isHydrated` grounded in the SDK's `hasSynced` (not a timer); a now-tick must not rebuild FactContext.
- `hooks.ts` (Fix C): `useRowsRead` returns `{data,isLoading,isFetching}`; module-scoped `ROWS_CACHE` keyed by sql+params serves warm revisits synchronously; **cache lifecycle** — eviction/size bound? stale entries after auth change/logout (data leak across accounts on shared device?) — if unbounded or not cleared on logout, that's a finding; hydration gating additive (mobile-compatible return types); the PRODUCED set uses `useSyncExternalStore` without adding second subscriptions (read-layer invariant).
- Empty-state gating: `List`/`Skeleton` components render skeleton until hydrated (no empty-then-fill flash) — spot-check the component contract; screens themselves are S9.
- `provenance.ts`: `explainProvenance` handles every `source_kind` incl. legacy rows → "origin unknown"; optimistic prediction consistent with S7.
- `portability/crypto.ts`: AES-256-GCM via WebCrypto; PBKDF2 params — record iteration count (≥600k for SHA-256 per current OWASP, else finding), random salt ≥16B, unique IV per encryption, auth-tag verified (wrong passphrase = clean failure); versioned envelope; no crypto in `packages/core`.
- `export-import.ts`: version-gated parse (unknown export version → explicit error, R11); DOM-free (runs on RN too); import HLC **floor** — client clock advances past imported high-water, floor persisted and re-observed at startup (R20).
- Adapter ports: `SecureStorage`/`DbEncryption` interfaces are provider-neutral (no expo/tauri types); web impls degrade honestly (documented localStorage limits, R13/DoF 21 documentation side).
- `worklist-grouping.ts` + components: pure, no IO.
**Efficiency lens:** FactContext rebuild triggers (should be data-change only), TreeIndex incremental vs full rebuild per sync batch, memoization of selectors, `ROWS_CACHE` growth, re-render fan-out from provider context value identity.

---

## Session 9 — Apps: web screens, mobile, desktop parity

**Report:** `docs/audit/session-09-apps.md`
**Objective:** verify the user-facing surfaces exist and behave per spec — §12 feature surface, M9 interaction surfaces, review inbox (§7.13 UI), portability UI (encrypted-by-default on installed targets, DoF 21), platform integrations (R1/R13) — and resolve Session 1's F6/F7.
**Scope:** `apps/web/src/**` (App.tsx, 13 screens, components, config.ts, powersync.ts, desktop.ts, portability.ts, auth.ts, format.ts, main.tsx), `apps/web/e2e/*.spec.ts` (inventory only), `apps/web/test/*`, `apps/mobile/**` (screens, secure-storage.ts, portability.ts, powersync.ts, device.ts, notifications.ts, auth.ts, config.ts, app config), `apps/desktop/**` (+ `src-tauri` config).
**Read first:** ARCHITECTURE_1.3 §12 (via 1.0 ARCHITECTURE.md §12 if referenced), §7.13, §13.2; CHANGE_SPEC §I; `docs/audit/session-01-foundation.md` F6/F7.

**Checklist:**
- Web screens vs feature surface: Worklist, Agenda, Kanban, Gantt, Flowchart (React Flow), Habits, Dashboard, DecisionBoard, Rules, Blockers, Inbox, Review, Settings (+ Login) — each reads via the provider/hooks (no direct shared-table subscriptions — read-layer test should enforce), writes only via `executeCommand` (DoF 1: grep for any `db.execute`/raw writes in screens).
- M9 surfaces: accept-suggestion optimistic flow; `WhyButton` on the provenance-bearing rows; force clock-in on blocked tasks → ongoing; weather-unverified badge is display-only; `ReviewBanner` schema_version_block prompt links to Review.
- Review screen: renders all 9 item_types; resolve/dismiss go through the `review.resolve`/`review.dismiss` **commands** (never a row patch).
- Settings/portability: web export opt-in encryption; installed targets (desktop via `isDesktop()`, mobile) **encrypted by default** with explicit plaintext opt-out + warning (V12/DoF 21); import → dry-run → restore flow wired to the server endpoints; mobile export via Share; mobile import deferred — confirm that's documented user-visibly or flag.
- `config.ts` (web): resolve S1-F7 — default PowerSync URL/port vs compose (8080 vs 8081), and how env overrides work at build time.
- **S1-F6 resolution (required):** determine the React version actually resolved for `apps/mobile` under the workspace override (`pnpm why react` / lockfile read) vs RN 0.79's supported pairing; check `react-native-renderer`/`react` version-lock implications and Expo 53 constraints; verdict: safe / unsafe / needs runtime verification (and if unverifiable statically, say exactly what command proves it).
- Mobile parity: screens (Worklist, Agenda, Kanban, Habits, Dashboard, Graph read-only, Review) hydration-gated skeletons; `secure-storage.ts` implements the S8 port via expo-secure-store; device id routed through it; session auth = native cookie handling; notifications adapter-contained.
- Desktop: Tauri v2 config — CSP, capability allowlist minimal, notification plugin; loads the identical web build (no forked bundle); updater/signing posture noted.
- PWA (web): service worker/offline shell present and not caching API responses incorrectly (vite-plugin-pwa config).
- e2e inventory: map every spec file (dod, s16–s20, m9, m10, m13, v14) to the §15 gates it covers; list gates with **no** e2e/test coverage (feed Synthesis).
**Efficiency lens:** screens subscribing redundantly vs provider, list virtualization for 100k-scale views (Worklist/Agenda), graph screens re-layout frequency, bundle red flags (accidental heavy imports in web — e.g. server-only libs).

---

## Session 10 — Security, performance, docs, release infrastructure

**Report:** `docs/audit/session-10-security-perf-docs.md`
**Objective:** re-verify every claim in `docs/SECURITY_REVIEW.md` against the code as it is now; confirm the performance budgets and the §15 gate list are actually enforced by existing tests; check docs/compose/scripts accuracy for self-hosting.
**Scope:** `docs/SECURITY_REVIEW.md`, `docs/SELF_HOSTING.md`, `README.md`, `docker-compose.prod.yml`, `infra/nginx/web.conf`, `scripts/{backup,restore}.sh`, `.env.example`, `.github/workflows/ci.yml`, the convergence harness `apps/server/test/convergence.integration.test.ts` (scenario list only), perf tests in core, `packages/db/src/cli/check-sync-rules.ts` (prod path).
**Read first:** ARCHITECTURE_1.3 §13, §15, §16.

**Checklist:**
- SECURITY_REVIEW.md: for each claim, cite the code that still satisfies it or flag drift (claims about auth, trust-strip, rate limits, JWT audience, import global-id guard, export encryption, secret storage). A security doc that overstates = High.
- Threat pass (beyond the doc): auth endpoints rate-limited; JWT expiry + audience checked by PowerSync config; CORS/trusted origins (`BETTER_AUTH_TRUSTED_ORIGINS`); nginx TLS/headers (HSTS, CSP for the web app); `.env.example` contains no real secrets and prod compose fails loudly on missing secrets; request logs redact tokens; import/export endpoints authenticated + authorized per user.
- §15 gate list: build the full checklist from §15 and mark each gate → the concrete test file(s) that enforce it (pull from S2–S9 reports if available; otherwise locate directly). Gates with no enforcing test = findings.
- Convergence harness: 13 scenarios enumerated and mapped to §15's named list (offline edits, HLC conflict, automation spawning, double clock-in, sort_order collision, mixed schema versions, external-fact divergence, overlay reconcile/rollback, union-not-sum, dependency cascade, …) — any §15-named scenario missing = finding.
- Performance: locate the 100k StatusIndex per-command test and the agenda/load budget tests; record measured numbers vs budgets; list performance **claims** (README/spec) with no enforcing test.
- Self-hosting docs vs reality: env var names (PS_-prefixed PowerSync vars), ports, Node version, migration + first-boot order (PowerSync after migrations), backup/restore scripts run against the prod compose volumes; README quickstart actually works on a fresh clone (trace each step; note S1-F7 port default here too).
- CI: does `ci.yml` gate everything §15 requires on PRs (perf test? export round-trip? recurrence?) — list uncovered gates.
- Annex A (A1–A8): one paragraph each — value, cost, and a recommendation (adopt next / defer / reject), feeding the Synthesis backlog.
**Efficiency lens:** CI minutes (redundant builds/installs across the 3 jobs), docker image sizes/layers in prod compose, nginx caching headers for the PWA bundle.

---

## Synthesis — consolidate all sessions into the conclusion

**Run this only after sessions 1–10 reports exist.** Output: `docs/audit/FINAL_REPORT.md` + updates to `docs/audit/00-feature-matrix.md` and `docs/audit/AUDIT_PLAN.md` (this run is the only one allowed to edit shared files).

**Inputs:** `docs/audit/session-01…10-*.md`, the feature matrix, this playbook.

**Method:**
1. **Collect** every finding into one register (keep original IDs).
2. **Dedup/merge** findings sharing a root cause across sessions (e.g., a schema drift seen by S2, S6, and S7 is one finding with three evidence sites); keep the highest justified severity.
3. **Resolve handoff items:** every "Handoff items" entry must end up either answered (cite where), converted into a finding, or explicitly declared unresolved in the final report.
4. **Adjudicate conflicts:** if two sessions disagree about the same code, read the code yourself and rule; never average.
5. **Spot-verify:** re-trace the evidence for every Critical and High finding before publishing it (parallel sessions ran without cross-context; this is the guard against confident-but-wrong).
6. **Update the matrix:** apply each session's "Proposed matrix updates" (R1–R20, V1–V12, DoF 1–23 → ✅/⚠️/❌ with finding refs); mark the tracker table in AUDIT_PLAN.md done.
7. **Write FINAL_REPORT.md:**
   - Executive summary (≤1 page): overall compliance verdict, the 5 most important findings, biggest efficiency wins.
   - Compliance scorecard: counts + tables for R/V/DoF (verified / with-findings / gaps), and the accepted-deviations list (e.g., no `packages/adapters`).
   - Full findings register sorted by severity, then by remediation effort (S/M/L), each with evidence and suggested change.
   - Remediation backlog: ordered plan (quick wins first, then correctness, then hardening), grouping findings into coherent PR-sized batches.
   - Test-gap appendix: §15 gates without enforcing tests.
   - Annex A adoption recommendation (from S10) as the post-1.4 backlog.
8. Nothing in the synthesis introduces new unaudited claims: every statement traces to a session report or to code you re-read.

---

## Dispatch cheat-sheet

| Run | Prompt to give an LLM |
|-----|----------------------|
| Session N (2–10) | "Read `Blueprints/AUDIT_PLAYBOOK.md` §0 and the Session N section, then execute Session N exactly as specified. Write only `docs/audit/session-0N-<slug>.md`." |
| Synthesis | "Read `Blueprints/AUDIT_PLAYBOOK.md` §0 and the Synthesis section. All session reports exist under `docs/audit/`. Execute the Synthesis." |
