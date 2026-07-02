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
- **`jobs2.integration.test.ts`**: pastdue test extended — the **second** scan passes a notify collector and asserts **no** notification (`second.notifications` empty, collector empty); `schedule.optimize stamps replaces_block_id` — the job-level unit concern: a flexible committed block yields a MOVE proposal carrying the replacement link, and an **anchored** committed block is never stamped as replaced (guard).
- **`convergence.integration.test.ts` — scenario 14 (the harness's 15th)**: the accept → no-double-book **end-to-end through the two-layer overlay** — seed an estimated task with an off-window flexible committed block, run the real `runScheduleOptimize` (asserts `replaces_block_id` stamped), then a real `Device` accepts via an overlay envelope + `sync`/reconcile; the converged Postgres state has exactly one committed block and the old one soft-deleted. This is the DoD's "convergence green (15 scenarios)".
- **`boss.test.ts`** (new, no-DB): asserts `review.expire` is scheduled weekly (`0 4 * * 0`), retention weekly, every scheduled queue is a registered `QUEUE`, and none is scheduled twice — the "review-expire scheduled (boss registration assert)" DoD item, made assertable by extracting the cron list into an exported `SCHEDULES` constant that `startJobs` loops over (identical runtime behavior).
- **`dispatcher.integration.test.ts`**: in-txn spawn `source_detail` assertion extended with both versions (the primary automation path).
- **`core/rules/engine.test.ts`**: new focused unit test — every spawned node/edge has a provenance entry with `rule_id`, correct `slot`, `rule_version: 1`, `template_version: 1` (the pre-R4 bug was `template_version` read by the UI but never written).

## Evidence (gate)

- core: typecheck ✓ · lint ✓ (2 pre-existing `load.perf.test.ts` warnings — R7's file) · coverage **90.49 / 93.36 / 93.6** (≥90 floor; core unchanged in the completion pass).
- server (live PG 5434): **13 files / 122 tests** (117 from the first R4 pass + 4 `boss.test.ts` + harness scenario 14; jobs2 net unchanged — trimmed accept, added anchored guard).
- convergence harness: **15 scenarios** (`pnpm test:convergence` green), matching the DoD.
- `pnpm turbo lint typecheck test` (with `PRISMS_DB_TEST_URL`): **21/21**.

## Notes / out-of-scope

- `boss.ts` comment corrected: review.expire soft-deletes closed items; retention.purge reclaims those tombstones ~90 days later (the two schedules are independent, not same-day-chained).
- S5-F6 cadence redesign (nightly-per-user vs hourly-all-users) and batch inserts deferred — bigger changes, explicitly out of the "quick wins" scope.
