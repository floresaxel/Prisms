# Web Redesign — Migration Plan (W0–W8)

**Goal:** ship the approved mockup (`docs/mockups/web-layout-redesign.html`, branch
`web-redesign-mockup`, commits 456fbd0 + 5896aa6) as the real `apps/web` interface.
The mockup is the visual/IA source of truth; this plan maps it onto the existing
code so the data layer is REUSED, not rewritten.

**Scope:** `apps/web` + the web-side of `packages/ui` (theme, Layout, hooks additions).
`apps/desktop` is a Tauri shell loading the identical web build — it gets the redesign
for free (verify in W8). `apps/mobile` has its own screens and shares only hooks —
untouched. One backend change: the `task_steps` table (W3).

**Branch:** `web-redesign` off `main`. One commit per session (house rule). Gate per
session: `pnpm turbo lint typecheck test` (all 21), `@prisms/core test:coverage` ≥ 90
floor, plus the Playwright specs named in the session (full suite at W1 and W8) vs the
live WSL stack (dev-DB integration tests need `PRISMS_DB_TEST_URL=127.0.0.1:5434`;
e2e recipe: shell-override prod `POWERSYNC_JWT_*` with dev values, build web with
`VITE_POWERSYNC_URL=:8081`, rerun flaky specs at low concurrency).

---

## Current-state inventory (verified 2026-07-05)

| Area | Fact |
|---|---|
| Shell | `packages/ui/src/components/Layout.tsx` — flat nav link list, no groups/badges/topbar |
| Theme | `packages/ui/src/theme.css` (198 lines) — **dark** tokens (`--px-bg:#0f1115`), `px-*` primitives (app/sidebar/list/modal/skeleton/badge/progress) |
| Routes | 13 flat routes in `apps/web/src/App.tsx`: `/` Worklist, `/inbox`, `/agenda`, `/kanban`, `/habits`, `/flowchart`, `/gantt`, `/decisions`, `/rules`, `/blockers`, `/dashboard`, `/review`, `/settings` |
| Reads | `packages/ui/src/hooks.ts` already covers most of the mock: `useGroupedWorklist`, `useBlockedTasks`, `useRunningTimer`, `useDayTimeLeft`, `useActivityInbox` + `usePromoteTargets`, `useAgenda`, `useHabits`/`useHabitTasks`, `useKanban`, `useGantt`, `useFlowchart`, `useDecisionBoards`, `useDashboard`, `useRules`, `useBlockers`, `useReviewInbox`, `useJournalMonths`/`useJournalDay` |
| Priority | `rankProjects(criteria, scores, projectIds)` in `packages/core/src/aggregates/decision.ts` — pure, reusable for My Day ordering |
| Timer | Worklist owns the running-timer bar + clock-out **focus-review modal** (I5: one timer, clock-in disabled while running) |
| Kanban | drag-to-re-date is `commands.setDates` — semantics already exist |
| Suggestions | scheduler suggestions exist in core (`scheduler/optimize.ts`, `commands/payloads.ts`, `status/context.ts`) — accept/reject is real, not mock flourish |
| Substeps | **NOT supported**: `ALLOWED_PARENT_TYPES.task = ['milestone','project']` (I1) — a task cannot parent a task. Needs W3 |
| Done today | no existing read — new selector/hook needed (W2) |
| e2e | 11 specs in `apps/web/e2e/`, **57 label-based navigations** (`getByRole('link', {name: 'Kanban'})` style) — every rename/regroup breaks specs |
| Journal | day-note UI exists (`DayJournal`, `RichJournalEditor` TipTap, month lazy-subscribe manager) — no standalone Journal screen yet (lives in Agenda) |

## Mock → code mapping

| Mock view | Real code | Session |
|---|---|---|
| Sidebar + topbar (clock, timer pill, sync chip) | `Layout.tsx` v2 | W1 |
| My Day | `Worklist.tsx` → `MyDay.tsx` (re-skin + sections) | W2 |
| Tasks (Inbox group + all tasks + substeps) | new `Tasks.tsx`, absorbs `Inbox.tsx` | W3–W4 |
| Projects › Board / Timeline / Graph / Decisions | `Projects.tsx` hub hosting existing `Kanban` / `Gantt` / `Flowchart` / `DecisionBoard` | W5 |
| Agenda (journal panel + week grid + to-schedule) | `Agenda.tsx` re-skin | W6 |
| Journal (month list + editor) | new `Journal.tsx` around existing components | W6 |
| Automations › Rules / Blockers | `Automations.tsx` hub hosting `Rules` / `Blockers` | W7 |
| Dashboard, Habits, Review, Settings | re-skins of existing screens | W7 |

---

## Design decisions (normative — do not re-litigate mid-build)

### D1 — Token-level light flip FIRST, structural re-skins after
Keep the `--px-*` variable **names**; change their **values** to the mockup palette
(bg `#f6f7f9`, surface `#fff`, border `#e6e8ec`, text `#18202b`, dim `#5f6b7a`,
accent `#2563eb`, danger `#dc2626`, ok `#16a34a`) and ADD the extended families
(teal/amber/green/red/sky + `-bg`/`-brd` tints, per the mockup `:root`). Every screen
instantly goes light with zero component churn; the dark-tuned `rgba(...)` badge
overlays in theme.css are re-tinted in the same pass. Screens then adopt new
structure one session at a time — the app is never half-dark/half-light.

### D2 — Layout v2 API (web/desktop shell only)
`Layout` gains grouped nav + topbar. Shape:
`{ groups: [{label?, items: [{label, href, icon, badge?, badgeTone?}]}], active, onNavigate, topbar: {breadcrumb}, status }`.
Badges are plain numbers passed from `App.tsx` (`useActivityInbox().length`,
`useReviewInbox()` count) — Layout stays dumb. The topbar owns: breadcrumb,
**persistent HH:MM clock** (1 s interval, tabular-nums), sync chip (moves out of the
sidebar footer), avatar. Icons: port the mockup SVG sprite to
`packages/ui/src/components/icons.tsx` (`<IconSprite/>` mounted once by Layout,
`<Ic name/>` helper using `<use>`).

### D3 — Route consolidation with permanent redirects
New routes: `/` My Day · `/tasks` · `/agenda` · `/habits` · `/journal` · `/projects`
(tab in hash: `#board|#timeline|#graph|#decisions`) · `/dashboard` · `/automations`
(`#rules|#blockers`) · `/review` · `/settings`. Old paths redirect on boot
(`/inbox→/tasks`, `/kanban→/projects#board`, `/gantt→/projects#timeline`,
`/flowchart→/projects#graph`, `/decisions→/projects#decisions`, `/rules→/automations#rules`,
`/blockers→/automations#blockers`) so bookmarks and mid-migration specs never 404.
Old screens render unchanged inside the new shell/tabs until their re-skin session.

### D4 — Substeps are a NEW `task_steps` table, not a hierarchy change
Rejected alternative: allowing `task → task` children — it ripples into I1/I3
invariants, StatusIndex, scheduler, kanban, burndown (double-counted estimates) and
the worklist. Instead, checklist semantics (mirrors the journal precedent of "new
synced table, not a node type"):

```
task_steps
  ...baseColumns                       -- id, user_id, timestamps, hlc, schema_version, provenance
  task_id     uuid NOT NULL            -- FK → nodes(id); parent must be node_type='task'
  title       text NOT NULL
  done        boolean NOT NULL DEFAULT false
  sort_order  text NOT NULL            -- same fractional ordering as nodes
  INDEX (user_id, task_id) WHERE deleted_at IS NULL
```

- Steps have NO status/schedule/estimate; they never appear in worklist, scheduler,
  StatusIndex, or burndown. Pure checklist.
- Commands (§8.1 additions): `step.add {id, task_id, title}`, `step.rename`,
  `step.toggle {done}`, `step.remove`, `step.reorder {sort_order}` — ownership +
  parent-is-a-task checks; edits rejected when the parent task is done (I8 spirit).
- Sync: rows join the main always-on stream (small rows, no lazy bucket). Tombstones
  join `history` (parity with `habit_completions`).
- Migration `0010` is additive; `ROW_SCHEMA_VERSION` stays 1. **0010 must add the
  table to the scoped publication (follow the 0009 pattern) and prod restarts
  powersync after migrating.**
- Checking off the parent task does NOT auto-toggle steps; deleting the task
  soft-deletes its steps (dispatcher cascade).

### D5 — My Day composition
- Sections: **Available now** (white cards) / **Blocked** / **Done today** — the
  latter two muted (`--px-surface-2` ground) and **collapsed by default**
  (`<button aria-expanded>` headers; collapse state per view in `localStorage`).
- **Ordering:** available items sort by parent-project priority DESC from the
  decision board (`rankProjects`), tie-break due date, then `sort_order`. New hook
  `useProjectPriorities(): Map<projectId, {priority, rank}>` built on the
  `useDecisionBoards` internals. Each row shows `prio n.n` + keeps the provenance
  `why?` (`WhyButton` exists).
- **Filter:** client-side project chips (chip set derived from projects present in
  the list; count label updates live).
- **Done today:** new read `useDoneToday(now)` — tasks completed since day-reset,
  with minutes logged from time entries (new selector in core if the join is not
  trivial in hooks.ts).
- **Clocked-in treatment:** run banner + topbar pill are white with an amber
  outline (mockup 5896aa6), never a filled card.
- Right rail: today's blocks from `useAgenda` (committed / anchored / habit /
  **suggested with accept-reject** via the existing scheduler commands) + habit
  summary from `useHabits`. Header chips: `useDayTimeLeft`, planned = Σ today's
  committed blocks, done count, blocked count.
- The existing Scheduled/Unscheduled split (`groupWorklistBySchedule`) stops being
  the section structure; scheduled-ness surfaces via the rail + a per-row chip.

### D6 — Tasks view absorbs Inbox
One screen, two grouping tabs (**By project** / **By status**), capture bar on top
(`activity.create`). The **Inbox group renders first** with the existing
promote-to-parent flow and its `promote-*` testids preserved. Project groups walk
`TreeIndex` (tasks under project/milestone); status groups use the `taskStatus`
selector (Available / Blocked / Inbox / Done today). Substep UI: expander chip
("N steps" / "+ steps"), checkbox toggle, **inline `<input>` rename** (controlled
input, NOT contenteditable — mock-only shortcut), add-on-Enter. `Inbox.tsx` is
deleted in W4; `/inbox` redirect stays forever.

### D7 — Timer pill goes global, modal comes with it
The running-timer pill moves into the topbar (visible on every view). Because
clock-out triggers the focus-review modal (focus factor + completed?), that modal
moves from `Worklist.tsx` into a shell-level component so clock-out works from any
screen (I5 stays: clock-in buttons everywhere disable while a timer runs). My Day
keeps its inline run banner as well.

### D8 — e2e policy: centralize navigation before renaming anything
W1 introduces `apps/web/e2e/util/nav.ts` (`goto(page, 'myday'|'tasks'|…)` mapping
label + route in ONE place) and mechanically converts the 57 label-based
navigations. After that, each session updates only the assertions of the screens it
re-skins. Data-testids (`progress-*`, `promote-*`, `sync-state`, `sign-out`,
`rejection-toast`, …) are load-bearing — keep them stable through re-skins.

### D9 — Mock content that is EXPLICITLY out of scope
- **Weather-driven blocker** (`weather.precip_prob`) — sample copy; there is no
  weather fact source. Blockers UI ships with the real condition set only.
- **Ctrl-K command palette** — backlog item, not in W0–W8.
- **Agenda drag-to-schedule polish** ("valid windows light up") — W6 keeps the
  existing scheduling interactions restyled; drag UX improvements are follow-up.
- **Skill "Level N" chips** — only if `canonicalPractice` already exposes levels
  (verify at W7 start); otherwise drop the chip, keep practiced-hours + streak.
- Anything else in the mock without a hook/command named in this plan defaults OUT.

---

## Sessions

### W0 — Light theme foundation (no markup changes)
- `theme.css`: new token values per D1 + extended families + re-tinted badge/skeleton
  overlays for light ground. Font stack: Inter-first, **preserve the emoji fallback
  chain** (journal D6 corpus must keep rendering in color).
- `icons.tsx` sprite + `<Ic/>` per D2 (exported, not yet used by screens).
- Visual pass over all 13 screens on the dev server — fix any hardcoded dark-only
  colors found inline in screens.
- **Gate:** turbo suite; `dod.spec.ts` green (labels untouched).

### W1 — Shell: Layout v2, routes, redirects, e2e nav helper
- `Layout.tsx` v2 per D2 (groups, badges, topbar with clock + sync chip + avatar).
- Global timer pill + relocated focus-review modal per D7.
- `App.tsx`: new route set + redirect map per D3; old screens render inside the new
  shell (Projects/Automations render the old screens under plain tabs).
- Breadcrumb map (`My work / My Day` etc. from the mock's CRUMBS).
- e2e: `util/nav.ts` + convert all 57 navigations; update `Layout`-dependent
  assertions (sidebar labels, sync-state location).
- **Gate:** FULL e2e suite vs live stack.

### W2 — My Day (Worklist → MyDay.tsx)
- Sections + muted/collapsed treatment + run banner per D5; header chips row.
- New reads: `useDoneToday`, `useProjectPriorities`; priority ordering + filter
  chips + `prio` chip per row.
- Right rail (today's plan + habits) incl. suggestion accept/reject wiring —
  **verify the suggestion command names in `commands/payloads.ts` at session start**.
- **Gate:** turbo suite + rewritten `s16.spec.ts`/`s17.spec.ts` equivalents
  (timer flow, check-off flow, progress bars) + new myday.spec (collapse, filter,
  priority order).

### W3 — Substeps data layer (backend + client plumbing, no UI)
- Migration `0010_task_steps` (+ scoped-publication add, 0009 pattern).
- Dispatcher: `step.*` commands per D4 + invariants + integration tests (dev DB up).
- `sync-streams.yaml` inclusion + tombstones via `history`.
- Client: schema, `rows.ts` mapper, overlay effects, `useTaskSteps(taskId)`,
  `useCommands` additions, unit tests (jsdom).
- **Gate:** turbo suite + `@prisms/core` coverage floor + dispatcher integration
  tests green. Prod note recorded in SELF_HOSTING.md (migrate → restart powersync).

### W4 — Tasks view UI
- `Tasks.tsx` per D6 (tabs, groups, capture, promote, substeps add/rename/toggle).
- Delete `Inbox.tsx`; sidebar entry becomes **Tasks** with the inbox-count badge.
- e2e: new `tasks.spec.ts` (capture → promote → shows under project group; step
  add/toggle survives reload + syncs cross-client like the dod pattern); update
  specs that navigated to Inbox.
- **Gate:** turbo suite + tasks.spec + touched specs.

### W5 — Projects hub
- `Projects.tsx`: hash-tab host + **shared scope picker** (project for Kanban filter
  + Gantt `projectId`; diagram for Flowchart `diagramId`; "All projects" default).
- Re-skin all four tabs to mock structure (board columns w/ `setDates` drop; Gantt
  critical-path legend; Flowchart node-type colors; Decisions matrix + add-criterion
  row). All four keep their existing computed layouts — styling only.
- **Gate:** turbo suite + updated kanban/gantt/flowchart/decisions specs
  (`s18`/`s19`/`m9`/`m10` as applicable).

### W6 — Agenda + Journal
- `Agenda.tsx`: 3-panel re-skin (DayJournal panel · week grid with block-type
  colors · to-schedule panel = unscheduled items). Keep existing interactions.
- New `Journal.tsx`: month list (lazy month subscribe on expand — manager exists),
  day editor (`RichJournalEditor`), per-day `.md` download + archive download.
  No "loads on open" label (mock feedback).
- **Gate:** turbo suite + `journal.spec.ts` (updated for the standalone view) +
  agenda assertions in `v14.spec.ts`/`m13.spec.ts`.

### W7 — Automations, Review, Dashboard, Habits, Settings
- `Automations.tsx` hub (Rules/Blockers tabs; toggle + flow pills + live impact
  line from `evaluateBlockerRules`).
- Review: severity filter pills; Dashboard: burndown/projection/priorities/
  completion/streaks cards; Habits: habit + skill cards with rings/streaks
  (level chip per D9 verify); Settings: General / Data & portability / Account tabs.
- **Gate:** turbo suite + `s20`/`m13`/`v14` updates + settings/review assertions.

### W8 — Polish, sweep, merge
- Keyboard + focus-visible pass, `prefers-reduced-motion` (pattern exists),
  min-width behavior, empty/skeleton states on light theme, purge dead `px-*` rules,
  desktop (Tauri) smoke: shell renders, notifications + sign-out intact.
- Docs: ARCHITECTURE §12 UI note + SELF_HOSTING upgrade note (0010).
- **Gate:** full turbo suite + core coverage + FULL Playwright suite vs live stack;
  PR `web-redesign → main`, CI green, merge.

---

## Risks & mitigations
- **57 label-coupled e2e navigations** → W1 nav helper before any rename lands.
- **Dark→light regressions** (hardcoded rgba/hex tuned for dark) → W0 is
  values-only + full visual pass; anything structural waits for its session.
- **Global clock-out modal** (D7) is behavior-moving, not just style → covered by
  the W2 timer spec from a non-worklist screen.
- **Suggestion wiring** assumed from core scheduler types → verified first thing W2;
  fallback: rail renders suggestions read-only, accept/reject deferred to Agenda.
- **task_steps double-write hazards** (two devices adding steps offline) → ids are
  client-minted per row (no arbiter needed — steps are independent rows; no
  journal-style D5 ack problem).
- **Known flakes:** turbo vitest fork-worker timeout → rerun package in isolation;
  Playwright parallel flake → rerun failures at low concurrency (house notes).

## Rough effort
9 sessions (W0–W8), same cadence as J0–J7. W1 and W2 are the heavy ones (shell +
e2e conversion; My Day + new reads). W3 is the only backend session.
