# Prisms - Session-Sized Build Plan, Revised

Version 1.4. Companion to `ARCHITECTURE_1.3.md` (architecture amendments for 1.4 are inlined under "Architecture Amendments (Normative)"). This file extends the 24-session v1.3 build (S0-S23, complete) with three read-path sessions — `S24`, `S25`, `S26` — that fix the client read/view-lifecycle defect v1.3 left unaddressed. Sessions are dependency-ordered. Never start a session whose dependencies have not passed their Definition of Done.

Version 1.4 adds the **persistent client read layer** and **loading-aware reads** (fixes A and C from the read-path diagnosis). New or changed steps and DoD lines are marked **[1.4]**.

## Why 1.4 Exists

The v1.3 work delivered the write/convergence contracts (command bridge, optimistic local writes, sync-back rollback). It did **not** touch the client *read path*. A diagnosis of the shipped web app found that switching tabs reloads data and shows a visible lag/flash on every navigation. The three confirmed root causes are all read-path / view-lifecycle, not write-path:

1. **Screens hard-unmount on every tab switch.** `apps/web/src/App.tsx` (L112-125) renders the active screen by indexing an inline JSX object literal with `[route]`; `navigate()` (L63-66) does `pushState` + `setRoute`, tearing down the previous screen's entire subtree and every hook it owns.
2. **The shared hook wrapper discards loading state, and base reads fan out.** `@powersync/react`'s `useQuery` already returns `{ data, isLoading, isFetching, error }` — the discard is the **one-line `@prisms/ui` wrapper** `useRows = (sql) => useQuery(sql).data ?? []` (`packages/ui/src/hooks.ts` L89), which is why a freshly mounted screen renders its **empty** branch until the async query resolves. Fix C is therefore a `@prisms/ui`-only change: patch `useRows`, not the underlying primitive. Separately, `useFactContext` (L98-124) issues **9** `SELECT *` watched subscriptions, and several other hooks re-subscribe to the same base tables on top of it (see the Table→Owner Matrix), so a single screen mount can open 12+ subscriptions.
3. **Per-component `WatchedQuery`, closed on unmount, no cross-mount cache.** `useQuery` builds a fresh `WatchedQuery` in `useState` via `customQuery().watch()` and `close()`s it on unmount (`useWatchedQuery.js` L13-39); initial state is `{ isLoading: true, data: [] }` (`useQuery.js` L42). Results are not shared across mounts. The `PowerSyncDatabase` instance (held in a ref at `App.tsx` L44-45) survives, but the **subscriptions do not**.

**The v1.3 two-layer store does not fix this** — it is a write-path/convergence redesign, and the bug is read-path. v1.4 fixes it directly with two changes that work together:

- **Fix A — Persistent client read layer.** Hoist the broadly-shared subscriptions and the heavy fact/tree derivation into a single provider mounted **above** the router, so they are created once per session and survive navigation. A tab switch then reads warm in-memory state instead of cold re-subscribing.
- **Fix C — Loading-aware, stale-while-revalidate reads.** Surface `isLoading`/`isFetching` through the read layer and retain last-known rows across refetch **and remount**, so a (re)mount or in-flight query renders a skeleton or prior data, never the empty/zero branch.

A neutralizes the *cost* of the remount (shared data is warm and resident); C removes the residual first-load/refetch/remount flash. Together they close the defect without keeping screens mounted (see "Deliberately Out of Scope").

### As-Built Facts This Plan Is Grounded In

The shipped code differs from the v1.3 spec; 1.4 layers onto reality, not the spec ideal. All facts below are verified against the repo:

- There is **no** two-layer overlay (`client_commands`/`overlay_effects`) and **no** `mergeRow`/`mergeTable` in the read path. Optimistic writes mutate replica tables directly via PowerSync's native local SQLite write (`packages/ui/src/powersync/commands.ts`); upload translation is `crud-to-command.ts`; rollback is "the unchanged row syncs back down." **Fix A must not change the db handle or wrap `db.execute`** — see S24 / Session Protocol rule 5.
- There is **no** incremental `StatusIndex`; status is recomputed live in selectors. Fix A hoists the **`FactContext` derivation** (`buildFactContext`/`buildTreeIndex`), not a `StatusIndex`. If §7.12's `StatusIndex` is added later it must be instantiated inside the same provider (§7.14).
- `useQuery` is **not** gated by sync: the app passes **no `streams` option** anywhere, so `useAllSyncStreamsHaveSynced(db, undefined)` returns `true` unconditionally (`streams.js` L58-59) and `useQuery` resolves against **local SQLite immediately**, skipping its `_loadingState` early return. On a fresh login the replica is empty *before* first sync, so the query emits `{ data: [], isLoading: false }`. This is why `isHydrated` must be grounded on `useStatus().hasSynced`, not on "resolved once" (§7.14, must-handle in S24/S25).
- `zustand` is already a web dependency, used for ephemeral UI state in `Habits`, `Rules`, `Blockers`. The persistent read store may use it or React context; it must not be confused with the ephemeral-UI usage.
- The CI gate is `pnpm turbo lint typecheck test` + `@prisms/core test:coverage` (≥90%) + 12 web Playwright e2e cases across `apps/web/e2e/dod.spec.ts` + `s16..s20.spec.ts`. There is **no `test:perf` script**; the only 100k asset is a pure-core vitest (`packages/core/.../load.perf.test.ts`) with no DOM/router/PowerSync. v1.4 must add its own harness (S24 step 1) rather than reference a perf script that does not exist.

## Table → Owner Matrix (normative)

Every `appSchema` table is either **provider-shared** (one session-scoped subscription, never created inside a screen) or **screen-local** (subscribed by the owning screen, but served through the SWR cache of §7.15 so it does not flash on remount). Session-Protocol rule 2 is checked against this matrix.

| Table(s) | Owner | Primary consumers |
| --- | --- | --- |
| `nodes` (subscribed unfiltered; provider derives the `deleted_at IS NULL` view for the tree **and** exposes raw rows for Dashboard's soft-delete-inclusive burndown) | **provider** | every screen, `FactContext`, `useNodeTree` |
| `edges` | **provider** | Agenda, Flowchart, Gantt, `FactContext` |
| `time_entries` | **provider** | Worklist, running timer, Habits, Agenda |
| `schedule_blocks` (subscribed unfiltered; provider derives the `committed` view in memory) | **provider** | Worklist, Agenda, Habits, Dashboard, time-block picker |
| `sprints`, `sprint_memberships` | **provider** | Agenda, `FactContext` |
| `blocker_rules` | **provider** | Blockers editor, status (`FactContext`) |
| `external_facts` | **provider** | weather/status (`FactContext`) |
| `user_settings` | **provider** | Settings, `useUserSettings`, `FactContext` |
| `decision_boards`, `decision_criteria`, `decision_scores` | screen-local | DecisionBoard |
| `diagram_layouts`, `diagram_groups` | screen-local | Flowchart |
| `automation_rules` | screen-local | Rules |
| `habits`, `habit_completions` | screen-local | Habits |
| `tags`, `tag_placements`, `tag_answers` | screen-local | Habits (tags), block tags |
| `computed_aggregates` | screen-local | Dashboard, Habits (freshness) |

Provider-shared subscription count after consolidation = **9** (one per shared table; `committed` blocks and the soft-delete-inclusive task view are derived in memory, not as extra subscriptions). This exact count, invariant across navigation, is the S24 DoD target.

## Changes From The 1.3 Build Plan

| Area | Affected sessions | Change |
| --- | --- | --- |
| Persistent client read layer | S24, (amends S15) | Hoist the **full provider-shared subscription surface** (the 9 base tables + derived `TreeIndex`/`FactContext`) into one provider above the router; route every shared-table consumer to the warm sets. Navigation creates no base subscription. |
| Loading-aware reads | S25, (amends S15) | `useRows` exposes `isLoading`/`isFetching` and is backed by a provider/module-scoped last-known cache so reads survive refetch **and remount** (stale-while-revalidate). Skeleton on genuine first load; empty branch only when confirmed empty. |
| First-sync correctness | S24, S25 | `isHydrated` is grounded on `useStatus().hasSynced`, not "resolved once," so a fresh login shows a skeleton (not the empty branch) while the empty local replica is still syncing; a populated OPFS replica renders offline without a stuck skeleton. |
| Test harness | S24 step 1 | Stand up an RTL+jsdom harness for `@prisms/ui` hooks + a PowerSync mock that counts `customQuery().watch()` calls and wraps `buildFactContext`/`buildTreeIndex` with call counters. Prerequisite for every count-based DoD below. |
| Recompute hygiene (minor) | S24, S25 | Single-ownership cleanup of `commandContext` (already `[user.id]`-stable); confirm the 1s `now` tick does not rebuild the fact/tree index (already true; structurally guaranteed once hoisted). |
| Read-path verification gates | S26 | Playwright no-flash / warm-revisit assertions; provider-held subscription + build call-counters invariant across navigations; selector-timing budget stays in the core 100k vitest. |

## Architecture Amendments (Normative)

These are the contracts S24-S26 implement. They extend `ARCHITECTURE_1.3.md`; where they refine an existing section the existing rule holds unless contradicted.

### §7.14 Persistent client read layer (amends §7.3, §7.12; Fix A)

- Provider-shared client reads (the 9 base tables of the Table→Owner Matrix) and their derived `TreeIndex`/`FactContext` must be subscribed and derived **once per authenticated session**, in a provider mounted **above** the view router, and shared by reference to all screens.
- Navigating between screens must not create, close, or re-run these subscriptions or rebuild the tree/fact index. Their lifetime is the session (the authenticated `PowerSyncDatabase` connection), not any screen.
- The provider exposes, at minimum: the derived `FactContext`; the raw shared row collections and `TreeIndex`; a stable `commandContext`; an `isFetching` flag; and an `isHydrated` flag defined as: **`(first base result has been produced) AND (PowerSync first sync is complete this session — `useStatus().hasSynced` — OR a base row already exists / was persisted this session)`.** The `hasSynced` conjunct prevents the empty-local-replica-before-first-sync flash; the "row already exists" disjunct prevents a stuck skeleton on an offline reload of a populated OPFS replica.
- The provider must **not** change the db identity used by writers or wrap `db.execute`; `createCommands` continues to bind to the live `usePowerSync()` db so the `uploadData` → `crudToCommand` translation and rejection rollback are unchanged.
- If a §7.12 `StatusIndex` is later built it is a single session-scoped member of this provider, never instantiated per screen.

### §7.15 Loading-aware, stale-while-revalidate reads (amends §12.2; Fix C)

- The reactive read primitive must expose `{ data, isLoading, isFetching }`; consumers must not collapse "loading" into "empty." The `data ?? []` pattern (rendering empty during the initial fetch) is prohibited for any user-visible list/section/`<select>` placeholder.
- Reads are stale-while-revalidate across both refetch and **remount**. Because the view router hard-unmounts screens, last-known rows must live where they survive an unmount: **provider-level** for shared base tables (warm after Fix A), and a **module/session-scoped cache keyed by query text + params** for screen-local reads, seeded synchronously on mount so a remounted screen-local list returns its prior rows on first paint.
- A view with no data yet (`isHydrated === false`) renders a loading/skeleton branch. The empty-state branch (including misleading `<select>` placeholders such as "Create a vision first") is reserved for **confirmed** empty (`isHydrated && length === 0`).

### §12.2 amendment — view shell

- The web view shell must not blank a screen's data on navigation. With §7.14, revisiting a tab reads warm context synchronously; with §7.15, any residual in-flight or screen-local read shows stale-or-skeleton, never empty.

## Session Protocol (read-path additions)

Apply to S24-S26 in addition to the v1.3 Session Protocol.

1. No user-visible list, section, or `<select>` placeholder may render its empty-state branch while a backing read is loading. Empty-state requires `isHydrated && length === 0`.
2. No provider-shared table (Table→Owner Matrix) may be subscribed inside a screen component. Only screen-local tables subscribe in a screen, and they read through the §7.15 cache.
3. A change is not done until a tab-switch Playwright check proves no empty-then-fill flash and the provider-held subscription/build counters are invariant on navigation.
4. Preserve all S16-S20 behavioral DoD. v1.4 is a read-path refactor; it must not change command, status, or sync semantics.
5. Do not change the db identity used by writers or wrap/replace `db.execute`. The `crudToCommand` upload path and rejection rollback must stay byte-for-byte behavior-equivalent.

---

## Phase F - Read-Path Convergence (v1.4)

### S24 - Persistent client read layer (Fix A)

**Deps:** S15-S20 (web app shipped)

**Spec:** §7.14, §7.3, §12.2, Table→Owner Matrix; current `apps/web/src/App.tsx`, `packages/ui/src/hooks.ts`

Build:

1. **[1.4]** Test harness (prerequisite for the DoD): stand up an RTL + jsdom harness for `@prisms/ui` hooks, plus a PowerSync mock exposing `customQuery().watch()` so subscription creation can be counted, and call-count spies wrapping `buildFactContext`/`buildTreeIndex`. List the new devDeps (`@testing-library/react`, `jsdom`/`happy-dom` already present for web; add for `@prisms/ui` vitest) and the harness file locations. This harness is reused by S25/S26.
2. **[1.4]** A `PrismsDataProvider` in `packages/ui` (React context + provider) that, given the live `PowerSyncDatabase` from `PowerSyncContext`, subscribes **once** to the 9 provider-shared tables and computes `buildFactContext`/`buildTreeIndex` a single time, memoized on the row sets. `nodes` and `schedule_blocks` are subscribed unfiltered; the provider derives the `deleted_at IS NULL` tree view, the soft-delete-inclusive task view (for Dashboard burndown), and the `committed` blocks view in memory.
3. **[1.4]** Provider context value exposes: `factContext`; the raw shared collections (`nodes` raw + active, all + committed `schedule_blocks`, `time_entries`, `edges`, `sprints`, `sprint_memberships`, `blocker_rules`, `external_facts`, `user_settings`) and the shared `TreeIndex`; a stable `commandContext`; `isFetching`; and `isHydrated` per §7.14 (conjoined with `useStatus().hasSynced`).
4. **[1.4]** Refactor every shared-table consumer to read the warm sets instead of re-subscribing, keeping their per-`now` derivation local: `useFactContext`, `useNodeTree`, `useWorklist`/`useGroupedWorklist`, `useTimeBlocksForDay`, `useRunningTimer`, `useNextBlockMinutes`, `useDayTimeLeft`, `usePromoteTargets`, `useActivityInbox`, `useAgenda`, `useHabits` (its `time_entries`/`schedule_blocks` reads only), `useDashboard` (its `schedule_blocks` + nodes reads), and `useGantt` (its `useFactContext` + `edges`/`schedule_blocks` reads). Standalone `useNodeTree` callers (Dashboard, Habits, Flowchart, Gantt, Inbox via `usePromoteTargets`) now hit the shared tree.
5. **[1.4]** Mount `PrismsDataProvider` in `apps/web/src/App.tsx` **inside** `PowerSyncContext.Provider` but **above** `Layout` and the route switch (L71-126), so it wraps every screen and is not unmounted by `navigate()`.
6. **[1.4]** Single-ownership cleanup: the provider owns the memoized `commandContext` (`ctx` is already `useMemo`'d on `[user.id]` at `App.tsx` L68 and session-stable — this is a consolidation, not a bug fix). `createCommands` still binds to the live `usePowerSync()` db; do not change db identity or wrap `db.execute`.
7. **[1.4]** Keep screen-local ONLY the tables outside the shared set (per the Matrix): `decision_*`, `diagram_*`, `automation_rules`, `habits`/`habit_completions`, `tags`/`tag_placements`/`tag_answers`, `computed_aggregates`. These are made loading-aware in S25.

DoD:

- **[1.4]** Across two full round-trips of all tabs, the provider opens exactly **9** base-table subscriptions total and rebuilds `FactContext`/`TreeIndex` a constant number of times independent of navigation (assert via the S24-step-1 counters; spy at the db/provider, not at `useQuery`).
- **[1.4]** No screen component creates a provider-shared subscription (test sweep over `hooks.ts` consumers + the Matrix).
- **[1.4]** The `PrismsDataProvider` instance and its `factContext` reference survive navigation; `useCommands` returns a stable reference across navigations and across a `now`-tick re-render.
- **[1.4]** Optimistic-write reactivity is intact: a local write still re-renders shared consumers (the hoisted `WatchedQuery` binds to the db, not tree position). The `crudToCommand` upload path and rejection rollback (`dod.spec`) stay green.
- **[1.4]** All S16-S20 Playwright flows still pass unchanged.

### S25 - Loading-aware, stale-while-revalidate reads (Fix C)

**Deps:** S24

**Spec:** §7.15, §12.2; `packages/ui/src/hooks.ts`

Build:

1. **[1.4]** Replace the data-discarding `useRows` (`hooks.ts` L89) with a read returning `{ data, isLoading, isFetching }` backed by a last-known-rows cache that survives **remount**: provider-level for shared tables, and a module/session-scoped cache keyed by query text + params for screen-local reads, seeded synchronously on mount. Keep a thin `.data`-only shim only for call sites that provably never render empty.
2. **[1.4]** Thread the provider's `isHydrated`/`isFetching` (S24) and each screen-local read's loading state into the screens. Add a shared `<ScreenSkeleton>` / section skeleton in `packages/ui`.
3. **[1.4]** Per-branch empty-state gating — gate **every** empty branch on `isHydrated && length === 0`, not just top-level lists. Enumerated checklist (each must be unreachable while loading):
   - **Worklist**: "No available tasks…" group-empty.
   - **Kanban**: per-column "—" empty.
   - **Agenda**: empty calendar + empty to-do panel.
   - **Habits**: `List` empty **and** the vision `<select>` "Create a vision first" CTA (must not render while visions load).
   - **Dashboard**: empty burndown + empty completion list.
   - **DecisionBoard**: all three nested empty branches (no boards / no criteria / no projects).
   - **Flowchart**: all three branches (no diagrams / no nodes / no groups).
   - **Gantt**: the project `<select>` empty option **and** "No dated tasks" (the no-`ctx` screen — easy to miss).
   - **Inbox**: `List` empty **and** the promote `<select>` placeholder (depends on `usePromoteTargets`).
   - **Rules / Blockers**: empty editor lists.
   - Add a test sweep asserting each branch is reachable only when `isHydrated && length === 0`.
4. **[1.4]** Make screen-local reads (`useDecisionBoards`, `useFlowchart`, `useGantt` local reads, `useRules`, `useBlockers`, `useAggregates`, `useUserSettings`, `useTagCatalog`, `useBlockTags`) loading-aware via the same primitive + cache.
5. **[1.4]** Confirm (do not "fix") that the 1s `now` tick does not rebuild `buildFactContext`/`buildTreeIndex`: pre-S24 the tick re-ran them because `useWorklist`→`useFactContext` re-ran on `now`; S24's hoist already removes that. Assert the provider's build call-count is invariant across N ticks while the per-`now` selectors (`useWorklist` status loop, `useHabits` today-minutes) still recompute correctly.

DoD:

- **[1.4]** Fresh-account first login (OPFS empty, first sync in flight, watched query already returning `data:[]`) shows the **skeleton**, not the empty branch.
- **[1.4]** Offline reload with a populated OPFS replica renders data, not a stuck skeleton (`hasSynced === false` but rows exist).
- **[1.4]** Tab away from a populated screen and back: prior rows return **synchronously** on first paint (remount SWR test, not just in-place refetch).
- **[1.4]** Confirmed-empty still renders the empty-state branch (`isHydrated && length === 0`), across every branch in the step-3 checklist.
- **[1.4]** The `now` tick re-renders time-relative UI with an invariant fact/tree build count.
- **[1.4]** All S16-S20 Playwright flows still pass.

### S26 - Read-path verification, perf gates, and regression

**Deps:** S24, S25

**Spec:** §7.14, §7.15, CI gates; `apps/web/e2e/`, `packages/core/.../load.perf.test.ts`

Build:

1. **[1.4]** Playwright spec `apps/web/e2e/v14.spec.ts`: with the seed loaded, navigate across all tabs, then revisit each. Assert (a) no empty-then-fill flash — data is present on the first paint after navigation; (b) populated content is visible synchronously on revisit (no skeleton on a warmed tab); (c) returning to Worklist re-derives the running-timer bar and worklist correctly (the timer bar is Worklist-local — "survives a round-trip" means re-derives on return, not a persistent global bar).
2. **[1.4]** Counter gate (via the S24-step-1 harness): provider-held subscription count and `buildFactContext`/`buildTreeIndex` call counts are invariant across N navigations (do not scale with navigations or screens); the absolute shared-subscription count equals 9.
3. **[1.4]** Selector-timing budget stays in the existing core 100k vitest (`load.perf.test.ts`): status/worklist recompute budget from v1.3 §7.12 is unaffected. (No browser-level `test:perf` script is invented; the tab-switch/no-re-query assertions live in `v14.spec.ts` + the counter gate.)
4. **[1.4]** Regression sweep: full `pnpm turbo lint typecheck test`, `@prisms/core test:coverage` (≥90% held), and all 12 web Playwright e2e cases (`dod.spec.ts` + `s16..s20.spec.ts`) green. Explicitly re-run the optimistic-rollback + rejection-toast case from `dod.spec.ts` to prove the upload path is unchanged.
5. **[1.4]** Update README / self-hosting notes only if a user-visible behavior changed (it should not; this is internal).

DoD:

- **[1.4]** `v14.spec.ts` proves no flash and warm synchronous revisit on tab switch.
- **[1.4]** Subscription/build counters are invariant across navigations; shared count == 9.
- **[1.4]** Core 100k selector-timing budget unaffected; navigation triggers no base re-query.
- **[1.4]** CI matrix (`pnpm turbo lint typecheck test` + core coverage + 12 web e2e) is green; optimistic-rollback/rejection-toast unchanged.
- **[1.4]** No change to command, status, or sync semantics (S16-S20 DoD intact).

---

## Deliberately Out of Scope

- **Fix B — keep screens mounted (visibility toggle / keep-alive `<Outlet>`).** Not included, per the chosen A+C path. Rationale: once shared data is hoisted (S24) and reads are loading-aware with a remount-surviving cache (S25), a screen remount is cheap — it re-reads warm session context and the SWR cache synchronously and never blanks. B would only avoid re-running a screen's *own* local `useMemo`/component state, a marginal gain on top of A+C. If profiling after S26 shows a specific heavy screen (e.g. Flowchart/Gantt layout) still janks on remount, add keep-alive for *that screen only* as a follow-up; it is not required to close the reported defect.
- **Building the v1.3 §7.12 `StatusIndex` / §7.2 two-layer overlay.** Not built in the shipped code and not required for A+C. If added later, §7.14 dictates they live in the `PrismsDataProvider`.

## Dependency Graph

```text
S15-S20 (shipped) -> S24 (harness + provider) -> S25 (loading-aware + SWR cache) -> S26 (verify + regress)
```

- S24 is the structural backbone; its step 1 harness unblocks every count-based DoD. S25 layers loading-aware UX + the remount-surviving cache on it. S26 verifies the whole and guards regression.
- S24 and S25 each preserve all prior behavioral DoD; S26 is the gate proving they do.

## Verification Commands and CI Gates (additions)

Extend the v1.3 gates with:

```bash
pnpm --filter @prisms/ui test          # RTL hook harness: loading-vs-empty, SWR-across-remount, counter invariance
pnpm --filter @prisms/web e2e          # includes v14.spec.ts: no-flash / warm-revisit on tab switch
pnpm --filter @prisms/core test        # load.perf.test.ts selector-timing budget unchanged
```

Minimum new gates:

- Tab-switch e2e proves no empty-then-fill flash and warm synchronous revisit.
- Provider-held subscription and `FactContext`/`TreeIndex` build counts are invariant across navigations; absolute shared-subscription count == 9.
- First-sync test proves the skeleton renders while `isHydrated === false` (empty replica, sync in flight) and the empty branch only when `isHydrated && length === 0`.
- Offline-populated-replica test proves no stuck skeleton (`hasSynced === false` but rows exist).
- SWR-across-remount test proves a populated list returns prior rows synchronously after tab-away-and-back.
- Optimistic-rollback + rejection-toast (`dod.spec.ts`) unchanged after the hoist.

## Definition of Finished (v1.4 delta)

The 1.4 increment is finished only when, in addition to the v1.3 Definition of Finished:

1. The 9 provider-shared reads and the `FactContext`/`TreeIndex` derivation run once per session, above the router, and survive navigation (§7.14); no screen subscribes a shared table.
2. Switching tabs creates no new base-table subscription and re-runs no base derivation; revisiting a tab shows data synchronously.
3. No user-visible list/section/`<select>` renders its empty-state branch while loading; first load shows a skeleton; refetch/remount shows stale-then-fresh; empty shows only when confirmed empty (§7.15).
4. `isHydrated` is grounded on `hasSynced` (plus row-exists fallback): fresh login shows a skeleton not empty; offline populated reload shows data not a stuck skeleton.
5. The 1s timer tick re-renders time-relative UI without rebuilding the fact/tree index; `useCommands` is reference-stable across navigations and ticks.
6. The db identity and `crudToCommand` upload/rollback path are unchanged; all v1.3 behavioral DoD (S16-S20) and the full CI matrix remain green.
