# Remediation Session R2 — Core status semantics: weather out of acceptance + dependency-lag gates

Branch `r02-status-semantics` (cut from `remediation` @ `7b3e428`). Executed 2026-07-02. Wave 1.

**Findings addressed:** **S3-F1 (High)**, S3-F5, S3-F8, S5-F10 + harness scenario 13b.

## What changed & why

### S3-F1 (High) — external facts stop gating command acceptance (R19/V10, DoF 22)
The dispatcher's `timer.clock_in` gate called `isBlocked`, which includes weather-reading blocker rules — so a task blocked only by advisory weather was rejected `E_BLOCKED_TASK` unless forced (a divergence-prone rejection that fires for any weather-rule user).

- `status/predicate.ts`: new **`referencesExternalFacts(predicate)`** — AST walk over `all/any/not` flagging any leaf whose `fact` is in `EXTERNAL_FACT_PREFIXES` (`['weather.']`; future providers add their prefix). Malformed → `false` (it can't fire regardless).
- `status/predicate.ts`: `evaluateBlockerRules` gains an `opts.excludeExternalFacts` flag — when set, a rule that references any external fact is **skipped whole** (not just the weather leaf), guaranteeing weather can never contribute to a rejection.
- `status/status.ts`: new **`isBlockedForAcceptance()`** = `dependencyBlocked ∨ non-external blockedBy`. The display path (`isBlocked`/`taskStatus`/badges) is **unchanged** — weather still shows the task blocked/unverified.
- `apps/server/src/dispatcher.ts` (~:699, my only region): the `E_BLOCKED_TASK` gate now calls `isBlockedForAcceptance`. **Semantics after:** a weather-only-blocked task clocks in **without** `force`; a dependency- or non-external-rule-blocked task still requires `force`.

### S3-F8 / S5-F10 — weather predicates invalid in automation conditions
Jobs never load `external_facts`, so a weather-conditioned automation rule could never fire (silently useless). `rules/validate.ts`: `validateAutomationRule` now rejects any condition referencing an external fact with the new typed code **`E_EXTERNAL_FACT_CONDITION`** (added to `domain/errors.ts`), pointing the user at blocker rules for advisory weather.

### S3-F5 — SS availability lag + SF completion lag now enforced (§7.6)
`FactContext.hasAnyEntry` is a boolean, so started-based lag had no start timestamp to gate on. Added **`FactContext.earliestEntryStart(nodeId): Instant | undefined`** (earliest `started_at` ms across a task's non-deleted entries), maintained in both `buildFactContext` (context.ts) and the incremental `StatusIndex` (status-index.ts — a per-task `entryStartsByTask` map so removal recomputes the min without a scan; R2 touched only this bookkeeping, R7 owns the rest).
- `status/status.ts` SS case: a started-but-not-completed predecessor now blocks availability until `start + lag`.
- `commands/invariants.ts` SF case: a started predecessor now blocks completion until `start + lag` (FS/FF completion lag were already correct).

## Tests (all part of the fix)
- `status/predicate.test.ts` (+3): `referencesExternalFacts` on nested all/any/not, internal-only, and malformed inputs.
- `status/status.test.ts` (+5): `isBlockedForAcceptance` — weather-blocked ⇒ display-blocked but acceptance-clear; dependency-blocked ⇒ still gated; non-external rule ⇒ still gated; **mixed weather+non-weather rule ⇒ excluded whole**. Plus **SS-lag** (started-not-completed predecessor blocks until start+lag).
- `commands/catalog.test.ts` (+1): **SF-lag** completion gate.
- `rules/validate.test.ts` (+1): weather condition rejected `E_EXTERNAL_FACT_CONDITION`.
- `apps/server/test/convergence.integration.test.ts`: **scenario 13b** (append-only) — a weather-blocker rule + a "blocking" weather fact + a scenario-local dispatcher pinned to `2026-06-13T12:00Z` (so `ctx.today()` deterministically resolves the `{today}` weather key). A non-force `timer.clock_in` on the weather-only-blocked task ⇒ **applied**; a non-force clock-in on a dependency-blocked task ⇒ **rejected `E_BLOCKED_TASK`**.

## Red → green evidence (S3-F1)
Ran the harness with scenario 13b present but **before** the dispatcher swap → 13b **RED**:
```
× scenario 13b … expected { result: 'rejected' } to match { result: 'applied' }  (okClock)
Test Files 1 failed | Tests 1 failed | 13 passed (14)
```
After swapping `isBlocked` → `isBlockedForAcceptance` at dispatcher :699 → **GREEN**:
```
convergence  Test Files 1 passed (1)  Tests 14 passed (14)
```

## Gate evidence (all with compose PG up + `PRISMS_DB_TEST_URL` set)
- `pnpm --filter @prisms/core test` → **547 passed** (was 537; +10).
- `pnpm --filter @prisms/core test:coverage` → Statements **90.49%**, Functions **93.4%**, Lines **93.58%** (all ≥90 floor; branches has no floor).
- `pnpm --filter @prisms/server test` → 13 files, **115 passed** (was 114; +1 = 13b), integration suites RAN (not skipped).
- `pnpm test:convergence` → **14/14**.
- `pnpm turbo lint typecheck test` → **21/21** (ui/web untouched and green — `evaluateBlockerRules`'s new param is optional, so the existing 4-arg ui call sites compile unchanged).

## Handoffs / notes for later sessions
- **R5 (client pre-flight, S7-F4):** the client's invariant pre-flight for `timer.clock_in` **must mirror** this — use an acceptance-safe evaluation (weather never blocks locally either) so the optimistic path and the server agree; `force: true` skips exactly the dependency/non-external blocking. `isBlockedForAcceptance` is exported from `@prisms/core` for this.
- **R10 (docs):** SECURITY_REVIEW / README should state the force-semantics: weather is advisory (clock-in needs no force); dependency/non-external blocking needs force. This is the change that makes R19/V10/DoF 22 true.
- **R4 (jobs):** S3-F8's ban closes the "weather automations never fire" gap at authoring time; no jobs change needed for that specific point.

## Out-of-scope observations (reported, not fixed)
- `dependencyBlocked`'s **uniform completed-lag clause** (`status.ts`) still runs for **FF/SF** edges too, so an FF/SF edge with `lag>0` and a completed predecessor currently blocks *availability* — but §7.6 says FF/SF "do not block availability". Not an audit finding, untested, and outside R2's SS/SF-lag scope; flag for a future status-semantics pass. (No test asserts it; the existing FF/SF-availability tests use lag=0.)

## Fence compliance
Owned: `status/{predicate,status,context}.ts`, `commands/invariants.ts` + their tests. Shared (my region only): `dispatcher.ts` (:699 gate + import), `status-index.ts` (earliestEntryStart bookkeeping only), `rules/validate.ts` (one check + import), harness (append 13b; Device model untouched). **Additive deviation:** `domain/errors.ts` gained one code (`E_EXTERNAL_FACT_CONDITION`) and `index.ts` re-exports flow through `export *` (no edit) — neither is a declared hotspot; no other Wave-1 session touches errors.ts, so the merge is clean. No forbidden files touched (no ui, no rules/engine|actions, no aggregates).
