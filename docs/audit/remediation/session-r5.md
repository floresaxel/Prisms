# Remediation Session R5 — Client write-path completion (offline parity)

Branch `r05-write-path-parity`, cut from the sequential head (`remediation` + R6..R10). Wave 2 (depended on R2 ✅ + R4 ✅, both merged). Findings addressed: **S7-F1 (High)** offline automation spawning, **S7-F4** invariant pre-flight, **S7-F7** soft-delete closure, **S7-F5** `depends_on` derivation. This closes the **last open High** — all 6 are now remediated. Playbook §R5.

## Approach — merged facts at write time (step 1)

`execute()` needs the merged (replica+overlay) fact set to run the §7.2d guards. I took **option (b)**: read it directly via the existing `readMergedRows(store, table)` seam (the same one `acceptSuggestion` already uses) + the `rows.ts` mappers, building a `FactContext`/`TreeIndex` on demand inside the writer. Justification: it is **self-contained in R5's owned files** — no dependency on the R7-owned `data-provider.tsx` and no new plumbing through `createCommands()` — and the write-time cost (a few SELECTs per user action) is negligible. All reads are lazy per verb, so a verb with no guard does zero extra I/O.

## What changed (`packages/ui/src/powersync/execute.ts`)

- **S7-F4 invariant pre-flight.** Before minting an id/envelope, `preflightError` runs the verb's checker against merged state for the audit's two cases: `timer.clock_in` (I5 double-clock-in / I8 done / the R2 acceptance-safe blocked gate — weather never blocks locally, `force` skips the dependency gate) and `node.move` (I1/cycle). **Conservative by design:** local state can be incomplete (a referenced row not yet synced / Tier-2 lazy), so it only rejects when the referenced row IS locally present and definitively violates an invariant; a missing row → defer to the server (authoritative). A failure throws a typed `CommandError` (new export) — no id, no envelope, no overlay, no review item.
- **S7-F1 offline automation spawning (High).** On `node.check_off` of a task (task_completed) or `node.create` of a task (task_created), `automationSpawnEffects` runs core `runAutomations` against merged facts and appends the spawn insert effects to **this command's** overlay (same `command_id`/`hlc`, one enqueue txn). It **mirrors `dispatcher.runAutomationInTx` exactly**: UUIDv5 spawn ids, predicted `source_kind='automation'` provenance (rule_id + slot + rule/template versions in `source_detail`), the I1/I3 spawn validation (`buildTreeIndex([...live, ...spawned])` → `checkNodeCreate` drops illegal spawns + dangling edges). The deterministic id makes the server's authoritative row reconcile the optimistic one **byte-identically** (the reconciler drops the overlay once the canonical row arrives with `last_modified_by_command_id === command.id`, which the triggering command's id satisfies).
- **S7-F7 soft-delete closure.** `node.soft_delete` now appends `del` effects for the deleted node's descendants (`softDeleteClosure` over the merged tree), so a flat merged read (worklist/kanban/agenda) hides the WHOLE subtree offline, not just the root. Stale comments fixed at `effects.ts` + `commands.ts`.
- **S7-F5 `depends_on`.** `deriveDependsOn` maps a payload's FK-like row-ids (parent_id/task_id/predecessor_id/…) against still-pending insert effects (`overlay_effects` op='insert' only ever holds pending creates) and passes the producing command ids into `enqueue(cmd, effects, dependsOn)` — **the R6 handshake interface, already wired**. So `edge.create` on a not-yet-uploaded node derives `depends_on=[nodeCmd.id]`, and the server's causal gate (V3 / `dependency_rejected` + review item) finally fires for real clients.

## R6 handshake

Fully closed. R6 shipped `overlay-store.enqueue(command, effects, dependsOn?)` + the persisted `depends_on` column + upload-body inclusion (commit `377060c`). R5 derives the value and passes it through that exact interface — no coordination gap remains.

## Tests (`packages/ui/test/write-path.test.ts`, 5 — all new)

A fake `OverlayStore` captures enqueued commands/effects and serves seeded replica rows, so the pure write-path logic runs without a browser. Cases: (1) a second clock-in with a merged open entry is rejected `CommandError`, **no command/effect written**; (2) a clock-in with no open timer proceeds; (3) completing a rule-bearing task inserts the spawned node with the deterministic `spawnedTaskId(rule,trigger,slot)` id + `source_kind='automation'` + `parent_id = same_as_trigger`, riding the same command; (4) soft-deleting a subtree root emits `del` for the whole subtree; (5) `edge.create` on a still-pending vision derives `depends_on=[cmd1.id]`.

## Evidence (gate)

- `pnpm turbo lint typecheck` — **14/14**. ui **89/89** (5 new). web **12/12** (ui consumers untouched). `pnpm test:convergence` — **16/16** (server harness unaffected — R5 is ui-only). core/db/server/mobile not touched by R5.

## Notes / gotchas

- **Conservative pre-flight was essential.** A first cut rejected on `E_NOT_FOUND` when a referenced row wasn't in local state, which false-rejects valid offline commands AND broke existing `commands.test.ts` clock-in/create tests (empty store). Fixed with presence guards: reject only when the referenced row is locally present. Dropped the `node.create` pre-flight case entirely (its missing-parent ambiguity can't be distinguished from a real I1 violation by error code) — the audit's S7-F4 examples are clock-in + move, both covered.
- **I3 justification needs full ancestry.** The spawn test initially seeded a bare milestone; the spawned task was dropped by `checkNodeCreate` because a task under a parentless milestone isn't justified (I3). Seeding the full vision→roadmap→project→milestone chain fixed it — a good reminder the client's I1/I3 spawn validation is the same the server applies.
- **Out of scope, honored:** did not touch `overlay-store.ts`/`upload-commands.ts`/`connector.ts`/`client-runtime.ts`/client `schema.ts` (R6), `data-provider.tsx`/`hooks.ts` (R7/R3/R9), or core (consumed only). Consumed `rows.ts` mappers (not owned, not forbidden — read-only use).

## Remediation now COMPLETE — final integration note

With R5 merged, **all 6 High findings are closed** (S3-F1 R2 · S3-F2 R3 · S7-F1 R5 · S7-F2 R6 · S8-F1 R7 · S9-F1+S9-F2 R9). The R10 sign-off should be re-run on the R5-inclusive head and the `remediation` label caught up through R6..R10 + R5; the `remediation`→`m0-spike` merge + any push remain the operator's call.
