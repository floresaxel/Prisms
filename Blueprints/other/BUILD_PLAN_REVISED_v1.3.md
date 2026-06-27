# Prisms - Session-Sized Build Plan, Revised

Version 1.3. Companion to `ARCHITECTURE_REVISED_v1.3.md`. This file decomposes the build into 24 sessions: one risk-reduction spike (`S0`) plus 23 implementation sessions. Sessions are dependency-ordered. Never start a session whose dependencies have not passed their Definition of Done.

Version 1.3 adds the runtime-convergence work introduced in architecture §§7.2, 7.10-7.12, 10.2, 13.1. New or changed steps and DoD lines are marked **[1.3]**.

## Changes From The 1.2 Build Plan

| Area | Affected sessions | Change |
| --- | --- | --- |
| Two-layer client store | S0, S2, S3, S11, S12, S15, S21, S22 | Split client store into read-only canonical replica + local-only optimistic overlay. UI reads the merge. Rollback drops overlay entries; never edits replica rows. |
| Command identity | S0, S2, S11, S12 | `command_log.id` must equal the client command id. Optimistic provenance must match server provenance after sync. |
| Command ordering / causal rejection | S2, S11, S12 | Add `depends_on`, HLC-ordered apply, and `dependency_rejected` handling with linked review items. |
| Trust fields server-assigned | S2, S11, S12 | Strip and overwrite client-supplied ownership/provenance/system/version/timestamp fields. |
| Synced-row schema versioning | S2, S3, S11, S12, S23 | Row-shape `schema_version` separate from command versioning; additive-only; mixed-version device test. |
| Automation drift | S7, S13 | Version rule/action templates; backstop checks content equivalence; drift review items. |
| Derived-status index | S5, S16, S23 | Maintain incremental, fact-keyed `StatusIndex`; measure per-command recompute at 100k. |
| Stream tiers required | S3, S10, S23 | Build Tier 0/1/2 streams before the 100k load test, not as deferred optimization. |
| Merge exceptions | S2, S4, S12, S16 | Deterministic merge for `sort_order` collisions and timer intervals; union-not-sum effective hours. |
| External-fact gating | S5, S13, S23 | External-fact-derived state advisory only; never gates command acceptance or convergence. |
| Idempotency retention | S11, S13 | Command-dedup retained >= `MAX_OFFLINE_HORIZON`; purge must not delete inside the horizon. |
| Import semantics | S2, S23 | Import restores data, does not replay commands, preserves HLC monotonicity; encrypted export default on installed targets. |
| HLC encoding | S2 | Zero-padded, lexicographically sortable HLC text encoding with property tests. |
| Verification gates | All sessions | Add overlay-reconciliation, causal-ordering, trust-field, mixed-schema, sort_order-collision, timer-merge, drift, and perf gates. |

## Session Protocol

Apply to every session.

1. Read the `ARCHITECTURE_REVISED_v1.3.md` sections listed under **Spec**.
2. Work on a branch `sNN-<slug>` or `s0-<slug>`.
3. Write tests first or alongside code. The DoD is the exit gate.
4. Run the full test suite for every upstream package before finishing.
5. Do not build ahead. Stub later-session functions with a typed `TODO(sNN)` throw.
6. No UI or app code may write canonical replica tables directly. All user writes go through `executeCommand`, which writes only overlay tables locally.
7. No server endpoint may accept arbitrary SQL, generic entity updates, or generic PowerSync row patches as the trusted write path.
8. Commands, exports, and imports carry explicit version information; row-shape `schema_version` is tracked separately from command version.
9. Material conflicts, rejections, dependency rejections, and drift create durable review items.
10. Provider SDKs stay outside `packages/core`; external facts never gate command acceptance.
11. Trust fields (ownership/provenance/system/version/server-timestamps) are server-assigned; client values are stripped.
12. At session end, report which DoD checks passed and which are blocked.

---

## Phase 0 - Highest-Risk Technical Spike

### S0 - Command bridge, two-layer store, Sync Streams, desktop feasibility

**Deps:** none

**Spec:** §§3.2, 4 (14-16), 7.2, 7.2a-7.2f, 7.3, 7.9a, 13, 14 (Phase 0)

Build a minimal vertical slice before broad implementation. May be a throwaway spike or the seed of the final repo.

Build:

1. Minimal pnpm workspace with `packages/core`, `packages/db`, `apps/server`, `apps/web`, and a tiny `apps/desktop` shell if feasible.
2. One canonical replica table: `nodes` (PowerSync-downloaded, read-only on the client).
3. Local-only overlay tables: `client_commands` and `overlay_effects`. **[1.3]**
4. One command: `node.rename`.
5. `executeCommand(name, payload)` that validates, strips trust fields, runs invariant checks against merged state, writes `client_commands` + `overlay_effects` in one SQLite transaction, and returns the optimistic result. **[1.3]**
6. Read-time merge selector (`mergeRow`/`mergeTable`) so the UI shows replica + pending overlay. **[1.3]**
7. PowerSync Sync Streams (3 tiers wired, even if Tier 0 carries the demo data) for the authenticated user's nodes. **[1.3]**
8. `uploadData()` that uploads only command envelopes from `client_commands`; it must fail loudly if any replica-table row op appears in the upload batch. **[1.3]**
9. Server command endpoint accepting only named commands; persists `command_log` using the client command id as the primary key. **[1.3]**
10. Postgres write through the server dispatcher; server assigns all trust fields. **[1.3]**
11. Command, command-payload-schema, row-`schema_version`, and client version fields on the envelope. **[1.3]**
12. Command-log effect summary and server-assigned provenance for the rename.
13. Reconciliation: after `applied` ack and arrival of the canonical row, delete the command's `overlay_effects` and confirm the merged read is unchanged (identical row, identical `created_by_command_id`). **[1.3]**
14. A forced rejection path that deletes overlay effects (rollback) and creates a synced review item. **[1.3]**
15. A two-device test: device A renames offline, reconnects, server applies, device B receives the row via Sync Stream.
16. Desktop feasibility check: Tauri opens the local store and uses the selected PowerSync path, or the blocker is documented with a proposed fallback.

DoD:

- Offline rename appears instantly in the merged read from local SQLite.
- Reconnect uploads exactly one named command envelope; no row patch is uploaded.
- **[1.3]** The optimistic overlay row reconciles to the identical canonical row after sync, with matching `created_by_command_id` (proves `command_log.id == client command id`).
- **[1.3]** A forced rejection removes the overlay effect from merged reads and creates a durable, synced review item.
- Server rejects or ignores any generic domain row patch for the same rename path.
- Second device receives the rename through Sync Streams.
- JWT scoping prevents another user from receiving the row; stream params cannot widen scope.
- Tauri feasibility report names the selected desktop approach or accepted risk.
- The rename row can explain which command last modified it.

---

## Phase A - Foundations

### S1 - Monorepo scaffold

**Deps:** S0 accepted or consciously waived

**Spec:** §§5, 6, 17

Build:

1. pnpm workspace and Turborepo.
2. `packages/{core,db,ui,adapters}` and `apps/{web,mobile,desktop,server}` skeletons, including `core/src/{merge,sync,status}` directories. **[1.3]**
3. Strict shared TypeScript config.
4. ESLint plus `eslint-plugin-boundaries`.
5. Core purity bans: no `Date.now`, `Math.random`, fetch, timers, browser storage, filesystem, or network in `packages/core`.
6. Vitest config with `test:property`, `test:convergence`, and `test:perf` script stubs. **[1.3]**
7. GitHub Actions CI for lint, typecheck, and tests.
8. `docker-compose.yml` stub with Postgres, PowerSync, and API services.
9. Current stable React baseline for the web app skeleton.

DoD:

- `pnpm lint`, `pnpm typecheck`, and `pnpm test` are green locally and in CI.
- A deliberate forbidden import in `packages/core` fails lint.
- Compose boots Postgres.
- Workspace dependency boundaries are enforced; apps cannot import server code.
- Provider SDK imports in `packages/core` fail lint.

### S2 - Domain types, schemas, time, merge, and version primitives

**Deps:** S1

**Spec:** §§7, 8, 9.2, 7.9a, 7.10, 7.11, 13, 17

Build in `packages/core`:

1. Entity TypeScript types and Zod schemas for all domain tables, each carrying `hlc` and `schema_version`. **[1.3]**
2. Zod schemas for `client_commands`, `overlay_effects`, server `command_log`, `schedule_suggestion_batches`, `sync_review_items`, provenance fields, and suggestion lifecycle fields. **[1.3]**
3. Command payload schemas that exclude trust fields; a `stripTrustFields` helper used before validation. **[1.3]**
4. `computed_aggregates` schema with `computed_by = 'server'` only.
5. `Result<T, DomainError>` and a complete machine-readable error-code enum (including `blocked_task`, `invalid_retype_children`, `dependency_rejected`, `unknown_target`, `client_too_old`). **[1.3]**
6. HLC encode/compare/tick/merge/device-tiebreak with the zero-padded, lexicographically sortable text encoding (§7.9a). **[1.3]**
7. `bucketDate(ts, timezone, dayResetHour)` and duration math.
8. Injected `Clock` and `Rng` interfaces.
9. UUIDv7 and deterministic UUIDv5 helpers with `PRISMS_NS`.
10. Dependency semantic types for FS, SS, FF, SF.
11. Command-version, command-payload-schema-version, row-`schema_version`, client-version, and migrator primitives, with the row-schema compatibility policy encoded (additive-only check). **[1.3]**
12. `core/merge`: deterministic merge functions for default per-field LWW, `sort_order` collision resolution (`(sort_order, hlc)` key), and `mergeTimeEntries` (union-not-sum). **[1.3]**
13. `core/sync`: `mergeRow`/`mergeTable` overlay-merge pure functions. **[1.3]**
14. Portable export/import manifest schemas with import-restores-data (non-replayable command history) semantics. **[1.3]**
15. Recurrence/timezone test harness fixtures for RRULE, day reset, DST, and habit buckets.

DoD:

- Schema round-trip tests for all entities.
- HLC property tests prove monotonicity, total order, deterministic device tiebreak, and that lexicographic text order equals causal order. **[1.3]**
- Day-reset golden tests cover timezone and DST boundary cases.
- UUIDv5 determinism test passes.
- `computed_aggregates` rejects client-owned values; `stripTrustFields` removes ownership/provenance/system fields before validation. **[1.3]**
- **[1.3]** `core/merge` property tests: two concurrent "insert between same pair" converge to one order; `mergeTimeEntries` unions overlapping intervals, is idempotent and order-independent.
- **[1.3]** `core/sync` merge tests: overlay over null canonical yields synthetic row; delete yields null; only named fields overlay; pending vs applied effects handled.
- Export manifest schema validates and rejects unsupported versions; import manifest marks command history non-replayable. **[1.3]**
- Command version migrator tests pass for one supported older payload and one unsupported payload; additive-only row-schema check rejects a non-additive change. **[1.3]**

### S3 - Database package and Sync Streams

**Deps:** S2

**Spec:** §§7.1-7.13, 13, 14 (Phase 1)

Build in `packages/db`:

1. Drizzle schema and forward-only migrations; all rows carry `hlc` and `schema_version`. **[1.3]**
2. All core domain tables.
3. Client-side local schema definitions for `client_commands` and `overlay_effects` (overlay tables, not synced). **[1.3]**
4. `schedule_suggestion_batches` and extended `schedule_blocks`.
5. `computed_aggregates` as server-owned only, with a static check proving no command handler targets it. **[1.3]**
6. Provenance columns on user-visible rows.
7. `sync_review_items` with the extended `item_type` set (dependency_rejection, automation_drift, schema_version_block). **[1.3]**
8. Partial unique indexes for all soft-deletable uniqueness rules.
9. DB backstops for core invariants where practical, including the `(sort_order, hlc)` ordering expectation. **[1.3]**
10. PowerSync Sync Streams config with three tiers (Tier 0 bootstrap, Tier 1 active, Tier 2 history/archive), scoped by verified JWT user id only. **[1.3]**
11. Server command-dedup table keyed by command id with a `MAX_OFFLINE_HORIZON` retention contract. **[1.3]**
12. A seed script with a realistic demo user: 4 visions, habits, project tree, dependencies, schedule blocks, time entries, provenance, and one review item.

DoD:

- Migrations apply cleanly to fresh Postgres in compose.
- Drizzle types match core types through compile-time assertions.
- Seed runs successfully.
- Sync Streams config validates; all three tiers are defined and JWT-scoped. **[1.3]**
- Recreate-after-soft-delete tests pass for edges, habit completions, sprint memberships, decision scores, and diagram layouts.
- `command_log` is not broadly synced; only a filtered command-result stream is.
- Review items are synced in the bootstrap/active stream.
- Provenance and `schema_version` fields compile against core types.
- **[1.3]** A test proves Tier 2 rows are absent until their stream is subscribed and reads tolerate that.

---

## Phase B - Core Engines

### S4 - Graph module

**Deps:** S2

**Spec:** §§7.1, 7.7, 7.10a, 9.1

Build `core/graph`:

1. Child, subtree, and ancestor queries over in-memory fact sets.
2. Fractional `sort_order` generation using the `(sort_order, hlc)` ordering key. **[1.3]**
3. DAG cycle detection for edges.
4. Hierarchy typing validator (used by `node.retype` orphan checks). **[1.3]**
5. Justification check: ancestry reaches a vision or task has `habit_id`.
6. Soft-delete closure.
7. Critical path over estimates.

DoD:

- Random edge insertion property tests never admit a cycle.
- Parent/child type matrix tests pass; retype orphan detection has a golden test. **[1.3]**
- Generate-between test creates 1,000 positions without collision; colliding fractions break deterministically by HLC. **[1.3]**
- Justification and cascade golden tests pass.

### S5 - Status, dependency gates, predicate AST, and status index

**Deps:** S4

**Spec:** §§7.6, 7.12, 9.1, 10

Build:

1. `core/status` with exact precedence: `done > ongoing > blocked > scheduled > prioritized > available`.
2. FS availability gate; SS availability gate.
3. FF and SF completion gates (not availability gates).
4. Project phase derivation.
5. Shared predicate AST evaluator with `all`, `any`, `not`, operators, and fact resolvers for node, ancestor, project phase, graph, date, and weather.
6. `unknown` weather semantics: not blocked plus UI badge state; advisory only, never affects command acceptance. **[1.3]**
7. **[1.3]** Incremental `StatusIndex`: `apply(effects)` recomputes status only for affected nodes and dependency neighbors; dependency registration for completed_at, open timers, edges/predecessors, sprint membership, committed future blocks, and blocker results.

DoD:

- Golden table covers every status precedence collision, including forced-clock-in-on-blocked showing `ongoing`. **[1.3]**
- FS, SS, FF, SF tests distinguish availability, scheduling, and completion gates.
- Completion rejects unmet FF/SF requirements with edge-specific error details.
- Weather absent evaluates unknown, does not hard-block, and never changes command acceptance. **[1.3]**
- Project phase derivation tests pass.
- **[1.3]** `StatusIndex` property test: incremental status equals full rebuild over randomized command streams.

### S6 - Aggregates

**Deps:** S5

**Spec:** §§7.4, 7.10b, 9.2, 13, 14 (Phase 5)

Build `core/aggregates`:

1. Effective hours, consuming `mergeTimeEntries` so overlapping intervals union not sum. **[1.3]**
2. Practice hours and levels.
3. All six streak modes, including `perfect_planned`.
4. Task progress.
5. Project completion percentage.
6. Burndown series and linear projection.
7. Time-left indicators.
8. Incremental and canonical entry points in pure core.
9. Explicit type separation between local-only client aggregate output and server-owned `computed_aggregates`.
10. Server aggregate provenance output shape.

DoD:

- For every metric, property test proves `incremental(facts) === canonical(facts)` over randomized streams.
- **[1.3]** Effective-hours test proves overlapping/double-clock-in intervals union (no double counting).
- Streak golden tests cover each mode and day-reset boundaries.
- Burndown scope-change test passes.
- No test or type path allows a client incremental aggregate to become an uploaded Postgres row.
- Canonical aggregate output includes source/job provenance.

### S7 - Rules engine

**Deps:** S5

**Spec:** §10, §7.8

Build `core/rules`:

1. Predicate integration for automation conditions.
2. Action executor for `spawn_task`.
3. Template interpolation with a `template_version` constant. **[1.3]**
4. `edge_from_slot`.
5. Trigger-relative date math from triggering fact timestamps.
6. Fixpoint loop with `MAX_DEPTH = 5`.
7. Self-trigger validation at rule creation.
8. Deterministic UUIDv5 output IDs.
9. Pure transactional output: return rows/effects for the command executor to commit (as overlay effects on the client).
10. Automation provenance for spawned tasks, blocks, and edges, recording `rule_version` and `template_version`. **[1.3]**
11. A canonical content-hash function over spawned fields for drift detection. **[1.3]**

DoD:

- Lecture example creates pre-brief, study task, and FS edge.
- Two simulated offline devices produce byte-identical automation outputs at the same rule/template version.
- **[1.3]** With divergent rule/template versions, outputs share the same id but the content hash differs, and the difference is detectable (feeds S13 drift).
- Depth guard test passes.
- Self-triggering rule is rejected.
- Replay is a no-op.
- Spawned rows link to automation rule, trigger command, trigger node, action slot, rule version, and template version. **[1.3]**

### S8 - Scheduler greedy mode

**Deps:** S5

**Spec:** §§7.5, 7.6, 11

Build `core/scheduler`:

1. Scheduler input model, operating on a bounded horizon window. **[1.3]**
2. `mode: 'greedy'` earliest-fit placement.
3. Anchored-block hard constraints.
4. No overlap constraints.
5. Done-task exclusion.
6. Task time-window constraints.
7. FS, SS, FF, SF scheduling constraints.
8. `validWindowsFor(task)` for agenda drag/tap hints.
9. Single-task past-due reschedule helper.
10. Proposal shape compatible with suggestion batches.

DoD:

- fast-check proves output never overlaps anchored blocks.
- fast-check proves dependencies are never violated.
- Scheduler is idempotent on its own output.
- Window-hint goldens pass.
- Unplaceable reasons are emitted and stable.

### S9 - Scheduler optimize mode

**Deps:** S8

**Spec:** §§7.5, 11, 12

Build:

1. `mode: 'optimize'` using deterministic local search over greedy seed.
2. Weighted soft objectives: due dates, sprint preference, fragmentation, daily habit targets.
3. Proposal diffing against current committed plan.
4. Suggestion batch builder.
5. Supersession metadata for older suggestions in the same horizon.
6. Scheduler provenance for suggestions and replacements.

DoD:

- Hard-constraint property suite from S8 still passes.
- Objective fixtures prove optimize score is at least greedy score on canned plans.
- Fixed RNG seed produces deterministic output.
- Suggestions are grouped into batches with horizon and source metadata.
- Suggested blocks explain their source batch and replaced block.

---

## Phase C - Server

### S10 - API shell, auth, and PowerSync auth

**Deps:** S3

**Spec:** §§5, 7.3, 13

Build `apps/server`:

1. Hono app.
2. Auth using Better Auth or accepted equivalent.
3. Short-lived JWTs consumable by API and PowerSync.
4. `/health`.
5. Request logging.
6. Per-user and per-verb rate limiting.
7. PowerSync configuration wired to the three Sync Streams tiers, JWT-scoped, no client-widenable params. **[1.3]**
8. `settings.update` as the first command endpoint smoke test, persisting `command_log` with the client command id. **[1.3]**
9. Secure-storage adapter interfaces for server-issued sessions and platform clients.

DoD:

- Register/login integration test passes.
- JWT is accepted by the PowerSync dev instance.
- Rate limit returns 429.
- `settings.update` round-trips through the named command path; `command_log.id` equals the client command id. **[1.3]**
- User A cannot subscribe to User B rows; stream parameters cannot widen scope. **[1.3]**
- Auth/session secret handling never uses ordinary app local storage in installed targets.

### S11 - Command dispatcher and full command catalog

**Deps:** S10, S4-S7

**Spec:** §§7.2b-7.2f, 7.8, 7.13, 8, 14 (Phase 2)

Build:

1. Command endpoint used by PowerSync `uploadData()`.
2. Six-step command pipeline: parse + strip trust fields, ownership (from JWT), `depends_on`/causality check, invariants, Drizzle transaction, command log (id = client command id). **[1.3]**
3. Idempotency by command ID with a dedup record retained >= `MAX_OFFLINE_HORIZON`. **[1.3]**
4. Full mutation catalog, including `timer.clock_in` blocked-task rule (`force` flag), `node.retype` orphan rule, and `layout.renormalize_order`. **[1.3]**
5. Machine-readable rejections (incl. `dependency_rejected`, `unknown_target`, `blocked_task`, `invalid_retype_children`, `client_too_old`). **[1.3]**
6. HLC same-field conflict handling; `sort_order` and timer merges use `core/merge`. **[1.3]**
7. Minimal-field patch handling.
8. Automation trigger integration (server re-applies authoritatively).
9. Explicit rejection of generic full-row write or generic entity update paths.
10. Completion validators for FS/FF/SF dependency requirements.
11. Command-payload version parsing and migration; row-`schema_version` floor check (`client_too_old`). **[1.3]**
12. Command-log effect summaries.
13. Server-assigned provenance/ownership/system fields on all command-created and command-updated rows; client values ignored. **[1.3]**
14. `sync_review_items` creation for rejections, dependency rejections, stale suggestions, material HLC conflicts, automation backstop notes, and schema-version blocks. **[1.3]**

DoD:

- One rejecting test per invariant.
- Replay returns `noop` with original result; dedup record survives a simulated `MAX_OFFLINE_HORIZON`-minus-one-day gap. **[1.3]**
- `node.move` revalidates hierarchy and justification; `node.retype` rejects orphaning. **[1.3]**
- Same row, different fields merge without clobber.
- Same row, same field resolves by HLC.
- Generic row patch upload cannot mutate server state.
- **[1.3]** A command with a rejected dependency is rejected `dependency_rejected` with a linked review item.
- **[1.3]** Client-supplied `user_id`/provenance/system fields are ignored and overwritten (trust-field test).
- Unsupported command version creates a review item and does not mutate domain rows; a below-floor `schema_version` yields `client_too_old`. **[1.3]**
- Command log explains which command created or last modified a row, with matching id end-to-end. **[1.3]**
- Material HLC conflict creates a review item with the losing value preserved in detail.

### S12 - Convergence harness

**Deps:** S11

**Spec:** §§7.2, 7.10, 7.11, 7.6, 13, 14 (Phase 3)

Build an integration rig simulating two devices with real local SQLite, overlay tables, upload queues, the server command endpoint, Postgres, and Sync Streams.

Scenarios:

1. Offline edits on different rows.
2. Same row, different fields.
3. Same row, same field with HLC winner.
4. Two offline clock-ins resolved by `mergeTimeEntries` (union not sum). **[1.3]**
5. Automation spawned on both devices converging via UUIDv5.
6. Soft-deleted unique row recreated after sync.
7. Stale suggestion accepted offline then rejected or rebased safely on reconnect.
8. Rejected offline command appears in review inbox; its overlay rolls back. **[1.3]**
9. Older supported command version migrates before apply.
10. **[1.3]** Concurrent "insert between same pair" sort_order collision converges to one deterministic order.
11. **[1.3]** Mixed-schema-version devices (N-1 ignoring an added column, N writing it) edit concurrently with no corruption.
12. **[1.3]** A command with a rejected `depends_on` cascades to `dependency_rejected`.
13. **[1.3]** Two devices with divergent weather facts converge to identical committed state.

DoD:

- All scenarios are green in CI under `pnpm test:convergence`.
- The harness proves command envelopes are the only trusted write upload and overlay effects never upload as row patches. **[1.3]**
- **[1.3]** Optimistic rows reconcile to identical canonical rows with matching `created_by_command_id`.
- Client observation rule hides double timers after sync (projection of `mergeTimeEntries`).
- This suite becomes a permanent regression gate.
- Review items sync to the affected device and can be resolved or dismissed.

### S13 - Jobs I: facts and canonical aggregates

**Deps:** S11, S6

**Spec:** §§7.4, 10.2, 12, 13

Build pg-boss bootstrap and workers:

1. `weather.poll`.
2. `aggregates.recompute` (transactional snapshot; HLC/`updated_at` guard so it never clobbers a later command). **[1.3]**
3. `automation.backstop` with content-hash drift detection. **[1.3]**
4. `retention.purge` that preserves command-dedup records younger than `MAX_OFFLINE_HORIZON`. **[1.3]**
5. `review.expire_resolved`.

Rules:

- `aggregates.recompute` writes server-owned `computed_aggregates` with server-job provenance.
- Client local aggregate caches are never read as canonical source.
- Backstop uses deterministic UUIDv5 no-op behavior, and raises an `automation_drift` review item on content mismatch. **[1.3]**

DoD:

- Clock-injected tests pass per job.
- Backstop no-ops on already-spawned content-equivalent rows; **[1.3]** creates a drift item when content differs at the same id.
- Recompute corrects displayed aggregate values after sync and does not overwrite a fact written by a later command. **[1.3]**
- No client-owned aggregate row can be uploaded.
- Backstop informational review item is created when it fills missed automation rows.
- **[1.3]** `retention.purge` leaves dedup records inside the offline horizon intact (idempotency-retention test).
- Resolved review item retention is tested.

### S14 - Jobs II: scheduling, layout, and notifications

**Deps:** S13, S9

**Spec:** §§7.5, 11, 12, 13

Build:

1. `pastdue.scan` with warning plus suggested replacement block.
2. `schedule.optimize` with suggestion batches.
3. Supersession of old suggestions in overlapping horizons.
4. `layout.precompute` for diagrams larger than 60 nodes (Tier 2 / on-demand). **[1.3]**
5. `notify.dispatch` with Web Push and Expo adapters behind one interface.
6. Provider-neutral adapter fakes for weather, notifications, layout, and future calendar export.

DoD:

- Past-due task yields exactly one active suggestion row per batch strategy.
- Optimize job emits only diffs.
- Newer optimize batch supersedes older active suggestions in its horizon.
- Stale suggestions cannot be accepted.
- Layout job fills `diagram_layouts` for the seed roadmap and is subscribed via Tier 2. **[1.3]**
- Push adapters are mock-tested.
- Provider SDKs are absent from `packages/core`.

---

## Phase D - Web App

### S15 - Web shell and data layer

**Deps:** S12

**Spec:** §§7.2, 7.3, 13, 14 (Phase 7)

Build `apps/web`:

1. Vite and current stable React.
2. Router.
3. Auth screens.
4. PowerSync web SDK with OPFS/wa-sqlite; canonical replica tables read-only. **[1.3]**
5. `executeCommand` wired to overlay tables (`client_commands` + `overlay_effects`). **[1.3]**
6. `packages/ui` overlay-aware hooks: `useStatus` (backed by `StatusIndex`), `useAggregates`, `useNodeTree`, `useCommands`, all reading merged replica+overlay. **[1.3]**
7. Optimistic apply plus rejection rollback by dropping overlay entries. **[1.3]**
8. Local-only aggregate overlay.
9. Review inbox data hook for command rejections, dependency rejections, conflicts, stale suggestions, drift, import warnings, and sync warnings. **[1.3]**
10. Workbox app shell.
11. Base design system.

DoD:

- Login renders seed data from local SQLite (merged read).
- Airplane-mode reload works after initial sync.
- Rejected optimistic edit visibly rolls back (overlay entry removed). **[1.3]**
- Static/lint test prevents direct canonical-table writes from UI components. **[1.3]**
- Command upload test proves a named command envelope is sent and no row patch.
- Server rejection appears in the review inbox after reconnect.

### S16 - Worklist, timer, and inbox

**Deps:** S15

**Spec:** §§1, 7.10b, 8, 9.1

Build:

1. Available-items worklist served from `StatusIndex`. **[1.3]**
2. Activity inbox.
3. `activity.promote`.
4. Clock-in and clock-out; `force` path for blocked-task clock-in surfaced explicitly. **[1.3]**
5. One global running timer UI.
6. Focus review modal.
7. Completed-session handling.
8. Task progress bars.
9. Time-left indicators.
10. "Why does this exist?" provenance affordance for tasks.

DoD:

- Playwright offline flow: create activity, promote, clock in, clock out, review, verify status transitions, reconnect, verify sync.
- UI makes double timer impossible locally; server double clock-in resolution reflected as one timer (projection of `mergeTimeEntries`). **[1.3]**
- Provenance affordance explains user-created and automation-created tasks.
- Worklist updates within the per-command status budget on a large seed. **[1.3]**

### S17 - Agenda and suggestions

**Deps:** S16, S8, S14

**Spec:** §§7.5, 11, 14 (Phase 7)

Build:

1. Week calendar and to-do side panel.
2. Drag-and-drop placement using `validWindowsFor`.
3. Highlight valid slots and dim invalid regions.
4. Anchored lock glyph and drag refusal.
5. Suggested blocks as dashed blocks with accept/reject.
6. Transactional `block.accept_suggestion`.
7. Stale-suggestion rejection UI.
8. Review item link when stale-suggestion acceptance is rejected.
9. Suggestion provenance detail.
10. Unjustified blocks dark grey.
11. Past `time_entries` as history layer.
12. Block move and resize commands.

DoD:

- Playwright creates a committed block by dragging a task.
- Valid windows render during drag.
- Anchored drag is rejected.
- Accepting a valid suggestion promotes it and resolves replacement/conflict behavior.
- Accepting a stale suggestion surfaces the machine-readable rejection and links a review item.
- Suggestion detail explains source batch and replaced block.
- Grey unjustified rule is verified.

### S18 - Kanban and habits

**Deps:** S16

**Spec:** §§1, 7.4, 9.2

Build:

1. Kanban grouped by date.
2. Drag between dates using `node.set_dates` or `block.move`.
3. Habit CRUD.
4. Daily target progress rings.
5. Streak counters.
6. Practice-hours and level display from server `computed_aggregates`.
7. Local incremental overlay while offline.
8. `computed_at` freshness label.
9. Dedicated recurrence/timezone regression harness wired into habit tests.

DoD:

- Ring fills during offline clock-in on a skill task.
- Local overlay disappears or reconciles after server canonical aggregate syncs.
- Streak flips at day-reset hour in clock-injected test.
- Kanban drag persists through sync.
- RRULE/day-reset/DST harness passes.

### S19 - Dashboard and decision board

**Deps:** S18

**Spec:** §§1, 7.4

Build:

1. Burndown chart with scheduled line.
2. Projection display with freshness label.
3. Project completion bars.
4. Priority list from decision-board ranking.
5. Streak summary.
6. Decision board UI: criteria, weights, scoring grid, live weighted ranking.

DoD:

- Dashboard renders entirely from local data offline.
- Changing a weight reorders priorities instantly.
- Projection freshness label reflects server aggregate timestamp.
- No dashboard path uploads local aggregate cache.

### S20 - Graph surfaces, Gantt, and rule editors

**Deps:** S17, S14

**Spec:** §§10, 11, 14 (Phase 8)

Build:

1. React Flow views for vision, roadmap, project.
2. Visual groups.
3. Layout persistence commands.
4. Date and no-date modes.
5. Gantt bars and dependency arrows.
6. Critical path display.
7. Automation rule editor (shows rule version).
8. Blocker rule editor.
9. Self-trigger validation errors surfaced.
10. Settings screen.

DoD:

- Playwright creates an edge in flowchart.
- Cycle attempt is rejected with `E_CYCLE`.
- Group and collapse state persist.
- Gantt arrows match edges.
- Rule built in editor spawns tasks on completion.

---

## Phase E - Mobile, Desktop, and Hardening

### S21 - Mobile core

**Deps:** S12, S16 patterns

**Spec:** §§7.2, 7.3, 13, 14 (Phase 9)

Build `apps/mobile`:

1. Expo app.
2. PowerSync React Native and auth; Tier 0/1 subscribed, Tier 2 lazy to protect cold start and storage. **[1.3]**
3. Mobile `executeCommand` and overlay path. **[1.3]**
4. Worklist, timer, focus review.
5. Agenda with tap-to-place assist.
6. Kanban.
7. Habits and rings.
8. Dashboard.
9. Read-only flowchart and Gantt renderers from `diagram_layouts` (Tier 2, lazy). **[1.3]**
10. Local notifications.
11. Expo push registration.
12. Mobile review inbox.
13. Secure storage for auth secrets.
14. Encrypted export/import entry point, or documented limitation. **[1.3]**

DoD:

- Maestro or Detox offline flow mirrors S16.
- Mobile creates, edits, clocks in/out, checks off while offline.
- Mobile receives and accepts/rejects synced suggestions offline.
- Local notification fires with network disabled.
- Graph view navigates on tap; Tier 2 layout loads lazily. **[1.3]**
- Rejected command appears in mobile review inbox after reconnect.
- Mobile auth/session secrets use secure storage; export defaults to encrypted. **[1.3]**

### S22 - Desktop

**Deps:** S0 desktop spike, S15-S20

**Spec:** §§5, 13, 14 (Phase 10)

Build `apps/desktop`:

1. Tauri v2 shell around the web build.
2. Selected PowerSync desktop path from S0.
3. Native SQLite integration (two-layer store). **[1.3]**
4. Secure storage for auth secrets.
5. Local DB encryption adapter or documented accepted v1 limitation.
6. Review inbox.
7. OS notifications.
8. App icons.
9. Windows and macOS packaging.

DoD:

- Packaged app passes the S16 command/sync smoke flow offline.
- Desktop uses named command envelopes and the overlay store. **[1.3]**
- Desktop syncs with web through Sync Streams.
- OS notification fires.
- Any remaining SDK alpha risk is documented as accepted or replaced with a working fallback.
- Desktop auth/session secrets use secure storage; export defaults to encrypted. **[1.3]**
- Desktop review inbox displays a synced rejection item.

### S23 - Hardening and release

**Deps:** all previous sessions

**Spec:** §§7.11, 7.12, 13-17

Build:

1. Full CI matrix: unit, property, convergence, Playwright, mobile e2e, desktop smoke, perf. **[1.3]**
2. Core coverage gate at or above 90 percent.
3. Production Docker Compose.
4. `.env.example`.
5. Backup and restore scripts.
6. Portable export/import implementation with dry-run validation; import restores data without replaying commands and preserves HLC monotonicity. **[1.3]**
7. Encrypted export default on installed targets; optional passphrase-encrypted web export or documented limitation. **[1.3]**
8. README.
9. Self-hosting guide.
10. Load sanity with 100k-node seed, measuring per-command status recompute and agenda render (`test:perf`). **[1.3]**
11. Security review of command upload, Sync Streams auth, stream-parameter scoping, trust-field assignment, secure storage, local encryption limitations, and export behavior. **[1.3]**
12. Adapter boundary review.
13. Final release checklist.

DoD:

- One-command fresh deploy on a clean VM serves web, API, Postgres, and sync.
- All suites are green, including `test:convergence` and `test:perf`. **[1.3]**
- 100k-node seed stays under agreed status and agenda render budgets, measured per-command not just on initial render. **[1.3]**
- Command-bridge test proves named commands are the only trusted server write path; overlay effects never upload as patches. **[1.3]**
- Sync Streams test proves one user cannot receive another user's rows and stream params cannot widen scope.
- Soft-delete uniqueness recreation tests pass.
- Stale suggestion rejection tests pass.
- **[1.3]** Mixed-schema-version, sort_order-collision, timer-merge, drift, and external-fact-divergence convergence tests pass.
- Release docs describe offline behavior and known platform limitations.
- Export/import round trip preserves facts, settings, provenance, review items, and supported command history; import does not replay commands and preserves HLC monotonicity. **[1.3]**
- Import dry-run reports conflicts without writing rows.
- Auth secrets and provider secrets are excluded from exports; installed-target exports are encrypted by default. **[1.3]**
- Adapter-boundary lint proves core imports no provider SDKs; external facts never gate command acceptance. **[1.3]**

---

## Dependency Graph

```text
S0 -> S1 -> S2 -> S3 -------------> S10 -> S11 -> S12 -> S15 -> S16 -> S17 -> S20
            |                                      |       |              |       |
            v                                      v       v              v       v
            S4 -> S5 -> S6 ----------------------> S13 -> S14 ----------> S18 -> S19
                  |      |
                  v      |
                  S7 ----|
                  |
                  v
                  S8 -> S9 ----------------------> S14

S21 depends on S12 and S16 patterns.
S22 depends on S0 and S15-S20.
S23 depends on all sessions.
```

Parallelization notes:

- S4-S9 can proceed after S2.
- S13 can begin after S11 and S6.
- S14 can begin after S13 and S9.
- S21 can start once S12 is green and S16 interaction patterns are stable.
- S22 should not start until S0 desktop feasibility is resolved.

## Implementation Order Within a Session

For the convergence-critical sessions (S0, S2, S11, S12), implement in this order to fail fast:

1. Pure core functions and their property tests (merge, HLC, status index, command handlers).
2. The local overlay write path and merge read.
3. The server applier with trust-field assignment and `command_log.id == command id`.
4. The reconciliation and rollback path.
5. Only then the cross-device/convergence integration scenarios.

If any of steps 1-4 is failing, do not write UI or move to the next session; these are the load-bearing contracts of the whole platform.
