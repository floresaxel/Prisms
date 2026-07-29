# Mobile "Today" — Implementation Plan (T0–T7)

**Goal:** ship the sketch-derived Today interface (`docs/mockups/mobile-today-sketch.html`,
commits 669ab77 → 1f9df38 → 29753b7 → f960b08 on `feat/landing-page`) as the real home screen of
`apps/mobile`, replacing the current Worklist tab. The mockup is the visual/interaction
source of truth; this plan maps every element of it onto the **existing** Prisms data
layer — hooks, commands, tables — so the mobile work is a presentation layer with
**zero backend changes and zero migrations**.

**Scope:** `apps/mobile` + small *shared* additions to `packages/ui` (one pure selector +
one composing hook + one lifted util, all unit-testable). Web/desktop untouched. The
`task_steps`, `journal_entries`, decision-board and scheduler machinery shipped by the
web redesign (W0–W8) and the journal feature (J0–J7) is reused as-is.

**Branch:** `feat/mobile-today` off `main`. One commit per session (house rule).
**Gate per session:** `pnpm turbo lint typecheck test` (all packages) + the unit tests
named in the session + the session's manual Expo checklist (mobile has **no e2e
harness** — verification is `expo run:android` on this machine + the manual checks
listed per session; cross-client sync spot-checks use the web e2e stack recipe from
[dev-stack notes] when a session touches commands).

---

## 1 · Current-state inventory (verified 2026-07-20)

| Area | Fact |
|---|---|
| Stack | Expo ^53, React Native 0.79, React 19, `@react-navigation/bottom-tabs` v7, `react-native-safe-area-context`, `expo-notifications`, PowerSync RN SDK (`@powersync/react-native` + quick-sqlite) |
| Gesture/animation | **No** reanimated, **no** gesture-handler, **no** linear-gradient — only built-in `Animated` + `PanResponder` are available today |
| Shell | `App.tsx`: bottom tab navigator (Worklist · Agenda · Kanban · Habits · Graph · Dashboard · Review), `navTheme` derived from **`DarkTheme`**, rejection banner, push registration |
| Design system | `src/ui.tsx` — **dark tokens** (`bg #0f1115`, `accent #5b8cff`…) + primitives `Screen/H1/H2/Txt/Muted/Card/Row/Badge/Btn/Field/Meter/Skeleton`. All screens consume `theme.*`, so a token-value flip re-themes the whole app (the exact trick web W0 used) |
| Journal | `screens/JournalDay.tsx` already edits a day note via `useJournalDay(date)` + `applyMarkdownEdit` toolbar helper + `react-native-markdown-display` preview; reached from Agenda |
| Tests | `vitest run` per package; pure logic lives in `packages/ui`/`packages/core` tests. RN components are not rendered in tests — **logic must live in hooks/selectors** |
| Shared reads already available | `useAgenda(now)` → `{ input(SchedulerInput incl. windows), tasksById, blocks: AgendaBlock[], entries: AgendaEntry[], todo }`; `useMyDayAvailable(now)` → priority-sorted `MyDayItem[]` (project + decision-board priority); `useRunningTimer(now)` → `{ entry, task, elapsedMs }`; `useDayTimeLeft`, `useTimeBlocksForDay` (check-off block picker), `useDoneToday`, `useTaskSteps/ByTask`, `useJournalDay`, `useUserSettings` (`dayResetHour` default 4, `timezone`), `useBlockTags(blockId)`, `useTagCatalog`, `useIsHydrated` |
| Shared commands already available | `clockIn/clockOut/review` (focus factor), `checkOff/uncheck` (disposition + `completedInBlockId`), `createActivity/promoteActivity/createTask/rename/softDelete/setDates`, `createBlock/moveBlock/setBlockAnchor/deleteBlock`, `acceptSuggestion/rejectSuggestion`, `writeJournal/deleteJournal`, `addStep/renameStep/toggleStep/reorderStep/removeStep`, `createEdge/deleteEdge`, `createTag/placeTag/unplaceTag`, `checkOffHabit`, `resolveReviewItem/dismissReviewItem` |
| Scheduler windows | `DEFAULT_WINDOWS = [{ id:'day', 08:00–20:00 }]` in `packages/core/src/scheduler/windows.ts`; `expandWindows(windows, timezone, horizon)` materialises them per local day. `Agenda.input` carries the account's windows |
| AgendaBlock shape | `{ id, taskId, title, startsAt, endsAt, status:'committed'\|'suggested', anchored, justified, suggestionReason, superseded, provenance }` — everything the itinerary + day map need |

## 2 · The function map — every mockup element → platform structure

This is the contract of the whole plan. "Screen" = the shipped Today screen.

| # | Mockup element | Data source (read) | Mutation (command) | Notes |
|---|---|---|---|---|
| 1 | **"Today" header + date** | `useUserSettings()` timezone + `bucketDate(now, dayResetHour, tz)` | — | the "day" respects day-reset, not civil midnight |
| 2 | **Itinerary rows** (7:00 Long Run…) | new `useTodayItinerary(now)` = today's committed `Agenda.blocks` bucketed via `bucketDate`, joined with `Agenda.entries` (logged time), `useRunningTimer` (live), task status (done) | — | one row per block; sorted by `startsAt`; includes anchored + habit-justified blocks |
| 3 | Row **time** `7:00` | `AgendaBlock.startsAt` formatted in account tz | — | |
| 4 | Row **title** (strike when done) | `AgendaBlock.title`; done = task status `done` (StatusIndex via worklist absence + `useDoneToday`) | — | |
| 5 | Row **category chips** (HEALTH / WELLNESS / SKILL / HABIT) | `useBlockTags(block.id)` (placed tags), plus computed `HABIT` chip when the task has `habit_id` | `placeTag/unplaceTag` (edit later, read-only in T1) | **T1 verify:** tags placed on blocks are the shipped read; if a task-level tag read is wanted later it's a new hook, not schema |
| 6 | Row **duration** — `· 1hr 30min` (done) vs `45 min est.` | done: summed `AgendaEntry` minutes for the task today; upcoming: `estimate_minutes` from `Agenda.tasksById` (fallback: block length) | — | mirrors mock copy exactly |
| 7 | **Uniform 14px dot markers**, colour by project | parent project via `ancestorsOf(tree)` → shared `projectTone(projectId)` (lift the web util from `apps/web/src/format.ts` into `@prisms/ui`) | — | no project → grey |
| 8 | **Done marker** (blue ✓ dot; tap = un/redo) | task status | `checkOff({ disposition:'completed', completedInBlockId: block.id })` / `uncheck(taskId)` | scheduled tasks auto-attribute to their block (same rule the web My Day uses) |
| 9 | **Live marker** (pulsing dot) | `useRunningTimer(now)` — running when `entry.task_id === block.taskId` | — | pulse = `Animated.loop` opacity + ring; disabled under reduce-motion (D8) |
| 10 | Row **elapsed ticking** `1hr 37min` | `RunningTimer.elapsedMs`, 1 s tick | — | only the live row re-renders on the second tick (memo the rest) |
| 11 | **••• row menu** | block + task state decide the items | `clockIn(taskId, blockId)` · `clockOut(entryId)` → **focus-review sheet** (`review({entryId, focusFactor, completedSession, taskId})`, I5 parity with web GlobalTimer) · `moveBlock` · `setBlockAnchor` · `deleteBlock` (unschedule) · "why?" = `explainProvenance(block.provenance)` | clock-in disabled while a timer runs (I5) |
| 12 | **24 h day-map bar** (right edge) | new **pure** `buildDayMap(...)` fed by `useTodayItinerary` + `expandWindows(agenda.input.windows, tz, today)` + `useRunningTimer` | — | segments carry `{topPct, heightPct, tone, state}` on a fixed 0–24 h scale |
| 13 | Bar **greyed non-active hours** | complement of today's expanded scheduler windows (default 08–20; the mock's 6–22 is sample data) | — | **no new setting, no migration** — active hours *are* the scheduling windows (D4) |
| 14 | Bar **red now-line** (moves) | `now` → minutes-of-day in account tz | — | recomputed with the 1 s tick, repositioned each minute |
| 15 | Bar **pulsing live segment** | segment `state === 'live'` | — | same Animated loop as #9 |
| 16 | **Drag bar left → expanded day calendar** | same `DayMap` + block labels; suggested blocks include accept/reject | `acceptSuggestion(blockId)` / `rejectSuggestion(blockId)` | `PanResponder` horizontal drag, snap at 55 %, tap toggles, scrim tap / drag-right / Android back closes |
| 17 | Expanded-calendar **block styles** (done filled+struck · live amber outline + ticking · upcoming tinted · anchored 🔒) | `DayMapSegment.state` (+ `anchored`) | — | identical state machine to the mini bar — one selector feeds both |
| 18 | **"All Tasks ▾"** foldable list | `useMyDayAvailable(now).filter(i => !i.scheduled)` — actionable, unscheduled, **priority-ordered by the decision board** | fold = local state | blocked tasks are *not* shown here (worklist semantics); count badge possible later |
| 19 | All-Tasks **check circles** | — | `checkOff` with block picker for unscheduled tasks (`useTimeBlocksForDay` — the existing Worklist flow, kept) | |
| 20 | **＋ → New Task sheet** | — | see §3 mapping | slides to just under the 4th row; measured from rendered rows like the mock |
| 21 | New Task **title** | — | part of create payload | autofocus, caret accent-coloured |
| 22 | **Project chip** (dashed→set) | `usePromoteTargets()` (projects + milestones) | with project → `createTask({ title, parentId, estimateMinutes?, dueDate? })`; without → `createActivity(title)` → lands in Inbox (Base-camp semantics: no "why", not in worklist until promoted — I3 kept visible) | chip opens a picker list |
| 23 | **Habit chip** | `useHabits()` list | habit-justified task = `createActivity(title)` then `promoteActivity(id, { habitId })` — **both shipped commands** (verified: `createTask` has no `habitId`, but promote accepts one) | I3's habit justification path, two commands in sequence |
| 24 | **Duration chip** (tap cycles 15 m→2 h) | — | `estimateMinutes` on `createTask` (verified in payload); for the activity path, set after promote | |
| 25 | **Due Date chip** | — | follow-up `setDates(taskId, …)` after create (**verified: `createTask` carries no due date**) | native date picker later; T5 ships preset chips (today/tomorrow/next week) |
| 26 | **Predecessor chip** | task picker over `useWorklist`/`useTasksByProject` | `createEdge({ fromTaskId, toTaskId })` after create | cycle rejection already enforced by invariants → rejection banner surfaces it |
| 27 | **↵ files the task** | — | command above; new row appears in All Tasks reactively (no optimistic hand-wiring — the overlay store already does it) | sheet closes on success |
| 28 | **Journal button → Day-note sheet** | `useJournalDay(todayDate)` | `writeJournal({ id, entryDate, content })` — debounced ~800 ms while typing + flush on close/blur (J-feature precedent) | plain multiline `TextInput`, markdown stays markdown; ruled-paper styling is cosmetic; concurrent-edit conflicts already surface in Review (J D2) |
| 29 | Sheet **"saved" dot** | pending-upload state (`client_commands` pending count or last write ack) | — | green when flushed, amber while dirty |
| 30 | **Sheets slide under row N** | measured from the rendered rows (`onLayout`), like the mock measures rects | — | note sheet under row 1; task sheet under row 4 (or last visible row when fewer) |
| 31 | **Top/bottom gradients** (timeline fades, sheet fade) | — | — | `expo-linear-gradient` (the one new dependency, D8) |
| 32 | **Empty / loading states** | `useIsHydrated()` → `Skeleton`; no blocks → "nothing scheduled — pull from All Tasks" | — | parity with §7.15 loading rules |

## 3 · Design decisions (normative — do not re-litigate mid-build)

**D1 — Light-theme token flip first, exactly like web W0.** `src/ui.tsx`'s `theme`
values flip to the web light palette (`bg #f6f7f9`, `surface #fff`, `surface2 #f2f4f7`,
`border #e6e8ec`, `text #18202b`, `dim #5f6b7a`, `accent #2563eb`, `danger #dc2626`,
`ok #16a34a`) **plus** new semantic keys the Today screen needs
(`live #d97706`, `liveSoft #fdf1dd`, `faint #98a1ae`, `redBg/greyBg` tints). `navTheme`
rebases on react-navigation's `DefaultTheme`. Every existing screen re-themes in one
session with zero markup churn; screens are then touched only by their own sessions.
Design rules stand: light + clean, **no purple/pink gradients**.

**D2 — Today replaces Worklist as the home tab.** The tab order becomes
**Today · Agenda · Kanban · Habits · Graph · Dashboard · Review**. `Worklist.tsx` is
retired **only at T7**, after every flow it owns (clock-in/out, focus-review sheet,
check-off with block picker, force clock-in) has a home in Today. Until then both tabs
coexist behind a temporary extra tab so nothing regresses mid-branch.

**D3 — `buildDayMap` is a shared pure function in `packages/ui`** (exported, no React),
unit-tested against fixed fixtures. Signature:

```ts
export interface DayMapSegment {
  blockId: string; taskId: string; title: string;
  startMin: number; endMin: number;          // minutes-of-day, account tz
  topPct: number; heightPct: number;         // on the fixed 0–1440 scale
  tone: string;                              // projectTone token key, 'grey' fallback
  state: 'done' | 'live' | 'upcoming' | 'suggested';
  anchored: boolean;
}
export interface DayMap {
  segments: DayMapSegment[];
  inactive: { topPct: number; heightPct: number }[];  // outside scheduler windows
  nowPct: number | null;                              // null when now ∉ today
}
export function buildDayMap(args: {
  blocks: readonly AgendaBlock[];            // already bucketed to today
  loggedMinutesByTask: ReadonlyMap<string, number>;
  windows: readonly ConcreteWindow[];        // expandWindows(...) for today
  runningTaskId: string | null;
  doneTaskIds: ReadonlySet<string>;
  now: Instant; timezone: string; dayResetHour: number;
}): DayMap
```

The mini bar and the expanded calendar render the **same** `DayMap` at two scales —
one state machine, one test suite. (Deliberate wearables synergy: the
`/api/wrist/snapshot` in `Blueprints/WEARABLES_PLAN.md` can serialise this later.)

**D4 — "Active hours" = the scheduler windows. No new setting.** The greyed zones are
the complement of `expandWindows(agenda.input.windows, tz, today)`. Default account =
08:00–20:00 (`DEFAULT_WINDOWS`); the mock's 6:00–22:00 was sample data. When windows
become user-editable someday, the bar follows for free.

**D5 — New Task = the existing create commands, honestly split.** Project chosen →
`createTask({ parentId, title, sortOrder, estimateMinutes? })` (justified, enters the
worklist). Habit chosen → `createActivity` + `promoteActivity(id, { habitId })` (the
shipped habit-justification path). Neither → `createActivity` alone (Inbox capture;
promotable later) — the sheet copy makes that visible ("no project → waits in Inbox").
Due date = follow-up `setDates`; predecessor = follow-up `createEdge` (invariant
rejections surface via the existing banner). Nothing bypasses I1/I3.

**D6 — Day-note sheet is the journal, not a new store.** `useJournalDay` +
`writeJournal`, debounce ~800 ms, flush on sheet close/blur/background. Content is
CommonMark text (same field TipTap edits on web). The existing `JournalDay` screen
stays (Agenda path + toolbar/preview); the sheet is a faster door to the same row.

**D7 — Colour = parent project, chips = placed tags.** `projectTone` moves from
`apps/web/src/format.ts` into `packages/ui` (single source; web re-imports). Category
chips read `useBlockTags(block.id)`; a synthetic `HABIT` chip renders when the task is
habit-justified. No tag editing in this plan (read-only chips).

**D8 — Dependencies: exactly one new package.** `expo-linear-gradient` for the fades.
Gestures use built-in `PanResponder`; animation uses built-in `Animated` with
`useNativeDriver: true`. `AccessibilityInfo.isReduceMotionEnabled()` disables the
pulse loops and swaps slide animations for fades.

**D9 — Clock-out keeps the focus review (I5 parity).** Clocking out from any Today
surface opens the focus-factor sheet (×0.5–1.0 + "completed?") and submits via
`review(...)` — ported from `Worklist.tsx`, not re-invented. Clock-in stays disabled
everywhere while a timer runs.

**D10 — Explicitly out of scope:** editing tags from chips; drag-rescheduling blocks
from the itinerary; the week view; a real date-picker (preset chips first);
"Gym/Wellness" sample taxonomy as a feature (chips render whatever tags exist); any
backend/schema change (none is needed).

## 4 · Sessions

### T0 — Light theme + Today-screen primitives (no behaviour change)
- `src/ui.tsx`: token flip per D1 (+ new `live/liveSoft/faint/greyBg/redBg` keys);
  `navTheme` → light; `expo-status-bar` style to `dark`.
- New `src/components/` primitives (presentational only): `Dot` (14 px, tone +
  `pulse` prop), `ChipPill` (bordered category chip), `FadeEdge`
  (expo-linear-gradient wrapper, top/bottom), `SheetBase` (absolute Animated sheet:
  measured `top`, grab bar, catcher, Android back handling, drag-down-close),
  `SectionFold` (chevron header).
- Add `expo-linear-gradient`; lift `projectTone` to `packages/ui` (web re-imports —
  touch `apps/web/src/format.ts` import only).
- **Gate:** turbo green; web unaffected (`@prisms/web` typecheck/test); manual: every
  existing mobile tab renders light, no dark remnants, notifications banner legible.

### T1 — `useTodayItinerary` + the itinerary list
- `packages/ui/src/hooks.ts`: `useTodayItinerary(now)` composing `useAgenda` (today's
  committed blocks), `useDoneToday`, `useRunningTimer`, logged minutes from
  `Agenda.entries`, tones via tree ancestry. Pure helpers unit-tested
  (`packages/ui/test/today-itinerary.test.ts`): bucketing across day-reset, done/live
  precedence, logged-minutes fallback to estimate.
- New `src/screens/Today.tsx`: header (#1), rows (#2–#10) with `FlatList`; the 1 s
  tick isolated to a `LiveElapsed` component so rows don't re-render.
- ••• menu (#11) as an action sheet (RN `ActionSheetIOS` / custom sheet on Android)
  wiring `clockIn/clockOut(+review sheet, D9)/moveBlock/setBlockAnchor/deleteBlock` +
  "why?" provenance alert.
- Temporary nav: Today added as first tab; Worklist kept (D2).
- **Gate:** turbo + new unit tests; manual: rows match Agenda for the same day,
  check-off round-trips (uncheck restores), clock-in/out + focus review work, elapsed
  ticks only on the live row.

### T2 — `buildDayMap` + the 24 h bar
- `packages/ui/src/day-map.ts`: `buildDayMap` per D3 + tests
  (`day-map.test.ts`): window complement (default 08–20 → two grey zones), segment
  percentages, live/done/suggested precedence, now-line across day-reset, empty day.
- `src/components/DayMapBar.tsx`: 14 px lane absolutely positioned right of the
  content (both itinerary and All-Tasks sections keep clear of it), hour ticks every
  3 h, segments, pulsing live segment, red now-line repositioned each minute.
- **Gate:** turbo + day-map tests; manual: bar mirrors the itinerary 1:1, grey zones
  match account windows, now-line agrees with the wall clock.

### T3 — Swipe-out day calendar
- `src/components/DayPanel.tsx`: hour grid 0–24 (labels every 3 h), grey window
  complement, labelled blocks from the same `DayMap` (#17), now-line + time label,
  accept/reject on suggested blocks (#16).
- Gesture: `PanResponder` on the bar and the open panel; `Animated.translateX` with
  native driver; snap threshold 55 %; tap toggles; scrim + Android back close.
- **Gate:** turbo; manual: drag follows the finger both directions, snap feels right,
  accept turns a dashed block solid (and the Agenda tab agrees), reject removes it,
  reduce-motion swaps slide for fade.
 
### T4 — All Tasks section
- Today screen lower section (#18–#19): `SectionFold` + priority-ordered unscheduled
  list from `useMyDayAvailable`, check circles with the block-picker flow, list
  scrolling under the bottom `FadeEdge`, count in the header.
- **Gate:** turbo; manual: order matches web My Day for the same account (decision
  board drives both), fold state survives tab switches, check-off attributes to the
  picked block.

### T5 — New Task sheet
- `src/components/NewTaskSheet.tsx` on `SheetBase` (#20–#27): title field, Project
  picker chip (`usePromoteTargets`), Habit picker chip (`useHabits`), Duration cycle
  chip, Due-date preset chips, Predecessor picker chip.
- Submit wiring per D5 (three paths: createTask / createActivity+promote-to-habit /
  createActivity alone, then setDates/createEdge follow-ups); rejection banner covers
  invariant failures (cycle edges, bad parents).
- **Gate:** turbo; manual: no-project capture appears in Inbox (web Tasks screen
  confirms cross-client), project task appears in All Tasks in priority position,
  predecessor edge visible in web Graph, duration/due round-trip.

### T6 — Day-note sheet
- `src/components/DayNoteSheet.tsx` on `SheetBase` (#28–#29): ruled-paper styled
  multiline `TextInput` bound to `useJournalDay(today)`, debounced `writeJournal`
  (~800 ms) + flush on close/blur/AppState-background, dirty/saved dot, placeholder.
- **Gate:** turbo; manual: note round-trips with web journal (type on phone, see it
  in web Journal screen and vice-versa; conflict path lands in Review), keyboard
  avoidance correct on Android.

### T7 — Consolidation, a11y, retirement, docs
- Retire `Worklist.tsx` (D2): remove the tab, delete the screen after confirming
  every testID-equivalent flow exists in Today; final tab order per D2.
- A11y pass: `accessibilityLabel`/`Role` on markers, chips, bar ("Day map, 5 events,
  drag left to expand"), sheets (`accessibilityViewIsModal`); reduce-motion audit.
- Empty/loading states (#32); Android hardware-back closes any open sheet/panel
  before navigating; keyboard insets on both sheets.
- Docs: ARCHITECTURE §12.1 note (Today = mobile home; day-map bar; sheets); memory
  file updated.
- **Gate:** full turbo + all new unit suites + complete manual checklist re-run +
  cross-client day: phone-created task scheduled on web appears in phone itinerary,
  web-running timer pulses on phone within sync latency. PR `feat/mobile-today → main`.

## 5 · Testing strategy

- **Pure logic (unit, CI-enforced):** `buildDayMap`, `useTodayItinerary`'s helpers,
  duration formatting — `packages/ui/test/*.test.ts`, no RN imports, deterministic
  fixtures across day-reset/timezone edges (reuse the tz fixtures from the journal
  tests).
- **Reactive reads:** already covered by the shared read-layer tests; new hooks only
  compose existing subscribed tables (no new subscriptions → no §7.14 regression).
- **Commands:** none are new; cross-client manual checks per session lean on the
  compose stack (`wsl docker compose up -d --wait`, web on :5173) exactly as the
  web e2e recipe documents.
- **What is *not* automated:** RN rendering/gestures (no Detox/Maestro in the repo —
  adding one is out of scope here; the manual checklists are the compensating
  control, kept short and per-session).

## 6 · Risks & mitigations

- **PanResponder vs FlatList scroll conflicts** (bar drag steals vertical scroll):
  claim the responder only on `|dx| > |dy|` and start the capture on the bar's hit
  slop; verified in T3's manual checklist.
- **1 s tick re-renders:** isolate elapsed/now-line into leaf components fed by a
  single interval context; T1/T2 gates include a "rows don't re-render" check via
  React DevTools highlight.
- **Tag chips read:** `useBlockTags` is per-block; if profiling shows N queries, add
  a `useBlockTagsByBlock()` map hook in `packages/ui` (pattern already exists:
  `useTaskStepsByTask`). Decision deferred to T1 with the profile in hand.
- **`createTask` payload gaps (habitId/dueDate):** T5 opens by reading the payload
  schema; anything missing ships as a disabled chip + note rather than a schema
  change (D10). No silent scope creep into the dispatcher.
- **OneDrive + Expo native build quirks on this machine:** `expo run:android` was
  chosen over dev-client; if the build fights OneDrive paths, move the *build* out
  via `EAS local` or the WSL clone — plan work, not app code, and it does not block
  T0–T2 (Metro + typecheck suffice for token/logic sessions).
- **Concurrent journal edits (phone sheet + web TipTap):** whole-content LWW with the
  loser preserved in Review — already the J-feature contract; the sheet adds no new
  merge surface.

## 7 · Deliberately created follow-ups (not in this plan)

Week strip on the day panel (swipe between days) · tag editing from chips ·
drag-to-reschedule from the itinerary · a proper date picker · Detox/Maestro harness ·
wearables reuse of `buildDayMap` (tracked in `Blueprints/WEARABLES_PLAN.md`).
