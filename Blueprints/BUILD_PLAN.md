# Prisms — Session-Sized Build Plan

Companion to `ARCHITECTURE.md` (the normative spec). This file decomposes the build into **20 sessions**, each scoped to be completed in a single focused LLM coding session. Sessions are dependency-ordered; never start a session whose dependencies haven't passed their Definition of Done (DoD).

## Session protocol (apply to every session)

1. Read `ARCHITECTURE.md` §2 (principles) plus the sections listed under **Spec** for the session.
2. Work on a branch `sNN-<slug>`; commit per deliverable.
3. Write the tests listed in the DoD **first or alongside** the code — the DoD is the exit gate.
4. Run the full test suite of every upstream package before finishing (no session may break a prior gate).
5. Do not build ahead: if a needed function belongs to a later session, stub it with a typed `TODO(sNN)` throw.

---

## Phase A — Foundations

### S1 · Monorepo scaffold
**Deps:** none · **Spec:** §5, §16
Build: pnpm workspace + Turborepo; `packages/{core,db,ui}` and `apps/{web,mobile,desktop,server}` skeletons; strict tsconfig base; ESLint + `eslint-plugin-boundaries` enforcing §5 dependency rules (including the `core` purity bans: no `Date.now`, `Math.random`, fetch, timers, storage); Vitest config; GitHub Actions CI (lint + test); `docker-compose.yml` stub (postgres + powersync + api services, healthchecks).
**DoD:** `pnpm turbo lint test` green in CI; a deliberate `import Date.now` in core fails lint; compose file boots postgres.

### S2 · Domain types, schemas, time
**Deps:** S1 · **Spec:** §6 (shapes only), §7.2 day bucketing, §7.3 HLC, §16
Build in `core`: entity TS types + Zod schemas for every table in §6.0 (single source of truth); `Result<T, DomainError>` + full error-code enum (§8); `time/` — HLC (encode/compare/tick), `bucketDate(ts, dayResetHour, tz)`, duration math; injected `Clock` and `Rng` interfaces; UUIDv7 + UUIDv5 helpers with `PRISMS_NS`.
**DoD:** schema round-trip tests for all entities; HLC property test (monotonic, total order, device tiebreak); day-reset golden tests incl. DST transitions; uuidv5 determinism test.

### S3 · Database package
**Deps:** S2 · **Spec:** §6.0 DDL, §7.3 down-sync
Build in `db`: Drizzle schema mirroring §6.0 exactly (all indexes, CHECKs, partial unique index for I5, I1 trigger); forward-only migrations; PowerSync `sync-rules.yaml` (one user bucket, every table except `command_log`); seed script generating a realistic demo user (4 visions, habits, a project tree, edges, entries).
**DoD:** migrations apply cleanly to fresh postgres in compose; drizzle types == core types (compile-time assertion file); seed runs; sync-rules lint passes via PowerSync CLI.

---

## Phase B — Core engines (pure TS; the system's brain)

### S4 · Graph module
**Deps:** S2 · **Spec:** §6.7 I1–I4, I10; §12.2
Build `core/graph`: child/subtree/ancestor queries over in-memory fact sets; fractional `sort_order` (generate-between); DAG cycle detection for `edges`; hierarchy-typing validator (I1); justification check (`isJustified`: ancestry reaches vision, or `habit_id`); soft-delete closure (I10); critical-path (longest path by estimates).
**DoD:** property test — random edge insert sequence never admits a cycle; I1 matrix test (every parent/child type pair); ordering test (1k generate-between without collision); justification + cascade golden tests.

### S5 · Status + predicate AST
**Deps:** S4 · **Spec:** §7.1, §9.2
Build `core/status` exactly per §7.1 (precedence, FS/SS/FF/SF + lag gates, project phase derivation) and the shared predicate AST evaluator (`all/any/not`, ops, fact resolvers for node/ancestor/project.phase/graph/date/weather with `unknown` semantics).
**DoD:** golden table covering every status × precedence collision (e.g. ongoing+blocked ⇒ ongoing); each edge type gate tested; weather-absent ⇒ `unknown` ⇒ not-blocked test; phase derivation tests.

### S6 · Aggregates
**Deps:** S5 · **Spec:** §7.2
Build `core/aggregates`: effective hours; practice hours + levels; all six streak modes (incl. `perfect_planned` requiring sessions on every scheduled block); task progress; project completion %; burndown series + linear projection; time-left trio. Each metric exposes `incremental(prev, newFact)` and `canonical(allFacts)`.
**DoD:** for every metric, property test `incremental ∘ facts === canonical(facts)` over randomized fact streams; streak goldens per mode across day-reset boundaries; burndown scope-change test.

### S7 · Rules engine
**Deps:** S5 · **Spec:** §9 (all)
Build `core/rules`: action executor (`spawn_task` templates with interpolation, `edge_from_slot`, trigger-relative dates), fixpoint loop with `MAX_DEPTH=5`, self-trigger validation at rule creation, UUIDv5 output IDs (§9.4), pure transactional output (returns rows to write; caller commits).
**DoD:** lecture example from §1.2 produces exactly the pre-brief + 3h study task with an FS edge; determinism property test (two simulated devices, identical outputs byte-for-byte); depth-guard and self-trigger rejection tests; replay = no-op test.

### S8 · Scheduler — greedy
**Deps:** S5 · **Spec:** §10 hard constraints, I7–I9
Build `core/scheduler` data model + `mode:'greedy'`: earliest-fit honoring anchors, overlaps, dependencies+lag, windows, done-task exclusion; `validWindowsFor(task)` helper for drag hints; single-task reschedule entry point.
**DoD:** fast-check properties — output never overlaps anchors, never violates dependency order, idempotent on own output; window-hint goldens (morning-only task, anchored collision); unplaceable reasons emitted.

### S9 · Scheduler — optimize
**Deps:** S8 · **Spec:** §10 soft objectives, §11 `schedule.optimize`
Build `mode:'optimize'`: weighted soft objectives (due dates, sprint preference, fragmentation, daily targets) via deterministic local-search over the greedy seed (injected Rng); proposal diffing (only emit changes vs current committed plan).
**DoD:** same hard-constraint property suite passes; objective regression fixtures (optimize ≥ greedy score on 5 canned plans); determinism test with fixed Rng seed.

---

## Phase C — Server

### S10 · API shell + auth
**Deps:** S3 · **Spec:** §13, §4
Build `apps/server`: Hono app, Better Auth (email+password), short-lived JWT issuance consumable by PowerSync, `/health`, `settings.update` as the first wired command, request logging, per-user+verb rate limiter middleware.
**DoD:** integration test — register/login/JWT verified by PowerSync dev instance in compose; rate limit returns 429; settings round-trips.

### S11 · Command dispatcher + full catalog
**Deps:** S10, S4–S7 · **Spec:** §8 (all), §6.7
Build `/sync/upload`: 5-step pipeline (parse → ownership → invariants via core → Drizzle transaction → `command_log`); idempotency by command id; every verb in §8.1 implemented; machine-readable rejections; automation triggers enqueue `automation.backstop`.
**DoD:** one rejecting test per invariant in §6.7; replay returns `noop` with original result; `node.move` re-parent revalidates I1/I3; full-row-write attempt is impossible by construction (schema test).

### S12 · Convergence harness
**Deps:** S11 · **Spec:** §7.3–§7.4, §14
Build an integration test rig simulating two devices with real local SQLite + upload queues against the compose stack: offline edits on different rows / same-row-different-fields / same-field (HLC winner), double clock-in resolution (§7.4 server rule + client-side observation rule in core), automation spawned on both devices converging via UUIDv5.
**DoD:** all five convergence scenarios green in CI; this suite becomes the permanent regression gate for everything after.

### S13 · Jobs I — facts & truth
**Deps:** S11, S6 · **Spec:** §11
Build pg-boss bootstrap + workers: `weather.poll` (Open-Meteo, per-user location, upsert `external_facts`), `aggregates.recompute` (per-user after their day-reset, canonical overwrite), `automation.backstop`, `retention.purge`.
**DoD:** clock-injected tests per job; backstop no-ops on already-spawned rows; recompute corrects a deliberately drifted client aggregate in the S12 harness.

### S14 · Jobs II — scheduling & notify
**Deps:** S13, S9 · **Spec:** §11, §10
Build `pastdue.scan` (warnings + suggested replacement blocks), `schedule.optimize` job (nightly + on-demand enqueue), `layout.precompute` (elkjs for diagrams > 60 nodes), `notify.dispatch` (Web Push + Expo push adapters behind one interface).
**DoD:** past-due task yields exactly one suggestion row with reason; optimize job emits only diffs; layout job fills `diagram_layouts` for seed roadmap; push adapters mocked-tested.

---

## Phase D — Web app

### S15 · Web shell + data layer
**Deps:** S12 · **Spec:** §12.3, §4
Build `apps/web`: Vite + React + router; PowerSync web SDK (wa-sqlite/OPFS) wired to compose stack; auth screens; `packages/ui` reactive hooks (`useStatus`, `useAggregates`, `useNodeTree`, `useCommands` with optimistic apply + rejection rollback); Workbox app-shell; base design system (theme, layout, list, modal).
**DoD:** login → seed data renders from local SQLite; airplane-mode reload works; an optimistic edit rejected by the server visibly rolls back.

### S16 · Worklist, timer, inbox
**Deps:** S15 · **Spec:** §1.2 task/time-tracking bullets, §8.1 timer verbs
Build: available-items worklist (clock-in / check-off / delete), activity inbox + `activity.promote`, running-timer UI (one global, per I5), clock-out → focus review modal (factor ×0.5–1.0, completed?), task progress bars, time-left-in-day/task indicators.
**DoD:** Playwright flow — create activity → promote → clock in → out → review → status transitions verified offline then synced; double-timer impossible in UI.

### S17 · Agenda
**Deps:** S16, S8 · **Spec:** §12.2, §10 client mode
Build: week calendar + to-do side panel; drag-and-drop placement calling `validWindowsFor` live (highlight valid slots, dim invalid); anchored lock glyph + drag refusal; suggested blocks dashed with accept/reject; unjustified blocks dark grey; past `time_entries` as history layer; block move/resize commands.
**DoD:** Playwright — drag task, valid windows render, drop creates committed block; anchored drag rejected; accept-suggestion promotes; grey rule verified.

### S18 · Kanban + habits
**Deps:** S16 · **Spec:** §1.2 habit bullets, §7.2 streaks
Build: kanban grouped by date (drag between days = `node.set_dates`/`block.move`); habit CRUD; daily target progress rings; streak counters per mode; practice-hours + level display from `computed_aggregates` with `computed_at` freshness label and live incremental overlay.
**DoD:** ring fills during an offline clock-in on a skill task; streak flips at day-reset hour (clock-injected test); kanban drag persists.

### S19 · Dashboard + decision board
**Deps:** S18 · **Spec:** §1.2 dashboard bullets, §6.0 decision tables
Build: burndown chart with scheduled-line + projection; project completion bars; priority items list = decision-board ranking; streak summary; decision board UI (criteria, weights, 0–10 scoring grid, live weighted ranking from core).
**DoD:** dashboard renders entirely from local data offline; changing a weight reorders priorities instantly; projection shows freshness label.

### S20 · Graph surfaces + editors
**Deps:** S17, S14 · **Spec:** §12.1–§12.2, §9 editors
Build: React Flow flowcharts for vision (≤4 angles, lower-level snippet cards, navigate), roadmap (all projects + dependency edges), project (tasks, drag-drop edit, dates/no-dates modes, visual groups); layout persistence (`layout.set_position`); Gantt (bars, dependency arrows, critical path); automation-rule and blocker-rule editors (form → AST JSON, with self-trigger validation errors surfaced); settings screen.
**DoD:** Playwright — create edge in flowchart, cycle attempt rejected with `E_CYCLE` toast; group/collapse persists; Gantt arrows match edges; rule built in editor spawns tasks on completion.

---

## Phase E — Mobile, desktop, hardening

### S21 · Mobile core
**Deps:** S12, S16 (patterns) · **Spec:** §12.1 mobile column, §12.3
Build `apps/mobile` (Expo): PowerSync RN + auth; worklist + timer + focus review; agenda with tap-to-place assist (window list instead of drag); kanban; habits + rings; dashboard; read-only flowchart/Gantt renderers from `diagram_layouts`; local notifications (past-due, streak-at-risk, daily target); Expo push registration.
**DoD:** Maestro/Detox flow mirroring S16's offline test on an emulator; local notification fires with network disabled; graph view navigates on tap.

### S22 · Desktop
**Deps:** S15–S20 · **Spec:** §12.3
Build `apps/desktop`: Tauri v2 wrapping the web build; SQLite via Tauri SQL plugin behind the same PowerSync interface; OS notifications; app icons + builds for Windows/macOS.
**DoD:** packaged app passes the S16 Playwright flow (via tauri-driver) offline; notification fires.

### S23 · Hardening & release
**Deps:** all · **Spec:** §14, §15 gates, §16 test floor
Build: full CI matrix (unit, property, convergence, Playwright, mobile e2e); coverage gate (core ≥ 90%); production `docker-compose.yml` + `.env.example` + backup/restore script (pg_dump); README + self-hosting guide; load sanity (100k-node seed: status/agenda render budgets met).
**DoD:** one-command fresh deploy on a clean VM serves web + sync; all suites green; 100k-node seed stays under 16ms status recompute and 100ms agenda render on reference hardware.

---

## Dependency graph (informative)

```
S1 → S2 → S3 ──────────────→ S10 → S11 → S12 ─→ S15 → S16 → S17 → S20
      └→ S4 → S5 → S6 ────────────↗  ↘ S13 → S14 ─↗      ↘ S18 → S19
             └→ S7 ──────────────↗                         S21  S22 → S23
             └→ S8 → S9 ────────↗
```

Parallelizable if running multiple sessions: B-phase sessions (S4–S9) only need S2; S13/S14 can interleave with D-phase; S21 can start once S12 is green.
