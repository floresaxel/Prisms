# Remediation Session R4 — Server jobs lifecycle + automation attribution

Branch `remediation` (sequential mode). Findings addressed: **S5-F1**, **S5-F2**, **S5-F3**, **S5-F5**, **S3-F4** (+S5-F8/S8-F5 lit up), S5-F6 (cheap wins). Playbook: `Blueprints/REMEDIATION_PLAYBOOK.md` §R4.

## What changed

### S5-F1 — review-expire wired + review/tag rows reclaimed
- **`boss.ts`** — new `reviewExpire: 'review.expire'` queue, worker (`runReviewExpireResolved`), and weekly schedule (`0 4 * * 0`, after `retention.purge`). The job logic already existed and was tested; it was simply never scheduled.
- **`retention-purge.ts`** — `PURGE_ORDER` gains `sync_review_items`, `tag_answers`, `tag_placements` (referencing-first, ahead of `schedule_blocks` which `tag_placements` references — this also fixes a latent bug where a soft-deleted block with a lingering placement could never purge). `tags` is purged separately with a `NOT EXISTS (tag_placements)` guard (a soft-deleted tag with a live placement waits, avoiding an FK NO ACTION throw), mirroring the existing `nodes` pattern.

### S5-F2 — optimize suggestions stamp `replaces_block_id` (accepting a move no longer double-books)
- **`schedule-optimize.ts`** — builds `replaceableByTask` from `input.committed` (the earliest **flexible** i.e. non-anchored committed block per task — exactly the set `placement.ts:171-174` un-obstacles) and stamps it as `replaces_block_id` on each suggested block. `accept_suggestion` already soft-deletes `replaces_block_id` when set (`dispatcher.ts:646`), so the move now replaces rather than adds. Anchored blocks are never replaced. No `scheduler-context.ts` edit needed — `CommittedBlock` already carries `id`+`anchored`.

### S5-F3 — past-due warnings fire once, not every 15 min
- **`pastdue-scan.ts`** — removed the eager "notify every past-due task each scan" block; the notification is now built and `enqueueNotify`'d **inside** the first-suggestion branch, so a task that already has a `past_due_reschedule` suggestion (the idempotence set) is skipped and never re-notified. Tradeoff (documented in-code): a task that can't yet be slotted gets neither a suggestion nor a warning that round — acceptable vs. the alternative watermark column (deferred; would need a migration, out of R4 scope).

### S5-F5 — aggregates recompute reads a real snapshot
- **`aggregates-recompute.ts`** — the nine-table read + upsert transaction now runs at `isolationLevel: 'repeatable read'`, pinning every statement to the txn-start snapshot so a mid-flight command commit can't tear the cross-table read. The existing `updated_at <= snapshot` no-clobber write guard is unchanged.

### S3-F4 — template/rule version attribution is real (V6 half)
- **`core/rules/actions.ts`** — `export const TEMPLATE_VERSION = 1` (code-level template-semantics version).
- **`core/rules/engine.ts`** — `SpawnProvenance` gains `rule_version` + `template_version`; both push sites stamp `rule.rule_version` and `TEMPLATE_VERSION`.
- **`dispatcher.ts` `stampProv`** (my only region there) and **`automation-backstop.ts` `prov`** — write both into `source_detail`; the backstop drift item detail records both versions + both content hashes. `ruleVersionOf` (which re-looked-up the rule) is gone — provenance now carries the version directly.
- **`ui/provenance.ts`** — untouched (reads `rule_version`/`template_version` already; S8-F5's blank line now renders).

### S5-F6 — cheap efficiency wins taken
- `pastdue-scan.ts` pushes `due_date IS NOT NULL AND due_date < today` into SQL (was a JS filter over all incomplete tasks). Deferred (documented): the row-by-row insert awaits and the hourly-all-users recompute cadence redesign (needs bigger changes; out of scope).

## Tests

- **`jobs.integration.test.ts`**: new `retention.purge reclaims soft-deleted review items + the tag chain` (review item beyond cutoff purged, recent survives; full tag→placement→answer chain gone; needed a real node for the block FK); drift test extended to assert `rule_version: 1, template_version: 1` in the drift detail; backstop fill test's `source_detail` assertion extended with both versions.
- **`jobs2.integration.test.ts`**: pastdue test extended — the **second** scan passes a notify collector and asserts **no** notification (`second.notifications` empty, collector empty); new `schedule.optimize stamps replaces_block_id … accept does not double-book` — gives a task a flexible committed block, runs the real optimize job, asserts the suggested row's `replaces_block_id` = the old block, then runs the real `block.accept_suggestion` command and asserts exactly one committed block remains and the old one is soft-deleted. This is the S5-F2 end-to-end pin (it runs the actual job + command, a stronger home than the convergence harness — see deviation note).
- **`dispatcher.integration.test.ts`**: in-txn spawn `source_detail` assertion extended with both versions (the primary automation path).
- **`core/rules/engine.test.ts`**: new focused unit test — every spawned node/edge has a provenance entry with `rule_id`, correct `slot`, `rule_version: 1`, `template_version: 1` (the pre-R4 bug was `template_version` read by the UI but never written).

## Evidence (gate)

- core: typecheck ✓ · lint ✓ (2 pre-existing `load.perf.test.ts` warnings — R7's file) · coverage **90.49 / 93.36 / 93.6** (≥90 floor).
- server (live PG 5434): **13 files / 117 tests** (+2 vs R3's 115).
- `pnpm turbo lint typecheck test` (with `PRISMS_DB_TEST_URL`): **21/21**.

## Deviation from playbook

- **Harness "scenario 14"** (optimize-move → accept → no double-book) landed in **`jobs2.integration.test.ts`**, not `convergence.integration.test.ts`. Rationale: it's a server-job + command-flow assertion, not a two-device convergence property; jobs2 already wires the real `runScheduleOptimize` + dispatcher, so the test exercises the actual components rather than the harness's `Device`/replica model. The behavioral coverage the playbook asked for (the double-book fix pinned by a test that runs the real optimize job and the real accept command) is fully delivered. The convergence harness stays reserved for convergence-shaped scenarios (R2's 13b, R3's extended 9).

## Notes / out-of-scope

- Review-expire **schedule wiring** is verified by inspection (3-line plumbing in `boss.ts` mirroring `retentionPurge`) plus the existing `runReviewExpireResolved` behavioral test; I did not boot pg-boss to assert the cron registration (heavy, low marginal value).
- `boss.ts` comment corrected: review.expire soft-deletes closed items; retention.purge reclaims those tombstones ~90 days later (the two schedules are independent, not same-day-chained).
- S5-F6 cadence redesign (nightly-per-user vs hourly-all-users) and batch inserts deferred — bigger changes, explicitly out of the "quick wins" scope.
