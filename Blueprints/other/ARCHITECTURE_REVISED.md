# Prisms Architecture Specification, Revised

Version 1.2 - single-user release, collaboration deferred

Audience: an LLM code generator building the codebase. Normative sections use "must". Informative sections use "should" or "may".

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

## 3. Critical Revisions From Version 1.0

The following revisions are mandatory before implementation.

| Area | Revision | Reason |
| --- | --- | --- |
| PowerSync writes | Add a command-envelope bridge. PowerSync records local row operations, so the app must explicitly map local optimistic writes to named commands before upload. | Preserves "commands, not queries" while using PowerSync correctly. |
| PowerSync config | Use Sync Streams for new work. Do not build around legacy Sync Rules. | Sync Streams are the current recommended PowerSync mechanism. |
| Aggregates | Client-computed aggregates are local-only caches. Only server canonical aggregates sync through Postgres. | Prevents derivative client cache rows from becoming conflict-prone source data. |
| Scheduler suggestions | Add suggestion batches, replacement links, supersession, and transactional acceptance rules. | Prevents stale or overlapping optimization proposals. |
| Dependency semantics | Define FS, SS, FF, and SF separately for status, scheduling, and completion gates. | Avoids ambiguous behavior around start and finish dependencies. |
| Soft deletes | Replace normal unique constraints on soft-deletable tables with partial unique indexes where `deleted_at IS NULL`. | Allows recreate-after-delete and avoids accidental uniqueness lockout. |
| Desktop risk | Keep desktop late, but run an early Tauri + PowerSync spike. Treat PowerSync Tauri support as a risk until proven. | Avoids discovering SDK/platform incompatibility after the app is otherwise built. |
| React version | Use "current stable React" rather than pinning React 18. | Keeps the generated project aligned with current frontend defaults. |
| Command history | Treat command logs, effects, provenance, and review items as user-facing recoverability infrastructure. | Enables explanations, undo groundwork, debugging, and trustworthy offline conflict handling. |
| Versioning | Add command, schema, export, and client version fields. | Protects multi-device sync when some clients are older. |
| Backup/export | Add a first-class portable export/import format. | Strengthens self-hosting and no-lock-in guarantees. |
| Privacy/adapters | Add local secret storage, optional DB encryption adapters, and provider ports. | Keeps personal data safer and prevents vendor APIs from spreading through the app. |

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

## 5. Technology Stack

| Layer | Choice | Notes |
| --- | --- | --- |
| Language | TypeScript strict mode | Shared across client, server, and core. |
| Monorepo | pnpm workspaces and Turborepo | Keep package boundaries explicit. |
| Web | Vite, current stable React SPA | No SSR required for the local-first app shell. |
| Desktop | Tauri v2 wrapping the web build | Run an early PowerSync desktop spike before committing deeply. |
| Mobile | Expo React Native | Use PowerSync React Native and Expo support. |
| Local DB | SQLite | OPFS/wa-sqlite on web, platform SQLite elsewhere. |
| Sync | PowerSync with Sync Streams | Self-hosted baseline, managed cloud optional. |
| Server DB | Postgres 15 or newer | Durable source of truth. |
| API | Hono on Node 20+ | Command dispatcher and auth integration. |
| ORM/migrations | Drizzle | Parameterized SQL only. |
| Validation | Zod in `packages/core` | Shared source for command and domain schemas. |
| Jobs | pg-boss | Queue inside Postgres, no Redis for v1. |
| Auth | Better Auth or equivalent API-owned auth | Must issue JWTs usable by API and PowerSync. |
| Graph UI | React Flow on web/desktop | Mobile graph editing is out of scope for v1. |
| Graph layout | ELK via `elkjs` | Invoked through core view-model builders or jobs. |
| Recurrence | `rrule.js` | Store RRULE strings. |
| UI state | PowerSync live queries plus Zustand | Zustand only for ephemeral UI state. |
| Tests | Vitest, fast-check, Playwright where UI matters | Core has the highest coverage bar. |

## 6. Monorepo Layout

```text
prisms/
  packages/
    core/
      src/domain/
      src/commands/
      src/status/
      src/aggregates/
      src/scheduler/
      src/rules/
      src/graph/
      src/time/
      test/
    db/
      drizzle schema, migrations, Sync Streams config
    ui/
      shared hooks and selectors
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

## 7. Data Model Revisions

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
- `user_settings`

All synced tables must have:

- `id uuid primary key`
- `user_id uuid not null`
- `created_at timestamptz not null`
- `updated_at timestamptz not null`
- `deleted_at timestamptz`

Client-created entity IDs use UUIDv7. Deterministic automation outputs use UUIDv5.

### 7.2 Command envelope bridge

PowerSync captures local SQLite writes as row operations. Prisms still requires named commands. Therefore the client must use a command executor that writes an explicit command envelope in the same SQLite transaction as its optimistic local effects.

Add a client-write command envelope table:

```sql
CREATE TABLE client_commands (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  device_id text NOT NULL,
  name text NOT NULL,
  command_version integer NOT NULL,
  schema_version integer NOT NULL,
  client_version text,
  hlc text NOT NULL,
  payload jsonb NOT NULL,
  provenance jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL,
  uploaded_at timestamptz,
  rejected_at timestamptz,
  reject_reason text
);
```

Rules:

- UI code must never write domain tables directly.
- UI code calls `executeCommand(name, payload)`.
- `executeCommand` validates the payload with core Zod schemas.
- `executeCommand` computes optimistic local effects with pure core command handlers.
- `executeCommand` writes `client_commands` and all optimistic effects in one local SQLite transaction.
- Every optimistic row operation must carry or be traceable to `command_id`.
- `uploadData()` must process `client_commands` operations as the authoritative upload.
- `uploadData()` must not translate domain table operations into generic SQL.
- The server applies named commands synchronously to Postgres and appends `command_log`.
- Rejections are written to a synced `sync_review_items` row plus a command result stream so clients can revert, rebase, or ask the user to review.

Server-side command log:

```sql
CREATE TABLE command_log (
  id uuid PRIMARY KEY,
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

Verification requirement: an integration test must prove that a local `node.rename` produces one named command upload and that the server does not accept a generic row patch path for the same change.

### 7.3 Sync Streams

Use PowerSync Sync Streams, not legacy Sync Rules.

Initial v1 stream strategy:

- One auto-subscribed stream for the current user's core data.
- Later optimization may split by active project, archive, or date horizon.
- Access control must be based on authenticated JWT user ID, never on client-supplied parameters alone.

Do not sync `command_log` as a general audit table unless the client needs it. Prefer a filtered command result stream scoped to the current user and recent command IDs.

The stream design must leave room for priority tiers:

- Tier 0 bootstrap: `user_settings`, active visions, current sprint, today/near-future agenda, open review items, and command results for pending local commands.
- Tier 1 active work: active projects, habits, dependencies, upcoming schedule horizon, and active dashboard data.
- Tier 2 history/archive: old time entries, completed project history, old command logs, and large diagram layouts.

v1 may subscribe to one user-wide stream if simpler, but code must not hard-code the assumption that only one stream will ever exist.

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
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz
);
```

Client incremental aggregates must live in memory or local-only cache tables. They must not upload to Postgres.

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
  deleted_at timestamptz
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

Examples:

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

Apply these fields to at least:

- `nodes`
- `edges`
- `schedule_blocks`
- `time_entries`
- `habit_completions`
- `automation_rules`
- `blocker_rules`
- `diagram_layouts`
- `computed_aggregates`

Rules:

- User-created rows use `source_kind = 'user'`.
- Automation-spawned rows use `source_kind = 'automation'`, `source_id = automation_rules.id`, and `source_detail` containing trigger node ID, trigger command ID, and action slot.
- Scheduler suggestions use `source_kind = 'scheduler'`, `source_id = schedule_suggestion_batches.id`.
- Server aggregate rows use `source_kind = 'server_job'`.
- Imported rows use `source_kind = 'import'` and include import file metadata in `source_detail`.
- The UI must be able to answer "why does this exist?" for tasks and schedule suggestions using provenance plus command history.

### 7.9 Conflict and rejection inbox

Add a synced review table:

```sql
CREATE TABLE sync_review_items (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  command_id uuid REFERENCES command_log(id),
  item_type text NOT NULL CHECK (item_type IN (
    'command_rejection',
    'hlc_conflict',
    'stale_suggestion',
    'automation_backstop',
    'import_warning',
    'sync_warning'
  )),
  severity text NOT NULL CHECK (severity IN ('info','warning','error')),
  title text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  created_at timestamptz NOT NULL,
  resolved_at timestamptz,
  deleted_at timestamptz
);
```

Rules:

- Server command rejections create or update an open review item.
- Stale suggestion acceptance creates an item if it cannot be resolved automatically.
- HLC conflicts create an item when the losing value is user-visible and materially different.
- Automation backstop creates an informational item when it adds rows that the client did not create locally.
- Review items must be visible in web, mobile, and desktop.
- Toasts may point to review items, but must not replace them.

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
group.create
group.update
group.delete

settings.update
```

Each command must define:

- Zod payload schema.
- `command_version` and migrator rules.
- Pure invariant checks.
- Pure optimistic effect builder.
- Server transaction applier.
- Machine-readable success or rejection result.
- Idempotency behavior using command ID.
- Provenance effects and command-log effect summaries.

Command compatibility rules:

- Every command envelope carries `command_version`, `schema_version`, and optional `client_version`.
- The server must either migrate an older supported command payload to the current handler or reject it with a version-specific review item.
- Command payloads may only gain optional fields within a compatible version.
- Removing or changing the meaning of a field requires a new command version.

## 9. Derived State

### 9.1 Task status

Task status precedence is:

```text
done > ongoing > blocked > scheduled > prioritized > available
```

Rules:

- `done` if `completed_at` is set.
- `ongoing` if an open `time_entry` exists for the task.
- `blocked` if FS or SS availability rules fail, or if a blocker rule evaluates true.
- `scheduled` if a committed future block exists.
- `prioritized` if the task belongs to an active sprint.
- `available` otherwise.

No status column exists.

### 9.2 Aggregates

Core must compute:

- effective hours,
- habit streaks,
- practice hours and levels,
- task progress,
- project completion percentage,
- burndown,
- projections,
- time left in day,
- time left in task,
- time until next committed block.

Every "today" calculation must use:

```text
bucketDate(ts, timezone, day_reset_hour)
```

## 10. Rules Engine

Automation and blocker rules share one predicate evaluator.

Automation rules:

- execute synchronously inside the same local SQLite transaction as the triggering command,
- run to fixpoint with `MAX_DEPTH = 5`,
- use deterministic UUIDv5 IDs for spawned rows,
- read timestamps from triggering facts,
- must be idempotent across offline devices.

Blocker rules:

- evaluate from synced local facts,
- may return `true`, `false`, or `unknown`,
- treat unknown weather as not blocked but surface a "weather unverified" UI badge.

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

Hard constraints:

- anchored blocks never move,
- no overlaps,
- no scheduling done tasks,
- dependency constraints for FS, SS, FF, and SF,
- task time windows,
- suggestion acceptance never creates anchored-block overlap.

Client mode:

- greedy earliest-fit,
- powers drag window hints,
- powers single-task past-due reschedule,
- must complete in milliseconds for normal agenda operations.

Server mode:

- optimize multi-day or multi-week plans,
- writes suggestion batches and suggested schedule blocks,
- never commits schedule changes without explicit user command.

## 12. Server Jobs

| Job | Trigger | Output |
| --- | --- | --- |
| `weather.poll` | Cron | `external_facts` rows. |
| `aggregates.recompute` | Nightly after user day reset | Server-owned `computed_aggregates`. |
| `schedule.optimize` | Nightly and on major plan changes | Suggestion batch plus suggested blocks. |
| `pastdue.scan` | Frequent cron | Warning notification plus suggested replacement block. |
| `automation.backstop` | Upload dispatcher | Missing deterministic spawned rows. |
| `layout.precompute` | Diagram set changes | Server-computed diagram layouts for large diagrams. |
| `notify.dispatch` | Other jobs | Web Push or Expo push. |
| `retention.purge` | Weekly | Hard-delete rows soft-deleted longer than retention. |

Additional platform maintenance jobs:

| Job | Trigger | Output |
| --- | --- | --- |
| `backup.snapshot` | User request or optional schedule | Portable export file or server-side backup artifact. |
| `import.validate` | User import request | Dry-run report and `sync_review_items` for warnings. |
| `review.expire_resolved` | Weekly | Soft-delete old resolved review items after retention. |

## 13. Security, Privacy, Portability, and Adapter Boundaries

### 13.1 Backup and export format

The app must support a portable export format:

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
- Import must support dry-run validation before writing.
- Import writes rows through an import command path or explicit import transaction that records provenance.
- Import conflicts create `sync_review_items`.
- The export format is versioned and must have migrators or explicit unsupported-version errors.

### 13.2 Local privacy and encryption

Rules:

- Auth/session secrets must use platform-secure storage, not ordinary local storage.
- Desktop and mobile database encryption must be behind an adapter so SQLCipher or platform-specific encryption can be added without touching core.
- Web storage limitations must be documented. Web exports should support optional passphrase encryption.
- Crash logs and telemetry, if added later, must never include task titles, descriptions, command payloads, or time-entry detail by default.

### 13.3 Adapter ports

Define provider-neutral interfaces outside core for:

- weather provider,
- notification provider,
- calendar import/export provider,
- backup/export provider,
- secure storage provider,
- local database encryption provider,
- future LLM assistance provider.

Rules:

- Core consumes provider-neutral facts and commands only.
- Server and platform apps own concrete provider implementations.
- Test fakes must exist for every adapter before production provider code is used in tests.

## 14. Build Plan for an LLM Implementation Agent

The agent must complete phases in order. Do not proceed to the next phase while the gate for the current phase is failing.

### Phase 0: Documentation and technical spike

Steps:

1. Create the monorepo shell with pnpm workspaces and Turborepo.
2. Add minimal `packages/core`, `packages/db`, `apps/server`, and `apps/web`.
3. Install PowerSync SDKs needed for web and server integration.
4. Implement one vertical slice: `node.rename`.
5. Implement `client_commands`.
6. Implement `executeCommand`.
7. Implement `uploadData()` so it sends named commands, not generic SQL patches.
8. Implement server command dispatcher for `node.rename`.
9. Include command, schema, and client version fields in the envelope.
10. Record provenance and command-log effect summaries for the rename.
11. Configure PowerSync Sync Streams for one user's nodes.
12. Run the same slice in web.
13. Run a desktop Tauri proof of concept that can open the same local database and sync at least one node row, or record the blocker clearly.
14. Create one forced server rejection and prove it becomes a review item.

Gate:

- A test proves an offline rename appears immediately in local SQLite.
- A test proves reconnect uploads a named command.
- A test proves the server rejects or ignores generic domain row upload paths.
- A test proves a second device receives the renamed node through sync.
- A spike report documents whether Tauri + PowerSync is viable for desktop.
- A test proves a rejected command creates a durable review item.

### Phase 1: Foundations

Steps:

1. Define core domain types and Zod schemas.
2. Define Drizzle schema and migrations.
3. Add partial unique indexes for all soft-deletable uniqueness rules.
4. Add provenance columns and review item schema.
5. Add HLC utilities.
6. Add `bucketDate` and duration utilities.
7. Add command payload schemas with versions and migrator hooks.
8. Add backup/export schema version constants.
9. Add invariant test fixtures.

Gate:

- `pnpm typecheck` passes.
- `pnpm lint` passes.
- Migration generation is stable.
- Unit tests reject each invariant violation.

### Phase 2: Core command engine

Steps:

1. Implement pure command validators.
2. Implement pure optimistic effect builders.
3. Implement server command appliers.
4. Implement idempotency behavior for repeated command IDs.
5. Implement command rejection codes.
6. Ensure all command effects are minimal-field effects.
7. Emit provenance and effect summaries.
8. Create review items for rejections and material conflicts.
9. Add version migrator tests.

Gate:

- Every command has a schema, validator, effect builder, and server applier.
- A test proves same command ID replays as `noop`.
- A test proves same row, different fields merge without clobber.
- A test proves same row, same field resolves by HLC.
- A test proves an old supported command version migrates or a clearly unsupported version creates a review item.
- A test proves command logs can explain which command created an automation-spawned row.

### Phase 3: Status, dependencies, and graph

Steps:

1. Implement tree traversal and ancestor queries.
2. Implement DAG cycle detection.
3. Implement dependency semantics for FS, SS, FF, and SF.
4. Implement task status from facts.
5. Implement project phase derivation.
6. Implement justified/unjustified ancestry checks.

Gate:

- Property tests prove edge insertion never creates cycles.
- Unit tests cover FS, SS, FF, and SF availability, scheduling, and completion behavior.
- Status tests prove precedence order exactly.

### Phase 4: Rules engine

Steps:

1. Implement predicate AST parser and evaluator.
2. Implement automation action templates.
3. Implement deterministic UUIDv5 spawned IDs.
4. Implement fixpoint execution with max depth.
5. Implement self-trigger validation for rules.
6. Implement server backstop no-op behavior.
7. Populate automation provenance on spawned rows.

Gate:

- Two simulated offline devices executing the same rule produce byte-identical spawned rows.
- Re-running automation backstop does not duplicate rows.
- A self-triggering rule is rejected.
- Unknown weather produces an unverified badge state, not a hard blocker.
- Spawned rows link back to the automation rule, trigger command, and action slot.

### Phase 5: Aggregates

Steps:

1. Implement pure aggregate functions in core.
2. Implement client local-only aggregate cache or in-memory selectors.
3. Implement server canonical recompute job.
4. Sync only server-owned `computed_aggregates`.
5. Add freshness labels using `computed_at`.
6. Add server-job provenance to canonical aggregates.

Gate:

- Client aggregate cache never uploads to Postgres.
- Server recompute overwrites stale displayed aggregate values after sync.
- Day-reset tests pass across timezone and DST-like boundary cases.
- Canonical aggregate rows include provenance for the recompute job.

### Phase 6: Scheduler

Steps:

1. Implement schedule input normalization.
2. Implement greedy earliest-fit mode.
3. Implement dependency constraints.
4. Implement anchored-block hard constraints.
5. Implement suggestion batches.
6. Implement suggestion accept/reject commands.
7. Implement optimize-mode server job after greedy mode is stable.
8. Populate scheduler provenance on suggestion rows.

Gate:

- Property tests prove no proposed block overlaps anchored blocks.
- Property tests prove accepted suggestions do not create overlaps.
- Tests prove stale suggestions cannot be accepted.
- Tests prove FS, SS, FF, and SF are respected in scheduling.
- Tests prove suggestion rows explain their batch, source, and replaced block.

### Phase 7: Web app

Steps:

1. Build the app shell and routing.
2. Build worklist, activity inbox, clock-in/out, and focus review.
3. Build agenda with drag-to-schedule and valid-window hints.
4. Build habit tracker.
5. Build kanban by date.
6. Build decision board.
7. Build dashboard.
8. Build settings and rule editors.
9. Build review inbox UI for rejections, stale suggestions, import warnings, and sync warnings.
10. Wire all writes through `executeCommand`.

Gate:

- Playwright proves each primary view loads offline after initial sync.
- Playwright proves no primary mutation calls a generic network write.
- Manual visual check confirms agenda drag hints and suggestion affordances.
- Playwright proves a server rejection appears in the review inbox after reconnect.

### Phase 8: Graph and Gantt surfaces

Steps:

1. Build React Flow views for project, roadmap, and vision.
2. Add grouping and persisted layout commands.
3. Add date/no-date modes.
4. Add Gantt with dependency arrows.
5. Add critical path computation in core.
6. Add layout precompute job for large diagrams.

Gate:

- Graph cycle attempts are rejected.
- Layout commands sync between devices.
- Large diagrams use server layout when available and local ELK fallback otherwise.

### Phase 9: Mobile

Steps:

1. Create Expo app.
2. Reuse core and shared UI hooks.
3. Implement editable list, agenda, kanban, habit, timer, and settings surfaces.
4. Implement read-only graph navigation.
5. Implement local notifications.
6. Build the shared recurrence/timezone regression harness for RRULE, day reset, DST, and habit buckets.
7. Verify background sync is helpful but not required.

Gate:

- Mobile can create, edit, clock in, clock out, and check off while offline.
- Mobile receives server suggestions and can accept or reject them offline.
- Mobile graph views render from synced layout rows.
- Recurrence/timezone harness passes on mobile runtime.

### Phase 10: Desktop

Steps:

1. Create Tauri v2 shell around the web build.
2. Wire native SQLite through the selected PowerSync desktop path.
3. Wire secure storage for auth secrets.
4. Wire the local DB encryption adapter or document accepted v1 limitation.
5. Wire OS notifications.
6. Package Windows and macOS builds.
7. Re-run the Phase 0 desktop sync proof against the production shell.

Gate:

- Desktop passes the same command/sync smoke tests as web.
- Desktop notifications work for local reminders.
- Packaged builds open, sync, and operate offline.
- Desktop uses secure storage for auth secrets.

### Phase 11: Portability, adapters, and release hardening

Steps:

1. Implement portable export.
2. Implement import dry-run validation.
3. Implement import apply with provenance and review items.
4. Add backup/export adapter interfaces and test fakes.
5. Add secure storage and local encryption adapter interfaces.
6. Add adapter-boundary lint rules.
7. Add release docs for offline behavior, export/import, and local privacy limits.

Gate:

- Export/import round trip preserves facts, settings, provenance, review items, and supported command history.
- Import conflicts create review items.
- Provider-specific APIs do not appear in core imports.
- Auth secrets are excluded from exports.
- Optional passphrase-encrypted web export is tested or documented as a v1 limitation.

## 15. Verification Commands

Exact scripts may evolve, but the repo must provide equivalents for:

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm test:property
pnpm test:integration
pnpm test:e2e
pnpm test:recurrence
pnpm test:export
pnpm build
docker compose up --build
```

Minimum CI gates:

- Core line coverage at or above 90 percent.
- Every invariant has a rejecting test.
- Scheduler property tests cover overlap, anchoring, dependencies, and idempotency.
- Rules engine property tests cover idempotency and deterministic spawned IDs.
- Two-device convergence test covers offline edits, HLC conflict resolution, automation spawning, and double clock-in resolution.
- Command bridge test proves named commands are the only server write path.
- Sync Streams test proves one user cannot receive another user's rows.
- Command version migration tests pass.
- Provenance tests prove tasks, suggestions, automation outputs, and canonical aggregates can explain their source.
- Review inbox tests prove rejections and material conflicts are durable.
- Export/import round-trip tests pass.
- Adapter-boundary lint proves core imports no provider SDKs.

## 16. Definition of Finished

The implementation is finished only when all of the following are true:

1. Every write in every app goes through `executeCommand`.
2. No app has a generic "update entity" network endpoint.
3. PowerSync uploads named command envelopes, not arbitrary SQL or generic row patches.
4. Offline creation, editing, scheduling, automation spawning, dependency unblocking, timer flow, and suggestion review all work.
5. Two offline devices converge after reconnect.
6. Server jobs produce synced data, never hidden blocking responses.
7. Client aggregate caches are local-only.
8. Server canonical aggregates sync down with `computed_at`.
9. Scheduler suggestions have batch lifecycle and stale-suggestion rejection.
10. Soft-deleted unique rows can be recreated.
11. FS, SS, FF, and SF semantics are covered by tests.
12. Command versions and schema versions are enforced at upload and export/import boundaries.
13. Tasks, schedule suggestions, automation outputs, and server aggregate rows have provenance.
14. Rejected offline commands and material conflicts appear in a durable review inbox.
15. Export/import round trip preserves facts, settings, command history, review items, and provenance.
16. Auth secrets use secure storage on installed apps, and local encryption limitations are documented.
17. Provider-specific APIs are contained behind adapters and absent from core.
18. Web, mobile, and desktop each pass their platform smoke tests or have a documented, accepted v1 exception.

## 17. Instructions to the LLM Code Generator

When implementing this architecture:

1. Read this file completely before coding.
2. Build the smallest vertical slice first: authenticated local rename through command envelope, server command dispatch, Postgres write, PowerSync down-sync, and second-device convergence.
3. Do not implement broad UI before the command bridge and sync semantics are proven.
4. Put all domain decisions in `packages/core`.
5. Keep IO at the app/server edges.
6. Add tests before or alongside each core behavior.
7. Prefer explicit small functions over clever abstractions.
8. Never store task status.
9. Never let server optimization directly commit a user's calendar changes.
10. Treat command history and provenance as product features.
11. Create review items for rejected or materially conflicted offline work.
12. Keep provider SDKs behind adapters.
13. Stop at each phase gate and report failures before proceeding.
