# Prisms — Migration Build Plan, v1.0 → v1.4

A session-sized plan for an LLM to **modify the existing Prisms codebase** (built from `Prisms_alpha/Blueprints/ARCHITECTURE.md` + `BUILD_PLAN.md`, the v1.0 spec) up to the v1.4 contracts. It implements every revision in `ARCHITECTURE_1.3.md` / `BUILD_PLAN_REVISED_v1.3.md` (the runtime-convergence layer) **and** the read-path fixes in `BUILD_PLAN_REVISED_v1.4.md` (persistent read layer + loading-aware reads).

This is a **migration**, not a greenfield build. Each session names the real files to change, the current behavior, the target behavior, and a Definition of Done. Migration sessions are numbered **M0–M15**. They follow the completed v1.0 build (the original S1–S23).

> This plan supersedes the standalone `BUILD_PLAN_REVISED_v1.4.md` increment (its S24–S26 assumed v1.3 was already in place). The 1.4 read-path work is folded in as **M11–M12** and now hoists the v1.3 two-layer merge + `StatusIndex` rather than the bare `FactContext`.

## How To Use This Plan

1. Before each session, read the cited `ARCHITECTURE_1.3.md` sections and the named source files.
2. Work on a branch `mNN-<slug>`; commit per deliverable.
3. Write tests first or alongside; the DoD is the exit gate. Never let an upstream package's gate go red.
4. **The convergence harness (M7) is the linchpin.** Server-side convergence sessions (M0, M5, M6) must keep it (and the v1.0 6-scenario harness it grows from) green. Do not start client rework (M8+) until M7 is green.
5. Do not change command, status, or sync *semantics* except where a session explicitly says so. The v1.0 behavioral e2e (the existing 12 Playwright cases) must stay green throughout — **except** M8, which intentionally changes the upload **and** rollback paths (see M8 DoD).
6. Trust fields (ownership/provenance/system/version/server-timestamps) become server-assigned; never trust client values for them after M5.
7. **This is a live migration of a populated, self-hosted database.** Every schema change (M3) must apply additively to a seeded DB with row counts preserved (see M3).

---

## Current Baseline — As-Built Audit (verified against the repo)

The v1.0 build went further than the 1.3 doc's notion of "1.0" in a few places (HLC, a command envelope, `command_log`, idempotency, `computed_aggregates`), but the entire convergence/reconciliation layer and the read-path fixes are absent. `appSchema` (`packages/ui/src/powersync/schema.ts`) has **21 synced tables**.

**Already present (keep, extend):**
- `packages/core`: `domain/`, `commands/` (incl. `envelope.ts`; the envelope already specs a client UUIDv7 id), `graph/`, `status/` (`status.ts`, `phase.ts`, `predicate.ts`, `context.ts`), `aggregates/`, `scheduler/`, `rules/`, `time/`. **`core/time/hlc.ts` already provides zero-padded, lexicographically-sortable encode/compare/tick** (`hlcEncode`/`hlcParse`/`hlcCompare`/`hlcCompareEncoded`/`hlcTick`); the dispatcher relies on it.
- `packages/db`: Drizzle `schema.ts`, forward migrations `0000`–`0007` (incl. `0003_field_versions.sql` = a `command_field_versions` **per-field HLC-LWW** table — this is V2/V3 convergence groundwork, **not** synced-row `schema_version`). `command_log`, `computed_aggregates`, and `user_settings` exist. **`hlc` exists only on `command_log` (schema.ts:517) and `user_settings` (schema.ts:563)** — `baseColumns` (schema.ts:59-65) has none.
- `apps/server`: `dispatcher.ts` (the v1.0 pipeline; **`command_log.id` already equals the arriving client command id**, schema.ts:511 / dispatcher writes it), `auth.ts`, `rate-limit.ts`, `request-log.ts`, and jobs (`aggregates-recompute`, `automation-backstop`, `pastdue-scan`, `schedule-optimize`, `scheduler-context`, `weather-poll`, `layout-precompute`, `notify-dispatch`, `retention-purge`, `push`, `boss`). `block.accept_suggestion`/`block.reject_suggestion` handlers **exist but are minimal stubs** (dispatcher.ts:394-409): accept flips status to `committed`, reject soft-deletes — neither runs the §7.5 transaction.
- `packages/ui`: reactive hooks (`hooks.ts`), `powersync/` data layer. **The upload path is `connector.ts:49-61`**: `uploadData` drains `getCrudBatch()`, runs `crudToCommand` over ~40 verbs / 17 tables, and **mints a fresh `newId()` per command at upload** (connector.ts:61) — decoupled from any client-side command id. `crudToCommand` is a **public `@prisms/ui` export** (index.ts:11) with a unit test.
- `apps/web`: Vite/React shell, hand-rolled router, screens. Rejection rollback today = "the unchanged canonical row syncs back down" via `connector` `onReject` + a toast (App.tsx:107-110); `onReject` carries **no command-id binding**.

**Absent (must be built by this migration):**
- **Two-layer client store.** No `client_commands` / `overlay_effects`; no `core/sync` `mergeRow`/`mergeTable`. Optimistic writes mutate replica tables directly (`packages/ui/src/powersync/commands.ts` does `db.execute('UPDATE nodes …')`).
- **Incremental `StatusIndex`** (§7.12): none; status recomputed live.
- **Sync Streams + tiers** (§7.3): sync is **legacy** `packages/db/sync-rules.yaml` (one user bucket). No Tier 0/1/2.
- **Per-row `hlc` column on fact tables** (§7.1): absent (only `command_log`/`user_settings` have it). The `(sort_order, hlc)` and same-field-LWW merges have no backing column yet.
- **Synced-row `schema_version`** (§7.11): **fully net-new** — `schema_version` has zero repo-wide hits. (The `command_field_versions` table is unrelated.)
- **Causal ordering / trust fields** (§7.2c/e): no `depends_on`, no HLC-ordered apply, no trust-field stripping, no `dependency_rejected`/`unknown_target`/`client_too_old`.
- **Provenance columns** (`created_by_command_id`, `source_kind`, …): none on any table.
- **Suggestion batch lifecycle** (§7.5): no `schedule_suggestion_batches`/`suggestion_batch_id`; the accept/reject **transaction logic** is absent (handlers are stubs).
- **Review inbox** `sync_review_items` (§7.13): none.
- **Automation rule/template versioning + drift** (§10.2): no `rule_version`/`template_version`/content-hash backstop.
- **Deterministic merge exceptions** (§7.10): no `(sort_order, hlc)` key, no `mergeTimeEntries` union-not-sum.
- **`layout.renormalize_order` command** (§7.10a/§8): absent from the catalog (`payloads.ts` jumps `layout.set_position` → `layout.set_collapsed` → `group.create`).
- **Idempotency retention** (`MAX_OFFLINE_HORIZON`) and **import/export** portable format: none.
- **Read path (the v1.4 bug):** `useRows = useQuery(sql).data ?? []` (`hooks.ts` L89) discards loading; `useFactContext` fans out 9 base subscriptions; screens hard-unmount on navigation (`App.tsx` L112-125).

---

## Delta Map: v1.0 → v1.4

Every target contract → its status in the current code → the session that lands it.

| # | Contract (spec) | Current status | Session |
| --- | --- | --- | --- |
| V1 | Two-layer store: replica + optimistic overlay; merged reads (§7.2) | absent | M0, M3, M8 |
| V2 | `command_log.id == client command id` (§7.2b) | **server side already holds**; client-side id-minting net-new | M0, M8 |
| V3 | Causal ordering: `depends_on`, HLC apply, `dependency_rejected` (§7.2e) | absent | M1, M3, M5 |
| V4 | Trust fields server-assigned; client values stripped (§7.2c) | absent | M1, M5 |
| V5 | Synced-row `schema_version`; additive-only; `client_too_old` (§7.11) | **absent** (net-new everywhere) | M1, M3, M5 |
| V6 | Automation rule/template versioning + content-drift backstop (§10.2) | absent | M3, M6 |
| V7 | Incremental `StatusIndex` (§7.12) | absent | M2 |
| V8 | Sync Streams Tier 0/1/2 (§7.3) | absent (legacy single-bucket Sync Rules) | M4 |
| V9 | Merge exceptions: `(sort_order, hlc)`, `mergeTimeEntries` union-not-sum (§7.10) | absent (no `hlc` col either) | M1, M3, M5 |
| V10 | External-fact gating: advisory only (§10.3) | likely-OK (verify) | M5, M7 |
| V11 | Idempotency retention ≥ `MAX_OFFLINE_HORIZON` (§7.2d) | partial (idempotency yes; retention contract no) | M3, M6 |
| V12 | Import restores data (non-replayable), HLC monotonic; encrypted export (§13.1) | absent | M6, M13 |
| — | Per-row `hlc` column on fact tables (§7.1) | absent (only `command_log`/`user_settings`) | M3 |
| — | Provenance columns + "why does this exist?" (§7.8) | absent | M3, M5, M9/M10 |
| — | Suggestion batch lifecycle + `block.accept/reject_suggestion` txn (§7.5) | tables absent; handlers are stubs | M3, M5, M6, M9 |
| — | Review inbox `sync_review_items` + all item_types (§7.13) | absent | M3, M5, M6, M8, M10 |
| — | `layout.renormalize_order` command (§7.10a/§8) | absent | M1, M5 |
| — | §7.6 FS/SS/FF/SF **scheduler-placement** constraints | verify in `core/scheduler` | M1, M6/M9 |
| — | §10.1 automation fixpoint (MAX_DEPTH=5) + §10.2 self-trigger rejection | verify/absent | M5, M8 |
| — | Server jobs `review.expire_resolved`, `import.validate`, `backup.snapshot` (§12) | absent | M6 |
| A | Persistent client read layer (v1.4 §7.14) | absent | M11 |
| C | Loading-aware, SWR reads (v1.4 §7.15) | absent | M12 |

---

## Sequencing Rationale

```text
M0 (spike: two-layer + client id + Sync Streams on a slice)
   └─ core ──────────────────────────────────────────────────────────────┐
      M1 (merge/sync/version + renormalize cmd + scheduler placement) ─ M2 (StatusIndex)
   └─ db ───────────────────────────────────────────────────────────────┐│
      M3 (schema: hlc col, schema_version, overlay, provenance, batches, review — additive/backfilled) ─ M4 (Sync Streams)
   └─ server ────────────────────────────────────────────────────────────┤
      M5 (6-step dispatcher + accept/reject txn + node.move/retype + fixpoint + response contract) ─ M6 (jobs)
   └─ gate ───────────────────────────────────────────────────────────────┤
      M7 (convergence harness: 6 → 13 scenarios)  ◄── must be green before client
   └─ client ──────────────────────────────────────────────────────────────┤
      M8 (two-layer client store + connector rewrite + overlay hooks + review inbox)
      M9 (suggestion/provenance/force-clock-in/weather UI)  ─  M10 (web review inbox + freshness)
      M11 (Fix A: hoist merged+StatusIndex read layer)  ── M12 (Fix C: loading-aware/SWR, covers screen-local tables)
   └─ portability + platforms + release ─────────────────────────────────────┘
      M13 (import/export client + secure storage + encryption)
      M14 (mobile + desktop parity)  ─  M15 (hardening, perf, security, delete crud-to-command, docs)
```

Front-load the highest-risk change (M0). Core → db → server → **convergence gate** → client → platforms. The two v1.4 read-path sessions (M11, M12) come after the client two-layer rework so they hoist the *final* merged read + `StatusIndex`.

---

## Phase M0 — Risk-Reduction Spike

### M0 · Two-layer store + client command identity + Sync Streams, end-to-end on a slice

**Deps:** none · **Spec:** §§3.2, 7.2, 7.2a–7.2f, 7.3, 13

Prove the load-bearing v1.3 contracts on **one existing command** (`node.rename`) before broad rework.

Build/Modify:
1. Add local-only `client_commands` + `overlay_effects` to the **client** schema (`schema.ts`) — **kept out of `appSchema`** so PowerSync never uploads them as row patches (verify this in the go/no-go).
2. Add `core/sync` `mergeRow`/`mergeTable` (minimal) and an `executeCommand('node.rename')` that validates, strips trust fields, **mints the client command id (UUIDv7) at write time**, writes `client_commands` + `overlay_effects` in one txn — replacing the direct `db.execute('UPDATE nodes …')`.
3. Merged read shows replica + pending overlay for the renamed node.
4. Upload this command from `client_commands` preserving the **stored id** (no `newId()` at upload); server persists `command_log` with `id == that id` (already the server's behavior — this proves V2 end-to-end client→server).
5. Wire one Sync Stream tier (Tier 0) for nodes; prove down-sync reconciles the overlay (delete `overlay_effects`, identical row, matching `created_by_command_id`).
6. Forced-rejection path: drop overlay (rollback) + create a `sync_review_items` row; the rejection carries the command id.

**DoD:**
- Offline rename shows instantly from the merged read; reconnect uploads exactly one named envelope carrying the **client-minted id** (no row patch, no upload-time id).
- Overlay reconciles to the identical canonical row, `created_by_command_id` matches (V2 end-to-end).
- Forced rejection removes the overlay and creates a synced review item bound to the command id.
- Second device receives the rename via Sync Stream; JWT scoping blocks cross-user receipt; overlay tables are confirmed absent from `appSchema`.
- Written go/no-go: PowerSync-on-the-existing-stack risk; confirm the `connector.ts` `getCrudBatch` path can be replaced by a `client_commands` reader (M8).

---

## Phase M1 — Core Primitives (`packages/core`)

### M1 · Merge, sync, version primitives + `layout.renormalize_order` + scheduler placement

**Deps:** M0 · **Spec:** §§7.6, 7.9a, 7.10, 7.11, 7.2c, 8, 13

Build/extend in `core`:
1. `core/merge`: default per-field LWW by HLC; `sort_order` collision via `(sort_order, hlc)`; `mergeTimeEntries` (union-not-sum, idempotent, order-independent).
2. `core/sync`: `mergeRow`/`mergeTable` overlay-merge pure functions (pending vs applied; insert/update/delete; minimal-field overlay).
3. `core/time`: HLC encode/compare/tick are **confirm-only** (already lexicographic in `hlc.ts`; reuse `hlcEncode`/`hlcCompare`/`hlcTick` names, no rename churn). Real work: add the lexicographic-order==causal-order property test if missing, and the **new `mergeHlc` receive-rule primitive** (does not exist).
4. `stripTrustFields` + command payload schemas excluding trust fields.
5. Command-version / payload-schema-version / **row `schema_version`** primitives + additive-only check (**fully net-new**); `depends_on` types; new error codes (`dependency_rejected`, `unknown_target`, `client_too_old`, `invalid_retype_children`, `blocked_task`).
6. **`layout.renormalize_order` command end-to-end in core** (absent today): Zod schema, `command_version`, idempotent pure effect builder over `(sort_order, hlc)`, provenance tagging — built **before** M5 wires its applier.
7. **§7.6 scheduler-placement constraints** in `core/scheduler` (verify/extend): successor start/finish at/after predecessor finish/start + lag per FS/SS/FF/SF edge type — the placement surface distinct from availability (M2) and completion (M5).
8. Portable export/import manifest schemas (import-restores-data / non-replayable).

**DoD:** merge property tests (concurrent insert-between → one order; `mergeTimeEntries` union/idempotent/order-independent); `core/sync` merge tests; lexicographic HLC property test; `mergeHlc` tests; additive-only check rejects a non-additive change; `stripTrustFields` removes ownership/provenance/system fields; `layout.renormalize_order` is idempotent over `(sort_order, hlc)`; FS/SS/FF/SF placement property tests (all three §7.6 surfaces now covered with M2+M5). Existing core suites green.

### M2 · Incremental `StatusIndex`

**Deps:** M1 · **Spec:** §§7.12, 9.1

Build in `core/status` (keep pure `statusOf`):
1. `StatusIndex` with `apply(effects)` recomputing status only for affected nodes + dependency neighbors; dependency registration for `completed_at`, open timers, edges/predecessors, sprint membership, committed future blocks, blocker results.

**DoD:** property test — incremental equals full rebuild over randomized effect streams; per-command recompute touches only affected nodes (instrumented). Existing status goldens green.

---

## Phase M2 — Database (`packages/db`)

### M3 · Schema migration for the 1.3 surface (additive, backfilled, live-DB-safe)

**Deps:** M1 · **Spec:** §§7.1, 7.5, 7.7, 7.8, 7.10a, 7.11, 7.13, 10.2

Forward-only **additive** migrations. **Every new server-assigned (NOT NULL) column ships with a DB-level DEFAULT or a backfill-then-set-NOT-NULL**, because the self-hosted Postgres is populated and migrations `0000`–`0007` never add a bare NOT-NULL column to live data.

1. **Per-row `hlc text not null`** added to `baseColumns` → every synced fact table (zero-padded §7.9a, server-assigned; backfilled for legacy rows). This is the backing column for `(sort_order, hlc)` and same-field LWW; surface it in core row types.
2. Local-only client schema for `client_commands` + `overlay_effects` (finalize M0 shapes; not in `appSchema`).
3. Row **`schema_version`** on every synced table, `DEFAULT <current-floor>` (legacy rows get the floor, never NULL).
4. Provenance columns (`created_by_command_id`, `last_modified_by_command_id`, `source_kind DEFAULT 'legacy'`, `source_id`, `source_detail`) on the §7.8 set **plus the as-built additions**: the **tag family** (`tags`, `tag_placements`, `tag_answers`) and a tier placement for `sprints`, `sprint_memberships`, `external_facts`, `user_settings` (the four `useFactContext` tables §7.1's list predates) — enumerate which receive provenance/`schema_version` vs are explicitly exempt.
5. `schedule_suggestion_batches` + `schedule_blocks` extensions (`suggestion_batch_id`, `replaces_block_id`, `superseded_at`) — required by M5's accept/reject transaction.
6. `sync_review_items` with the full `item_type` set (incl. `dependency_rejection`, `automation_drift`, `schema_version_block`, `automation_backstop`, `sync_warning`, `import_warning`).
7. `rule_version` on `automation_rules`; `template_version` in provenance `source_detail`. `depends_on` on `command_log`.
8. Server command-dedup table keyed by command id with a `MAX_OFFLINE_HORIZON` retention contract.
9. **Build** (not just verify) partial unique indexes for every §7.7 soft-deletable table, including the `computed_aggregates` **dual** indexes for nullable `subject_id` (user-level vs subject-level), and `decision_scores`/`diagram_layouts`.

**DoD:** migrations apply cleanly to a fresh Postgres **and to a SEEDED/populated Postgres with row counts preserved**; legacy rows get the floor `schema_version` (not NULL) and `source_kind='legacy'`; a static test proves no command handler targets `computed_aggregates`; recreate-after-soft-delete passes for every §7.7 table; Drizzle types == core row types (incl. new `hlc`/`schema_version`). State explicitly that M9 provenance / M5 "explains which command created a row" apply only to post-migration rows (legacy shows "origin unknown").

### M4 · Sync Rules → Sync Streams (Tier 0/1/2)

**Deps:** M3 · **Spec:** §7.3

1. Replace `sync-rules.yaml` with a Sync Streams config: **Tier 0 bootstrap / Tier 1 active / Tier 2 history**, scoped by verified JWT user id only; no client-widenable params. Place **all 21 synced tables** in a tier (incl. the tag family, decision/diagram/automation tables, `computed_aggregates`).
2. Sync `sync_review_items` in bootstrap/active; a **filtered command-result** stream (not broad `command_log`).
3. Tier 2 (old entries, completed history, large diagram layouts) subscribed lazily.

**DoD:** config validates; all tiers JWT-scoped; Tier 2 rows absent until subscribed and reads tolerate it; one user cannot receive another's rows; stream params cannot widen scope.

---

## Phase M3 — Server (`apps/server`)

### M5 · Dispatcher upgrade + suggestion transaction + revalidation + response contract

**Deps:** M2, M3, M4 · **Spec:** §§7.2b–7.2f, 7.5, 7.6, 7.8, 7.10, 7.11, 7.13, 8, 9.1, 10.1–10.3

Rework `apps/server/src/dispatcher.ts`:
1. Six-step pipeline: parse + **strip trust fields**, ownership from JWT, `depends_on`/causal check, invariants (core), Drizzle txn, command log. (`command_log.id == client id` already holds server-side — keep it; the net-new identity work is client-side, M8.)
2. Causal rejection: `dependency_rejected` + `unknown_target` with linked review items; HLC-ordered apply per device.
3. Server-assigned provenance/ownership/system/timestamp/`hlc`/`schema_version` on every created/updated row; client values ignored.
4. Merge exceptions on apply: `sort_order` via `(sort_order, hlc)`; timer via `mergeTimeEntries`; same-field HLC LWW.
5. Row `schema_version` floor → `client_too_old`; payload-version migrate-or-reject.
6. **Upgrade the existing minimal `block.accept_suggestion`/`block.reject_suggestion` handlers (dispatcher.ts:394-409) to the full §7.5 transaction**: verify not superseded/deleted, verify task not done, soft-delete/move the replaced block, reject on anchored-block overlap, promote to `committed`, mark conflicting suggestions superseded — a rejecting test per branch. M9's optimistic builder **mirrors** this rule, it does not replace it.
7. Command rules: `timer.clock_in` `force` on blocked; **`node.move` and `node.retype` revalidate hierarchy typing + justification** (ancestry reaches a Vision or `habit_id`), `node.retype` orphan rule → `invalid_retype_children`; wire the `layout.renormalize_order` applier (built in M1); FF/SF/FS completion validators with edge-specific errors.
8. **Automation (§10.1):** synchronous in-txn execution to fixpoint (`MAX_DEPTH=5`), server re-applied authoritatively; **reject a self-triggering rule at `rule.create`/`rule.update`** (§10.2).
9. `sync_review_items` creation for rejections, dependency rejections, material HLC conflicts, stale suggestions, schema-version blocks. External facts never gate acceptance (V10).
10. **Freeze the `uploadData` response contract** as a named deliverable: per-command `result ∈ {applied,rejected,noop}`, `reject_code`, server-assigned ids incl. `created_by_command_id`, and any review-item ids — the shape M7 asserts and M8 parses.

**DoD:** one rejecting test per invariant; replay → `noop` with original result; trust-field test (client `user_id`/provenance ignored & overwritten); `dependency_rejected` + linked review item; same-row-different-field merges without clobber; same-field resolves by HLC; below-floor `schema_version` → `client_too_old` + review item; `node.move`/`node.retype` revalidation rejecting tests; self-triggering rule rejected; accept/reject §7.5 branches each tested; automation fixpoint converges and is server-re-applied; the response-contract shape has a schema test. The v1.0 (6-scenario) convergence harness stays green.

### M6 · Jobs: drift, retention, batches, review-item producers, portability jobs

**Deps:** M5 · **Spec:** §§7.4, 7.5, 7.13, 10.2, 12, 13

Modify/add jobs:
1. `aggregates-recompute`: transactional snapshot + HLC/`updated_at` guard (never clobber a later command); server-job provenance.
2. `automation-backstop`: content-hash drift → `automation_drift` review item on content mismatch (same UUIDv5 id); **also emit the `automation_backstop` info item** when it adds rows the client didn't create locally; no-op on content-equivalent.
3. `retention-purge`: preserve command-dedup records younger than `MAX_OFFLINE_HORIZON`.
4. `schedule-optimize` / `pastdue-scan`: emit `schedule_suggestion_batches`; supersede older non-accepted suggestions in the same horizon; suggestion provenance; validate FS/SS/FF/SF placement (M1).
5. `layout-precompute`: Tier 2 / on-demand.
6. **New jobs (§12):** `review.expire_resolved` (weekly soft-delete of resolved `sync_review_items` past retention); `import.validate` (dry-run report emitting `import_warning` review items); `backup.snapshot` (portable export artifact). The `sync_warning` item_type producer is assigned here where a job detects a sync anomaly.

**DoD:** backstop no-ops on content-equivalent rows, creates a drift item on mismatch, and an `automation_backstop` item when filling missed rows; recompute does not overwrite a later command's fact; `retention.purge` leaves in-horizon dedup intact; past-due yields one active suggestion per batch strategy; newer batch supersedes older; `review.expire_resolved` purges old resolved items while open/in-horizon survive; `import.validate` dry-run emits `import_warning` without writing rows.

---

## Phase M4 — Convergence Gate

### M7 · Convergence harness: 6 → 13 scenarios

**Deps:** M5, M6 · **Spec:** §§7.2, 7.6, 7.10, 7.11, 13, 14

Extend the existing v1.0 two-device harness (`convergence.integration.test.ts`). It currently has **6** `it('scenario…')` blocks over a plain SQLite queue **with no overlay tables** — the overlay shape is what **M7 builds** (post-M8 client model), not the v1.0 baseline. Its device id already equals `command_log.id` (partially proving V2 at the harness layer).

Keep the existing 6 (offline different-row; same-row-different-field; same-field HLC winner; automation UUIDv5 convergence; soft-deleted-unique recreate; **tag-answer HLC**). Add:
7. Overlay reconciliation: optimistic row → identical canonical row, matching `created_by_command_id`.
8. Rejected offline command → review inbox; overlay rolls back.
9. Double clock-in resolved by `mergeTimeEntries` (union-not-sum).
10. `sort_order` "insert between same pair" collision → one deterministic order.
11. Mixed-schema-version devices (N-1 ignores added column, N writes it) — no corruption.
12. `dependency_rejected` cascade from a rejected `depends_on`.
13. Divergent weather facts converge to identical committed state. (Older-command-version migration folded into the same rig.)

**DoD:** all scenarios green under `pnpm test:convergence`; harness proves command envelopes (with client-minted ids) are the only trusted upload and overlay effects never upload as row patches; the M5 response contract is asserted here; review items sync to the affected device. **M8+ may not start until this is green.**

---

## Phase M5 — Client (`apps/web` + `packages/ui`)

### M8 · Two-layer client store + connector rewrite + overlay hooks + review inbox

**Deps:** M7 · **Spec:** §§7.2, 7.2d, 7.13, 9.1

Rework the client data layer. **This session intentionally changes both the upload and rollback paths**; update the affected S16–S20 assertions.
1. `packages/ui/src/powersync/commands.ts`: replace direct replica `db.execute` writes with `executeCommand` writing `client_commands` + `overlay_effects` in one txn (validate against merged state, strip trust fields, **mint the command id + tick HLC at write**, compute `depends_on`). Automation rules run to fixpoint (`MAX_DEPTH=5`, §10.1) **inside the same overlay txn**, their spawned effects landing as `overlay_effects`; the server re-applies authoritatively (M5 step 8).
2. **`packages/ui/src/powersync/connector.ts` (the real edit site, L49-61):** replace the `getCrudBatch()` → `crudToCommand` → `newId()` loop with a `client_commands` reader that uploads in HLC order honoring `depends_on` and **preserves the stored command id and HLC** (kills `newId()`-at-upload — required for V2). Every verb `crudToCommand` produces must have an `executeCommand` writer **before** removal; until then keep `crud-to-command.ts` as a **loud guard** that throws if any replica-table CRUD op reaches the upload batch (it stays a public `@prisms/ui` export with its test until M15). On `applied` → reconcile via the M5 response contract; on `rejected` → drop overlay + ensure review item.
3. `hooks.ts`: reads become `mergeTable(replica, overlay)`; **status served from the `StatusIndex` (M2) through a context/selector seam** — an interim app-level singleton, so M11 is a *hoist*, not a rewrite. Rejection rollback = drop overlay.
4. `apps/web/src/App.tsx` + `connector` `onReject`: thread the **rejected command id** so rollback drops the matching `overlay_effects`/`client_commands` row (today `onReject` has no id binding).
5. Review-inbox data hook (rejections, dependency rejections, conflicts, stale suggestions, drift, backstop, schema blocks, import/sync warnings).

**DoD:** rejected optimistic edit visibly rolls back by dropping its overlay (rollback assertions updated from the old "canonical re-syncs" behavior); a named command envelope with the client-minted id is uploaded and no row patch; an unported verb cannot silently no-op (loud guard fires in a test); server rejection appears in the review inbox after reconnect; airplane-mode reload renders from local SQLite; S16–S20 e2e pass with updated upload/rollback assertions.

### M9 · 1.3 interaction surfaces

**Deps:** M8 · **Spec:** §§7.5, 7.8, 8, 9.1, 10.3

1. Suggestion batches: dashed suggested blocks with accept/reject; the optimistic `block.accept_suggestion` builder **mirrors** the M5 server transaction; stale-suggestion rejection UI + linked review item; supersession reflected.
2. Provenance "why does this exist?" affordance for tasks and suggestions (post-migration rows; legacy shows "origin unknown").
3. `force` clock-in on a blocked task surfaced explicitly; `ongoing` wins precedence.
4. Weather-unverified advisory badge; never blocks acceptance.
5. `schema_version_block` upgrade prompt in the UI.

**DoD:** Playwright — accept a valid suggestion promotes it (and the replaced block resolves per §7.5); accepting a stale suggestion surfaces the machine-readable rejection + review item; provenance explains user- vs automation-created tasks; forced clock-in shows `ongoing`.

### M10 · Web review inbox + freshness + dashboard/decision parity

**Deps:** M8 · **Spec:** §§7.4, 7.13, 1

1. Review inbox screen (open/resolve/dismiss) for all `item_type`s.
2. `computed_at` freshness labels; local incremental overlay reconciles to server canonical.
3. Confirm decision-board ranking, burndown/projection, completion render from merged local state.

**DoD:** review inbox shows a synced rejection and resolves/dismisses; freshness label reflects server aggregate timestamp; no dashboard path uploads a local aggregate cache.

### M11 · Fix A — persistent client read layer (v1.4 §7.14)

**Deps:** M8 (M9/M10 may run in parallel) · **Spec:** v1.4 §7.14, Table→Owner Matrix; `apps/web/src/App.tsx`, `packages/ui/src/hooks.ts`

1. `PrismsDataProvider` mounted **above** the router in `App.tsx` (inside `PowerSyncContext.Provider`, above `Layout`/route switch L71-126). It owns, once per session: the merged replica+overlay subscriptions for the **StatusIndex/FactContext base tables (the 9)** plus the other shared tables consumed by more than one screen, the derived `FactContext`/`TreeIndex`, and the **single session-scoped `StatusIndex`** (promoting the M8 interim singleton — a hoist, not a rewrite). Exposes `factContext`, raw shared collections, a stable `commandContext`, `isFetching`, `isHydrated`.
2. Route every shared-table consumer (incl. the duplicate base subscriptions in `useWorklist`/`useAgenda`/`useHabits`/`useDashboard`/`useRunningTimer`/standalone `useNodeTree`/`useGantt`) to the warm sets; per-`now` derivation stays local. Genuinely screen-local tables (`decision_*`, `diagram_*`, `tags*`, `habits`/`habit_completions`, `automation_rules`, `computed_aggregates`) stay screen-scoped but are made flash-proof by M12's cache — per the v1.4 Table→Owner Matrix.
3. Do not change the db identity used by writers; `executeCommand` still binds to the live db (M8).

**DoD:** two full tab round-trips create the shared-table subscriptions once and rebuild `FactContext`/`StatusIndex` a constant number of times independent of navigation (provider/db spy); no screen creates a shared subscription; provider + `factContext` survive navigation; optimistic-write reactivity + overlay rollback intact; M7 convergence and S16–S20 e2e green.

### M12 · Fix C — loading-aware, stale-while-revalidate reads (v1.4 §7.15)

**Deps:** M11 · **Spec:** v1.4 §7.15; `packages/ui/src/hooks.ts`

1. Replace `useRows = useQuery(sql).data ?? []` with `{ data, isLoading, isFetching }` backed by a last-known-rows cache surviving **remount**: provider-level for shared tables, module/session-scoped (keyed by query+params) for **screen-local reads — explicitly covering Habits, Decisions, and Flowchart** so those tabs don't flash.
2. `isHydrated` grounded on a conjunction with PowerSync `useStatus().hasSynced` (the app passes no `streams` to `useQuery`, so a fresh login otherwise resolves empty-before-sync and flashes the empty branch) — plus a "row already exists" fallback so an offline populated reload doesn't stick on a skeleton.
3. Per-branch empty-state gating across all 12 screens (lists, sections, and `<select>` placeholders like Gantt's project picker and Habits' "Create a vision first"): empty only when `isHydrated && length === 0`; skeleton otherwise.
4. Confirm the 1s `now` tick does not rebuild the fact/tree index (structurally true after M11); per-`now` selectors still recompute.

**DoD:** fresh-account first login (empty replica, sync in flight) shows a skeleton not empty; offline populated reload shows data not a stuck skeleton; tab-away-and-back returns prior rows synchronously (remount SWR) **including Habits/Decisions/Flowchart**; confirmed-empty still shows the empty branch; a Playwright `v14.spec.ts` proves no empty-then-fill flash and warm synchronous revisit.

---

## Phase M6 — Portability, Platforms, Hardening

### M13 · Import/export client + secure storage + encryption

**Deps:** M5, M6, M8 · **Spec:** §§13.1, 13.2

1. Client import/export wired to the M1 manifest schemas and the M6 `import.validate`/`backup.snapshot` jobs: dry-run validate; import **restores data** (command history non-replayable); advance device HLC past max imported HLC (monotonicity); import conflicts → `import_warning` review items.
2. Encrypted export default on installed targets; optional passphrase encryption on web.
3. Auth/session secrets via platform-secure storage; DB-encryption adapter port (no core changes).

**DoD:** export includes facts/settings/command-history/review-items, excludes secrets; dry-run reports conflicts without writing; "import then edit" yields monotonic ordering + deterministic converged result; installed-target export encrypted by default.

### M14 · Mobile + desktop parity

**Deps:** M8–M12, M0 desktop note · **Spec:** §§7.2, 7.3, 13, 12.3

1. `apps/mobile` (Expo): two-layer `executeCommand`/overlay path + the `client_commands` upload (no `newId()`-at-upload); Tier 0/1 subscribed, Tier 2 lazy; review inbox; secure storage; encrypted export; loading-aware reads.
2. `apps/desktop` (Tauri): native SQLite two-layer store; secure storage; OS notifications; review inbox; the M11/M12 read layer via the shared web build.

**DoD:** mobile + desktop pass the S16-equivalent offline command/sync flow; rejected command appears in each platform's review inbox after reconnect; Tier 2 loads lazily; secrets in secure storage; export encrypted by default.

### M15 · Hardening, perf, security, cleanup, release

**Deps:** all · **Spec:** §§7.11, 7.12, 13–17, v1.4 §7.14/§7.15

1. **Delete `crud-to-command.ts`** (and remove the `@prisms/ui` export) only after a coverage test enumerates every `CommandName` and proves each has an `executeCommand` writer — retiring the M8 loud guard.
2. Full CI matrix: unit, property, **convergence (M7)**, Playwright (incl. `v14.spec.ts`), mobile e2e, desktop smoke, perf; core coverage ≥ 90%.
3. Perf: 100k-node seed — **per-command** status recompute via `StatusIndex` within budget; tab-switch creates no base re-query (read-path counters invariant); agenda render within budget.
4. Security review: command upload as the only trusted write path; Sync Streams auth + stream-parameter scoping; trust-field assignment; secure storage; local-encryption limitations; export behavior.
5. Update production compose, `.env.example`, backup/restore, README, self-hosting guide for the 1.4 surface.

**DoD:** one-command fresh deploy serves web/API/Postgres/sync; all suites green incl. `test:convergence` and the read-path no-flash/no-re-query gates; 100k-node per-command status + agenda within budget; named commands proven the only trusted write path (no verb left on the old CRUD path); cross-user stream isolation proven; export/import round-trip preserves facts/provenance/review items without replaying commands.

---

## Relationship To The Other Planning Docs

- **`ARCHITECTURE_1.3.md`** is the normative spec for M0–M10, M13–M15. Its §§7.14/7.15 (from v1.4) govern M11–M12.
- **`BUILD_PLAN_REVISED_v1.3.md`** is the greenfield equivalent; this plan re-expresses its `[1.3]` deltas as migrations against the real code and adds the v1.0-baseline audit it assumed away.
- **`BUILD_PLAN_REVISED_v1.4.md`** (the standalone A+C increment) is **superseded** by M11–M12 here, which hoist the v1.3 two-layer merge + `StatusIndex`; its Table→Owner Matrix is reused by M11/M12.

## Risk Notes

- **M0 is the gate on feasibility.** If PowerSync on the existing stack can't carry the explicit `client_commands` upload + Sync Streams, surface it there, not in M8. Confirm overlay tables stay out of `appSchema`.
- **M3 is a live-DB migration.** Bare NOT-NULL columns fail on populated tables — every new column needs a DEFAULT or backfill-then-enforce; the per-row `hlc` column is the most load-bearing addition. Legacy rows carry `source_kind='legacy'` and "origin unknown" provenance.
- **M8 changes upload AND rollback semantics** and rewrites `connector.ts`. Stage the `crud-to-command` cutover behind the loud guard; do not delete it until M15's coverage test passes, or uploads silently break for unported verbs. `crudToCommand` is a public export — note the API change.
- **Do not begin M8 until M7 is green.** The convergence harness proves the server contracts (and the M5 response shape) before the UI depends on them.
- **M11/M12 ordering:** Fix A before Fix C; the provider is where the SWR cache and `isHydrated`/`hasSynced` gating live for shared tables, and M12 must additionally cover the screen-local tables (Habits/Decisions/Flowchart).
