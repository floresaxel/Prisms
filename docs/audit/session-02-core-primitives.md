# Audit Session 2 — Core Primitives: Time/HLC, Merge, Sync Contracts, StatusIndex

Audited at commit `4f30e4e` (branch `m0-spike`, clean; code identical to baseline `2ab3bf7` — later commits are docs-only), 2026-07-01.

**Scope examined:** `packages/core/src/time/{hlc,clock,instant*}.ts`, `merge/{lww,sort-order,time-entries,renormalize}.ts`, `sync/{overlay,version,manifest}.ts`, `status/{status,status-index,context}.ts`, `commands/timer-merge.ts` (the §7.10b row-level half; overlaps S3), `domain/primitives.ts` (HLC/device-id regexes), and the tests: `test/time/{hlc,hlc-merge}.test.ts`, `test/merge/*.test.ts`, `test/sync/*.test.ts`, `test/status/{status,status-index}.test.ts`, `test/load.perf.test.ts`.

**Verdict:** this layer is the strongest part of the codebase — the HLC, the LWW default, both V9 merge exceptions, the overlay merge contract, and the incremental StatusIndex are all implemented as specified, pure (mechanically enforced), and pinned by the exact property tests §7.9a/§7.10/§7.12 demand, including a real no-full-scan gate at 100k nodes. Three Medium findings temper it: the double clock-in row rule contradicts the 1.3 spec's letter (deterministic either way), the §7.11 additive-only guard exists but nothing runs it against real migrations, and the StatusIndex itself is not wired into any production path — the live system still derives status by full-context builds.

---

## Findings

### S2-F1 · Medium — Double clock-in row-level rule contradicts §7.10b: latest-wins survivor instead of earliest, no `superseded` marker at this layer

**Evidence:** `packages/core/src/commands/timer-merge.ts:29-46` — `resolveOpenTimeEntries` keeps the entry with the **latest** `started_at` open and closes every other at that latest `started_at` (ties by larger id). ARCHITECTURE_1.3 §7.10b (lines 563): "If both are still open, keep one open interval with the **earliest** `started_at`; mark the later open entry `superseded` with provenance pointing at the survivor." `status/context.ts:76-77` exposes the latest-started open entry too (citing the v1.0 §7.4 rule), and `merge/time-entries.ts` docs acknowledge both rules coexist.

**Failure mode:** none for convergence or hours — the rule is deterministic (all devices agree) and the union spans `min(started_at)` onward because losers are closed at the winner's start, so `mergeTimeEntries` still never double-counts. The deviation is observable state: which row remains open (and the running timer's displayed start) is the opposite of what the spec text prescribes, and no `superseded` provenance marker is produced by this function.

**Suggested change:** reconcile spec and code deliberately. The implementation's latest-wins is defensible UX ("my most recent clock-in is what I'm doing now") and is what the convergence harness locks in — if you keep it, amend §7.10b's text to codify latest-wins and drop/relocate the `superseded` wording; if the spec stands, flip the winner in `resolveOpenTimeEntries` and add the superseded provenance stamp. **Handoff (S4/S5):** verify whether the server applier stamps any supersession provenance on the losing entry today.

### S2-F2 · Medium — §7.11/V5 additive-only schema rule has no mechanical enforcement: `isAdditiveSchemaChange` is production-dead

**Evidence:** `packages/core/src/sync/version.ts:51-66` implements the additive check exactly (new-nullable ok, NOT-NULL-without-default / removal / type change / tightening rejected). A repo-wide grep shows its only caller is its own unit test (`test/sync/version.test.ts`).

**Failure mode:** a future migration `0009` adds a NOT-NULL column without a default (or tightens a column) on a synced table; nothing fails at commit time; old clients break mid-sync — precisely the corruption class V5 exists to prevent. The guard exists; the gate does not.

**Suggested change:** add a `packages/db` test that derives a `TableShape` per synced table (from the Drizzle schema, or `information_schema` in the integration environment), keeps a committed baseline JSON per `ROW_SCHEMA_VERSION`, and asserts `isAdditiveSchemaChange(baseline, current).ok` — bumping the baseline file becomes the explicit "major schema version" act. **Handoff (S6)** to place it next to the migration tests.

### S2-F3 · Medium — `StatusIndex` (V7) is a proven primitive that no runtime path uses

**Evidence:** grep across all `src/`: the only references are core itself and a comment in `packages/ui/src/powersync/data-provider.tsx:23` ("A later §7.12 `StatusIndex` would live here"). The client derives status via `buildFactContext` (rebuilt per data change; ~65 ms at 100k per `load.perf.test.ts` logs) + `taskStatus` per read; server-side use is unverified here.

**Failure mode:** DoF 16 ("status is derived **through an incremental index**") is satisfied by the test suite but not by the product. Practically: every sync batch/local command triggers an O(all-rows) FactContext rebuild on the client — inside budget today (~65 ms at 100k, within the §15 100 ms agenda budget) but it is the exact "full scan per data change" shape V7 was written to remove, and it burns the budget headroom the index was built to reclaim.

**Suggested change:** wire `StatusIndex.apply()` into the persistent read layer (Fix A's provider is the natural seam — it already receives the overlay effects and sync deltas), replacing rebuild-per-change with incremental apply; audit the server dispatcher for the same pattern. If the decision is to defer, amend DoF 16 or record an accepted exception. **Handoffs:** S4 (does the dispatcher build a full FactContext per command for invariants/automation?), S8 (client seam).

### S2-F4 · Low (Medium once F3 is fixed) — StatusIndex broad fan-outs degrade to all-tasks recompute; the perf gate doesn't cover those paths

**Evidence:** `status-index.ts:405,425,458,475` — when any enabled blocker rule mentions `project.phase`, every node delete, completion change, time-entry change, and schedule-block change adds **all task ids** to the dirty set; `applyExternalFact` (`:534-543`) does the same for weather when a weather blocker exists; `applyBlockerRule` (`:523-532`) always fans out fully (documented, rare). `load.perf.test.ts` gates only the no-blocker path (touch set < 100).

**Failure mode:** a user with one `project.phase` blocker rule and 100k nodes makes every completion/clock-in command recompute 100k statuses (each running `evaluateBlockerRules`) — the per-command 16 ms budget will not survive that, and the gate won't notice because it never enables a phase blocker.

**Suggested change:** scope the phase fan-out to descendants of projects actually referenced by phase predicates (the rule structure names its targets), and weather fan-out to tasks matched by weather-reading rules; add a 100k perf case with one phase blocker + one weather blocker enabled. Cheap to do now; mandatory before F3's wiring makes the index the live path.

### S2-F5 · Low — StatusIndex fabricates rows from partial fields when an update targets an unknown row

**Evidence:** `status-index.ts:408-411` (`addNode(toNode(id, effect.fields))` — `toNode` fills missing columns with defaults: empty title, `node_type` undefined, `parent_id` null), and the `{ id, ...(existing ?? {}), ...effect.fields } as unknown as X` casts in `applyEntry`/`applyBlock`/`applyMembership`/`applySprint` (`:467,484,501,519`).

**Failure mode:** benign today — commands update rows the index already holds, and no undelete/restore verb exists (verified: no `deleted_at: null` effect in `packages/ui/src/powersync/effects.ts`; S3 to confirm at the catalog level). But a future restore-style command whose effect is a partial update (`{deleted_at: null}`) on a row the index dropped at delete time would resurrect a default-stuffed ghost node (non-task `node_type` → status silently deleted) with no error.

**Suggested change:** in `applyOne`, ignore (or count via an instrumentation hook) `update` effects for rows absent from the index instead of fabricating; document that inserts are the only unknown-row path.

### S2-F6 · Low — LWW default lacks a property test; deleted-vs-updated semantics untested

**Evidence:** `test/merge/lww.test.ts` is example-based only (no fast-check, confirmed by grep), while the two §7.10 exceptions both carry property tests. `lww.ts` claims order-independence of `lwwMergeFields` in prose. Concurrent delete-vs-edit resolves implicitly (per-field: `deleted_at` from one device + `title` from the other both survive → a deleted row with a newer title) — deterministic, but stated nowhere and tested nowhere.

**Suggested change:** one `fc.property` asserting `lwwMergeFields` is invariant under patch-array permutation and idempotent under duplication; one example test documenting the delete-vs-edit outcome as intended. **Handoff (S4):** confirm the server field-merge applies the same per-field rule so a delete never resurrects.

### S2-F7 · Info — the §15 agenda budget is soft-gated

**Evidence:** `load.perf.test.ts:108-115` — per-command recompute is hard-gated at 16 ms (measured ~0.01 ms; `StatusIndex.apply` ~0.02 ms with touch-set < 100 asserted), but `buildFactContext` asserts only `< 10_000` ms with a comment explaining CPU contention in the concurrent suite; the real ~65 ms figure is logged, not asserted.

**Suggested change:** none required (rationale is documented and sound); S10 should list "agenda build ≤ 100 ms" under performance claims verified by observation rather than assertion. For S1-F4: the perf alias should be `pnpm --filter @prisms/core test -- load.perf`.

### S2-F8 · Info — `openEntryFor` exposes the latest-started open entry

**Evidence:** `status/context.ts:76-79` and `status-index.ts:238-244` (consistent with each other, citing the §7.4 display rule). `taskStatus` uses it purely as an existence check (`status.ts:92`), so status is unaffected.

**Suggested change:** none for status. This is the display-side twin of F1 — resolve them together so "which timer is the running one" has a single documented answer.

### S2-F9 · Info (efficiency) — `mergeTimeEntries` focus sweep is O(N²) per task

**Evidence:** `merge/time-entries.ts:86-104` — for each boundary interval (≤2N) it scans all closed entries (N).

**Suggested change:** none urgent (N = time entries per single task; realistically small). If per-task entry counts grow (long-lived recurring tasks), replace with an event sweep carrying a focus multiset — O(N log N). Note for S10's efficiency roll-up.

---

## Compliance checklist results

| Check (playbook §S2) | Result |
|---|---|
| HLC encoding: lexicographic == causal order | **PASS** — fixed-width lowercase hex + fixed offsets; property test `hlc.test.ts:117`; device-id charset (`[A-Za-z0-9_-]{1,64}`) can't break field alignment; `hlcCompareEncoded` ≡ `hlcCompare` incl. dash-bearing device ids |
| Counter overflow handling | **PASS** — tick and merge both roll into +1 ms (tested) |
| Device-id tiebreak → total order | **PASS** — property-tested (reflexive/antisymmetric/transitive; tie only on identity) |
| Monotonicity under stalled/backward wall clock | **PASS** — `hlcTick` property test over arbitrary clock behavior; `mergeHlc` strictly dominates local+remote and keeps this device's id (tested) |
| No wall-clock reads in core | **PASS** — `Clock` injected (`time/clock.ts`); `Date.now`/`new Date()` banned by lint (verified S1) |
| LWW per-field, deterministic tiebreak, idempotent | **PASS** (example-based only → F6); tie keeps current = idempotent re-apply |
| Deleted-vs-updated resolution stated and tested | **PARTIAL** — deterministic implicitly via per-field LWW; undocumented/untested (F6; server side → S4) |
| `sort_order` collision → deterministic convergent order (V9) | **PASS** — `(sort_order, hlc)` pair key; total-order + same-fraction-convergence tests; harness has the two-device scenario |
| Renormalize idempotent, can't fight concurrent inserts | **PASS** — deterministic spacing, idempotence tested; concurrent later-HLC insert wins its row, order stays total |
| `mergeTimeEntries`: union-not-sum, idempotent, order-independent | **PASS** — all three property-tested, plus union ≤ naive-sum property; row-level survivor rule deviates from spec text (F1) |
| Overlay merge contract: pure, deterministic, rollback = drop entry | **PASS** — `(hlc, seq)` ordering tested incl. same-HLC seq; effects keyed by `command_id`; "never uploaded" enforcement → S7 |
| Trust-field strip (client side) | **PASS** — R17 list covered incl. `source_detail`; row id + fact timestamps correctly exempt (tested); `applied_at` N/A client-side → S4 must cover it server-side |
| Command vs row-schema version axes separate (R16 core) | **PASS** — `COMMAND_VERSION` / `ROW_SCHEMA_VERSION` independent; `isClientTooOld` strict floor; enforcement → S4 |
| Additive-only check exists **and gates migrations** | **FAIL** on the gate half → F2 |
| Export manifest: versioned, strict, HLC high-water | **PASS** — strict Zod, `isSupportedExportVersion` rejects newer; note: `tables` accepts arbitrary table-name keys → import must allowlist (**handoff S5**) |
| Status derived, no stored column (core) | **PASS** — `taskStatus` exact §7.1 precedence; FS/SS/lag/deleted-predecessor/suggested-block/sprint-bucket all tested; DB column check → S6 |
| StatusIndex: fact-keyed, affected-nodes-only, rebuild ≡ incremental | **PASS** as primitive — instrumented touch-set tests + random-effect-stream equivalence property; **not used in runtime** → F3; broad fan-outs → F4 |
| 100k perf test exists; record budget + filename | **PASS** — `test/load.perf.test.ts`: per-command `apply` < 16 ms (≈0.02 ms) with touch-set < 100 asserted; single recompute < 16 ms (≈0.01 ms); agenda build soft-gated (F7) |

## Positive observations

- `hlc.test.ts` proves the load-bearing claim most HLC implementations skip: **string order on encodings equals structural order**, with malformed-input and dash-in-device-id cases.
- The rebuild-equals-incremental property over a random effect stream (`status-index.test.ts:158`) is exactly the §7.12-mandated invariant, and the transition tests assert the touch set, not just the value.
- `stripTrustFields` tests include the inverse assertion (row id and fact timestamps are NOT stripped) — the common over-stripping bug is guarded against.
- Sprint-pair reference counting in the index (`sprintPairCount`) correctly mirrors set-of-rows rebuild semantics for duplicate memberships — a subtle convergence detail handled deliberately.
- API naming deviates trivially from §7.9a (`hlcEncode`/`hlcTick` vs `encodeHlc`/`tickHlc`); substance and property coverage fully present.

## Matrix updates applied (sequential mode)

- V7 → ⚠️ (primitive + 100k gate verified; not wired into runtime — S2-F3/F4)
- V9 → ⚠️ (deterministic + property-tested; row-level survivor deviates from §7.10b letter — S2-F1)
- V5 → note added (S2-F2: no mechanical additive gate; S6 to enforce)

## Handoff items

1. **S4:** server trust-strip must cover `applied_at` + the full `TRUST_FIELDS` list (client strip is defense-in-depth only).
2. **S4/S5:** who stamps `superseded` provenance on the losing double clock-in entry (§7.10b) — core's resolver doesn't (F1).
3. **S4:** does the dispatcher build a full FactContext per command (invariants/automation)? If yes, F3's server half is a 100k perf risk inside the command txn.
4. **S5:** import restore must allowlist table names — `exportManifestSchema.tables` accepts arbitrary keys.
5. **S6:** wire `isAdditiveSchemaChange` into a migration-shape gate (F2); confirm no stored status column in the schema.
6. **S8:** evaluate the StatusIndex client seam in the data provider (F3); measure FactContext rebuild cadence under sync batches.
7. **S3:** confirm no undelete/restore verb in the catalog (F5's assumption); FF/SF completion/scheduling gates live in invariants/scheduler per §7.6; verify no server-side invariant evaluates weather-dependent blockers (V10, force clock-in flow).

**Next:** Session 3 — core engines (`commands`, `rules`, `scheduler`, `aggregates`, `graph`, `domain`) against §7.4–§7.6, §8, §9.2, §10 (pure), §11.
