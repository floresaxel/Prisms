# Prisms — Change Specification: v1.0 → v1.4

The **complete** set of changes required to take the codebase from the original Blueprints (`Prisms_alpha/Blueprints/ARCHITECTURE.md` + `BUILD_PLAN.md`, "v1.0") to the latest version (architecture 1.3 + build plan 1.4, "v1.4").

**Baseline assumption: the code is exactly the v1.0 Blueprints output and NOTHING from v1.1–v1.4 has been implemented.** Every change below is treated as net-new work — there are no "already exists / confirm-only" shortcuts. If a primitive turns out to already exist in the tree, that is a bonus that shrinks the named session, not an assumption this document relies on.

- **Part I** is the architectural change inventory: what changes versus the v1.0 spec, organized by the v1.0 `ARCHITECTURE.md` section it amends. This is the normative "what must change."
- **Part II** is the build plan: dependency-ordered sessions to implement Part I from a clean v1.0 baseline.

Section references like "§7.3" point at the **v1.0** `ARCHITECTURE.md` unless prefixed `1.3` (→ `ARCHITECTURE_1.3.md`) or `1.4` (→ `BUILD_PLAN_REVISED_v1.4.md` §7.14/§7.15).

> Relationship to the other docs: `ARCHITECTURE_1.3.md` is the normative target spec for the convergence layer; `BUILD_PLAN_REVISED_v1.3.md` is the greenfield 1.3 plan; `BUILD_PLAN_REVISED_v1.4.md` is the read-path (A+C) increment; `MIGRATION_PLAN_v1.0_to_v1.4.md` is the as-built-grounded execution version (it leaned on partial primitives). **This file is the complete, assume-nothing reference for the full v1.0 → v1.4 delta.**

---

# Part I — Architectural Change Inventory

## A. New hard requirements — adds R15–R20 to §1.1

The v1.0 requirements R1–R8 stand. Add:

- **R15. Two-layer client store.** The client store is a read-only canonical replica synced down from Postgres **plus** a local-only optimistic overlay of pending commands and their computed effects. The UI reads the merge. Optimistic effects are never uploaded as row patches and must be reconcilable or discardable without data loss. (→ §7.3 below.)
- **R16. Synced-row schema compatibility** is separate from command-payload versioning. Devices on different app versions sync concurrently without corruption; downloaded columns are additive within a major schema version; old clients ignore unknown columns.
- **R17. Server owns trust fields.** Ownership/provenance/system/version-of-record/`*_at` server-timestamp fields are server-assigned; client-supplied values for them are stripped and overwritten.
- **R18. Idempotency-dedup retention ≥ `MAX_OFFLINE_HORIZON`** (default 90 days); a device offline up to that horizon never re-applies an already-applied command.
- **R19. External-fact-derived state is advisory only** — it never causes a command rejection and never changes a convergent outcome.
- **R20. Import restores data** (does not replay commands), preserves HLC monotonicity; installed-target export is encrypted by default.

## B. New architecture principles — adds 14–16 to §2

Principles 1–8 stand. Add:

- **14. Two-layer client store.** Canonical replica is read-only/authoritative; the optimistic overlay is local-only/disposable; the UI reads the deterministic merge. Nothing in the overlay is ever a server write source.
- **15. Convergence is deterministic.** Given the same applied commands, every device computes the same canonical state. Any field that cannot satisfy this under naive LWW gets an explicit merge function and a property test.
- **16. The server owns trust.** Ownership/provenance/system/version-of-record fields are server-assigned; client values are never trusted.

## C. Data-model changes — amends §6

### C.1 New columns on **every** synced table (§6 base columns)
The v1.0 base columns are `id, user_id, created_at, updated_at, deleted_at`. Add to all synced tables:
- `hlc text NOT NULL` — zero-padded, lexicographically-sortable HLC (§7.9a), **server-assigned**. (v1.0 puts `hlc` only on `command_log`; it is now a per-row fact column backing `(sort_order, hlc)` and same-field LWW.)
- `schema_version integer NOT NULL` — row-shape version, server-assigned, additive-only within a major version.

> Live-migration rule: because the self-hosted DB is populated, every new NOT-NULL column ships with a DB-level DEFAULT (or backfill-then-set-NOT-NULL). Legacy rows get the floor `schema_version` and `source_kind='legacy'`.

### C.2 Provenance columns (§7.8) on user-visible fact tables
Add to at least `nodes, edges, schedule_blocks, time_entries, habit_completions, automation_rules, blocker_rules, diagram_layouts, computed_aggregates`:
```
created_by_command_id uuid,
last_modified_by_command_id uuid,
source_kind text CHECK (source_kind IN ('user','automation','scheduler','server_job','import','system','legacy')),
source_id uuid,
source_detail jsonb NOT NULL DEFAULT '{}'
```
All server-assigned (R17). The optimistic client may *predict* `created_by_command_id`/`source_kind='user'` for overlay display only. The UI must answer "why does this exist?" from provenance + command history.

### C.3 New tables
- **`client_commands`** and **`overlay_effects`** — **client-local only** (not in `appSchema`, never synced/uploaded as rows). The pending-command queue + per-command optimistic effects that the read-merge applies over the replica. (1.3 §7.2a shapes.)
- **`schedule_suggestion_batches`** — `(id, user_id, source IN ('past_due','nightly_optimize','manual_optimize'), horizon_start, horizon_end, computed_at, superseded_at, …)`.
- **`sync_review_items`** — the durable conflict/rejection inbox with `item_type IN ('command_rejection','dependency_rejection','hlc_conflict','stale_suggestion','automation_backstop','automation_drift','schema_version_block','import_warning','sync_warning')`, `severity`, `title`, `detail`, `status`.

### C.4 Extended existing tables
- **`schedule_blocks`** += `suggestion_batch_id`, `replaces_block_id`, `superseded_at` (suggestion lifecycle §7.5).
- **`automation_rules`** += `rule_version` (bumped on update); `template_version` recorded in spawned-row `source_detail` (§10.2).
- **`command_log`** (server) += `command_version`, `schema_version`, `client_version`, `effects jsonb`, `parent_command_id`, `triggering_command_id`, `depends_on uuid[]`. **`command_log.id` equals the client-generated command id** (idempotency key and provenance link — v1.0 already states this; it becomes load-bearing).
- **`computed_aggregates`** is server-owned: `computed_by` enforced `'server'` for synced rows; client incremental values are local-only caches, never uploaded; add provenance; add the dual partial unique indexes for nullable `subject_id`.
- **Server command-dedup table** keyed by command id with the `MAX_OFFLINE_HORIZON` retention contract (R18).

### C.5 Partial unique indexes (§7.7)
Build `WHERE deleted_at IS NULL` partial unique indexes for every soft-deletable uniqueness rule (`edges`, `habit_completions`, `sprint_memberships`, `decision_scores`, `diagram_layouts`), plus the two `computed_aggregates` indexes (user-level vs subject-level). v1.0 relied on plain `UNIQUE` constraints, which block recreate-after-soft-delete.

> Out-of-spec features added during the v1.0 build (e.g. confirmable event tags) must receive the same `hlc`/`schema_version`/provenance treatment, but are not enumerated here because they are outside the v1.0→v1.4 spec lineage.

## D. Derived-state & sync changes — amends §7 (the largest change area)

### D.1 Status — add the incremental `StatusIndex` (1.3 §7.12)
Status stays derived (no stored column). Add an incremental, fact-keyed `StatusIndex.apply(effects)` that recomputes status only for affected nodes + dependency neighbors (registering deps on `completed_at`, open timers, edges/predecessors, sprint membership, committed future blocks, blocker results). v1.0's full-scan `taskStatus` per command is the 100k-node performance cliff. Keep pure `statusOf` as the canonical reference the index must equal.

### D.2 Aggregates (§7.2)
Effective-hours must consume the new `mergeTimeEntries` resolver so overlapping intervals **union, not sum**. Client incremental aggregates are local-only caches; only server canonical `computed_aggregates` sync down. A static test must prove no command handler and no upload path can write `computed_aggregates`.

### D.3 Sync mechanics (§7.3) — the core rewrite
v1.0's "per-field CRUD patches wrapped in commands, single global bucket" becomes:

1. **Two-layer store (R15/§7.2):** the UI reads `mergeTable(replica, overlay)` via pure `core/sync` functions. Optimistic writes go to `client_commands` + `overlay_effects`, never to replica tables. Rollback = drop the overlay entry.
2. **Uploads are named command envelopes** read from `client_commands` (HLC order, honoring `depends_on`) — **not** PowerSync CRUD row patches. `uploadData` must fail loudly if any replica-table row op appears in the batch.
3. **Command identity (1.3 §7.2b):** the client mints the command id (UUIDv7) at write; the server persists `command_log` with that id; optimistic `created_by_command_id` equals the value synced back.
4. **Trust fields server-assigned (R17/§7.2c):** parse step strips client ownership/provenance/system/timestamp/`schema_version`; Zod payload schemas exclude them.
5. **Causal ordering (1.3 §7.2e):** `depends_on` encodes intra-device causal deps; HLC-ordered apply per device; a command depending on a rejected command is rejected `dependency_rejected` with a linked review item; a command referencing an unknown row is rejected `unknown_target`.
6. **Deterministic merge exceptions (1.3 §7.10):** per-field LWW-by-HLC is the default; `sort_order` uses the `(sort_order, hlc)` key; timer intervals use `mergeTimeEntries` (union-not-sum, idempotent, order-independent).
7. **Sync Rules → Sync Streams tiers (1.3 §7.3):** replace the single user bucket with **Tier 0 bootstrap / Tier 1 active / Tier 2 history**, JWT-scoped, no client-widenable params. `command_log` is not broadly synced — a filtered command-result stream is. Reads tolerate Tier 2 rows being absent until subscribed.
8. **HLC encoding (1.3 §7.9a):** zero-padded, lexicographically-sortable text (`compareHlc` == causal order), with a `mergeHlc` receive-rule and property tests.
9. **Row schema versioning (R16/1.3 §7.11):** additive-only within a major version; old clients ignore unknown columns; a command from a client below the server's floor is rejected `client_too_old` with a review item.
10. **Idempotency retention (R18/§7.2d):** dedup records kept ≥ `MAX_OFFLINE_HORIZON`; purge never deletes inside the horizon.

### D.4 Double clock-in (§7.4) → `mergeTimeEntries`
v1.0's bespoke "keep latest started_at open" rule is formalized as the deterministic `mergeTimeEntries` resolver and becomes the single source of truth for effective hours; the client "hide double timers" rule is a display projection of it.

### D.5 New: conflict & rejection inbox (1.3 §7.13)
Server rejections, dependency rejections, material HLC conflicts (losing value preserved), stale-suggestion failures, automation backstop/drift, and schema-version blocks all create durable `sync_review_items`. Toasts may point to items but never replace them. Items sync to web/mobile/desktop.

## E. Command API changes — amends §8

- **Pipeline 5-step → 6-step:** insert **strip-trust-fields** (after parse) and **`depends_on`/causal check** (after ownership). Steps: parse+strip → ownership (JWT) → causal/`depends_on` → invariants (core) → Drizzle txn → `command_log` (id == client id, effects summary).
- **Command versioning:** every envelope carries `command_version`, `schema_version`, optional `client_version`; the server migrates a supported older payload or rejects with a version-specific review item; payloads may only gain optional fields within a version.
- **New / changed commands:**
  - **`layout.renormalize_order`** (new, §7.10a): deterministic idempotent `sort_order` cleanup over `(sort_order, hlc)`, provenance-tagged (server-issued or batched).
  - **`block.accept_suggestion` / `block.reject_suggestion`** become the full §7.5 transaction: verify not superseded/deleted, verify task not done, soft-delete/move the replaced block, reject on anchored-overlap, promote to `committed`, mark conflicting suggestions superseded. (v1.0's verbs are one-liners.)
  - **`timer.clock_in`** on a `blocked` task is rejected `blocked_task` unless `force: true`; with force, `ongoing` wins precedence.
  - **`node.retype`** rejects orphaning child types (`invalid_retype_children`) absent a cascade plan; `node.move` and `node.retype` revalidate hierarchy typing + justification.
- Server-assigned provenance/effects on every created/updated row; machine-readable rejections gain `dependency_rejected`, `unknown_target`, `client_too_old`, `invalid_retype_children`, `blocked_task`.

## F. Rules-engine changes — amends §9

The v1.0 execution contract (synchronous in-txn, fixpoint `MAX_DEPTH=5`, UUIDv5 IDs, trigger-fact timestamps, self-trigger validation) **stands** — but now runs inside the overlay txn client-side and is re-applied authoritatively server-side. Add **§10.2 versioning + drift:**
- `automation_rules.rule_version` (bumped on `rule.update`); action templates carry a `template_version` constant; spawned-row provenance records both.
- The backstop job compares **content** (a canonical content hash over spawned fields), not just row existence: absent → create; content-equivalent → no-op; content differs (version skew) → keep existing, **do not overwrite**, raise an `automation_drift` review item.

## G. Scheduler changes — amends §10

- **Suggestion batch lifecycle (§7.5):** `schedule.optimize`/`pastdue.scan` emit `schedule_suggestion_batches`; a newer batch supersedes older non-accepted suggestions in the same horizon; suggested blocks carry `suggestion_batch_id`/`replaces_block_id`; provenance `source_kind='scheduler'`.
- **FS/SS/FF/SF across three surfaces (1.3 §7.6):** make the edge semantics explicit and tested for **availability** (status), **scheduler placement** (successor start/finish at/after predecessor finish/start + lag), and **completion** gates — not just the v1.0 availability gate.
- Scheduler operates on a bounded horizon window; optimize mode writes proposals only (never commits).

## H. Server-jobs changes — amends §11

- `aggregates.recompute`: transactional snapshot + HLC/`updated_at` guard so it never clobbers a later command.
- `automation.backstop`: content-hash drift detection → `automation_drift` items; emit `automation_backstop` info items when it fills rows the client didn't create.
- `retention.purge`: preserve command-dedup records younger than `MAX_OFFLINE_HORIZON`.
- `layout.precompute`: Tier 2 / on-demand.
- **New jobs (1.3 §12):** `review.expire_resolved` (weekly soft-delete of old resolved review items), `import.validate` (dry-run report emitting `import_warning` items), `backup.snapshot` (portable export artifact).

## I. Client-application changes — amends §12 (includes the v1.4 read-path)

### I.1 Two-layer client store + surfaces (1.3 client)
- Replace direct replica writes with `executeCommand` → `client_commands`+`overlay_effects`; replace the CRUD-patch upload with the `client_commands` envelope upload; overlay-aware hooks read the merge; status from `StatusIndex`.
- Review-inbox screen (open/resolve/dismiss) for all `item_type`s, on web/mobile/desktop.
- Provenance "why does this exist?" affordances; suggestion-batch accept/reject UI with stale-rejection handling; `force` clock-in surfaced; weather-unverified advisory badge; `schema_version_block` upgrade prompt; aggregate `computed_at` freshness labels.

### I.2 Persistent client read layer — **Fix A** (1.4 §7.14)
v1.0's "every view is a reactive query → core selector" mounts each screen's subscriptions per navigation. Add a `PrismsDataProvider` mounted **above** the router that owns, once per session: the merged replica+overlay subscriptions for the shared base tables, the derived `FactContext`/`TreeIndex`, and the single session-scoped `StatusIndex`. Screens read warm context; navigation creates/closes no shared subscription. (Distinguish the StatusIndex/FactContext base tables from the full set of tables shared by >1 screen so Habits/Decisions/Flowchart are covered too.)

### I.3 Loading-aware, stale-while-revalidate reads — **Fix C** (1.4 §7.15)
The read primitive exposes `{ data, isLoading, isFetching }` and retains last-known rows across refetch **and remount** (provider-level for shared tables; a module/session-scoped cache keyed by query+params for screen-local reads). `isHydrated` is grounded on a conjunction with PowerSync `hasSynced` (so a fresh login shows a skeleton, not the empty branch, while the empty replica syncs) with a "row already exists" fallback. Every empty-state branch (lists, sections, `<select>` placeholders) renders only when `isHydrated && length === 0`; a skeleton renders otherwise.

> Fix B (keep-screens-mounted) is deliberately out of scope: once A hoists the data and C makes reads loading-aware, a screen remount is cheap. Add it later only for a specific heavy screen if profiling demands.

## J. Security, privacy, portability changes — amends §13

- Trust fields server-assigned (R17); command upload remains the only trusted write path; Sync Streams auth scopes by verified JWT user id with no client-widenable params.
- **Portable export/import (1.3 §13.1):** versioned `prisms-export` manifest; dry-run validate; import **restores rows as data** (command history non-replayable); advance the device HLC past the max imported HLC (monotonicity); import conflicts → `import_warning` review items; export excludes auth/provider secrets.
- Installed-target export **encrypted by default**; optional passphrase encryption on web.
- Auth/session secrets in platform-secure storage; DB-encryption behind an adapter; all external services behind provider-neutral ports with test fakes (weather, notification, calendar, backup/export, secure storage, DB encryption, future LLM).

## K. Build-plan & convention changes — amends §15/§16

Add CI gates: 13-scenario two-device convergence (`test:convergence`); overlay-reconciliation; causal-ordering; trust-field overwrite; mixed-schema-version; `sort_order` collision; timer-merge union-not-sum; automation drift; external-fact divergence; command-version migration + `client_too_old`; **per-command** status recompute at 100k (not just initial render); read-path **no-flash / no-cold-re-subscribe on tab switch**; export/import round-trip (no replay, HLC monotonic); adapter-boundary lint. Mutation payloads still only gain optional fields; migrations forward-only and additive within a major schema version.

---

# Part II — Build Plan (sessions, clean-v1.0 baseline)

Dependency-ordered. Each session implements a slice of Part I. The convergence harness (P7) is the gate before any client rework. Sessions assume a clean v1.0 tree; treat every contract as net-new.

```text
P0 spike → P1 core → P2 StatusIndex → P3 db schema → P4 Sync Streams
       → P5 dispatcher → P6 jobs → P7 convergence GATE
       → P8 client two-layer → P9 1.3 surfaces → P10 review inbox/freshness
       → P11 Fix A (read layer) → P12 Fix C (loading-aware)
       → P13 import/export+privacy → P14 mobile+desktop → P15 hardening/perf/release
```

### P0 · Spike — two-layer store + command identity + Sync Streams on one command
Prove `node.rename` end-to-end: `client_commands`/`overlay_effects` (client-local, out of `appSchema`); `core/sync` merge; `executeCommand` minting the client id; envelope upload preserving that id; `command_log.id == client id`; Tier-0 down-sync reconciles overlay; forced-rejection rollback + review item; second-device receipt; JWT scoping. **DoD:** overlay reconciles to identical canonical row with matching `created_by_command_id`; no row patch uploaded; go/no-go on PowerSync feasibility for the explicit upload path. (Part I: A, C.3, D.3.)

### P1 · Core — merge / sync / version primitives + new command + scheduler placement
`core/merge` (LWW, `(sort_order,hlc)`, `mergeTimeEntries`); `core/sync` (`mergeRow`/`mergeTable`); HLC zero-padded lexicographic encode/compare/tick + `mergeHlc`; `stripTrustFields`; command/payload/row `schema_version` primitives + additive-only check; `depends_on` types; new error codes; **`layout.renormalize_order` end-to-end**; FS/SS/FF/SF **placement** constraints in `core/scheduler`; export/import manifest schemas. **DoD:** merge/HLC/sync property tests; placement property tests; additive-only rejects a non-additive change. (Part I: C.1, D.3, E, G, J.)

### P2 · Core — incremental `StatusIndex`
`StatusIndex.apply(effects)` with dependency registration; pure `statusOf` kept as the equality reference. **DoD:** incremental == full rebuild over randomized effect streams; only affected nodes recompute. (Part I: D.1.)

### P3 · DB — full 1.3 schema (additive, backfilled, live-DB-safe)
Per-row `hlc` + `schema_version` on all synced tables (with DEFAULT/backfill); `client_commands`/`overlay_effects` client-local; provenance columns; `schedule_suggestion_batches` + `schedule_blocks` extensions; `sync_review_items` (full item_type set); `rule_version`; `command_log` extensions + `depends_on`; dedup table w/ `MAX_OFFLINE_HORIZON`; build all §7.7 partial unique indexes incl. `computed_aggregates` dual. **DoD:** applies to fresh **and** seeded Postgres with row counts preserved; legacy rows get floor `schema_version` + `source_kind='legacy'`; recreate-after-soft-delete passes; no handler targets `computed_aggregates`. (Part I: C.)

### P4 · DB/Server — Sync Rules → Sync Streams tiers
Replace `sync-rules.yaml` with Tier 0/1/2 streams, JWT-scoped, no client-widenable params; filtered command-result stream; all synced tables placed in a tier; Tier 2 lazy. **DoD:** config validates; cross-user isolation proven; Tier 2 absent-until-subscribed tolerated. (Part I: D.3 §7.)

### P5 · Server — 6-step dispatcher + suggestion txn + revalidation + response contract
Trust-strip; ownership; `depends_on`/causal (`dependency_rejected`/`unknown_target`); invariants; txn; `command_log` (id==client, effects). Merge exceptions on apply; row `schema_version` floor → `client_too_old`; payload migrate-or-reject; **§7.5 accept/reject transaction**; `node.move`/`node.retype` revalidation + orphan rule; `force` clock-in; `layout.renormalize_order` applier; FF/SF/FS completion validators; automation fixpoint server re-apply + self-trigger rejection; review-item creation; **freeze the `uploadData` response contract** (applied|rejected|noop, reject_code, server ids, review-item ids). **DoD:** one rejecting test per invariant; trust-field overwrite; replay→noop; same-field HLC LWW; below-floor → `client_too_old`. (Part I: D.3, E, F, G.)

### P6 · Server — jobs
`aggregates.recompute` HLC guard; `automation.backstop` content-hash drift → `automation_drift` (+ `automation_backstop` info items); `retention.purge` dedup retention; suggestion-batch supersession; `layout.precompute` Tier 2; **new** `review.expire_resolved`, `import.validate`, `backup.snapshot`. **DoD:** drift item on content mismatch; recompute doesn't clobber a later command; in-horizon dedup preserved; dry-run import emits `import_warning` without writing. (Part I: H.)

### P7 · Convergence harness — GATE (13 scenarios)
Two-device rig (real SQLite, overlay tables, upload queues, server, Postgres, Sync Streams): offline different-row; same-row-different-field; same-field HLC; double clock-in union-not-sum; automation UUIDv5; soft-delete recreate; overlay reconciliation; rejection→inbox rollback; `sort_order` collision; mixed-schema-version; `dependency_rejected` cascade; command-version migration; weather divergence. **DoD:** all green under `test:convergence`; envelopes are the only trusted upload; response contract asserted. **No client work starts until green.** (Part I: D, K.)

### P8 · Client — two-layer store + connector rewrite + overlay hooks + review inbox
`executeCommand` → overlay tables (mint id + HLC + `depends_on`; automation fixpoint in the overlay txn); rewrite the upload path to read `client_commands` preserving the stored id (kill upload-time id minting); merged-read hooks; status via an app-level `StatusIndex` seam (so P11 is a hoist); rollback drops overlay; `onReject` threads the command id; review-inbox hook. Stage retirement of the old CRUD-patch path behind a loud guard. **DoD:** rejected edit rolls back by dropping overlay; named envelope uploaded, no row patch; review item appears after reconnect; airplane-mode reload renders locally. (Part I: I.1, D.3.)

### P9 · Client — 1.3 interaction surfaces
Suggestion-batch dashed blocks + accept/reject (mirrors the P5 server rule) + stale-rejection; provenance affordance; `force` clock-in; weather-unverified badge; `schema_version_block` prompt. **DoD:** Playwright accept/stale/provenance/forced-clock-in flows. (Part I: I.1, E.)

### P10 · Client — review inbox + freshness + dashboard parity
Review-inbox screen for all item_types; `computed_at` freshness labels; local aggregate overlay reconciles to canonical. **DoD:** synced rejection shows and resolves; no dashboard path uploads a local aggregate. (Part I: I.1, D.5.)

### P11 · Client — Fix A: persistent read layer (1.4 §7.14)
`PrismsDataProvider` above the router owns the shared subscriptions + `FactContext`/`TreeIndex` + the single `StatusIndex` (promote the P8 seam); route all shared-table consumers to warm sets; screen-local tables stay scoped but flash-proof via P12. **DoD:** N navigations create the shared subscriptions once and rebuild `FactContext`/`StatusIndex` a constant number of times; no screen creates a shared subscription; optimistic reactivity + rollback intact. (Part I: I.2.)

### P12 · Client — Fix C: loading-aware, SWR reads (1.4 §7.15)
Loading-aware read primitive + remount-surviving cache (provider + module/session-scoped, covering Habits/Decisions/Flowchart); `isHydrated` gated on `hasSynced` + row-exists fallback; per-branch empty-state gating across all screens incl. `<select>` placeholders; confirm the `now` tick doesn't rebuild the fact/tree index. **DoD:** fresh login shows skeleton not empty; offline-populated reload shows data not stuck skeleton; tab-away-and-back returns prior rows synchronously; `v14.spec.ts` proves no flash. (Part I: I.3.)

### P13 · Client/Server — import/export + secure storage + encryption
Manifest-driven import/export (dry-run; restores data, non-replayable; HLC advanced past max imported); encrypted export default on installed targets; secure storage for auth secrets; DB-encryption adapter. **DoD:** round-trip preserves facts/provenance/review items without replaying; "import then edit" is monotonic; installed export encrypted. (Part I: J.)

### P14 · Mobile + desktop parity
Two-layer overlay path + `client_commands` upload; Tier 0/1 + lazy Tier 2; review inbox; secure storage; encrypted export; loading-aware reads. **DoD:** each passes the offline command/sync flow; rejected command appears in its review inbox; Tier 2 lazy. (Part I: I, J.)

### P15 · Hardening, perf, security, release
Retire the old CRUD-patch path after a coverage test enumerates every `CommandName`; full CI matrix incl. `test:convergence` + read-path no-flash/no-re-query gates; 100k-node **per-command** status + agenda budgets; security review (upload-only write path, stream scoping, trust fields, secure storage, export); update prod compose / docs. **DoD:** one-command deploy; all suites green; named commands proven the only trusted write path; cross-user stream isolation proven. (Part I: K, J.)

---

## Coverage Checklist (every Part I change → session)

| Change | Sessions |
| --- | --- |
| R15 two-layer / overlay merge | P0, P1, P3, P8 |
| R16 row schema versioning / `client_too_old` | P1, P3, P5 |
| R17 trust fields server-assigned | P1, P5 |
| R18 idempotency retention | P3, P6 |
| R19 external-fact advisory-only | P5, P7 |
| R20 import non-replay / HLC monotonic / encrypted export | P1, P6, P13 |
| Per-row `hlc` + `schema_version` columns | P3 |
| Provenance columns + "why exists?" | P3, P5, P9/P10 |
| `sync_review_items` inbox + producers | P3, P5, P6, P8, P10 |
| Suggestion batches + accept/reject txn | P1, P3, P5, P6, P9 |
| `layout.renormalize_order` | P1, P5 |
| HLC lexicographic + `mergeHlc` | P1 |
| Merge exceptions `(sort_order,hlc)` / `mergeTimeEntries` | P1, P5, P7 |
| `StatusIndex` | P2, P8, P11 |
| Sync Streams tiers | P4 |
| 6-step dispatcher + causal ordering | P5 |
| Automation rule/template versioning + drift | P3, P6 |
| FS/SS/FF/SF three surfaces | P1 (placement), P2 (availability), P5 (completion) |
| New jobs (`review.expire_resolved`/`import.validate`/`backup.snapshot`) | P6 |
| Fix A persistent read layer | P11 |
| Fix C loading-aware/SWR reads | P12 |
| Import/export + secure storage + encryption | P13 |
| New CI gates | P7, P12, P15 |
