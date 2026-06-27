# Prisms Architecture Specification, Revised

Version 1.3 - single-user release, collaboration deferred

Audience: an LLM code generator building the codebase. Normative sections use "must". Informative sections use "should" or "may".

This version supersedes 1.2. It keeps every 1.2 decision and adds the runtime-convergence and reconciliation contracts that 1.2 left to interpretation. The new material is concentrated in §§2 (R15-R20), 3, 4, 7.2, 7.2a-7.2f, 7.3, 7.4, 7.10-7.13, 8, 9.1, 10, 12, and 13. If any older section conflicts with this version, this version wins.

## 1. Product Definition

Prisms is a local-first goal execution platform. A user states a long-term mission and decomposes it through six layers until it lands on a calendar:

```text
Vision -> Roadmap -> Project -> Milestone -> Task -> Schedule Block
```

Skills and habits are a parallel track. They attach directly to a Vision, not to a Project, and produce recurring practice tasks, streaks, daily targets, and practice-hour accumulation.

## 2. Hard Requirements

R1. Supported platforms: web, Windows, macOS, Android, and iOS.

R2. All reads and writes must hit a local SQLite database first. The UI must not wait on the network for normal use.

R3. The app must operate offline and converge across multiple devices when connectivity returns.

R4. Follow-up task spawning, dependency unblocking, clock-in/out, agenda edits, and accepting/rejecting synced suggestions must work offline.

R5. The durable server source of truth is vanilla Postgres. The durable client store is vanilla SQLite. Managed services are optional replacements, not architectural requirements.

R6. No client sends arbitrary SQL over the network. Uploads are named commands, not generic database mutations.

R7. Server computation can improve results, but must not be required for offline function.

R8. The codebase must be friendly to LLM implementation: mainstream TypeScript, explicit contracts, deterministic pure functions, narrow modules, and high test coverage for core logic.

R9. The command/event history is product data, not only an audit log. The app must explain why important rows exist, which command or automation created them, and which offline commands later need review.

R10. The system must support local-first backup, export, and import without relying on a managed service.

R11. Command payloads and export files must be versioned. Old mobile and desktop clients must fail gracefully or be upgraded through explicit migrators, never through silent schema guesses.

R12. Offline conflicts and server rejections must produce reviewable inbox items. A late rejection must not disappear as a toast-only event.

R13. Sensitive local data must have a privacy boundary. Auth secrets must use platform-secure storage, and desktop/mobile database encryption must remain an explicit adapter choice.

R14. External services must sit behind adapters. Weather, notification, calendar, backup, export, and future LLM assistance must not leak provider APIs into `packages/core`.

R15. The client store is two logical layers: a read-only canonical replica synced down from Postgres, and a local-only optimistic overlay of pending commands and their computed effects. The UI reads the merge of the two. Optimistic effects must never be uploaded as row patches, and must be reconcilable or discardable without data loss when the server confirms or rejects the originating command. (See §7.2.)

R16. Synced-row schema compatibility is a separate concern from command-payload versioning. Devices on different app versions must sync concurrently without corruption. Downloaded columns must be additive within a major schema version, and older clients must ignore unknown columns rather than fail. (See §7.11.)

R17. Ownership, provenance, system, and version-of-record fields are server-assigned. A client payload that sets `user_id`, `source_kind`, `source_id`, provenance command IDs, `computed_by`, `applied_at`, or any `*_at` server timestamp must have those values ignored and overwritten by the server. (See §7.2c.)

R18. Server idempotency-dedup records for applied commands must be retained for at least `MAX_OFFLINE_HORIZON` (default 90 days). A device offline up to that horizon must never have a previously-applied command re-applied after reconnect. (See §7.2d and §12.)

R19. State derived from external facts (weather and any future provider fact) is advisory display state only. It must never cause a server command to be rejected, and must never change the convergent outcome of any command. (See §10 and §13.4.)

R20. Import restores facts, settings, command history, review items, and provenance as data. Import must not re-execute historical commands. Imported HLC values must be dominated by any subsequent local write so that monotonic ordering is preserved. (See §13.1.)

## 3. Critical Revisions

### 3.1 Revisions carried from Version 1.0 (still mandatory)

| Area                  | Revision                                                                                                                                                       | Reason                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| PowerSync writes      | Add a command-envelope bridge. PowerSync records local row operations, so the app must explicitly map local optimistic writes to named commands before upload. | Preserves "commands, not queries" while using PowerSync correctly.                           |
| PowerSync config      | Use Sync Streams for new work. Do not build around legacy Sync Rules.                                                                                          | Sync Streams are the current recommended PowerSync mechanism.                                |
| Aggregates            | Client-computed aggregates are local-only caches. Only server canonical aggregates sync through Postgres.                                                      | Prevents derivative client cache rows from becoming conflict-prone source data.              |
| Scheduler suggestions | Add suggestion batches, replacement links, supersession, and transactional acceptance rules.                                                                   | Prevents stale or overlapping optimization proposals.                                        |
| Dependency semantics  | Define FS, SS, FF, and SF separately for status, scheduling, and completion gates.                                                                             | Avoids ambiguous behavior around start and finish dependencies.                              |
| Soft deletes          | Replace normal unique constraints on soft-deletable tables with partial unique indexes where `deleted_at IS NULL`.                                             | Allows recreate-after-delete and avoids accidental uniqueness lockout.                       |
| Desktop risk          | Keep desktop late, but run an early Tauri + PowerSync spike. Treat PowerSync Tauri support as a risk until proven.                                             | Avoids discovering SDK/platform incompatibility after the app is otherwise built.            |
| React version         | Use "current stable React" rather than pinning React 18.                                                                                                       | Keeps the generated project aligned with current frontend defaults.                          |
| Command history       | Treat command logs, effects, provenance, and review items as user-facing recoverability infrastructure.                                                        | Enables explanations, undo groundwork, debugging, and trustworthy offline conflict handling. |
| Versioning            | Add command, schema, export, and client version fields.                                                                                                        | Protects multi-device sync when some clients are older.                                      |
| Backup/export         | Add a first-class portable export/import format.                                                                                                               | Strengthens self-hosting and no-lock-in guarantees.                                          |
| Privacy/adapters      | Add local secret storage, optional DB encryption adapters, and provider ports.                                                                                 | Keeps personal data safer and prevents vendor APIs from spreading through the app.           |

### 3.2 New revisions in Version 1.3 (mandatory)

These close the runtime-reconciliation and convergence gaps that 1.2 left implicit. Each maps to a normative section and to one or more build-plan gates.

| #   | Area                         | Revision                                                                                                                                                                                                                   | Reason                                                                                                            | Spec         |
| --- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------ |
| V1  | Optimistic store model       | Split the client store into a read-only canonical replica plus a local-only optimistic overlay. UI reads the merge. Rollback drops the overlay entry; it never edits replica rows.                                         | Removes the double-write reconciliation ambiguity in PowerSync and makes rejection rollback trivial.              | §7.2, §7.2a  |
| V2  | Command identity             | `command_log.id` on the server must equal the client-generated command id. Optimistic provenance written locally must match server provenance exactly after sync.                                                          | A second, server-generated id breaks every `created_by_command_id` link written optimistically.                   | §7.2b        |
| V3  | Command ordering             | Commands from one device apply in HLC order. A command that depends on a not-yet-applied or rejected command is parked or rejected with a linked review item, never applied against a missing precondition.                | Prevents FK and invariant failures from out-of-order or orphaned offline commands.                                | §7.2e        |
| V4  | Trust fields                 | Ownership, provenance, system, version-of-record, and server-timestamp fields are server-assigned and ignored from client payloads.                                                                                        | Stops clients from forging provenance, ownership, or system rows.                                                 | §7.2c        |
| V5  | Synced-row schema versioning | Treat downloaded-row schema compatibility separately from command versioning. Additive-only within a major schema version; clients ignore unknown columns; never make a downloaded column required for an old client read. | Lets an old phone and a new desktop sync concurrently without corruption.                                         | §7.11        |
| V6  | Automation content drift     | Version automation action templates. The backstop checks content equivalence, not only row existence, and raises an informational review item on drift. Automation uses the rule version visible at trigger time.          | UUIDv5 guarantees the same id, not the same content; silent divergence must surface.                              | §10.2        |
| V7  | Derived-status performance   | Maintain an incremental, fact-keyed status index. Status stays derived (no stored status column) but is recomputed only for affected nodes, not by full scan.                                                              | Full-scan status over 100k nodes per command is the performance cliff.                                            | §7.12, §9.1  |
| V8  | Stream tiers required        | Implement the Tier 0/1/2 stream split before the 100k load test, not as deferred optimization.                                                                                                                             | A single user-wide stream bakes "everything is local" into queries and is untested at scale.                      | §7.3         |
| V9  | Merge exceptions             | Per-field HLC last-writer-wins is the default. `sort_order` and timer intervals use explicit deterministic merge functions, not raw LWW.                                                                                   | Concurrent fractional inserts collide; two open timers must merge by a stated rule that drives effective-hours.   | §7.10        |
| V10 | External-fact gating         | External-fact-derived state is advisory only and never gates a command rejection or changes a convergent outcome.                                                                                                          | Stale or absent weather must not make two devices diverge or reject commands.                                     | §10.3, §13.4 |
| V11 | Idempotency retention        | Server command-dedup records are retained at least `MAX_OFFLINE_HORIZON`. Retention purge must not delete dedup records inside that horizon.                                                                               | A long-dormant device reconnecting must not re-apply old commands.                                                | §7.2d, §12   |
| V12 | Import semantics             | Import restores data, does not replay commands, and preserves HLC monotonicity. Encrypted export is default on installed targets.                                                                                          | Replaying commands against an evolved schema is non-deterministic; imported HLCs must not dominate future writes. | §13.1        |

## 4. Architecture Principles

1. Local-first. The network is a background concern. Losing the server degrades the product from optimized to good enough, not to broken.

2. Facts, not flags. User-visible state such as task status, progress, streaks, blockers, and projections is computed from facts. Status is never a stored column.

3. Commands, not queries. Every user mutation is a named command with a Zod schema, invariant checks, and an idempotency key. No generic update endpoint exists.

4. One logic, two tiers. `packages/core` contains pure TypeScript and zero platform IO. Clients and server jobs call the same functions.

5. Suggestions are not facts. Server schedulers and jobs write proposals. A user command promotes a proposal to a committed fact.

6. Deterministic automation. Automation outputs use deterministic UUIDv5 IDs based on rule ID, trigger ID, and action slot. Rules use triggering fact timestamps, not wall clock.

7. Minimal-field mutations. Commands write only the fields named in their payloads.

8. Server canonical, client responsive. Client caches may make the UI instant, but canonical rows come from validated commands and server jobs.

9. History is explainability. Commands, effects, and provenance links must be sufficient to answer "why did this task, block, rule result, or review item appear?"

10. Version every boundary. Commands, synced computed rows, exports, imports, and adapter payloads must carry enough version information to migrate or reject safely.

11. Conflicts are work items. A command rejection, stale suggestion, or non-trivial conflict creates a durable review item until the user or a deterministic resolver closes it.

12. Portability is a feature. Backup, export, and import must be maintained as normal product paths, not emergency scripts.

13. Adapters contain vendors. Provider-specific code belongs at app/server edges behind explicit ports; core consumes only provider-neutral facts and commands.

14. Two-layer client store. The canonical replica is read-only and authoritative. The optimistic overlay is local-only and disposable. The UI reads the deterministic merge of both. Nothing in the overlay is ever a server write source. (See §7.2.)

15. Convergence is deterministic. Given the same set of applied commands, every device computes the same canonical state. Any field that cannot satisfy this under naive LWW gets an explicit merge function and a property test. (See §7.10.)

16. The server owns trust. Ownership, provenance, system, and version-of-record fields are assigned server-side. Client-supplied values for those fields are never trusted. (See §7.2c.)

## 5. Technology Stack

| Layer          | Choice                                          | Notes                                                          |
| -------------- | ----------------------------------------------- | -------------------------------------------------------------- |
| Language       | TypeScript strict mode                          | Shared across client, server, and core.                        |
| Monorepo       | pnpm workspaces and Turborepo                   | Keep package boundaries explicit.                              |
| Web            | Vite, current stable React SPA                  | No SSR required for the local-first app shell.                 |
| Desktop        | Tauri v2 wrapping the web build                 | Run an early PowerSync desktop spike before committing deeply. |
| Mobile         | Expo React Native                               | Use PowerSync React Native and Expo support.                   |
| Local DB       | SQLite                                          | OPFS/wa-sqlite on web, platform SQLite elsewhere.              |
| Sync           | PowerSync with Sync Streams                     | Self-hosted baseline, managed cloud optional.                  |
| Server DB      | Postgres 15 or newer                            | Durable source of truth.                                       |
| API            | Hono on Node 20+                                | Command dispatcher and auth integration.                       |
| ORM/migrations | Drizzle                                         | Parameterized SQL only.                                        |
| Validation     | Zod in `packages/core`                          | Shared source for command and domain schemas.                  |
| Jobs           | pg-boss                                         | Queue inside Postgres, no Redis for v1.                        |
| Auth           | Better Auth or equivalent API-owned auth        | Must issue JWTs usable by API and PowerSync.                   |
| Graph UI       | React Flow on web/desktop                       | Mobile graph editing is out of scope for v1.                   |
| Graph layout   | ELK via `elkjs`                                 | Invoked through core view-model builders or jobs.              |
| Recurrence     | `rrule.js`                                      | Store RRULE strings.                                           |
| UI state       | PowerSync live queries plus Zustand             | Zustand only for ephemeral UI state.                           |
| Tests          | Vitest, fast-check, Playwright where UI matters | Core has the highest coverage bar.                             |

## 6. Monorepo Layout

```text
prisms/
  packages/
    core/
      src/domain/
      src/commands/
      src/status/        // includes incremental status index (§7.12)
      src/aggregates/
      src/scheduler/
      src/rules/
      src/graph/
      src/merge/         // deterministic merge functions (§7.10)
      src/time/
      src/sync/          // overlay/replica merge contract, HLC, version policy
      test/
    db/
      drizzle schema, migrations, Sync Streams config
    ui/
      shared hooks and selectors (overlay-aware reads)
    adapters/
      provider-neutral ports and test fakes
  apps/
    web/
    mobile/
    desktop/
    server/
  docker-compose.yml
  turbo.json
```

Dependency rules:

- `packages/core` must import no workspace package and no platform IO.
- `packages/db` may import core types and schemas.
- `packages/adapters` may define provider-neutral ports and fakes. Concrete provider implementations live in apps or server packages.
- `apps/server`, `apps/web`, `apps/mobile`, `apps/desktop`, and `packages/ui` may import core.
- Apps must not import server code.
- Enforce boundaries with lint rules.

## 7. Data Model

### 7.1 Core tables

Keep the original high-level model:

- `nodes`
- `edges`
- `schedule_blocks`
- `time_entries`
- `habits`
- `habit_completions`
- `decision_boards`
- `decision_criteria`
- `decision_scores`
- `sprints`
- `sprint_memberships`
- `automation_rules`
- `blocker_rules`
- `external_facts`
- `diagram_layouts`
- `diagram_groups`
- `command_log`
- `sync_review_items`
- `computed_aggregates`
- `user_settings`

All synced tables must have:

- `id uuid primary key`
- `user_id uuid not null`
- `created_at timestamptz not null`
- `updated_at timestamptz not null`
- `deleted_at timestamptz`
- `hlc text not null` (zero-padded, lexicographically sortable; see §7.9a)
- `schema_version integer not null` (row-shape version; see §7.11)

Client-created entity IDs use UUIDv7. Deterministic automation outputs use UUIDv5.

### 7.2 The two-layer client store and the command bridge

This section replaces and expands 1.2 §7.2. It is the most important contract in the document. Implement it exactly; do not improvise a single-table optimistic model.

#### 7.2a Two-layer store

The client SQLite database holds two disjoint sets of tables:

1. **Canonical replica tables** (`nodes`, `edges`, `schedule_blocks`, ...): these are PowerSync-downloaded, read-only mirrors of Postgres. UI code, commands, and selectors must never `INSERT`/`UPDATE`/`DELETE` these directly. PowerSync owns them; it overwrites them with server truth on every download.

2. **Local-only overlay tables**: not subscribed to any Sync Stream and never uploaded as rows. These are:

```sql
-- The pending command queue. This is the ONLY upload source.
CREATE TABLE client_commands (
  id uuid PRIMARY KEY,              -- client-generated; becomes command_log.id (§7.2b)
  user_id uuid NOT NULL,
  device_id text NOT NULL,
  name text NOT NULL,
  command_version integer NOT NULL,
  schema_version integer NOT NULL,
  client_version text,
  hlc text NOT NULL,
  payload jsonb NOT NULL,
  depends_on uuid[] NOT NULL DEFAULT '{}',   -- prior client_commands ids this one needs (§7.2e)
  provenance jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','uploading','applied','rejected','superseded')),
  uploaded_at timestamptz,
  acked_at timestamptz,
  rejected_at timestamptz,
  reject_reason text
);

-- Per-command optimistic effects. Read-time merge applies these over the replica.
CREATE TABLE overlay_effects (
  command_id uuid NOT NULL REFERENCES client_commands(id) ON DELETE CASCADE,
  table_name text NOT NULL,
  row_id uuid NOT NULL,
  op text NOT NULL CHECK (op IN ('insert','update','delete')),
  fields jsonb NOT NULL DEFAULT '{}',   -- only the minimal fields this command writes
  seq integer NOT NULL,                 -- order within the command
  PRIMARY KEY (command_id, table_name, row_id, seq)
);
```

#### 7.2b Read-time merge

The UI never reads replica tables raw. It reads through merge selectors in `packages/ui` backed by pure functions in `core/sync`:

```ts
// core/sync/merge.ts
function mergeRow(canonical: Row | null, overlay: OverlayEffect[]): Row | null
// Applies overlay ops for one row_id in (command hlc, seq) order over the canonical row.
// 'delete' yields null. 'insert' over a null canonical yields a synthetic row.
// Only fields named in `fields` are overlaid; all other fields come from canonical.

function mergeTable(canonicalRows: Row[], overlay: OverlayEffect[]): Row[]
```

Merge rules:

- Overlay effects from commands in `state IN ('pending','uploading')` are applied. Effects from `applied` commands are NOT applied (the replica now carries server truth); a reconciliation step (below) removes them.
- Within a row, multiple pending commands apply in `(hlc, seq)` order.
- `command_log.id` equals `client_commands.id`. The server must persist the client-supplied command id as the primary key of `command_log` and must use it for every provenance link it writes. There is no second server-side command id. This guarantees that an optimistic `created_by_command_id` written into an overlay effect equals the value the server later syncs down, so the row does not visibly change identity on reconciliation. (Revision V2.)

#### 7.2c Trust fields are server-assigned

The server, when applying a command, must set these fields itself and ignore any client-supplied value for them: `user_id` (from JWT), `source_kind`, `source_id`, `source_detail`, `created_by_command_id`, `last_modified_by_command_id`, `computed_by`, `applied_at`, `created_at`/`updated_at` server timestamps, `schema_version`, and `command_log.result`. The optimistic client may *predict* `user_id`, `created_by_command_id`, and `source_kind` for its overlay (it knows them deterministically), but the server value is authoritative on sync-down. Zod command payload schemas must not include these fields at all; if present they are stripped before validation. (Revision V4, R17.)

#### 7.2d executeCommand and uploadData

```ts
// client write path
async function executeCommand(name: CommandName, payload: unknown): Promise<CommandLocalResult>
```

`executeCommand` must, in one local SQLite transaction:

1. Validate `payload` with the core Zod schema for `name` (after stripping trust fields per §7.2c).
2. Run pure invariant checks against the *merged* current state (replica + pending overlay).
3. Compute optimistic effects with the pure core handler for `name`.
4. Compute `depends_on`: the ids of any pending `client_commands` whose target rows this command reads or mutates (§7.2e).
5. Generate the command id (UUIDv7), tick the HLC, and write one `client_commands` row plus its `overlay_effects`.
6. Return a result the UI can use to show the optimistic outcome immediately.

`uploadData()` (the PowerSync upload hook) must:

- Read `client_commands` in `state = 'pending'` ordered by HLC, honoring `depends_on` (a command is not uploaded before its dependencies are `applied`).
- POST each as a named command envelope to the server dispatcher. Never translate `overlay_effects` or any replica-table operation into an HTTP row patch. If PowerSync surfaces replica-table operations in the upload batch (it must not, because the UI never writes replica tables), `uploadData` must treat that as a bug and fail loudly, not silently upload them.
- On `applied` ack: mark the command `applied`, record `acked_at`. The reconciliation step then waits for the corresponding canonical rows to arrive via Sync Stream and, once present and HLC-dominant, deletes the command's `overlay_effects` (cascade) and prunes the `client_commands` row to a short-lived `applied` tombstone (kept until its canonical rows are confirmed downloaded, then removable).
- On `rejected` ack: mark the command `rejected`, record `reject_reason`, delete its `overlay_effects` (this is the rollback — the optimistic change simply disappears from the merged read), and ensure a `sync_review_items` row exists. Dependent pending commands (those listing the rejected id in `depends_on`) are cascaded to `rejected` with reason `dependency_rejected` and also surfaced.

Server idempotency: the server keeps a dedup record keyed by command id. A re-uploaded command id returns the original stored result as `noop` and mutates nothing. Dedup records are retained at least `MAX_OFFLINE_HORIZON` (default 90 days, configurable). `retention.purge` must never delete a dedup record younger than that horizon. (Revisions V11, R18.)

#### 7.2e Command ordering and causal rejection

- Within a device, commands carry a monotonic HLC and are applied server-side in HLC order per device.
- `depends_on` encodes intra-device causal dependencies (e.g., `edge.create` referencing a node from a not-yet-applied `node.create`). The client must not upload a command before its dependencies are `applied`; the server must reject a command whose `depends_on` references a command that was rejected, with reason `dependency_rejected`, and must create one linked review item.
- Cross-device causality is carried by the canonical replica: a device can only reference rows it has already received via sync, or rows it created locally (tracked through `depends_on`). A command that references a `row_id` that exists in neither the replica nor the device's own pending creates is rejected `unknown_target` with a review item.
- The server applies each command in a single Drizzle transaction. If application fails an invariant or FK, it rejects atomically; no partial effects persist.

#### 7.2f Server command log

```sql
CREATE TABLE command_log (
  id uuid PRIMARY KEY,              -- equals client_commands.id (§7.2b)
  user_id uuid NOT NULL,
  device_id text NOT NULL,
  name text NOT NULL,
  command_version integer NOT NULL,
  schema_version integer NOT NULL,
  client_version text,
  hlc text NOT NULL,
  payload jsonb NOT NULL,
  effects jsonb NOT NULL DEFAULT '[]',
  parent_command_id uuid,
  triggering_command_id uuid,
  depends_on uuid[] NOT NULL DEFAULT '{}',
  applied_at timestamptz NOT NULL DEFAULT now(),
  result text NOT NULL CHECK (result IN ('applied','rejected','noop')),
  reject_reason text
);
```

Command history rules:

- Command logs are user-facing recoverability data, not just private diagnostics.
- `effects` stores a compact summary of rows created, updated, deleted, superseded, or rejected. It is not a replacement for table facts.
- `parent_command_id` links follow-up commands, undo commands, retries, and automation backstop work to their cause.
- `triggering_command_id` links deterministic automation output to the user command that triggered it.
- Command logs must be sufficient to explain automation provenance, conflict resolution, and server rejection reasons.
- v1 does not need a full undo/redo UI, but the command model must preserve enough information to add inverse commands later.

Verification requirement: integration tests must prove (a) a local `node.rename` produces exactly one named command upload and no generic row patch is ever accepted for the same change; (b) the optimistic overlay row reconciles to the identical canonical row with the same `created_by_command_id` after sync; (c) a rejected command's overlay effects vanish from merged reads and a review item appears; (d) a command with a rejected dependency is itself rejected with `dependency_rejected`.

### 7.3 Sync Streams

Use PowerSync Sync Streams, not legacy Sync Rules.

Access control must be based on the authenticated JWT user ID, never on client-supplied parameters alone. Stream parameter definitions must not accept a client-provided `user_id` or filter that could widen visibility; the user scope is derived from the verified token.

Stream tiers are not optional and must exist before the §15 100k-node load test (Revision V8). Define three subscribed streams from the start, even if Tier 0 and Tier 1 carry most data for a small user:

- **Tier 0 bootstrap**: `user_settings`, active visions, current sprint, today/near-future agenda, open review items, and command results for pending local commands. Must be small and fast on cold start.
- **Tier 1 active work**: active projects, habits, dependencies, the upcoming schedule horizon, active dashboard data, and canonical aggregates for visible subjects.
- **Tier 2 history/archive**: old time entries, completed project history, old command logs, and large diagram layouts. Subscribed lazily/on demand, not on cold start, and especially not eagerly on mobile.

Do not sync `command_log` as a general audit table. Use a filtered command-result stream scoped to the current user and recent/pending command IDs. Code must not hard-code the assumption that only one stream exists; reads must tolerate Tier 2 rows being absent until their stream is subscribed.

### 7.4 Aggregates

`computed_aggregates` is server-owned.

```sql
CREATE TABLE computed_aggregates (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  subject_kind text NOT NULL CHECK (subject_kind IN ('habit','node','user')),
  subject_id uuid,
  metric text NOT NULL,
  value jsonb NOT NULL,
  computed_at timestamptz NOT NULL,
  computed_by text NOT NULL DEFAULT 'server' CHECK (computed_by = 'server'),
  source_kind text NOT NULL DEFAULT 'server_job',
  source_id uuid,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  hlc text NOT NULL,
  schema_version integer NOT NULL
);
```

The `computed_by = 'server'` single-value CHECK is documentation-as-constraint; the real enforcement is that `computed_aggregates` is not a writable target in any client command handler and is absent from any client upload path. Client incremental aggregates live only in memory or local-only cache tables and must not upload to Postgres. A static test must prove no command handler and no upload path can write `computed_aggregates`.

### 7.5 Scheduler suggestion lifecycle

Add suggestion batches:

```sql
CREATE TABLE schedule_suggestion_batches (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('past_due','nightly_optimize','manual_optimize')),
  horizon_start timestamptz NOT NULL,
  horizon_end timestamptz NOT NULL,
  computed_at timestamptz NOT NULL,
  superseded_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  hlc text NOT NULL,
  schema_version integer NOT NULL
);
```

Extend `schedule_blocks`:

```sql
ALTER TABLE schedule_blocks ADD COLUMN suggestion_batch_id uuid REFERENCES schedule_suggestion_batches(id);
ALTER TABLE schedule_blocks ADD COLUMN replaces_block_id uuid REFERENCES schedule_blocks(id);
ALTER TABLE schedule_blocks ADD COLUMN superseded_at timestamptz;
```

Rules:

- Suggested blocks must have `status = 'suggested'`.
- Committed blocks must not have `suggestion_batch_id`.
- A newer optimization batch supersedes older non-accepted suggestions in the same horizon.
- `block.accept_suggestion` must run in one transaction:
  - verify suggestion is not superseded or deleted,
  - verify the task is not done,
  - soft-delete or move any replaced flexible block,
  - reject if it overlaps an anchored block,
  - promote the suggestion to `committed`,
  - mark conflicting suggestions as superseded.
- `block.reject_suggestion` soft-deletes only the suggestion.

### 7.6 Dependency semantics

Edges use:

- FS: successor start depends on predecessor finish.
- SS: successor start depends on predecessor start.
- FF: successor finish depends on predecessor finish.
- SF: successor finish depends on predecessor start.

For status availability:

- FS blocks availability until predecessor is completed plus lag.
- SS blocks availability until predecessor has started plus lag. "Started" means at least one `time_entries.started_at` exists or the predecessor is completed.
- FF does not block availability. It blocks completion until predecessor is completed plus lag.
- SF does not block availability. It blocks completion until predecessor has started plus lag.

For scheduler placement:

- FS: successor block start must be at or after predecessor finish plus lag.
- SS: successor block start must be at or after predecessor start plus lag.
- FF: successor block finish must be at or after predecessor finish plus lag.
- SF: successor block finish must be at or after predecessor start plus lag.

For completion:

- Completing a task must reject if any FF or FS predecessor completion requirement is unmet.
- Completing a task must reject if any SF predecessor start requirement is unmet.
- The error code must identify the blocking edge and predecessor.

### 7.7 Soft-delete uniqueness

Any table with `deleted_at` and uniqueness semantics must use partial unique indexes.

```sql
CREATE UNIQUE INDEX edges_active_unique
  ON edges(predecessor_id, successor_id)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX habit_completions_active_unique
  ON habit_completions(habit_id, occurrence_date)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX sprint_memberships_active_unique
  ON sprint_memberships(sprint_id, node_id)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX decision_scores_active_unique
  ON decision_scores(criterion_id, project_id)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX diagram_layouts_active_unique
  ON diagram_layouts(diagram_id, node_id)
  WHERE deleted_at IS NULL;
```

For nullable `subject_id` in `computed_aggregates`, use separate partial indexes for user-level and subject-level aggregates.

### 7.8 Provenance columns

Important user-visible rows must include provenance fields:

```sql
created_by_command_id uuid,
last_modified_by_command_id uuid,
source_kind text CHECK (source_kind IN ('user','automation','scheduler','server_job','import','system')),
source_id uuid,
source_detail jsonb NOT NULL DEFAULT '{}'
```

Apply these fields to at least: `nodes`, `edges`, `schedule_blocks`, `time_entries`, `habit_completions`, `automation_rules`, `blocker_rules`, `diagram_layouts`, `computed_aggregates`.

Rules:

- User-created rows use `source_kind = 'user'`.
- Automation-spawned rows use `source_kind = 'automation'`, `source_id = automation_rules.id`, and `source_detail` containing trigger node ID, trigger command ID, action slot, **rule version, and template version** (§10.2).
- Scheduler suggestions use `source_kind = 'scheduler'`, `source_id = schedule_suggestion_batches.id`.
- Server aggregate rows use `source_kind = 'server_job'`.
- Imported rows use `source_kind = 'import'` and include import file metadata in `source_detail`.
- All provenance fields are server-assigned per §7.2c. The optimistic client may predict `created_by_command_id` and `source_kind='user'` for overlay display only.
- The UI must answer "why does this exist?" for tasks and schedule suggestions using provenance plus command history.

### 7.9 HLC and identifiers

#### 7.9a HLC encoding

The HLC is stored as `text` and must be encoded so that lexicographic string comparison equals causal/temporal order. Use fixed-width zero-padded fields: a 48-bit physical-time millisecond component, a 16-bit logical counter, and a device-id tiebreak suffix, e.g. `"<paddedMillis>:<paddedCounter>:<deviceId>"`. `core/time` must expose `encodeHlc`, `compareHlc`, `tickHlc`, and `mergeHlc`, with property tests proving total order, monotonicity, and deterministic device tiebreak.

#### 7.9b Identifiers

Client-created entity IDs use UUIDv7. Deterministic automation outputs use UUIDv5 with namespace `PRISMS_NS` over `(rule_id, trigger_id, action_slot)`.

### 7.10 Deterministic merge and LWW exceptions

Per-field last-writer-wins by HLC is the default conflict resolution for scalar fields (title, description, dates, estimates). Two fields require explicit deterministic merge functions in `core/merge`, with fast-check property tests in the convergence harness. (Revision V9.)

#### 7.10a sort_order

`sort_order` uses fractional indexing (§7.1 / S4). Concurrent "insert between the same pair" on two devices can produce equal or near-equal fractions. Resolution:

- The effective ordering key is the pair `(sort_order, hlc)`, never `sort_order` alone. Equal fractions break by HLC, which is total and deterministic.
- A periodic, deterministic renormalization command (`layout.renormalize_order`, server-issued or batched) may rewrite collided fractions to clean spacing; it must be idempotent and provenance-tagged.
- Property test: two devices each insert between the same neighbors offline; after convergence both devices show the same total order.

#### 7.10b Timer intervals

Two offline clock-ins on the same task produce two open `time_entries`. The deterministic resolver `mergeTimeEntries(taskId, entries)` is a pure core function applied server-side on convergence and mirrored client-side for display:

- Open intervals on the same task are merged into a single canonical interval spanning `min(started_at)` to the resolved end. If both are still open, keep one open interval with the earliest `started_at`; mark the later open entry `superseded` with provenance pointing at the survivor.
- When one has a `clock_out`, the merged interval ends at the latest known `ended_at`; overlapping spans are unioned (not summed) so effective hours never double-count.
- This rule is the single source of truth for `effective hours`. It has dedicated property tests: union-not-sum, idempotency, and order-independence.
- The client "hide double timers" rule is a display projection of this resolver, not a second algorithm.

### 7.11 Synced-row schema versioning and mixed-version devices

Row-shape compatibility is separate from command-payload versioning (§8). (Revision V5, R16.)

- Every synced row carries `schema_version` (the row-shape version, server-assigned).
- Within a major schema version, changes are additive only: new nullable columns, new tables, new indexes. Renames, type changes, drops, and new NOT-NULL-without-default columns require a major bump and an explicit migrator.
- Client local schemas define their own column set. PowerSync clients must ignore unknown downloaded columns rather than fail. An old client reading a row with new columns simply does not use them.
- A downloaded column must never be required for an older client to render a row it already understands. New required semantics ship behind a new command/feature, not by making an existing read mandatory.
- The server records the minimum client schema version it still accepts commands from. A command from a client below that floor is rejected `client_too_old` with a review item instructing upgrade, and never applied by guesswork.
- The convergence harness (S12) must include a mixed-schema-version test: a simulated "old" client (schema_version N-1, ignoring an added column) and a "new" client (schema_version N, writing it) editing concurrently, proving no corruption and deterministic convergence.

### 7.12 Derived-status incremental index

Status stays derived (no stored status column, Principle 2), but must not be computed by full table scan per command. (Revision V7.)

- `core/status` exposes both a pure `statusOf(nodeId, facts)` and an incremental index `StatusIndex` that maintains derived status (and the "available worklist" set, "blocked" set, and "scheduled" set) keyed by node.
- `StatusIndex.apply(effects)` accepts the minimal effects of a command (the same `overlay_effects`/server effect summary) and recomputes status only for the affected nodes and their dependency neighbors (successors of changed predecessors, ancestors for rollups). It must not rescan unrelated nodes.
- Inputs that influence status — `completed_at`, open `time_entries`, edges and predecessor states, sprint membership, committed future blocks, blocker-rule results — register dependencies so the index knows which nodes to invalidate when each fact changes.
- The index is a pure, deterministic projection: rebuilding from scratch must equal the incrementally maintained value (property test).
- The §15 load test must measure per-command status recompute time at 100k nodes, not only initial render. Budget: a single typical command must update status in well under the agenda interaction budget.

### 7.13 Conflict and rejection inbox

```sql
CREATE TABLE sync_review_items (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  command_id uuid REFERENCES command_log(id),
  item_type text NOT NULL CHECK (item_type IN (
    'command_rejection',
    'dependency_rejection',
    'hlc_conflict',
    'stale_suggestion',
    'automation_backstop',
    'automation_drift',
    'schema_version_block',
    'import_warning',
    'sync_warning'
  )),
  severity text NOT NULL CHECK (severity IN ('info','warning','error')),
  title text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  created_at timestamptz NOT NULL,
  resolved_at timestamptz,
  deleted_at timestamptz,
  hlc text NOT NULL,
  schema_version integer NOT NULL
);
```

Rules:

- Server command rejections create or update an open review item.
- A command rejected for a rejected dependency creates a `dependency_rejection` item linked to the root cause.
- Stale suggestion acceptance creates an item if it cannot be resolved automatically.
- HLC conflicts create an item when the losing value is user-visible and materially different; the losing value is preserved in `detail`.
- Automation backstop creates an informational item when it adds rows the client did not create locally.
- Automation drift (§10.2) creates an informational item when backstop finds the same deterministic id with different content.
- `schema_version_block` is created when a command is rejected `client_too_old`.
- Review items must be visible in web, mobile, and desktop.
- Toasts may point to review items but must not replace them.

## 8. Command Catalog

The complete command catalog should include at least:

```text
node.create
node.rename
node.set_description
node.move
node.retype
node.set_dates
node.set_estimate
node.reorder
node.check_off
node.uncheck
node.soft_delete
activity.promote

edge.create
edge.delete

block.create
block.move
block.set_anchor
block.delete
block.accept_suggestion
block.reject_suggestion

timer.clock_in
timer.clock_out
timer.review

habit.create
habit.update
habit.delete
habit.check_off

sprint.create
sprint.add_node
sprint.remove_node
sprint.delete

board.create
criterion.create
criterion.set_weight
score.set

rule.create
rule.update
rule.toggle
rule.delete

blocker.create
blocker.update
blocker.toggle
blocker.delete

layout.set_position
layout.set_collapsed
layout.renormalize_order
group.create
group.update
group.delete

settings.update
```

Each command must define:

- Zod payload schema (excluding trust fields, §7.2c).
- `command_version` and migrator rules.
- Pure invariant checks (run against merged state on the client, against Postgres state on the server).
- Pure optimistic effect builder (produces `overlay_effects`).
- Server transaction applier.
- Machine-readable success or rejection result.
- Idempotency behavior using command ID.
- `depends_on` derivation rules where the command can reference locally-created rows (§7.2e).
- Provenance effects and command-log effect summaries (server-assigned).

Command compatibility rules (payload versioning, distinct from row-schema versioning §7.11):

- Every command envelope carries `command_version`, `schema_version` (client row-shape version), and optional `client_version`.
- The server must either migrate an older supported command payload to the current handler or reject it with a version-specific review item.
- Command payloads may only gain optional fields within a compatible version.
- Removing or changing the meaning of a field requires a new command version.

Specific command rules clarified in 1.3:

- `timer.clock_in` on a task whose merged status is `blocked` is rejected `blocked_task` unless the user explicitly overrides via a payload flag `force: true`; with `force`, the entry is created and `ongoing` wins the status precedence. Define this consistently so two devices converge identically.
- `node.retype` must reject if the new type would orphan child types (e.g., retyping a Project to a Task while it has Milestone/Task children), with error `invalid_retype_children`, unless the payload includes an explicit cascade plan. It revalidates hierarchy and justification.
- `node.move` revalidates hierarchy typing and justification (ancestry reaches a Vision or the node has `habit_id`).
- `layout.renormalize_order` is the deterministic sort_order cleanup from §7.10a; it is idempotent and provenance-tagged.

## 9. Derived State

### 9.1 Task status

Task status precedence is:

```text
done > ongoing > blocked > scheduled > prioritized > available
```

Rules:

- `done` if `completed_at` is set.
- `ongoing` if an open `time_entry` exists for the task (after timer-merge resolution, §7.10b).
- `blocked` if FS or SS availability rules fail, or if a blocker rule evaluates true. Weather-derived blocking is advisory display only and never participates in command acceptance (§10.3, R19).
- `scheduled` if a committed future block exists.
- `prioritized` if the task belongs to an active sprint.
- `available` otherwise.

No status column exists. Status is served from the `StatusIndex` (§7.12), which is a deterministic projection of these rules.

Interaction with `timer.clock_in`: because `ongoing` outranks `blocked`, a forced clock-in on a blocked task shows `ongoing`. Without `force`, clock-in on a blocked task is rejected (§8), so the contradictory state cannot arise by accident.

### 9.2 Aggregates

Core must compute: effective hours, habit streaks, practice hours and levels, task progress, project completion percentage, burndown, projections, time left in day, time left in task, and time until next committed block.

Every "today" calculation must use:

```text
bucketDate(ts, timezone, day_reset_hour)
```

Effective hours specifically must consume the timer-merge resolver (§7.10b) so overlapping intervals union rather than sum.

## 10. Rules Engine

Automation and blocker rules share one predicate evaluator.

### 10.1 Execution model

Automation rules:

- execute synchronously inside the same local SQLite transaction (overlay) as the triggering command, and are re-applied authoritatively server-side,
- run to fixpoint with `MAX_DEPTH = 5`,
- use deterministic UUIDv5 IDs for spawned rows,
- read timestamps from triggering facts, not wall clock,
- must be idempotent across offline devices.

### 10.2 Rule and template versioning, drift detection

(Revision V6.)

- Each `automation_rules` row carries a `rule_version` (bumped on `rule.update`) and the action templates carry a `template_version` constant in code.
- Automation evaluated offline uses the rule version locally visible at trigger time. Spawned-row provenance records `rule_version` and `template_version` in `source_detail` alongside trigger node id, trigger command id, and action slot.
- UUIDv5 guarantees the spawned-row **id** is identical across devices; it does not guarantee identical **content** when rule/template versions differ. Therefore the server `automation.backstop` job must compare content, not just existence:
  - If the deterministic row is absent, create it.
  - If present and content-equivalent (by a canonical content hash over the spawned fields), no-op.
  - If present but content differs (drift from a version skew), keep the existing row, do not silently overwrite, and create an `automation_drift` informational review item recording both versions and both content hashes.
- A self-triggering rule is rejected at `rule.create`/`rule.update` time.

### 10.3 Blocker rules and external facts

Blocker rules:

- evaluate from synced local facts,
- may return `true`, `false`, or `unknown`,
- treat unknown weather as not blocked but surface a "weather unverified" UI badge.

External-fact-derived results (weather and any future provider fact) are advisory display state only. They must never cause a command to be rejected and must never change a convergent canonical outcome. Two devices with different weather freshness may display different advisory blocking, but both converge to identical committed facts. (Revision V10, R19.)

## 11. Scheduler

The scheduler is a pure core function:

```ts
schedule(input: {
  tasks: SchedulableTask[];
  committed: Block[];
  windows: TimeWindow[];
  horizon: { from: Instant; to: Instant };
  mode: 'greedy' | 'optimize';
}): {
  proposals: BlockProposal[];
  unplaceable: Array<{ task_id: string; reason: string }>;
}
```

Hard constraints: anchored blocks never move; no overlaps; no scheduling done tasks; dependency constraints for FS, SS, FF, and SF; task time windows; suggestion acceptance never creates anchored-block overlap.

Client mode: greedy earliest-fit; powers drag window hints; powers single-task past-due reschedule; must complete in milliseconds for normal agenda operations and must operate on a bounded horizon window, not the full task set.

Server mode: optimize multi-day or multi-week plans; writes suggestion batches and suggested schedule blocks; never commits schedule changes without an explicit user command.

## 12. Server Jobs

| Job                      | Trigger                           | Output                                                                                                                                    |
| ------------------------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `weather.poll`           | Cron                              | `external_facts` rows.                                                                                                                    |
| `aggregates.recompute`   | Nightly after user day reset      | Server-owned `computed_aggregates`, computed against a transactional snapshot.                                                            |
| `schedule.optimize`      | Nightly and on major plan changes | Suggestion batch plus suggested blocks.                                                                                                   |
| `pastdue.scan`           | Frequent cron                     | Warning notification plus suggested replacement block.                                                                                    |
| `automation.backstop`    | Upload dispatcher                 | Missing deterministic spawned rows; drift review items (§10.2).                                                                           |
| `layout.precompute`      | Diagram set changes               | Server-computed diagram layouts for large diagrams.                                                                                       |
| `notify.dispatch`        | Other jobs                        | Web Push or Expo push.                                                                                                                    |
| `retention.purge`        | Weekly                            | Hard-delete rows soft-deleted longer than retention. Must preserve command-dedup records younger than `MAX_OFFLINE_HORIZON` (§7.2d, R18). |
| `backup.snapshot`        | User request or optional schedule | Portable export file or server-side backup artifact.                                                                                      |
| `import.validate`        | User import request               | Dry-run report and `sync_review_items` for warnings.                                                                                      |
| `review.expire_resolved` | Weekly                            | Soft-delete old resolved review items after retention.                                                                                    |

Job rules:

- Canonical-state jobs (`aggregates.recompute`, `schedule.optimize`, `automation.backstop`) read a consistent transactional snapshot and write with `computed_at`/provenance. If a newer command lands during a job, the next scheduled run supersedes; a job must not clobber a fact written by a later command (compare HLC/`updated_at`).
- Jobs are idempotent: re-running with the same inputs produces the same rows (deterministic IDs where rows are created).

## 13. Security, Privacy, Portability, and Adapter Boundaries

### 13.1 Backup and export/import format

Portable export format:

```json
{
  "format": "prisms-export",
  "format_version": 1,
  "schema_version": 1,
  "exported_at": "2026-06-14T00:00:00Z",
  "app_version": "x.y.z",
  "user": {"id": "..."},
  "tables": {},
  "command_history": [],
  "review_items": [],
  "attachments": [],
  "checksums": {}
}
```

Rules:

- Export must include facts, settings, command history needed for provenance, and review items.
- Export must not include raw auth tokens or provider secrets.
- Export may include attachment manifests even if attachments are deferred in v1.
- On installed targets (desktop, mobile), export defaults to passphrase-encrypted; plaintext export requires an explicit user opt-out and a warning. Web supports optional passphrase encryption. (Revision V12.)
- Import semantics (Revision V12, R20):
  - Import supports dry-run validation before writing.
  - Import **restores rows as data**; it must not re-execute historical commands. The `command_history` array is restored as command-log records marked non-replayable.
  - Imported rows are written through an explicit import transaction that stamps `source_kind = 'import'` provenance and import file metadata.
  - Imported HLC values must be made dominated by any subsequent local write: on import, the device HLC clock is advanced past the maximum imported HLC, so new edits always order after imported state. A test must prove "import then edit" yields monotonic ordering and a deterministic converged result.
  - Import conflicts create `sync_review_items`.
  - The export format is versioned and must have migrators or explicit unsupported-version errors.

### 13.2 Local privacy and encryption

- Auth/session secrets must use platform-secure storage, not ordinary local storage.
- Desktop and mobile database encryption must be behind an adapter so SQLCipher or platform-specific encryption can be added without touching core.
- Web storage limitations must be documented. Web exports should support optional passphrase encryption.
- Crash logs and telemetry, if added later, must never include task titles, descriptions, command payloads, or time-entry detail by default.

### 13.3 Adapter ports

Define provider-neutral interfaces outside core for: weather provider, notification provider, calendar import/export provider, backup/export provider, secure storage provider, local database encryption provider, and future LLM assistance provider.

Rules:

- Core consumes provider-neutral facts and commands only.
- Server and platform apps own concrete provider implementations.
- Test fakes must exist for every adapter before production provider code is used in tests.

### 13.4 External facts and convergence

External facts enter only through the weather adapter as `external_facts` rows. Their derived effects are advisory (§10.3). No command applier may read an external fact in a way that changes whether the command is accepted, and no convergent canonical row may depend on which device had fresher external facts. A test must prove that two devices with deliberately divergent weather facts converge to identical committed state.

## 14. Build Plan Summary

Detailed, session-sized steps and Definition-of-Done gates live in `BUILD_PLAN_REVISED_v1.3.md`. The phase order and gates there are normative; this section is the index.

- Phase 0: command-bridge, two-layer store, Sync Streams, desktop feasibility spike (S0).
- Phase A: foundations - scaffold, domain types/time/merge/version primitives, db + Sync Streams (S1-S3).
- Phase B: core engines - graph, status + incremental index, aggregates, rules, scheduler greedy/optimize (S4-S9).
- Phase C: server - API/auth, dispatcher + catalog + ordering, convergence harness, jobs (S10-S14).
- Phase D: web app (S15-S20).
- Phase E: mobile, desktop, hardening/portability (S21-S23).

## 15. Verification Commands and CI Gates

The repo must provide equivalents for:

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm test:property
pnpm test:integration
pnpm test:convergence
pnpm test:e2e
pnpm test:recurrence
pnpm test:export
pnpm test:perf            # status/agenda recompute at 100k nodes
pnpm build
docker compose up --build
```

Minimum CI gates:

- Core line coverage at or above 90 percent.
- Every invariant has a rejecting test.
- Scheduler property tests cover overlap, anchoring, dependencies, and idempotency.
- Rules engine property tests cover idempotency, deterministic spawned IDs, and drift detection.
- Two-device convergence test covers offline edits, HLC conflict resolution, automation spawning, double clock-in resolution, sort_order collision, mixed-schema-version devices, and external-fact divergence.
- Command-bridge test proves named commands are the only server write path and that overlay effects never upload as row patches.
- Overlay reconciliation test proves an optimistic row converges to the identical canonical row, with matching `created_by_command_id`, and that a rejected command's overlay vanishes.
- Causal-ordering test proves a command with a rejected dependency is rejected `dependency_rejected` with a linked review item.
- Sync Streams test proves one user cannot receive another user's rows and that stream parameters cannot widen scope.
- Command version migration and `client_too_old` rejection tests pass.
- Trust-field test proves client-supplied `user_id`/provenance/system fields are ignored and overwritten.
- Provenance tests prove tasks, suggestions, automation outputs, and canonical aggregates can explain their source.
- Review inbox tests prove rejections, dependency rejections, drift, and material conflicts are durable.
- Export/import round-trip tests pass and prove import does not replay commands and preserves HLC monotonicity.
- Performance test proves per-command status recompute and agenda render stay within budget at 100k nodes.
- Adapter-boundary lint proves core imports no provider SDKs.

## 16. Definition of Finished

The implementation is finished only when all of the following are true:

1. Every write in every app goes through `executeCommand`.
2. No app has a generic "update entity" network endpoint.
3. PowerSync uploads named command envelopes, not arbitrary SQL or generic row patches; overlay effects never upload as row patches.
4. The client store is two layers: read-only canonical replica plus disposable optimistic overlay, and the UI reads their deterministic merge.
5. An optimistic write reconciles to the identical canonical row after sync, with matching provenance, and a rejected command's overlay rolls back cleanly into a durable review item.
6. `command_log.id` equals the client command id end-to-end.
7. Commands apply in HLC order with causal `depends_on`; a command with a rejected dependency is rejected, not misapplied.
8. Offline creation, editing, scheduling, automation spawning, dependency unblocking, timer flow, and suggestion review all work.
9. Two offline devices converge after reconnect, including sort_order collisions, double clock-ins, mixed schema versions, and divergent external facts.
10. Server jobs produce synced data against consistent snapshots, never hidden blocking responses, and never clobber later command writes.
11. Client aggregate caches are local-only; server canonical aggregates sync down with `computed_at` and provenance.
12. Scheduler suggestions have batch lifecycle and stale-suggestion rejection.
13. Soft-deleted unique rows can be recreated.
14. FS, SS, FF, and SF semantics are covered by tests.
15. Command versions and synced-row schema versions are enforced separately at upload and export/import boundaries; old clients fail gracefully.
16. Status is derived through an incremental index and meets the 100k-node per-command budget; no stored status column exists.
17. Tasks, schedule suggestions, automation outputs, and server aggregate rows have server-assigned provenance; client-supplied trust fields are ignored.
18. Automation drift is detected and surfaced, not silently overwritten.
19. Rejected offline commands and material conflicts appear in a durable review inbox.
20. Export/import round trip preserves facts, settings, command history, review items, and provenance; import restores data without replaying commands and preserves HLC monotonicity.
21. Auth secrets use secure storage on installed apps; installed-target export is encrypted by default; local encryption limitations are documented.
22. Provider-specific APIs are contained behind adapters and absent from core; external facts never gate command acceptance or convergence.
23. Web, mobile, and desktop each pass their platform smoke tests or have a documented, accepted v1 exception.

## 17. Instructions to the LLM Code Generator

1. Read this file completely before coding.
2. Build the smallest vertical slice first: authenticated local rename through the command envelope and optimistic overlay, server command dispatch with the client command id as `command_log.id`, Postgres write, PowerSync down-sync, overlay reconciliation, and second-device convergence.
3. Do not implement broad UI before the two-layer store, command bridge, reconciliation, and rejection rollback are proven.
4. Put all domain decisions, merge functions, and the status index in `packages/core`.
5. Keep IO at the app/server edges.
6. Add tests before or alongside each core behavior.
7. Prefer explicit small functions over clever abstractions.
8. Never store task status; serve it from the incremental index.
9. Never let server optimization directly commit a user's calendar changes.
10. Treat command history and provenance as product features; assign all trust fields server-side.
11. Create review items for rejected, dependency-rejected, drifted, or materially conflicted offline work.
12. Keep provider SDKs behind adapters; never let an external fact change whether a command is accepted.
13. Stop at each phase gate and report failures before proceeding.
