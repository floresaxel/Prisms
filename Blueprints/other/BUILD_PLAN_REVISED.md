# Prisms - Session-Sized Build Plan, Revised

Companion to `ARCHITECTURE_REVISED.md`. This file decomposes the build into 24 sessions: one risk-reduction spike (`S0`) plus 23 implementation sessions. Sessions are dependency-ordered. Never start a session whose dependencies have not passed their Definition of Done.

## Affected Portions From The Original Build Plan

The original build plan remains directionally solid, but the revised architecture changes these portions:

| Original area | Affected sessions | Change |
| --- | --- | --- |
| Overall session count | Header and dependency graph | The original said 20 sessions but listed S1-S23. This revision explicitly defines S0-S23. |
| Architecture reference | Session protocol, every session | Agents must read `ARCHITECTURE_REVISED.md`, not the old `ARCHITECTURE.md`. |
| PowerSync upload model | S0, S3, S10-S12, S15, S21, S22 | Add a command-envelope bridge. PowerSync row operations are not the trusted server API; named commands are. |
| PowerSync configuration | S0, S3, S10, S12 | Replace `sync-rules.yaml` with Sync Streams for new implementation. |
| Database schema | S2, S3, S11, S14 | Add `client_commands`, suggestion batches, suggestion lifecycle fields, server-owned aggregate rows, and partial unique indexes for soft-deletable uniqueness. |
| Aggregates | S6, S13, S15, S18, S19 | Client incremental aggregates are local-only. Only server canonical `computed_aggregates` sync through Postgres. |
| Dependency semantics | S5, S8, S11, S12, S17 | FS/SS/FF/SF rules now differ for availability, scheduling, and completion gates. |
| Scheduler suggestions | S8, S9, S14, S17 | Suggestions now require batches, supersession, replacement links, stale-suggestion rejection, and transactional acceptance. |
| Desktop risk | S0, S22, S23 | Add an early Tauri + PowerSync spike; keep desktop late, but do not wait until the end to discover feasibility. |
| React version | S1, S15 | Use current stable React rather than pinning React 18. |
| Command history and provenance | S0, S2, S3, S7, S9, S11-S13, S15, S23 | Add versioned command logs, effect summaries, provenance fields, and source explanations for tasks, suggestions, automation outputs, and aggregates. |
| Conflict/rejection inbox | S0, S3, S11, S12, S15, S17, S21, S23 | Add durable review items for command rejections, material conflicts, stale suggestions, import warnings, and sync warnings. |
| Backup/export/import | S2, S3, S11, S15, S21, S22, S23 | Add a versioned portable export/import format with dry-run validation and provenance-preserving import. |
| Privacy and adapter boundaries | S1, S10, S14, S21-S23 | Add secure storage, local DB encryption adapters, provider-neutral ports, and lint gates preventing provider SDKs in core. |
| Recurrence/timezone harness | S2, S6, S18, S21, S23 | Add dedicated RRULE/day-reset/DST tests across core and platform runtimes. |
| Verification gates | All sessions | Add explicit tests proving named commands are the only write path, Sync Streams authorization works, soft-deleted rows can be recreated, and stale suggestions cannot be accepted. |

## Session Protocol

Apply this protocol to every session.

1. Read `ARCHITECTURE_REVISED.md` sections listed under **Spec** for the session.
2. Work on a branch `sNN-<slug>` or `s0-<slug>` for the spike.
3. Write tests first or alongside code. The DoD is the exit gate.
4. Run the full test suite for every upstream package before finishing.
5. Do not build ahead. If a needed function belongs to a later session, stub it with a typed `TODO(sNN)` throw.
6. No UI or app code may write domain tables directly. All user writes must go through `executeCommand`.
7. No server endpoint may accept arbitrary SQL, generic entity updates, or generic PowerSync row patches as the trusted write path.
8. Commands, exports, and imports must carry explicit version information.
9. Material conflicts and rejections must create durable review items.
10. Provider SDKs must stay outside `packages/core`.
11. At the end of each session, report which DoD checks passed and which, if any, are blocked.

---

## Phase 0 - Highest-Risk Technical Spike

### S0 - Command bridge, Sync Streams, and desktop feasibility spike

**Deps:** none

**Spec:** revised architecture §§3, 7.2, 7.3, 13, 14 Phase 0

Build a minimal vertical slice before broad implementation. This may be a throwaway spike or may become the seed of the final repo.

Build:

1. Minimal pnpm workspace with `packages/core`, `packages/db`, `apps/server`, `apps/web`, and a tiny `apps/desktop` shell if feasible.
2. One domain table: `nodes`.
3. One local-only command table: `client_commands`.
4. One command: `node.rename`.
5. `executeCommand(name, payload)` that validates, writes `client_commands`, and applies local optimistic effects in one SQLite transaction.
6. PowerSync Sync Streams for the authenticated user's nodes.
7. `uploadData()` that uploads the command envelope, not generic row patches.
8. Server command endpoint that accepts only named commands.
9. Postgres write through the server dispatcher.
10. Command, schema, and client version fields on the envelope.
11. Command-log effect summary and row provenance for the rename.
12. A forced rejection path that creates a synced review item.
13. A two-device test or script: device A renames offline, reconnects, server applies command, device B receives row via sync.
14. A desktop feasibility check: Tauri can open the local store and use the selected PowerSync path, or the blocker is documented with a proposed fallback.

DoD:

- Offline rename appears instantly in local SQLite.
- Reconnect uploads exactly one named command envelope.
- Server rejects or ignores a generic domain row patch for the same rename path.
- Second device receives the rename through Sync Streams.
- JWT scoping prevents another user from receiving the row.
- Tauri feasibility report exists and names the selected desktop approach or accepted risk.
- Rejected command creates a durable review item that syncs down.
- The rename row can explain which command last modified it.

---

## Phase A - Foundations

### S1 - Monorepo scaffold

**Deps:** S0 accepted or consciously waived

**Spec:** revised architecture §§5, 6, 17

Build:

1. pnpm workspace and Turborepo.
2. `packages/{core,db,ui,adapters}` and `apps/{web,mobile,desktop,server}` skeletons.
3. Strict shared TypeScript config.
4. ESLint plus `eslint-plugin-boundaries`.
5. Core purity bans: no `Date.now`, `Math.random`, fetch, timers, browser storage, filesystem, or network in `packages/core`.
6. Vitest config.
7. GitHub Actions CI for lint, typecheck, and tests.
8. `docker-compose.yml` stub with Postgres, PowerSync, and API services.
9. Current stable React baseline for the web app skeleton.

DoD:

- `pnpm lint`, `pnpm typecheck`, and `pnpm test` are green locally and in CI.
- A deliberate forbidden import in `packages/core` fails lint.
- Compose boots Postgres.
- Workspace dependency boundaries are enforced.
- Provider SDK imports in `packages/core` fail lint.

### S2 - Domain types, schemas, and time

**Deps:** S1

**Spec:** revised architecture §§7, 8, 9.2, 13, 17

Build in `packages/core`:

1. Entity TypeScript types and Zod schemas for all domain tables.
2. Zod schemas for `client_commands`, server `command_log`, `schedule_suggestion_batches`, `sync_review_items`, provenance fields, and suggestion lifecycle fields.
3. `computed_aggregates` schema with `computed_by = 'server'` only.
4. `Result<T, DomainError>` and complete machine-readable error-code enum.
5. HLC encode, compare, tick, merge, and device tiebreak logic.
6. `bucketDate(ts, timezone, dayResetHour)`.
7. Duration math.
8. Injected `Clock` and `Rng` interfaces.
9. UUIDv7 and deterministic UUIDv5 helpers with `PRISMS_NS`.
10. Dependency semantic types for FS, SS, FF, and SF.
11. Command version, schema version, client version, and migrator primitives.
12. Portable export/import manifest schemas.
13. Recurrence/timezone test harness fixtures for RRULE, day reset, DST, and habit buckets.

DoD:

- Schema round-trip tests for all entities.
- HLC property tests prove monotonicity, total order, and deterministic device tiebreaks.
- Day-reset golden tests cover timezone and DST boundary cases.
- UUIDv5 determinism test passes.
- `computed_aggregates` rejects client-owned values.
- Export manifest schema validates and rejects unsupported versions.
- Command version migrator tests pass for one supported older payload and one unsupported payload.

### S3 - Database package and Sync Streams

**Deps:** S2

**Spec:** revised architecture §§7.1-7.9, 13, 14 Phase 1

Build in `packages/db`:

1. Drizzle schema and forward-only migrations.
2. All core domain tables.
3. `client_commands` local schema definition for client stores.
4. `schedule_suggestion_batches` and extended `schedule_blocks`.
5. `computed_aggregates` as server-owned only.
6. Provenance columns on user-visible rows.
7. `sync_review_items`.
8. Partial unique indexes for all soft-deletable uniqueness rules.
9. DB backstops for core invariants where practical.
10. PowerSync Sync Streams config, not legacy Sync Rules.
11. A seed script with a realistic demo user: 4 visions, habits, project tree, dependencies, schedule blocks, time entries, provenance, and one review item.

DoD:

- Migrations apply cleanly to fresh Postgres in compose.
- Drizzle types match core types through compile-time assertions.
- Seed runs successfully.
- Sync Streams config validates.
- Recreate-after-soft-delete tests pass for edges, habit completions, sprint memberships, decision scores, and diagram layouts.
- `command_log` is not broadly synced unless a filtered command-result stream requires it.
- Review items are synced in the bootstrap/active stream.
- Provenance fields compile against core types.

---

## Phase B - Core Engines

### S4 - Graph module

**Deps:** S2

**Spec:** revised architecture §§7.1, 7.7, 9.1

Build `core/graph`:

1. Child, subtree, and ancestor queries over in-memory fact sets.
2. Fractional `sort_order` generation.
3. DAG cycle detection for edges.
4. Hierarchy typing validator.
5. Justification check: ancestry reaches a vision or task has `habit_id`.
6. Soft-delete closure.
7. Critical path over estimates.

DoD:

- Random edge insertion property tests never admit a cycle.
- Parent/child type matrix tests pass.
- Generate-between test creates 1,000 positions without collision.
- Justification and cascade golden tests pass.

### S5 - Status, dependency gates, and predicate AST

**Deps:** S4

**Spec:** revised architecture §§7.6, 9.1, 10

Build:

1. `core/status` with exact precedence: `done > ongoing > blocked > scheduled > prioritized > available`.
2. FS availability gate: successor availability waits for predecessor completion plus lag.
3. SS availability gate: successor availability waits for predecessor start plus lag.
4. FF and SF completion gates, not availability gates.
5. Project phase derivation.
6. Shared predicate AST evaluator with `all`, `any`, `not`, operators, and fact resolvers for node, ancestor, project phase, graph, date, and weather.
7. `unknown` weather semantics: not blocked plus UI badge state.

DoD:

- Golden table covers every status precedence collision.
- FS, SS, FF, and SF tests distinguish availability, scheduling, and completion gates.
- Completion rejects unmet FF/SF requirements with edge-specific error details.
- Weather absent evaluates unknown and does not hard-block.
- Project phase derivation tests pass.

### S6 - Aggregates

**Deps:** S5

**Spec:** revised architecture §§7.4, 9.2, 13, 14 Phase 5

Build `core/aggregates`:

1. Effective hours.
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
- Streak golden tests cover each mode and day-reset boundaries.
- Burndown scope-change test passes.
- No test or type path allows a client incremental aggregate to become an uploaded Postgres row.
- Canonical aggregate output includes source/job provenance.

### S7 - Rules engine

**Deps:** S5

**Spec:** revised architecture §10

Build `core/rules`:

1. Predicate integration for automation conditions.
2. Action executor for `spawn_task`.
3. Template interpolation.
4. `edge_from_slot`.
5. Trigger-relative date math from triggering fact timestamps.
6. Fixpoint loop with `MAX_DEPTH = 5`.
7. Self-trigger validation at rule creation.
8. Deterministic UUIDv5 output IDs.
9. Pure transactional output: return rows/effects for the command executor to commit.
10. Automation provenance for spawned tasks, blocks, and edges.

DoD:

- Lecture example creates pre-brief, study task, and FS edge.
- Two simulated offline devices produce byte-identical automation outputs.
- Depth guard test passes.
- Self-triggering rule is rejected.
- Replay is a no-op.
- Spawned rows link to automation rule, trigger command, trigger node, and action slot.

### S8 - Scheduler greedy mode

**Deps:** S5

**Spec:** revised architecture §§7.5, 7.6, 11

Build `core/scheduler`:

1. Scheduler input model.
2. `mode: 'greedy'` earliest-fit placement.
3. Anchored-block hard constraints.
4. No overlap constraints.
5. Done-task exclusion.
6. Task time-window constraints.
7. FS, SS, FF, and SF scheduling constraints.
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

**Spec:** revised architecture §§7.5, 11, 12

Build:

1. `mode: 'optimize'` using deterministic local search over greedy seed.
2. Weighted soft objectives: due dates, sprint preference, fragmentation, and daily habit targets.
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

**Spec:** revised architecture §§5, 7.3, 13

Build `apps/server`:

1. Hono app.
2. Auth using Better Auth or accepted equivalent.
3. Short-lived JWTs consumable by API and PowerSync.
4. `/health`.
5. Request logging.
6. Per-user and per-verb rate limiting.
7. PowerSync configuration wired to Sync Streams.
8. `settings.update` as the first command endpoint smoke test.
9. Secure-storage adapter interfaces for server-issued sessions and platform clients.

DoD:

- Register/login integration test passes.
- JWT is accepted by PowerSync dev instance.
- Rate limit returns 429.
- `settings.update` round-trips through named command path.
- User A cannot subscribe to User B rows.
- Auth/session secret handling never uses ordinary app local storage in installed targets.

### S11 - Command dispatcher and full command catalog

**Deps:** S10, S4-S7

**Spec:** revised architecture §§7.2, 7.8, 7.9, 8, 14 Phase 2

Build:

1. Command endpoint used by PowerSync `uploadData()`.
2. Five-step command pipeline: parse, ownership, invariants, Drizzle transaction, command log.
3. Idempotency by command ID.
4. Full mutation catalog.
5. Machine-readable rejections.
6. HLC same-field conflict handling.
7. Minimal-field patch handling.
8. Automation trigger integration.
9. Explicit rejection of generic full-row write or generic entity update paths.
10. Completion validators for FS/FF/SF dependency requirements.
11. Command version parsing and migration.
12. Command-log effect summaries.
13. Provenance assignment on all command-created and command-updated rows.
14. `sync_review_items` creation for rejections, stale suggestions, material HLC conflicts, and automation backstop notes.

DoD:

- One rejecting test per invariant.
- Replay returns `noop` with original result.
- `node.move` revalidates hierarchy and justification.
- Same row, different fields merge without clobber.
- Same row, same field resolves by HLC.
- Generic row patch upload cannot mutate server state.
- Unsupported command version creates a review item and does not mutate domain rows.
- Command log can explain which command created or last modified a row.
- Material HLC conflict creates a review item with the losing value preserved in detail.

### S12 - Convergence harness

**Deps:** S11

**Spec:** revised architecture §§7.2, 7.3, 7.6, 13, 14 Phase 3

Build an integration test rig simulating two devices with real local SQLite, `client_commands`, upload queues, server command endpoint, Postgres, and Sync Streams.

Scenarios:

1. Offline edits on different rows.
2. Same row, different fields.
3. Same row, same field with HLC winner.
4. Two offline clock-ins resolved deterministically.
5. Automation spawned on both devices converging via UUIDv5.
6. Soft-deleted unique row recreated after sync.
7. Stale suggestion accepted offline then rejected or rebased safely on reconnect.
8. Rejected offline command appears in review inbox after reconnect.
9. Older supported command version migrates before apply.

DoD:

- All scenarios are green in CI.
- The harness proves command envelopes are the only trusted write upload.
- Client observation rule hides double timers after sync.
- This suite becomes a permanent regression gate.
- Review items sync to the affected device and can be resolved or dismissed.

### S13 - Jobs I: facts and canonical aggregates

**Deps:** S11, S6

**Spec:** revised architecture §§7.4, 12, 13

Build pg-boss bootstrap and workers:

1. `weather.poll`.
2. `aggregates.recompute`.
3. `automation.backstop`.
4. `retention.purge`.
5. `review.expire_resolved`.

Rules:

- `aggregates.recompute` writes server-owned `computed_aggregates`.
- `aggregates.recompute` writes server-job provenance.
- Client local aggregate caches are never read as canonical source.
- Backstop uses deterministic UUIDv5 no-op behavior.

DoD:

- Clock-injected tests pass per job.
- Backstop no-ops on already-spawned rows.
- Recompute corrects displayed aggregate values after sync.
- No client-owned aggregate row can be uploaded.
- Backstop informational review item is created when it fills missed automation rows.
- Resolved review item retention is tested.

### S14 - Jobs II: scheduling, layout, and notifications

**Deps:** S13, S9

**Spec:** revised architecture §§7.5, 11, 12, 13

Build:

1. `pastdue.scan` with warning plus suggested replacement block.
2. `schedule.optimize` with suggestion batches.
3. Supersession of old suggestions in overlapping horizons.
4. `layout.precompute` for diagrams larger than 60 nodes.
5. `notify.dispatch` with Web Push and Expo adapters behind one interface.
6. Provider-neutral adapter fakes for weather, notifications, layout, and future calendar export.

DoD:

- Past-due task yields exactly one active suggestion row per batch strategy.
- Optimize job emits only diffs.
- Newer optimize batch supersedes older active suggestions in its horizon.
- Stale suggestions cannot be accepted.
- Layout job fills `diagram_layouts` for seed roadmap.
- Push adapters are mock-tested.
- Provider SDKs are absent from `packages/core`.

---

## Phase D - Web App

### S15 - Web shell and data layer

**Deps:** S12

**Spec:** revised architecture §§7.2, 7.3, 13, 14 Phase 7

Build `apps/web`:

1. Vite and current stable React.
2. Router.
3. Auth screens.
4. PowerSync web SDK with OPFS/wa-sqlite.
5. `executeCommand` wired to `client_commands`.
6. `packages/ui` hooks: `useStatus`, `useAggregates`, `useNodeTree`, `useCommands`.
7. Optimistic apply plus rejection rollback.
8. Local-only aggregate overlay.
9. Review inbox data hook for command rejections, conflicts, stale suggestions, import warnings, and sync warnings.
10. Workbox app shell.
11. Base design system.

DoD:

- Login renders seed data from local SQLite.
- Airplane-mode reload works after initial sync.
- Rejected optimistic edit visibly rolls back.
- Static/lint test prevents direct domain table writes from UI components.
- Command upload test proves named command envelope is sent.
- Server rejection appears in the review inbox after reconnect.

### S16 - Worklist, timer, and inbox

**Deps:** S15

**Spec:** revised architecture §§1, 8, 9.1

Build:

1. Available-items worklist.
2. Activity inbox.
3. `activity.promote`.
4. Clock-in and clock-out.
5. One global running timer UI.
6. Focus review modal.
7. Completed-session handling.
8. Task progress bars.
9. Time-left indicators.
10. "Why does this exist?" provenance affordance for tasks.

DoD:

- Playwright offline flow: create activity, promote, clock in, clock out, review, verify status transitions, reconnect, verify sync.
- UI makes double timer impossible locally.
- Server double clock-in resolution is reflected without showing two running timers.
- Provenance affordance explains user-created and automation-created tasks.

### S17 - Agenda and suggestions

**Deps:** S16, S8, S14

**Spec:** revised architecture §§7.5, 11, 14 Phase 7

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
- Accepting a stale suggestion surfaces the machine-readable rejection.
- Stale suggestion rejection creates or links to a review item.
- Suggestion detail explains source batch and replaced block.
- Grey unjustified rule is verified.

### S18 - Kanban and habits

**Deps:** S16

**Spec:** revised architecture §§1, 7.4, 9.2

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

**Spec:** revised architecture §§1, 7.4

Build:

1. Burndown chart with scheduled line.
2. Projection display with freshness label.
3. Project completion bars.
4. Priority list from decision-board ranking.
5. Streak summary.
6. Decision board UI: criteria, weights, scoring grid, and live weighted ranking.

DoD:

- Dashboard renders entirely from local data offline.
- Changing a weight reorders priorities instantly.
- Projection freshness label reflects server aggregate timestamp.
- No dashboard path uploads local aggregate cache.

### S20 - Graph surfaces, Gantt, and rule editors

**Deps:** S17, S14

**Spec:** revised architecture §§10, 11, 14 Phase 8

Build:

1. React Flow views for vision, roadmap, and project.
2. Visual groups.
3. Layout persistence commands.
4. Date and no-date modes.
5. Gantt bars and dependency arrows.
6. Critical path display.
7. Automation rule editor.
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

**Spec:** revised architecture §§7.2, 13, 14 Phase 9

Build `apps/mobile`:

1. Expo app.
2. PowerSync React Native and auth.
3. Mobile `executeCommand` and `client_commands` path.
4. Worklist, timer, and focus review.
5. Agenda with tap-to-place assist.
6. Kanban.
7. Habits and rings.
8. Dashboard.
9. Read-only flowchart and Gantt renderers from `diagram_layouts`.
10. Local notifications.
11. Expo push registration.
12. Mobile review inbox.
13. Secure storage for auth secrets.
14. Export/import entry point if supported on v1 mobile, or documented limitation.

DoD:

- Maestro or Detox offline flow mirrors S16.
- Mobile creates, edits, clocks in/out, and checks off while offline.
- Mobile receives and accepts/rejects synced suggestions offline.
- Local notification fires with network disabled.
- Graph view navigates on tap.
- Rejected command appears in mobile review inbox after reconnect.
- Mobile auth/session secrets use secure storage.

### S22 - Desktop

**Deps:** S0 desktop spike, S15-S20

**Spec:** revised architecture §§5, 13, 14 Phase 10

Build `apps/desktop`:

1. Tauri v2 shell around the web build.
2. Selected PowerSync desktop path from S0.
3. Native SQLite integration.
4. Secure storage for auth secrets.
5. Local DB encryption adapter or documented accepted v1 limitation.
6. Review inbox.
7. OS notifications.
8. App icons.
9. Windows and macOS packaging.

DoD:

- Packaged app passes the S16 command/sync smoke flow offline.
- Desktop uses named command envelopes.
- Desktop syncs with web through Sync Streams.
- OS notification fires.
- Any remaining SDK alpha risk is documented as an accepted release risk or replaced with a working fallback.
- Desktop auth/session secrets use secure storage.
- Desktop review inbox displays a synced rejection item.

### S23 - Hardening and release

**Deps:** all previous sessions

**Spec:** revised architecture §§13-17

Build:

1. Full CI matrix: unit, property, convergence, Playwright, mobile e2e, desktop smoke.
2. Core coverage gate at or above 90 percent.
3. Production Docker Compose.
4. `.env.example`.
5. Backup and restore scripts.
6. Portable export/import implementation with dry-run validation.
7. Optional passphrase-encrypted web export or documented v1 limitation.
8. README.
9. Self-hosting guide.
10. Load sanity with 100k-node seed.
11. Security review of command upload, Sync Streams auth, secure storage, local encryption limitations, and export behavior.
12. Adapter boundary review.
13. Final release checklist.

DoD:

- One-command fresh deploy on a clean VM serves web, API, Postgres, and sync.
- All suites are green.
- 100k-node seed stays under agreed status and agenda render budgets.
- Command bridge test proves named commands are the only trusted server write path.
- Sync Streams test proves one user cannot receive another user's rows.
- Soft-delete uniqueness recreation tests pass.
- Stale suggestion rejection tests pass.
- Release docs describe offline behavior and known platform limitations.
- Export/import round trip preserves facts, settings, provenance, review items, and supported command history.
- Import dry-run reports conflicts without writing rows.
- Auth secrets and provider secrets are excluded from exports.
- Adapter-boundary lint proves core imports no provider SDKs.

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
