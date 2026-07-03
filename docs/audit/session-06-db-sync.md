# Audit Session 6 — DB Schema, Migrations, Sync Topology

Audited at commit `c4056c7` (branch `m0-spike`, clean; code identical to baseline `2ab3bf7` — later commits are docs-only), 2026-07-02.

**Scope examined:** `packages/db/src/schema.ts` (all 730 lines), `migrations/0008_v13_convergence.sql` (first 130 lines — the additive pattern is uniform), `src/migrate.ts`, `src/cli/check-sync-rules.ts`, `packages/db/sync-streams.yaml`, `infra/powersync/powersync{,.prod}.yaml`, `infra/postgres/init/02-powersync-publication.sql`, `docker-compose.yml` (postgres/powersync services), `packages/ui/src/powersync/schema.ts` (full client-schema diff). **Inventory-only:** `seed.ts`, `auth-schema.ts`, migrations 0000–0007, `db/test/*` (names + CI wiring verified, contents not line-audited).

**Verdict:** the physical layer is excellent — every synced table carries the C.1/C.2 columns via one `baseColumns` spread with live-DB-safe defaults (the `LEGACY_HLC` sentinel is exactly right), all §7.7 partial uniques exist including the I5/I6 DB backstops, migration 0008 is genuinely additive, and the sync streams pass the security gate decisively (every query filters `auth.user_id()`, zero client parameters). The findings are about the *shape of the sync topology*: the tier split is nominal (Tier 0 = the whole tree), the command-results stream ships data no client can read, and omitting `hlc` from the client schema makes the §7.10a ordering key unimplementable client-side.

---

## Findings

### S6-F1 · Medium — the V8 tier split is nominal: Tier 0 is the entire tree, Tier 2 is empty by construction

**Evidence:** `sync-streams.yaml` — `bootstrap` (Tier 0, auto-subscribed) carries **all** `nodes`, **all** `edges`, **all** `schedule_blocks` (plus settings/sprints/memberships/batches/review items); `active` (Tier 1) carries **all** live `time_entries`, `habit_completions`, `computed_aggregates`, `diagram_layouts`, etc.; `history` (Tier 2) is *only* soft-deleted time entries (`:58-60`) — a set retention hard-deletes at 90 days, so Tier 2 is bounded-tiny forever. §7.3's Tier 2 list — old time entries, completed project history, old command logs, large diagram layouts — all remain in Tiers 0/1.

**Failure mode:** V8's stated purpose is to have the split real *before* the 100k load test ("a single user-wide stream bakes 'everything is local' into queries and is untested at scale"). Here a 100k-node account cold-starts by syncing the entire tree + all edges + all blocks in Tier 0 — the exact shape V8 warns about, with a tier veneer. The spec's "even if Tier 0 and Tier 1 carry most data for a **small** user" clause covers today's accounts, not the 100k budget the product claims.

**Suggested change:** make Tier 2 real: move closed time entries older than N days, completed/archived subtrees, and non-recent diagram layouts into `history`-tier queries (sync-rule-side date expressions; no client parameters). Keep Tier 0 to the §7.3 bootstrap list (settings, active visions, near agenda, open review items). Gate with a 100k cold-start measurement (S10).

### S6-F2 · Medium — the `command_results` stream syncs the full 90-day command log (payloads included) to every device, and no client table can read it

**Evidence:** `sync-streams.yaml:53-55` — `command_results` is `auto_subscribe: true` with `SELECT * FROM command_log WHERE user_id = auth.user_id()` — user-scoped ✓ but not "scoped to … recent/pending command IDs" as §7.3 requires ("do not sync `command_log` as a general audit table"). The client schema (`packages/ui/src/powersync/schema.ts`) defines **no** `command_log` table, so PowerSync has nowhere to put the rows client-side (they land untyped/inaccessible). Reconciliation doesn't need them — it uses the upload response contract (S4).

**Failure mode:** every device — including mobile — downloads and stores up to 90 days of command envelopes (full JSON payloads) that nothing can ever query. Pure bandwidth, storage, and replication-lag cost; also a wider-than-necessary data-at-rest copy of user content on every device.

**Suggested change:** either drop the stream entirely (the response contract already closes the loop; nothing consumes it — S7 to confirm no hidden reader), or make it what §7.3 asked for: filter to a recent window (e.g. `applied_at > now() - interval '7 days'`) *and* add the client table so a history/undo UI can actually use it (pairs with S4-F3's empty `effects` decision).

### S6-F3 · Medium — client schema omits `hlc` everywhere: the §7.10a `(sort_order, hlc)` ordering key cannot exist client-side

**Evidence:** no table in `packages/ui/src/powersync/schema.ts` includes an `hlc` column, although the streams `SELECT *` and the server rows all carry it. Core's `compareSortKey` (V9, §7.10a: "the effective ordering key is the pair `(sort_order, hlc)`, never `sort_order` alone") therefore has no client-side input; UI sorts can only use `sort_order` alone. Compounding: `layout.renormalize_order` — the §7.10a cleanup — is never issued by any server path (S5 resolved-handoff), so collisions persist indefinitely.

**Failure mode:** two devices insert between the same siblings offline and mint equal fractions (the exact §7.10a property-test scenario). Canonically the HLC breaks the tie deterministically — but neither device's UI can see the HLC, so displayed order is whatever SQLite returns; the two devices can render *different orders forever* while the server considers them converged. The §15 gate ("after convergence both devices show the same total order") holds in core tests and fails in the actual UI.

**Suggested change:** add `hlc: column.text` to the client `nodes` table (and any table the UI orders by `sort_order`), and route UI sibling-sorts through `compareSortKey`. Alternatively (weaker): wire renormalization to run server-side after collisions. The first is a two-line schema change + one sort-callsite change; prefer it.

### S6-F4 · Low — `CREATE PUBLICATION powersync FOR ALL TABLES` over-replicates

**Evidence:** `infra/postgres/init/02-powersync-publication.sql:3`. The publication feeds PowerSync's replication slot with every table in the database: better-auth users/sessions/accounts, `push_subscriptions` (push keys), `command_field_versions` (per-field write churn — one row per field per command), and pg-boss's queue tables (constant churn).

**Failure mode:** no client exposure (no sync-rule query touches them — verified), but session updates, LWW bookkeeping, and job-queue churn all flow through the WAL slot for PowerSync to discard; auth/session data transits to the PowerSync service unnecessarily. Replication lag and slot volume grow with exactly the busiest internal tables.

**Suggested change:** scope the publication to the synced set: `CREATE PUBLICATION powersync FOR TABLE nodes, edges, …` (the 22 tables the streams reference). One migration/init edit; check PowerSync's docs note on publication scope first (it requires the published set ⊇ sync-rule tables).

### S6-F5 · Low — the additive-only gate is still mechanical-nowhere (S2-F2, owned here)

**Evidence:** `migrate.ts` is a plain forward-only runner; `db/test` has `m3-migration.test.ts` (backfill assertions) but nothing derives current `TableShape`s and asserts `isAdditiveSchemaChange` against a committed baseline. Migration 0008 *was* verified additive by inspection this session (every ADD COLUMN nullable-or-defaulted; the dropped constraints at `:47-52` are the plain-unique → §7.7 partial-index conversion, which doesn't change row shape); migration 0009 will be verified by nobody.

**Suggested change:** as specified in S2-F2 — a db test with a per-`ROW_SCHEMA_VERSION` baseline JSON of table shapes, asserted via the existing core function. Place it next to `m3-migration.test.ts`.

### S6-F6 · Info — small accuracies and accepted deviations (bundle)

- `schema.ts:12-14` header claims `computed_aggregates` uses NULLS NOT DISTINCT; the actual (correct) implementation is the §7.7 **dual partial unique indexes** (`:513-521`) that exactly match the recompute job's upsert arbiters. Fix the comment.
- §7.13's `command_id REFERENCES command_log(id)` FK is deliberately dropped repo-wide ("plain uuids (no FK)", `:559-560`) — accepted deviation; it is what makes the 90-day `command_log` purge mechanically safe (S5-F7). Record in the spec.
- `external_facts` unique `(user, kind, key)` is **not** partial — fine (weather upserts by key; soft-delete isn't a flow for facts).
- Client `sync_review_items` omits `resolved_at` (cosmetic: UI can't show close time); provenance columns are client-visible only on `nodes` + `schedule_blocks` (documented M9 scope choice); `powersync.yaml`'s comment says "packages/db/sync-rules.yaml" but the file is `sync-streams.yaml` (compose mounts it correctly).
- Backstop-filled rows keep the `LEGACY_HLC` default while dispatcher-spawned rows get the command HLC — inconsistent but safe (sentinel loses every LWW, the desired direction).
- Purge-probe indexes: `sprint_memberships.node_id`, `habits.vision_id`, `decision_scores.project_id`, `diagram_layouts.node_id` have no leading index for retention's `NOT EXISTS` scans — weekly job, acceptable; note for the efficiency roll-up.

---

## Resolved handoffs

| Handoff | Resolution |
|---|---|
| DB defaults for `hlc`/`schema_version` on job-inserted rows; default must sort below real writes (S5-F8) | **PASS** — `baseColumns`: `hlc DEFAULT '000000000000-0000-legacy'` (valid HLC shape, physical 0 → sorts below everything), `schema_version DEFAULT 1`, `source_kind DEFAULT 'legacy'` = "origin unknown". |
| `tables` registry excludes secrets (S5, backup-snapshot safety) | **PASS** — registry (`:704-729`) covers the 24 domain tables; `push_subscriptions`, `command_field_versions`, and all auth tables are excluded. |
| Unique index backing `command_field_versions` upsert (S4) | **PASS** — PK `(table_name, row_id, field)` matches the `onConflictDoUpdate` target exactly. |
| Review-items index (S4) | **PASS** — `review_items_user_status (user_id, status) WHERE deleted_at IS NULL`. |
| JWT audience/kid; no `iss` expected (S4) | **PASS** — dev: kid `powersync-dev`, audience `['powersync-dev']` matching `env.ts` defaults; prod via `!env PS_JWT_KID`/`PS_JWT_AUDIENCE`; neither config expects an issuer claim. Prod carries the documented manual invariant PS_JWT_K_B64URL = base64url(PS_JWT_SECRET) → S10 compose check (S4-F4). |
| No stored status column (S2) | **PASS** — `nodes` has no status column; `schedule_blocks.status` is block lifecycle, not derived task status. |
| `computed_aggregates` arbiter indexes (S5) | **PASS** — dual partial uniques with predicates matching the job's `targetWhere` exactly. |

## Compliance checklist results

| Check (playbook §S6) | Result |
|---|---|
| C.1 base columns on every synced table; C.2 provenance on fact tables | **PASS** — single `baseColumns` spread (id, user_id, timestamps, deleted_at, hlc, schema_version, created_by/last_modified_by_command_id, source_kind/id/detail) on all 22 synced tables |
| C.3 new tables (batches, review items, command_log, dedup) | **PASS** — `schedule_suggestion_batches`, `sync_review_items` (all 9 item types + severity + status CHECKs), `command_log` (§7.2f shape incl. effects/parent/triggering columns — unpopulated per S4-F3), dedup = command_log id PK; `command_field_versions` as the LWW store |
| §7.7 partial uniques (DoF 13) | **PASS** — edges, habit_completions, sprint_memberships, decision_scores, diagram_layouts (the spec's five) + tags, tag_placements, tag_answers, and the dual computed_aggregates pair; `entries_open` as the I5 backstop; I6 interval CHECKs on blocks/entries |
| Migrations forward-only; 0008 additive + backfilled (V5) | **PASS** — drizzle forward-only runner; every 0008 ADD COLUMN nullable-or-defaulted; constraint→partial-index conversions shape-neutral; mechanical gate still missing → F5 |
| Drizzle ↔ client schema diff | **DONE** — client omits `hlc`/`schema_version` everywhere (→ F3 for hlc; schema_version not needed client-side), provenance only on nodes/blocks (accepted), `resolved_at` missing on review items (cosmetic); type-assertions.ts pins Drizzle ↔ core entities at compile time |
| Streams: tiers exist (V8); per-user scoping airtight; params can't widen | **PARTIAL** — security **PASS** (every query `auth.user_id()`, zero parameters; `user_settings` aliased `user_id AS id`); tier substance → F1; command_results scope → F2; reads tolerate absent Tier 2 ✓ (history = separate lazily-subscribed stream into the same client table) |
| `sync_review_items` + `computed_aggregates` sync down; `command_log` not as audit; internals never sync | **PARTIAL** — review items + aggregates ✓; command_log → F2; `command_field_versions`/`push_subscriptions`/auth have no stream ✓ |
| `check-sync-rules` validates the real file | **PASS** — uses `@powersync/service-sync-rules` (the service's own parser) against `sync-streams.yaml`; `db/test/sync-streams.test.ts` exists and db tests run in CI's stack job |
| Compose: wal_level=logical, publication, storage bootstrap, prod parity | **PASS with F4** — `wal_level=logical` set; publication over-broad (F4); powersync storage DB bootstrapped via init SQL; prod yaml = same shape via `!env PS_*` (deep prod-compose check → S10) |

## Matrix updates applied (sequential mode)

- V5 → ✅ implementation (0008 verified additive, live-DB-safe backfill; mechanical gate still absent — S2-F2/S6-F5 note kept)
- V8 → ⚠️ (streams exist + security airtight; tier substance nominal — S6-F1; command_results — S6-F2)
- V9 → note added (client half: `hlc` not in client schema → ordering key unimplementable in UI — S6-F3)
- R5 → ✅ (vanilla Postgres via compose `wal_level=logical`; vanilla SQLite client-side via PowerSync loose schema)
- R16 → note (schema side ✅: per-row `schema_version` with defaults; the S4-F1 floor bypass remains the enforcement gap)

## Handoff items

1. **S7:** confirm nothing reads `command_log`/`command_results` client-side (F2's "drop the stream" precondition); how `client_commands`' simplified column set (no stored `depends_on`/versions/device_id) still produces correct envelopes at upload time.
2. **S8/S9:** UI sibling-ordering call sites — confirm they sort by `sort_order` alone today (F3's user-visible half).
3. **S10:** 100k cold-start sync measurement (F1); publication scope vs PowerSync docs (F4); `PS_JWT_K_B64URL` ↔ `PS_JWT_SECRET` invariant in prod compose + `.env.example` (carried S4-F4); confirm `sync-rules:check` (or the db test) is a required CI gate.

**Next:** Session 7 — client write path (`packages/ui/src/powersync/*`) against §7.2/R15/V1–V2, including the two carried priority questions: client-side invariants (S3-F3) and offline automation spawning (R4).
