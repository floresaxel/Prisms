# Prisms — Architecture Specification

**Version 1.0 — Single-user release (collaboration deferred)**
**Audience: an LLM code generator building the entire codebase. Every section is normative unless marked *(informative)*.**

---

## 1. Product Definition

Prisms is a goal-execution platform. A user states a long-term mission and decomposes it through six layers until it lands on a calendar:

```
Vision → Roadmap → Project → Milestone → Task → Schedule (calendar block)
```

Skills & Habits are a parallel track: recurring practices tied directly to a Vision (not to a Project), with streaks, practice-hour accumulation, and daily targets.

### 1.1 Hard requirements

| # | Requirement |
|---|-------------|
| R1 | Platforms: Web, Windows, macOS, Android, iOS — shared business logic and backend |
| R2 | UX-first: no perceptible lag; all reads/writes hit a local database |
| R3 | Full offline operation; real-time bidirectional sync when connected; multi-session (several devices converge) |
| R4 | Follow-up task spawning and dependency unblocking MUST work fully offline |
| R5 | No vendor lock-in: source of truth is vanilla Postgres; client store is vanilla SQLite; everything self-hostable; managed services optional drop-ins |
| R6 | No SQL crosses the network in either direction |
| R7 | Compute-heavy work may run server-side but must never be required for offline function |
| R8 | LLM-built codebase: prefer mainstream TypeScript, explicit contracts, deterministic pure functions, heavy test coverage on core logic |

### 1.2 Feature inventory (all in scope)

- **Decision board:** weighted decision matrix for project prioritization.
- **Gantt** per project with predecessor/successor dependencies (FS/SS/FF/SF + lag).
- **Flowchart** creation (drag-and-drop) and visualization with and without dates; task **grouping** inside flowcharts; Roadmap-level flowchart mapping all projects and dependencies; Vision-level flowchart with snippets of lower levels for navigation.
- **Vision angles:** maximum 4 vision nodes (e.g. Wellness, Work, Knowledge, Expression), each owning a subset of roadmaps/projects/habits.
- **Dynamic blockers** driven by project phase/group, node position in the graph, weather, or date conditions.
- **Kanban** board grouping tasks by date.
- **Past-due warning** + suggested auto-reschedule for incomplete tasks.
- **Statuses are never set manually.** The only task statuses are: `blocked`, `available`, `prioritized`, `scheduled`, `ongoing`, `done` — all derived (see §6).
- **Worklist** ("available items"): clock in, check off, or delete.
- **Agenda view:** to-do list beside the calendar; drag-and-drop tasks into the week; while dragging, show the valid time windows where the task may land.
- **Every task belongs to a project or a habit.** A parentless **activity inbox** holds temporary items until promoted.
- **Automations:** completing/creating a task can spawn other tasks from templates (e.g. "lecture" spawns a 30-min pre-brief + 3-hour study task). Must work offline (R4).
- **Time tracking:** clock-in is the ONLY way a task becomes `ongoing`. Clock-out logs a time entry (start/end), creates a calendar event view of the session, and prompts a **focus score** (×0.5–×1.0 productivity factor) plus "completed?" flag. Configurable **day-reset hour**. Display time remaining in day / task / until next block.
- **Task progress bar:** time consumed vs. estimate.
- **Habits/Skills:** recurring check-off tasks; streak counters (perfect-planned, daily, weekly, monthly, quarterly, yearly); total practice-hours counter with levels (e.g. 10,000-hour mastery); daily target timers with progress rings.
- **Dashboard:** burndown + projections vs. scheduled items, completion progress bars, priority items list (from decision matrices), streaks.
- **Calendar semantics:** blocks whose task ancestry does not reach a Vision render dark grey ("unjustified"); **anchored** events (rigid start, end, or both) can never be moved by the scheduler; **flexible** events (default) may be rescheduled freely while incomplete.

### 1.3 Explicit scope exclusions (v1)

- No collaboration: no people/teams/qualifications/assignments tables, no shared projects. **Preserve the door:** every row carries `user_id`; every mutation is a named command; never write core logic that assumes a global singleton instead of a per-user one.
- No external calendar (Google/CalDAV) sync yet; `schedule_blocks.external_event_id` is reserved for it.

---

## 2. Architecture Principles (normative — every module must conform)

1. **Local-first.** Every read and write hits on-device SQLite. The network is an asynchronous background concern. Unplugging the server degrades the app from "optimized" to "good enough", never to "broken".
2. **Facts, not flags.** The database stores immutable/append-mostly *facts* (time entries, completions, schedule blocks, sprint memberships, habit completions, weather observations). User-visible state (status, streaks, progress, blockers, burndown) is **computed** from facts by pure functions in `packages/core`. Statuses are never columns. Completion timestamps ARE facts and are stored.
3. **Commands, not queries.** Devices never send SQL (R6). The write path is a catalog of named, Zod-validated mutations with minimal payloads (only the fields the user changed). The read path is row data streamed by the sync engine under server-defined sync rules.
4. **One logic, two tiers.** `packages/core` is pure TypeScript with zero platform/IO dependencies. Clients call it for instant local results; server jobs call the *same functions* for canonical/heavy results. Where code runs is a deployment decision, never a reimplementation.
5. **Server output is data, never a blocking response.** Heavy server computation lands as synced rows with a `computed_at` timestamp. Every heavy path has a defined client fallback (incremental delta, stale value + freshness label, or simplified algorithm).
6. **Suggestions are distinct from facts.** The scheduler and jobs write *proposal* rows; only an explicit user mutation promotes a suggestion to a fact. Reviewing/accepting suggestions works offline.
7. **Deterministic by construction.** Automation outputs use deterministic UUIDv5 IDs so independent offline executions on multiple devices converge to byte-identical rows. Rules read time from the triggering fact, never the wall clock.
8. **Minimal-field mutations.** No mutation may write a field the user did not change. No generic "update entity" endpoint exists. (Prevents both the security and the cross-device clobbering failure modes.)

---

## 3. System Topology

```
┌────────────────────────── Devices ──────────────────────────┐
│  Web (Vite+React)   Desktop (Tauri v2 ⟵ same web build)     │
│  Mobile (Expo / React Native)                                │
│                                                              │
│  UI ── reactive queries ──► local SQLite ◄── packages/core   │
│        (instant reads)        ▲    │   (status, scheduler,   │
│                               │    │    rules engine, aggs)  │
│                 sync stream   │    │  upload queue           │
└───────────────────────────────┼────┼────────────────────────┘
                          (WebSocket│HTTPS — rows down, commands up)
┌───────────────────────────────┼────┼────────────────────────┐
│   PowerSync service ◄─────────┘    └──► API (Hono, Node)    │
│   (sync rules: user_id buckets)        command catalog       │
│            │ replication                │ validated writes   │
│            ▼                            ▼                    │
│   PostgreSQL (source of truth) ◄── pg-boss jobs              │
│     • weather poll      • nightly canonical recompute        │
│     • past-due scan     • schedule prediction/optimization   │
│     • automation backstop • push notification dispatch       │
│     • graph layout precompute                                │
└──────────────────────── Server (Docker Compose) ─────────────┘
```

Self-hosted baseline: one `docker-compose.yml` with `postgres`, `powersync`, `api` (includes pg-boss workers), and a static web host. Managed drop-ins (no architecture change): PowerSync Cloud, Neon/Supabase Postgres, Fly.io/Railway for the API.

## 4. Technology Stack (fixed — do not substitute)

| Layer | Choice | Notes |
|---|---|---|
| Language | TypeScript (strict) everywhere | one language across client/server/core |
| Monorepo | pnpm workspaces + Turborepo | |
| Web | Vite + React 18 SPA | no SSR; local-first app |
| Desktop | Tauri v2 wrapping the web build | Windows + macOS; native SQLite via plugin |
| Mobile | Expo (React Native) | iOS + Android; `@powersync/react-native` |
| Local DB | SQLite everywhere | wa-sqlite/OPFS on web via PowerSync web SDK |
| Sync | PowerSync (self-hosted; Cloud optional) | full offline queue + streamed sync |
| Server DB | PostgreSQL ≥ 15 | source of truth |
| API | Hono on Node 20 | small, fast, typed |
| ORM/migrations | Drizzle | parameterized SQL only |
| Validation | Zod — single source of truth in `packages/core`, shared by client and server | |
| Jobs | pg-boss (queue inside Postgres) | no Redis |
| Auth | Better Auth (library in our API) | email+password, sessions/JWT |
| Graph/flowchart UI | React Flow (web/desktop) | mobile is read-only renderer |
| Graph layout | ELK (elkjs) invoked from core view-model builders | |
| Recurrence | rrule.js | RRULE strings in DB |
| State/UI data | PowerSync reactive queries + Zustand for ephemeral UI state | no Redux |
| Tests | Vitest (+ fast-check for property tests) | core has highest coverage bar |

## 5. Monorepo Layout

```
prisms/
├─ packages/
│  ├─ core/                    # PURE TS. No IO, no platform APIs, no Date.now() outside injected clock.
│  │  ├─ src/domain/           # entity types, Zod schemas (single source of truth)
│  │  ├─ src/status/           # derived status function (§6.1)
│  │  ├─ src/aggregates/       # streaks, practice hours, progress, burndown (§6.2–6.5)
│  │  ├─ src/scheduler/        # pure scheduling engine (§10)
│  │  ├─ src/rules/            # automation + blocker rules engine (§9)
│  │  ├─ src/graph/            # tree ops, DAG ops, cycle detection, ELK view-models
│  │  ├─ src/commands/         # mutation catalog: names, payload schemas, invariant checks (§8)
│  │  ├─ src/time/             # HLC, day-reset bucketing, duration math
│  │  └─ test/                 # unit + property tests (determinism, idempotency, no-cycles)
│  ├─ db/                      # Drizzle schema, migrations, PowerSync sync-rules.yaml
│  └─ ui/                      # shared React hooks (usePowerSync queries → core selectors)
├─ apps/
│  ├─ web/                     # Vite + React; full feature surface incl. flowchart/Gantt editing
│  ├─ desktop/                 # Tauri v2 shell around apps/web build output
│  ├─ mobile/                  # Expo; full lists/kanban/agenda/clock-in; read-only graph views
│  └─ server/                  # Hono API + Better Auth + pg-boss workers (imports core + db)
├─ docker-compose.yml
└─ turbo.json
```

**Dependency rules (enforce with eslint-plugin-boundaries):** `core` imports nothing from other packages. `db` imports `core` (types only). `ui`, `server`, and all apps import `core`. Apps never import `server`.

---

## 6. Data Model

Tree (containment) + Graph (dependencies) + Logs (facts) + Caches (server-computed). All tables carry `user_id uuid NOT NULL`, `created_at timestamptz NOT NULL DEFAULT now()`, `updated_at timestamptz NOT NULL`, and soft-delete `deleted_at timestamptz` (sync requires soft deletes; hard-delete via retention job ≥ 90 days after `deleted_at`). All PKs are `uuid`. Client-generated IDs are UUIDv7 except automation outputs (UUIDv5, §9.4).

### 6.0 DDL (Drizzle generates from this; shown as SQL for precision)

```sql
-- THE TREE -----------------------------------------------------------------
CREATE TABLE nodes (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  parent_id uuid REFERENCES nodes(id),
  node_type text NOT NULL CHECK (node_type IN
    ('vision','roadmap','project','milestone','task','activity')),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  sort_order text NOT NULL,              -- fractional index (e.g. 'a0','a1','a0V')
  start_date date, due_date date,
  estimate_minutes integer,              -- tasks: basis for progress bar & scheduling
  completed_at timestamptz,              -- FACT. NULL = not done. Only set by mutations.
  habit_id uuid,                         -- task spawned by a habit occurrence (XOR parent rule, §6.7-I3)
  attributes jsonb NOT NULL DEFAULT '{}',-- type-specific extras only; never queried fields
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz
);
CREATE INDEX nodes_children ON nodes(user_id, parent_id, sort_order) WHERE deleted_at IS NULL;
CREATE INDEX nodes_by_type  ON nodes(user_id, node_type)             WHERE deleted_at IS NULL;
CREATE INDEX nodes_due      ON nodes(user_id, due_date)              WHERE deleted_at IS NULL;

-- THE GRAPH ------------------------------------------------------------------
CREATE TABLE edges (
  id uuid PRIMARY KEY, user_id uuid NOT NULL,
  predecessor_id uuid NOT NULL REFERENCES nodes(id),
  successor_id   uuid NOT NULL REFERENCES nodes(id),
  edge_type text NOT NULL DEFAULT 'FS' CHECK (edge_type IN ('FS','SS','FF','SF')),
  lag_minutes integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  UNIQUE (predecessor_id, successor_id)
);
CREATE INDEX edges_succ ON edges(user_id, successor_id) WHERE deleted_at IS NULL;
CREATE INDEX edges_pred ON edges(user_id, predecessor_id) WHERE deleted_at IS NULL;

-- SCHEDULING ----------------------------------------------------------------
CREATE TABLE schedule_blocks (
  id uuid PRIMARY KEY, user_id uuid NOT NULL,
  task_id uuid NOT NULL REFERENCES nodes(id),
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
  anchor_type text NOT NULL DEFAULT 'none' CHECK (anchor_type IN ('none','start','end','both')),
  rrule text,                            -- recurrence (habit-generated blocks)
  status text NOT NULL DEFAULT 'committed' CHECK (status IN ('committed','suggested')),
  suggestion_reason text,                -- e.g. 'past_due_reschedule','nightly_optimization'
  computed_at timestamptz,               -- set when produced by a server job
  external_event_id text,               -- reserved (v2 calendar sync)
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL,
  deleted_at timestamptz
);
CREATE INDEX blocks_time ON schedule_blocks(user_id, starts_at) WHERE deleted_at IS NULL;
CREATE INDEX blocks_task ON schedule_blocks(user_id, task_id)   WHERE deleted_at IS NULL;

-- TIME TRACKING (append-only facts) ------------------------------------------
CREATE TABLE time_entries (
  id uuid PRIMARY KEY, user_id uuid NOT NULL,
  task_id uuid NOT NULL REFERENCES nodes(id),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,                  -- NULL = clock currently running
  focus_factor real CHECK (focus_factor BETWEEN 0.5 AND 1.0),  -- set at clock-out review
  completed_session boolean,             -- "was the task finished this session?"
  planned boolean NOT NULL DEFAULT true, -- false = unplanned ad-hoc work
  device_id text NOT NULL,               -- for the offline double-clock-in rule (§7.4)
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL,
  deleted_at timestamptz
);
CREATE INDEX entries_open ON time_entries(user_id) WHERE ended_at IS NULL AND deleted_at IS NULL;
CREATE INDEX entries_task ON time_entries(user_id, task_id, started_at) WHERE deleted_at IS NULL;

-- HABITS & SKILLS --------------------------------------------------------------
CREATE TABLE habits (
  id uuid PRIMARY KEY, user_id uuid NOT NULL,
  vision_id uuid NOT NULL REFERENCES nodes(id),   -- must reference a node_type='vision'
  title text NOT NULL,
  rrule text NOT NULL,                   -- occurrence pattern
  streak_mode text NOT NULL CHECK (streak_mode IN
    ('perfect_planned','daily','weekly','monthly','quarterly','yearly')),
  daily_target_minutes integer,          -- progress-ring target (e.g. 120 = 2h study)
  mastery_target_hours integer,          -- e.g. 10000; NULL = plain habit, not a skill
  level_thresholds_hours integer[] NOT NULL DEFAULT '{}',  -- ascending hour marks per level
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL,
  deleted_at timestamptz
);
CREATE TABLE habit_completions (         -- append-only facts (check-offs)
  id uuid PRIMARY KEY, user_id uuid NOT NULL,
  habit_id uuid NOT NULL REFERENCES habits(id),
  occurrence_date date NOT NULL,         -- bucketed with day-reset hour (§6.6)
  completed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  UNIQUE (habit_id, occurrence_date)
);

-- DECISION MATRIX ----------------------------------------------------------------
CREATE TABLE decision_boards (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL, deleted_at timestamptz
);
CREATE TABLE decision_criteria (
  id uuid PRIMARY KEY, user_id uuid NOT NULL,
  board_id uuid NOT NULL REFERENCES decision_boards(id),
  label text NOT NULL, weight real NOT NULL CHECK (weight > 0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL, deleted_at timestamptz
);
CREATE TABLE decision_scores (
  id uuid PRIMARY KEY, user_id uuid NOT NULL,
  criterion_id uuid NOT NULL REFERENCES decision_criteria(id),
  project_id uuid NOT NULL REFERENCES nodes(id),
  score real NOT NULL CHECK (score BETWEEN 0 AND 10),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL, deleted_at timestamptz,
  UNIQUE (criterion_id, project_id)
);
-- priority(project) = Σ weight×score / Σ weight   (computed in core, never stored)

-- SPRINT / PRIORITIZED GROUP ----------------------------------------------------
CREATE TABLE sprints (
  id uuid PRIMARY KEY, user_id uuid NOT NULL,
  title text NOT NULL, starts_on date NOT NULL, ends_on date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL, deleted_at timestamptz
);
CREATE TABLE sprint_memberships (
  id uuid PRIMARY KEY, user_id uuid NOT NULL,
  sprint_id uuid NOT NULL REFERENCES sprints(id),
  node_id uuid NOT NULL REFERENCES nodes(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL, deleted_at timestamptz,
  UNIQUE (sprint_id, node_id)
);

-- AUTOMATION & BLOCKER RULES (declarative JSON, §9) -------------------------------
CREATE TABLE automation_rules (
  id uuid PRIMARY KEY, user_id uuid NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('task_completed','task_created')),
  conditions jsonb NOT NULL,             -- predicate AST, §9.2
  actions jsonb NOT NULL,                -- spawn templates, §9.3
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL, deleted_at timestamptz
);
CREATE TABLE blocker_rules (
  id uuid PRIMARY KEY, user_id uuid NOT NULL,
  scope jsonb NOT NULL,                  -- which nodes it applies to (subtree/type/tag)
  predicate jsonb NOT NULL,              -- same AST grammar; may reference external_facts
  label text NOT NULL,                   -- shown in UI: "Blocked: rain forecast"
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL, deleted_at timestamptz
);

-- EXTERNAL FACTS (server-written, sync down read-only) ------------------------------
CREATE TABLE external_facts (
  id uuid PRIMARY KEY, user_id uuid NOT NULL,
  kind text NOT NULL,                    -- 'weather_forecast'
  key text NOT NULL,                     -- e.g. 'merritt-island-fl/2026-06-12'
  payload jsonb NOT NULL,                -- {high_c, low_c, precip_prob, wind_kph, ...}
  computed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL, deleted_at timestamptz,
  UNIQUE (user_id, kind, key)
);

-- SERVER-COMPUTED CACHES (clients read; clients also patch incrementally, §6.3) -----
CREATE TABLE computed_aggregates (
  id uuid PRIMARY KEY, user_id uuid NOT NULL,
  subject_kind text NOT NULL CHECK (subject_kind IN ('habit','node','user')),
  subject_id uuid,                       -- NULL for user-level aggregates
  metric text NOT NULL,                  -- 'practice_hours','streak','progress','burndown_series','projection'
  value jsonb NOT NULL,
  computed_at timestamptz NOT NULL, computed_by text NOT NULL CHECK (computed_by IN ('client','server')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL, deleted_at timestamptz,
  UNIQUE (user_id, subject_kind, subject_id, metric)
);

-- DIAGRAM PRESENTATION (never affects semantics) -------------------------------------
CREATE TABLE diagram_layouts (
  id uuid PRIMARY KEY, user_id uuid NOT NULL,
  diagram_id uuid NOT NULL,              -- the node whose subtree the diagram shows
  node_id uuid NOT NULL REFERENCES nodes(id),
  x real NOT NULL, y real NOT NULL,
  group_id uuid,                          -- visual grouping container
  collapsed boolean NOT NULL DEFAULT false,
  computed_at timestamptz,                -- set when produced by the layout job
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL, deleted_at timestamptz,
  UNIQUE (diagram_id, node_id)
);
CREATE TABLE diagram_groups (
  id uuid PRIMARY KEY, user_id uuid NOT NULL,
  diagram_id uuid NOT NULL, label text NOT NULL, color text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL, deleted_at timestamptz
);

-- COMMAND LOG (audit; written server-side on every applied mutation) -----------------
CREATE TABLE command_log (
  id uuid PRIMARY KEY,                   -- client-generated command id (idempotency key)
  user_id uuid NOT NULL,
  name text NOT NULL, payload jsonb NOT NULL,
  device_id text NOT NULL, hlc text NOT NULL,         -- hybrid logical clock, §7.3
  applied_at timestamptz NOT NULL DEFAULT now(),
  result text NOT NULL CHECK (result IN ('applied','rejected','noop')),
  reject_reason text
);

-- SETTINGS ----------------------------------------------------------------------------
CREATE TABLE user_settings (
  user_id uuid PRIMARY KEY,
  day_reset_hour smallint NOT NULL DEFAULT 4 CHECK (day_reset_hour BETWEEN 0 AND 23),
  timezone text NOT NULL DEFAULT 'America/New_York',
  weather_location jsonb,                -- {lat, lon, label}
  updated_at timestamptz NOT NULL
);
```

### 6.7 Invariants and where each is enforced

Every invariant is implemented once in `core/src/commands` (so it runs offline) and re-executed by the server on upload (so it cannot be bypassed). DB constraints are last-resort backstops.

| ID | Invariant | core | server | DB |
|----|-----------|------|--------|----|
| I1 | Hierarchy typing: parent of roadmap=vision, project=roadmap, milestone=project, task=milestone or project; `activity` has no parent | ✔ | ✔ | trigger |
| I2 | Max 4 non-deleted `vision` nodes per user | ✔ | ✔ | — |
| I3 | A task has exactly one justification: an ancestor project **xor** `habit_id` (activities exempt until promoted) | ✔ | ✔ | — |
| I4 | `edges` form a DAG; predecessor and successor are the same `node_type` (task↔task, project↔project) | ✔ cycle-check on insert | ✔ | — |
| I5 | At most one open `time_entry` per user (see §7.4 for the offline merge rule) | ✔ | ✔ resolves | partial unique index |
| I6 | `ends_at > starts_at` on blocks and entries | ✔ | ✔ | CHECK |
| I7 | Anchored blocks (`anchor_type != 'none'`) are immutable to the scheduler; only an explicit user mutation moves them | ✔ scheduler hard constraint | ✔ | — |
| I8 | A `done` task (completed_at set) cannot be clocked into or rescheduled | ✔ | ✔ | — |
| I9 | Suggested blocks never overlap anchored blocks | ✔ scheduler | ✔ | — |
| I10 | `deleted_at` cascades logically down the subtree (core computes the closure; mutation marks all) | ✔ | ✔ | — |

---

## 7. Derived State & Sync

### 7.1 The status function (core/src/status) — normative algorithm

```ts
type TaskStatus = 'done'|'ongoing'|'blocked'|'scheduled'|'prioritized'|'available';

function taskStatus(t: Task, ctx: FactContext, now: Instant): TaskStatus {
  if (t.completed_at) return 'done';
  if (ctx.openEntryFor(t.id)) return 'ongoing';            // clock-in is the ONLY path here
  if (isBlocked(t, ctx, now)) return 'blocked';
  if (ctx.hasCommittedBlockAtOrAfter(t.id, now)) return 'scheduled';
  if (ctx.inActiveSprint(t.id, now)) return 'prioritized';
  return 'available';
}

function isBlocked(t: Task, ctx: FactContext, now: Instant): boolean {
  // (a) dependency gate
  for (const e of ctx.incomingEdges(t.id)) {
    const p = ctx.node(e.predecessor_id);
    switch (e.edge_type) {
      case 'FS': if (!p.completed_at) return true; break;
      case 'SS': if (!ctx.hasAnyEntry(p.id) && !p.completed_at) return true; break;
      case 'FF': case 'SF': /* gate completion/scheduling, not availability */ break;
    }
    if (e.lag_minutes > 0 && p.completed_at &&
        now < addMinutes(p.completed_at, e.lag_minutes)) return true;
  }
  // (b) declarative blocker rules (phase, position, weather, dates) — §9.2 AST
  return ctx.blockerRules().some(r => inScope(r.scope, t, ctx) && evalPredicate(r.predicate, t, ctx, now));
}
```

Precedence is exactly: `done > ongoing > blocked > scheduled > prioritized > available`. Project "phases" referenced by blocker rules are derived too: a project's phase = aggregate of its tasks' statuses (`completed` | `executing` (any ongoing/done) | `planned` (any scheduled) | `idle`). Completing a predecessor therefore unblocks successors instantly and offline with no rule firing and no write to the successor (R4).

### 7.2 Derived aggregates (core/src/aggregates)

All read facts + `user_settings.day_reset_hour`; all have an **incremental** form (client, on each new fact) and a **canonical** form (server, full recompute) — same module, two entry points. Canonical results land in `computed_aggregates` with `computed_by='server'` and always overwrite client values (drift self-heals nightly).

- `effectiveHours(entry) = (ended_at − started_at) × focus_factor (default 1.0)`
- **Practice hours** (skill): Σ effectiveHours over entries of tasks with `habit_id = skill`, plus level = count of `level_thresholds_hours` passed.
- **Streaks:** evaluate habit `rrule` occurrences against `habit_completions` per `streak_mode`. `perfect_planned` additionally requires every scheduled block of that habit's tasks in the period to have a session (`time_entries` overlap).
- **Task progress bar:** Σ raw entry minutes ÷ `estimate_minutes` (cap display at 100%, show overflow numerically).
- **Project completion %:** weighted by `estimate_minutes` (fallback weight 1) over descendant tasks' `completed_at`.
- **Burndown:** daily series of remaining estimate minutes (scope changes included) vs. the *scheduled* line (sum of committed blocks per day). **Projection:** linear regression over trailing 14-day completion velocity → projected finish date; client fallback = simple linear estimate; server may later upgrade to Monte Carlo without client changes (principle 5).
- **Day bucketing:** `bucketDate(ts) = date(ts − day_reset_hour)` in the user's timezone. Every "today/daily" computation MUST go through this function.
- **Time-left indicators:** time left in day (next day-reset − now), in task (estimate − consumed), until next committed block.

### 7.3 Sync mechanics

- **Down:** PowerSync sync rules — one global bucket per user: every table above (except `command_log`) with `WHERE user_id = token_user_id`. `external_facts` and `computed_aggregates` flow down like any rows.
- **Up:** PowerSync upload queue → `POST /sync/upload` → command dispatcher (§8). Uploads are **per-field patches** (changed columns only) wrapped in named commands; full-row writes are forbidden.
- **Ordering & conflicts:** server applies patches in arrival order; each command carries an HLC timestamp (`core/src/time/hlc.ts`: 48-bit physical ms + 16-bit logical counter + device_id). Same-field conflicts resolve LWW **by HLC**, not arrival order, so the genuinely-later offline edit wins. Losing values persist in `command_log` (recoverable history).
- **Conflict matrix:** different rows → both apply (no conflict). Same row, different fields → both apply (minimal-field patches). Same row+field → HLC LWW. Append-only tables → no conflicts by construction.

### 7.4 The one special merge rule — double clock-in

Two devices clock in while offline (violating I5 invisibly). Server resolution, deterministic: keep the entry with the **latest `started_at`** open; auto-close the other at the later entry's `started_at` (flag `attributes.auto_closed=true` is not available on this table — instead set its `ended_at` and `completed_session=NULL`, and write a `command_log` noop noting the resolution). Clients apply the same rule locally in `core` when they observe two open entries after sync, so UI never shows two running timers even before the server responds.

---

## 8. Command API (the only write path)

`POST /sync/upload` body: `{ device_id, commands: [{ id, name, hlc, payload }] }`. Pipeline per command, in order: **(1)** Zod parse against the catalog schema → **(2)** auth: every referenced row's `user_id` must equal the token's user → **(3)** invariant checks from `core/src/commands` (same functions the client ran) → **(4)** apply via Drizzle in a transaction → **(5)** append `command_log` (the command `id` is the idempotency key: replays return the original result as `noop`). Rejections return machine-readable codes (`E_CYCLE`, `E_MAX_VISIONS`, `E_DONE_IMMUTABLE`, …); the client surfaces them and reverts the optimistic local write.

### 8.1 Mutation catalog (complete; payloads are Zod schemas in `core/src/commands`)

```
node.create        {id, node_type, parent_id?, title, sort_order, habit_id?, ...}
node.rename        {id, title}
node.set_description {id, description}
node.move          {id, new_parent_id, sort_order}        // re-parent: I1,I3 revalidated
node.retype        {id, node_type}                        // promote/demote: I1 revalidated
node.set_dates     {id, start_date?, due_date?}
node.set_estimate  {id, estimate_minutes}
node.reorder       {id, sort_order}
node.check_off     {id, completed_at}                     // completion FACT; triggers rules
node.uncheck       {id}
node.soft_delete   {id}                                   // cascades per I10
activity.promote   {id, parent_id | habit_id}             // inbox item → real task
edge.create        {id, predecessor_id, successor_id, edge_type, lag_minutes}
edge.delete        {id}
block.create       {id, task_id, starts_at, ends_at, anchor_type}
block.move         {id, starts_at, ends_at}               // rejected if anchored (I7)
block.set_anchor   {id, anchor_type}
block.delete       {id}
block.accept_suggestion {id}                              // suggested → committed
block.reject_suggestion {id}                              // soft-delete the suggestion
timer.clock_in     {entry_id, task_id, started_at, planned}
timer.clock_out    {entry_id, ended_at}
timer.review       {entry_id, focus_factor, completed_session}  // may also set node.completed_at
habit.create / habit.update {…} / habit.delete {id}
habit.check_off    {id, habit_id, occurrence_date, completed_at}
sprint.create / sprint.add_node / sprint.remove_node / sprint.delete
board.create / criterion.create / criterion.set_weight / score.set {criterion_id, project_id, score}
rule.create / rule.update / rule.toggle / rule.delete      // automation_rules
blocker.create / blocker.update / blocker.toggle / blocker.delete
layout.set_position {diagram_id, node_id, x, y, group_id?}
layout.set_collapsed {diagram_id, node_id, collapsed}
group.create / group.update / group.delete                 // diagram_groups
settings.update    {day_reset_hour?, timezone?, weather_location?}
```

Rules: every verb writes only the fields named in its payload (principle 8). `timer.clock_out` additionally emits a derived calendar event — implemented as nothing at all: the agenda view renders past `time_entries` as events directly (facts ARE the calendar history).

---

## 9. Rules Engine (core/src/rules) — automations and blockers share one evaluator

### 9.1 Execution contract (R4)

`task_completed` / `task_created` mutations run the engine **synchronously inside the same local SQLite transaction** as the triggering write. Spawned rows commit atomically with the trigger, appear instantly, and enter the upload queue as ordinary `node.create` / `block.create` / `edge.create` commands. The engine runs to **fixpoint** (spawned tasks may trigger further rules) with `MAX_DEPTH = 5`; rule-creation validates that no rule's action pattern can trigger itself transitively.

### 9.2 Predicate AST (used by automation `conditions` and blocker `predicate`)

```json
{ "all": [
  { "fact": "node.title",      "op": "matches",  "value": "lecture" },
  { "fact": "ancestor.type",   "op": "eq",       "value": "project" },
  { "any": [
    { "fact": "weather.precip_prob", "key": "{block_date}", "op": "gt", "value": 0.6 },
    { "fact": "project.phase",  "op": "eq", "value": "planned" },
    { "fact": "graph.unfinished_predecessors", "op": "gt", "value": 0 },
    { "fact": "date.window",    "op": "outside", "value": {"start":"2026-06-01","end":"2026-09-01"} }
  ]}
]}
```

Fact resolvers read only synced rows (`nodes`, `edges`, `time_entries`, `external_facts`, …) — identical inputs on device and server. `weather.*` resolves from `external_facts`; if the fact is absent (long offline), the predicate evaluates `unknown` and a blocker rule treats `unknown` as **not blocked** with a UI badge "weather unverified" (graceful degradation, principle 5).

### 9.3 Actions

```json
[{ "action": "spawn_task", "slot": 0,
   "template": { "title": "Pre-brief: {trigger.title}", "estimate_minutes": 30,
                 "parent": "same_as_trigger", "due": "trigger.completed_at + P2D" } },
 { "action": "spawn_task", "slot": 1,
   "template": { "title": "Study & practice: {trigger.title}", "estimate_minutes": 180,
                 "parent": "same_as_trigger", "edge_from_slot": 0 } }]
```

All time math reads the **triggering fact's timestamps** (`trigger.completed_at`), never the wall clock — device and server backstop runs are mathematically identical.

### 9.4 Idempotency — deterministic IDs

`spawned.id = uuidv5(namespace=PRISMS_NS, name = rule_id + ':' + trigger_node_id + ':' + slot)`. Two devices executing the same rule offline produce byte-identical rows; the server upserts on PK and duplication is structurally impossible. The server's **automation backstop job** re-runs the engine on every incoming completion/creation: already-executed → no-op; missed (stale client) → filled.

---

## 10. Scheduler (core/src/scheduler) — one pure function, two callers

```ts
schedule(input: {
  tasks: SchedulableTask[];        // estimate, due, dependencies, windows
  committed: Block[];              // anchored = hard immovable (I7); flexible = movable if incomplete
  windows: TimeWindow[];           // morning/day/evening/night definitions + task window constraints
  horizon: {from: Instant; to: Instant};
  mode: 'greedy' | 'optimize';
}): { proposals: BlockProposal[]; unplaceable: {task_id, reason}[] }
```

Hard constraints: anchored blocks never move; no overlaps; dependency order with lag; task time-windows; nothing scheduled for `done` tasks (I8). Soft objectives (optimize mode): meet due dates, prefer sprint members, minimize fragmentation, respect daily target minutes for habit tasks.

**Client (`greedy`):** earliest-fit placement. Powers (a) drag-to-agenda — as the user drags, valid windows = `schedule({tasks:[t], mode:'greedy'})` rendered as highlighted slots, invalid regions dimmed; (b) single past-due reschedule. Milliseconds, fully offline.
**Server (`optimize`):** nightly + on-demand multi-week re-optimization and next-day predicted schedule. Output rows: `schedule_blocks(status='suggested', suggestion_reason, computed_at)`. Past-due scan job marks warnings (push + in-app) and attaches a suggested replacement block; the user accepts/rejects via `block.accept_suggestion` / `block.reject_suggestion` — both plain local mutations (works offline, principle 6).
**Determinism:** identical inputs ⇒ identical output (stable sort keys, injected clock). Property-tested with fast-check: never overlaps anchors, never violates dependencies, idempotent on its own output.

---

## 11. Server Jobs (pg-boss; all import core)

| Job | Trigger | Output (synced rows) |
|---|---|---|
| `weather.poll` | cron 30 min | `external_facts(kind='weather_forecast')` per user location, 7-day horizon |
| `aggregates.recompute` | cron nightly (per-user, after their day-reset hour) | canonical `computed_aggregates` |
| `schedule.optimize` | cron nightly + enqueued on big plan changes | `schedule_blocks(status='suggested')` |
| `pastdue.scan` | cron 15 min | warning notifications + suggested reschedule blocks |
| `automation.backstop` | enqueued by upload dispatcher on completions/creations | spawned rows (UUIDv5 no-ops if device already ran) |
| `layout.precompute` | enqueued when a diagram's node/edge set changes | `diagram_layouts(computed_at)` via ELK for diagrams > 60 nodes |
| `notify.dispatch` | enqueued by other jobs | Web Push / Expo push |
| `retention.purge` | cron weekly | hard-delete rows `deleted_at < now()−90d` |

Notifications are dual-path: server push for closed-app delivery; clients also schedule **local notifications** (past-due, streak-at-risk, daily targets) so reminders fire offline.

---

## 12. Client Applications

### 12.1 Surface matrix

| View | Web | Desktop (Tauri) | Mobile |
|---|---|---|---|
| Dashboard (burndown, progress, priority list, streaks) | ✔ | ✔ | ✔ |
| Worklist (clock-in / check-off / delete) + activity inbox | ✔ | ✔ | ✔ |
| Agenda: calendar + to-do side panel, drag-drop with window hints | ✔ | ✔ | ✔ (tap-to-place assist) |
| Kanban by date | ✔ | ✔ | ✔ |
| Habit tracker (rings, streaks, levels) | ✔ | ✔ | ✔ |
| Clock-in screen + focus review modal | ✔ | ✔ | ✔ |
| Decision board | ✔ | ✔ | ✔ |
| Gantt (edit) | ✔ | ✔ | read-only |
| Flowcharts: vision / roadmap / project (drag-drop edit, grouping) | ✔ | ✔ | read-and-navigate only |
| Settings, rules & blockers editors | ✔ | ✔ | ✔ |

Graph editing is React-Flow/DOM-based and deliberately not ported to RN. Mobile renders graphs from `diagram_layouts` (read-only, tappable navigation); all list/agenda/kanban/timer surfaces are fully editable on mobile.

### 12.2 Rendering rules

- Calendar: blocks of tasks whose ancestry reaches no Vision (and no habit) render **dark grey** (`core/graph.isJustified(node)`); anchored blocks show a lock glyph and refuse drag; suggested blocks render dashed with accept/reject affordances; past `time_entries` render as the historical event layer.
- Gantt: bars from committed blocks + due dates; dependency arrows from `edges`; critical path = longest path over estimates, computed in core on demand (cheap, stays client-side).
- Flowchart "no dates" mode hides the time axis and lays out purely by ELK; "dates" mode positions x by date.
- All views are PowerSync reactive queries → core selectors → React. No view ever caches derived status; recompute on data change (it's microseconds).

### 12.3 Local platform glue

- Web: PowerSync web SDK (wa-sqlite/OPFS), Workbox service worker for app-shell offline, Web Push.
- Desktop: Tauri v2 loads the identical web bundle; SQLite via Tauri SQL plugin through the same PowerSync interface; OS notifications via Tauri plugin.
- Mobile: `@powersync/react-native` + expo-sqlite; expo-notifications for local + push; background fetch only as best-effort (never load-bearing — server jobs are the guarantee).

---

## 13. Security Model

- TLS everywhere; Better Auth sessions → short-lived JWT presented to both API and PowerSync (PowerSync validates the JWT and scopes buckets to `user_id`).
- No SQL over the wire in either direction (R6); DB credentials exist only server-side; Drizzle parameterized queries internally.
- Every command: schema-validated, ownership-checked, invariant-checked, rate-limited per user+verb, logged to `command_log`.
- Stolen-token blast radius = that user's verbs on that user's rows; no enumeration or arbitrary-query surface exists.

## 14. Offline Behavior Matrix *(informative)*

| Capability | Offline behavior |
|---|---|
| CRUD, reorder, re-parent, retype | full, instant, queued |
| Clock-in/out, focus review, check-off | full (facts are local writes) |
| Dependency unblocking | instant (derived status, zero writes) |
| Automation spawning | full, atomic, deterministic IDs |
| Streaks/practice/progress | live incremental values; canonical correction on reconnect |
| Drag-to-agenda window hints, single reschedule | full (greedy scheduler in core) |
| Multi-week optimization, projections, weather | last synced values + `computed_at` freshness label; refresh on reconnect |
| Past-due warnings | local notifications fire; push arrives on other devices when online |
| Accept/reject suggestions | full (plain mutations on synced suggestion rows) |

## 15. Build Plan (execute in order; each phase gates the next)

1. **Foundations:** monorepo, `core/domain` types + Zod, `db` schema + migrations, HLC + day-reset time utils. *Gate: all invariant unit tests green.*
2. **Core engines:** status function, aggregates (incremental + canonical), graph ops + cycle detection, rules engine, greedy scheduler. *Gate: property tests (determinism, idempotency, DAG safety) green.*
3. **Server:** Hono + Better Auth, command dispatcher + full catalog, command_log, PowerSync sync rules, Docker Compose. *Gate: integration test — two simulated devices, offline edits, convergence including §7.4.*
4. **Web app:** worklist, agenda (drag + window hints), clock-in + review, habits, kanban, dashboard, decision board, settings; PowerSync web SDK wired end-to-end.
5. **Graph surfaces (web):** React Flow flowcharts (3 levels) with grouping + layout persistence, Gantt, rules/blockers editors.
6. **Jobs:** all §11 jobs + optimize-mode scheduler + push.
7. **Mobile (Expo):** shared `ui` hooks; full editable surfaces + read-only graphs; local notifications.
8. **Desktop:** Tauri shell, SQLite plugin, OS notifications. (Cheapest phase — do last.)

## 16. Code-Generation Conventions

- TS `strict`; no `any`; Zod schemas in `core/domain` are the single source — DB types, API payloads, and client forms all derive from them (`z.infer`).
- `core` is forbidden from importing `Date.now`, `Math.random`, timers, fetch, or storage — clock and RNG are injected parameters (lint-enforced). This is what makes device/server runs identical and the whole system testable.
- Errors: never throw strings; `Result<T, DomainError>` in core, typed error codes over the API.
- Migrations forward-only; sync rules versioned alongside schema; mutation payloads only ever gain optional fields (old clients keep working).
- Test floor: core ≥ 90% line coverage; every invariant in §6.7 has a rejecting test; scheduler and rules engine have fast-check property suites; one end-to-end two-device convergence test runs in CI.
