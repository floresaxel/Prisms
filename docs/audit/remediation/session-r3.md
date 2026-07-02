# Remediation Session R3 — Hours correctness: consume the union resolver everywhere

Branch `remediation` (sequential mode — no session branch, matching R1/R2). Findings addressed: **S3-F2 (High)**, **S5-F4 (Medium, server half — fixed via core)**, S10-F3b (harness gate gap), S2-F9 (noted, untouched). Playbook: `Blueprints/REMEDIATION_PLAYBOOK.md` §R3.

## What changed

1. **`packages/core/src/aggregates/practice.ts`** — `canonicalPractice` now groups live entries per task and sums `mergeTimeEntries(taskEntries).effectiveMinutes` across tasks (§9.2/§7.10b): overlapping same-task entries count once, focus integrates as max-per-instant. Deleted `incrementalPractice` + `emptyPractice`: zero production consumers (verified by grep), and a per-entry fold is structurally incompatible with union semantics — keeping it would reopen the S3-F2 footgun.
2. **`packages/core/src/aggregates/progress.ts`** — `canonicalProgress` = union `rawMinutes` of the task's live entries ÷ estimate. Deleted `incrementalProgress` + `emptyProgress` (same rationale). `aggregates/timeleft.ts` consumes `canonicalProgress` → time-left inherits the union fix with no edit.
3. **`packages/core/src/aggregates/effective.ts`** — header now states the guard: per-entry display helpers only; aggregation must go through `mergeTimeEntries`.
4. **NEW `packages/core/src/aggregates/today.ts`** — `habitTodayMinutes(entries, taskIds, today, dayResetHour, timeZone, nowMs)`: today's closed entries union per task + live elapsed for the running entry (pure; `nowMs` is a parameter). Exported via `core/src/index.ts` (one added line — noted as the only edit outside owned dirs besides the two shared regions below).
5. **`packages/ui/src/hooks.ts`** (shared hotspot, my region only) — the `useHabits` today-total loop (ex `:722-727`) is now one `habitTodayMinutes` call; dropped the now-unused `rawMinutes` import, added `habitTodayMinutes`. `canonicalPractice`/`canonicalProgress` call sites (`:720`, `:334`) unchanged — they inherit the core fix.
6. **`apps/server/src/jobs/aggregates-recompute.ts`** — **no edit needed** (verified: `:131` calls `canonicalPractice`, so server-canonical `practice_hours` is fixed via core — exactly the one-logic-two-tiers design).

## Tests

- **`packages/core/test/aggregates/sums.property.test.ts`** reworked: the two `incremental ∘ facts === canonical` properties are gone with the folds; in their place (a) union goldens — the audit pair 09:00–11:00 ∪ 09:30–10:30 → **120 min (per-entry sum said 180)**, focus max-per-instant → 90 eff min, cross-task concurrency still sums (per-TASK grouping pinned); (b) properties over a NEW overlap-capable arbitrary (the old arb placed each entry on its own day — overlap was ungenerated, which is precisely why the sum bug looked correct): order-independence, **duplication-idempotence** (a union invariant per-entry sums violate), union ≤ naive sum; (c) a `habitTodayMinutes` golden (closed union 90 + live 30; other-bucket/other-task/deleted excluded).
- **Fixture bug found by the fix:** the pre-existing "levels pass thresholds" golden started BOTH entries at 00:00 (1h session contained in the 5h one) and expected 6h — it only ever passed because the old code double-counted. Rewritten as disjoint sessions (5h + 1h); incidental confirmation that S3-F2 was live in the test base too.
- **Harness scenario 9 extended (append-only)** per the S10-F3b gate gap: after sync, `canonicalProgress` over the SYNCED rows asserts **90 consumed / 75%** — the production aggregate, not just the resolver. (Red-before/green-after not run as a separate cycle — the source fix landed in the same session; the pin is arithmetic: old code returns 120/100% for these rows, and the reworked unit goldens encode the same old-vs-new delta. Noted per playbook §0.3.3.)

## Evidence (gate)

- core: typecheck ✓ · lint ✓ (2 pre-existing warnings in `load.perf.test.ts` — R7's file, untouched) · **552/552 tests** · coverage **90.49 stmts / 93.36 fns / 93.6 lines** (≥90 floor).
- ui: typecheck ✓ · lint ✓ · **78/78 tests**.
- server (live PG 5434): **13 files / 115 tests passed** — full integration suite incl. the convergence harness with the new scenario-9 production-aggregate assertions (`canonicalProgress` = 90 min / 75% over the synced rows).
- `pnpm turbo lint typecheck test` (with `PRISMS_DB_TEST_URL` set): **21/21 tasks** (6 cached, integration suites ran fresh under R1's env-keyed cache).

## Notes / out-of-scope

- The audit prose (S3-F2/FINAL_REPORT) says the 09:00–11:00 + 09:30–10:30 pair "shows 150 instead of 120" — the naive sum for that pair is 180, not 150 (arithmetic slip in the audit text; the failure class and fix are unaffected).
- S2-F9 (O(N²) boundary sweep inside `mergeTimeEntries`) left as-is per playbook (N = entries per task, small); revisit only if per-task entry counts grow.
- Deleting `incremental{Practice,Progress}`/`empty{Practice,Progress}` removes them from the public core API. Grep-verified zero consumers outside their own property test (which is what the rework replaced). `incrementalCompletion` is untouched — completion is a toggle sum, not an interval aggregate.
- Dashboard/other surfaces reading `canonicalProgress`/`canonicalPractice` pick up union values with no further edits; the only remaining per-entry summation sites in the repo are the single-entry display helpers themselves.
