# Remediation Session R7 — StatusIndex wiring, client half

Branch `remediation` (sequential mode). Findings addressed: **S2-F4** (fan-out gaps), **S2-F5** (unknown-row guard), **S8-F1** (full FactContext rebuild per change — the audit's #1 efficiency finding, client half). Wave 2; hard dep R2 (merged) — R2's `earliestEntryStart` bookkeeping in `status-index.ts` is preserved. Playbook §R7.

## What changed

### Core — `packages/core/src/status/status-index.ts`

1. **Fan-out scoping (S2-F4).** The index previously dirtied ALL tasks on any completion/entry/block/delete when a `project.phase` blocker existed, and ALL tasks on any weather-fact change when a weather blocker existed — so a single such rule turned every command into an O(100k) recompute.
   - `project.phase` resolves to a task's *nearest ancestor-or-self project* (predicate.ts). A fact change under node X changes only X's containing project's phase, so the fan-out is now scoped to that project's task-subtree (`containingProjectId` + `phaseImpactTaskIds` + `dirtyPhaseImpact`), a correct superset that's ~project-sized, not account-sized. The delete path captures the impact set *before* mutating the tree.
   - Weather fan-out is scoped to the subtrees of weather-reading rules (`dirtyWeatherImpact`); a genuinely global weather rule (no `subtree_of`) still fans to all tasks (it really applies to all), but a subtree-scoped one touches only its subtree. `applyBlockerRule` keeps its full fan-out (enabling/editing a rule is rare, documented).
2. **Unknown-row update guard (S2-F5).** `applyNode`/`applyEdge`/`applyEntry`/`applyBlock`/`applyMembership`/`applySprint` now ignore an `update` effect for a row the index doesn't hold (no default-stuffed ghost from `toNode`), counted via `skippedUnknownUpdates`. Inserts remain the only unknown-row entry path.
3. **Read-layer seam (S8-F1 support).**
   - `freshView(): FactContext` — a fresh top-level identity (with fresh `tree`/`edgeIndex` wrappers) over the live, incrementally-maintained maps, so React consumers memoized on the context re-run after `apply()` without a rebuild.
   - Sibling lists are kept in insertion order for status (order-agnostic) but `freshView()` lazily re-sorts only the sibling lists changed since the last view (`dirtyChildLists` + `compareSiblings`), so the exposed `tree.childrenByParent` matches `buildTreeIndex` order exactly (drop-in for consumers like `childrenOf`) — O(changed), not O(all).
   - `trackStatus` constructor option: view-only mode maintains the maps but skips the per-node status pass (the read layer derives status live with the screen's `now`). `recompute` reports the touch set (`recomputed`) in *both* modes.

### UI — `packages/ui/src/powersync/data-provider.tsx`

Replaced `buildFactContext(rows)`-memoized-on-`[rows]` (which re-ran the full ~65ms derivation on every optimistic write, since every write changes the overlay) with an incremental engine held in a ref: **seed a view-only `StatusIndex` once, then feed it the minimal diff of the merged rows on each change** and expose `freshView()`. The diff is **correct-by-construction** — it reconciles the index to the current merged rows each render, so reconcile/rollback need no special handling (a reconciled command's row simply diffs from optimistic→canonical). It leans on two `mergeTable` facts: unaffected tables return the replica array by reference (skipped via array identity), and unaffected rows keep object identity (skipped via row identity) — so a keystroke diffs O(changed), and only changed rows are re-mapped (killing the mapper churn). A change larger than `REBUILD_THRESHOLD` (a big sync-down) reseeds instead. Public API (`factContext/tree/rows/isFetching/isHydrated`) unchanged — all consumers compile untouched.

## Tests

- **`status-index.test.ts`** (+3): phase fan-out scoped to the changed project (a completion in P1 doesn't recompute P2's tasks; values still equal a fresh rebuild over the post-state); unknown-row update guard (no ghost, `skippedUnknownUpdates` increments, insert still works); `freshView` drop-in (sorted children matching `buildFactContext`, fresh identity per call, live after apply).
- **`load.perf.test.ts`** (+1): 100k + a global phase blocker + a subtree-scoped weather blocker → a completion's touch set is **100** (project subtree), a weather change's is **99** (rule subtree) — bounded, not 100k (before the scoping fix these were ~100k). View-only so the case gates the fan-out bound without an O(all-tasks) status pass (the 16ms per-command wall-time is gated by the existing single-node case).
- **`apps/web/test/data-provider.test.ts`** (rewritten): spies **StatusIndex seeds** (not `buildFactContext`, which the provider no longer calls). Pins: 9 base + 1 overlay subscriptions and one seed on mount; navigation and the `now` tick don't reseed; **an optimistic overlay write updates the merged FactContext with NO reseed** (the S8-F1 fix, red before it).

## Evidence (gate)

- core: typecheck ✓ · lint ✓ (3 pre-existing `no-console` unused-disable warnings in `load.perf.test.ts`) · **557/557 tests** (isolated) · coverage **90.34 stmts / 93.99 fns / 93.26 lines** (≥90 floor).
- ui **82/82** (incl. read-layer subscription-count invariant, unchanged) · web **7/7** · web build ✓.
- `pnpm turbo lint typecheck test` (with `PRISMS_DB_TEST_URL`): **21/21**.

## Notes / gotchas

- **Turbo concurrency flake:** the first full-gate runs timed out (30s vitest limit) — NOT assertion failures. Under 7-way concurrency the CPU is starved (the existing 100k build test alone took ~10s; a pre-existing `optimize.property` test also flaked — see [[dev-stack-on-this-machine]]). The original S2-F4 perf case constructed a *status-tracking* 100k index with a phase blocker (a full ~10s pass) → 34s → timeout, which also worsened the pool. Fixed by switching that case to **view-only** (`trackStatus:false`, ~0.1ms) — the fan-out bound is what it gates, not wall time. This also motivated `recompute` reporting the touch set in view-only mode.
- **Not done (correctly out of scope per §R7.4):** the server half (S4-F2 — R8) and hoisting screen-local reads. The index maintains `statusByNode` in status-tracking mode but the provider runs it view-only and derives status live (the per-second `now` makes `statusByNode` stale by design); a later change can consume `statusOf` once status is made now-injectable.
- **Handoff (R9):** the provider engine lives in a `useRef`, reseeded on remount — so R9's `disconnectAndClear`/account-switch (provider unmount→remount) resets it cleanly; no cross-account index carryover.
