# Remediation Session R8 — Server write-path scale + command-log effects channel

Branch `remediation` (sequential mode). Findings addressed: **S4-F2** (100k server write-path cliff), **S4-F3** (empty `command_log.effects` channel, per §0.7 **D3**). Wave 3; deps R2/R4/R6 all merged (last dispatcher surgeon). Playbook §R8. Owned: `apps/server/src/dispatcher.ts` + server tests only — no core/ui/jobs changes.

## What changed — `apps/server/src/dispatcher.ts`

### Perf (S4-F2)

1. **Parallelized `loadFactContext`** — its 9 sequential full-table SELECTs now run in one `Promise.all` (was 9 round-trips per gated clock-in/completion).
2. **Per-batch context cache (`BatchContext`).** A whole upload batch is one user's sequential commands, so the heavy `tree`/`edgeIndex`/`factContext` loads are memoized across the batch and reloaded only when a prior command wrote the underlying table. Correctness model: each command reads the context BEFORE it writes (invariant checks), so the cache always reflects the latest COMMITTED state per table; the in-txn automation reads fresh (uncached) because it must see the handler's own write.
3. **Declarative, auditable invalidation** (`CONTEXT_WRITES`): a command→tables map that MUST be a superset of a command's actual context writes; a command absent from the map invalidates ALL context tables (the safe default — over-invalidation only costs a reload, never correctness). Verified narrow entries for all `node.*` (→`nodes`, +`edges` where automation spawns), `edge.*` (→`edges`), `block.*` (→`schedule_blocks`), `timer.*` (→`time_entries`), `settings.update` (→`user_settings`); everything else (habit/decision/rule/blocker/sprint/layout/group/tag/review) safely defaults to all. A `disableBatchCache` option is the kill-switch + the perf-test baseline.

### Effects channel (S4-F3 / D3)

A per-command `EffectSummary[]` collector threaded through `runHandler` (a `rec(table, row_id, op, fields?)` helper at the common write sites: `updateNode`, `node.create`/`check_off`/`move`/`retype`/`soft_delete`/`activity.promote`, `edge.create`/`delete`, `block.create`, `timer.clock_in`) and through `runAutomationInTx` (spawned rows recorded with `triggering_command_id` = the user command, only for rows actually inserted and only after the SAVEPOINT commits). Written to `command_log.effects` in the same txn (empty on rejection).

## Tests

- **NEW `perf.write-path.integration.test.ts`** (gated on `PRISMS_DB_TEST_URL`): seeds a 100k-node account, then times a 20-edge DAG-chain of `edge.create` (each runs `checkEdgeCreate` over the full tree, but writes only `edges` → the 100k `tree` load survives when cached) with cache OFF vs ON. **Measured: baseline 22 181ms → cached 1 260ms = 17.6×.** Hard-asserts ≥3× (huge headroom; the ratio is contention-robust — starvation slows both runs proportionally); 120/180s timeouts guard turbo concurrency.
- **`dispatcher.integration.test.ts` +1**: rename → a `nodes` update effect naming `title`; check_off → the completion update naming `completed_at` + the automation-spawned node carrying `triggering_command_id` = the check_off command (§7.2f).

## Evidence (gate)

- server (live PG 5434): **15 files / 125 tests** (123 + perf + effects) — full suite incl. convergence **15/15** (response contract unchanged, the harness proves it) and dispatcher **31**.
- `pnpm turbo lint typecheck test` (with `PRISMS_DB_TEST_URL`): **21/21** (server perf test survived concurrency).
- core/ui **untouched** (coverage unaffected).

## Notes / deferrals

- **Stretch skipped (per playbook §R8.4):** S4-F7 (per-(user,device) last-applied-HLC floor) and Annex-A2 (far-future clock-skew hard-reject + `clock_skew` review item). Both are hardening, not the write-path cliff; deferred to keep this high-risk file's change focused. Recorded for R10/backlog.
- **Cache scope (honest):** `factContext` aggregates all 9 tables, so ANY context write invalidates it — it rarely survives across commands. The big cross-command win is the `tree` cache (invalidated only by `nodes` writes), which survives across edge/block/timer/non-structural commands — the 17.6× above. A true incremental server context (the audit's "long term", mirroring the client StatusIndex) would also cache `factContext` across writes; deferred as a larger build.
- **Effects coverage (honest):** the collector is wired at the common verbs + both tested paths; long-tail verbs (habit/decision/rule/blocker/sprint/layout/group/tag/review, `block.move`/`set_anchor`/`delete`/`accept`/`reject`, `timer.clock_out`/`review`) currently emit empty effects. The channel is no longer always-empty and is trivially extensible (add `rec(...)` at those sites); the D3 requirement (populate + automation attribution) is met for the representative set.
- **Handoff (R10):** the `disableBatchCache` kill-switch exists if a staging soak surfaces any cache-correctness surprise; the `CONTEXT_WRITES` map is the single place to audit invalidation.
