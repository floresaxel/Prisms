# Audit Session 5 — Server Jobs

Audited at commit `c1e02db` (branch `m0-spike`, clean; code identical to baseline `2ab3bf7` — later commits are docs-only), 2026-07-02.

**Scope examined:** `apps/server/src/jobs/{boss,retention-purge,review-expire,aggregates-recompute,automation-backstop,import-restore,schedule-optimize,pastdue-scan,notify-dispatch,weather-poll}.ts` in full; `backup-snapshot.ts` + `import-validate.ts` (headers + core logic); schema FK spot-checks. **Inventory-verified only (not line-audited):** `push.ts`, `layout-precompute.ts`, `scheduler-context.ts`, `clock.ts` — flagged for the Synthesis to treat as reduced-coverage.

**Verdict:** the individually hard parts are done well — the backstop implements V6's decision table exactly (fill / content-equivalent no-op / drift-item-never-overwrite, with content hashes), retention honors the R18 horizon with the right boundary, and import-restore passes every security-critical check (table allowlist, cross-account global-id guard, HLC-LWW keep-newer-local, non-replayable history, single txn, forced ownership/provenance). The failures are wiring and lifecycle: one §12 job is never scheduled, optimize suggestions never carry the replacement link the accept transaction depends on, past-due warnings re-notify every 15 minutes, and the S3-F2 double-count is confirmed in the canonical aggregates.

---

## Findings

### S5-F1 · Medium — `review.expire_resolved` is never scheduled, and review items are never purged: resolved items accumulate (and sync) forever

**Evidence:** `runReviewExpireResolved` (`jobs/review-expire.ts`) is correct (soft-deletes non-open items with `resolved_at` older than 30 d; open items survive at any age) — but `boss.ts` neither imports it, creates a queue for it, nor schedules it; a repo-wide grep finds its only caller is `jobs.integration.test.ts`. Compounding: `retention-purge.ts`'s `PURGE_ORDER` (`:26-43`) omits `sync_review_items` (and `tags`/`tag_placements`/`tag_answers`), so even soft-deleted items are never hard-deleted.

**Failure mode:** every rejection, backstop fill, drift, and import warning creates a durable synced row; closed ones are never expired (stage 1 never runs) and never reclaimed (stage 2 skips the table). The review table grows without bound and keeps syncing to every device. Same disease as S2-F3/S3-F2: built, tested, not wired.

**Suggested change:** add a `reviewExpire` queue + weekly schedule in `boss.ts` (three lines, mirroring `retentionPurge`); add the four missing tables to `PURGE_ORDER`.

### S5-F2 · Medium — optimize suggestions never set `replaces_block_id`: accepting a reschedule double-books the task

**Evidence:** `schedule-optimize.ts:71-88` inserts suggested blocks without `replaces_block_id`. The core placement deliberately treats a schedulable task's existing *flexible* committed blocks as replaceable — they are excluded from obstacles (`core/scheduler/placement.ts:171-174`) — so an optimize proposal for an already-scheduled task is a *move*. The accept transaction soft-deletes the replaced block **only** when the link exists (`dispatcher.ts:646-651`). §7.5's schema extension exists precisely for this ("replacement links").

**Failure mode:** task T has a flexible committed block Mon 9–10. Nightly optimize proposes Tue 2–3 (Mon block wasn't an obstacle, so the proposal may even overlap it). User accepts → Tue block committed, Mon block still committed → the task is double-booked, occupies two agenda slots, and `hasCommittedBlockAtOrAfter` keeps it `scheduled` off both.

**Suggested change:** in `scheduler-context.ts`/`schedule-optimize.ts`, when a proposal's task has live flexible committed block(s) in the horizon, stamp the earliest/overlapped one as `replaces_block_id` on the suggested row (the same information the placement already used to un-obstacle them). `pastdue-scan` is exempt by construction — it only targets tasks with **no** future committed block.

### S5-F3 · Medium — past-due warnings re-notify every 15 minutes for every past-due task

**Evidence:** `pastdue-scan.ts:63-65` enqueues a notification for **every** past-due task on **every** scan ("independent of whether a suggestion is produced"); the `hasPastDueSuggestion` idempotence set gates only suggestion creation (`:89`). `notify-dispatch.ts` sends to all registered targets with no dedup. Cron is `*/15 * * * *` (`boss.ts:96`).

**Failure mode:** one overdue task → a push notification to every device every 15 minutes, indefinitely, until the user completes/reschedules it. §12 intends "warning notification plus suggested replacement block" — once. This is the kind of behavior that gets notification permission revoked.

**Suggested change:** move `enqueueNotify` inside the first-suggestion branch (notify once, when the `past_due_reschedule` suggestion is first created), or persist a per-task `last_notified_at` watermark.

### S5-F4 · Medium — canonical `practice_hours` inherits the per-entry summation (S3-F2's server half, CONFIRMED)

**Evidence:** `aggregates-recompute.ts:131` computes `canonicalPractice(habit, nodeRows, entryRows)` — the same `aggregates/practice.ts` path that sums `effectiveMinutes(entry)` per entry (S3-F2). No job consumes `mergeTimeEntries`.

**Failure mode:** overlapping closed entries (both devices clocked in *and* out offline) double-count in the **server-canonical** aggregate too — the value that syncs down with `computed_by='server'` authority. Client and server agree on the same wrong number.

**Suggested change:** same fix as S3-F2 — union per task via `mergeTimeEntries`, then sum across tasks; fixing core's `canonicalPractice` fixes both tiers at once (one-logic-two-tiers working as designed).

### S5-F5 · Low-Medium — the "consistent transactional snapshot" claim runs at READ COMMITTED

**Evidence:** `aggregates-recompute.ts:54-65` — nine parallel SELECTs inside `db.transaction(...)` with no isolation option. Postgres default READ COMMITTED gives each statement its own snapshot, so the nine reads can observe different states when a command commits mid-flight. §12 job rules require "a consistent transactional snapshot"; the file's own doc-comment claims one.

**Failure mode:** transient cross-table inconsistency in a computed aggregate (e.g., a habit row visible but its just-committed completion missing). Self-heals on the next hourly run; the `setWhere: updated_at <= snapshot` no-clobber guard (correct, `:90-104`) protects against overwriting *newer* rows but not against reading torn state.

**Suggested change:** `db.transaction(fn, { isolationLevel: 'repeatable read' })` — one argument.

### S5-F6 · Low — job-tier efficiency: hourly full recompute for all users, per-row awaits, unfiltered scans

**Evidence:** `aggregates.recompute` runs hourly for **every** user (`boss.ts:92-93` + comment) vs the spec's nightly-per-user-after-day-reset — a documented refinement costing ~24× the compute, each run re-reading 9 user tables and upserting one row per aggregate sequentially. `pastdue-scan` selects **all** incomplete tasks + all blocks per user every 15 min and filters by due date in JS (`:49-60`). `import-restore`/`schedule-optimize` insert row-by-row with awaits.

**Suggested change:** gate recompute on the user's day-reset bucket (compute once/day/user); push the `due_date < today` filter into SQL with an index; batch inserts. None urgent at v1 scale; all worth doing before multi-user load.

### S5-F7 · Low — the 90-day `command_log` purge also erases user-facing history; §7.13's FK deliberately dropped

**Evidence:** `retention-purge.ts:82-84` deletes all `command_log` rows older than `MAX_OFFLINE_HORIZON` (R18-compliant: "retained **at least**" the horizon; strict `<` boundary correct; constants not env-forgeable). But `command_log` is also the R9/§7.2f user-facing history and the target of every `created_by_command_id`. The schema stores those links as plain uuids with an explicit "no FK" comment (`schema.ts:559`) — a documented deviation from §7.13's `REFERENCES command_log(id)` that makes the purge mechanically safe; after 90 d, WhyButton explanations degrade to row-level `source_kind`/`source_detail` (which survive on the rows).

**Suggested change:** decide the history-retention product stance explicitly: either retain `command_log` longer than the dedup horizon (split dedup from history — Annex A5's compaction is the designed vehicle), or document "history window = 90 days" in user-facing docs. Record the FK deviation as accepted in the spec.

### S5-F8 · Info — jobs rely on DB defaults for `hlc`/`schema_version`; drift items can't attribute versions

**Evidence:** backstop spawns (`prov()`, `:90-98`), optimize/past-due suggestion inserts, and aggregate upserts all omit `hlc`/`schema_version` (and backstop spawns omit `created_by_command_id` — they have no command). Integration tests pass, so column defaults presumably exist — **S6 must confirm** they're sane (a `LEGACY_HLC`-style floor, not something that outranks real writes). Backstop drift items record only the *current* `rule_version` + both content hashes (`:86-89,:157-164`) — the spawn-time version pair §10.2 wants is unrecordable because versions were never stamped at spawn time (S3-F4's root cause, third confirmation site).

### S5-F9 · Info — cadence/coverage deviations from §12, and a dry-run parity nit

**Evidence:** `schedule.optimize` "on major plan changes" enqueue path doesn't exist (cron only); `backup.snapshot`'s "optional schedule" doesn't exist (HTTP-only — fine); batch workers (`boss.ts:67-86`) fail a whole pg-boss batch if one job throws (idempotency makes retries safe; a per-job try/catch would be cleaner); push-subscription expiry cleanup unverified (`push.ts` not audited); `import-validate`'s conflict check is user-scoped while `import-restore`'s is global — a dry run won't preview cross-account-id skips. Export manifest omits §13.1's `app_version`/`checksums`/`attachments` fields (strict schema — deliberate simplification; attachments explicitly deferrable).

### S5-F10 · Info (refines S3-F8) — weather-conditioned automations can never fire server-side

**Evidence:** neither the dispatcher's in-txn automation (`dispatcher.ts:227-231`) nor the backstop (`automation-backstop.ts:60-64`) loads `external_facts`, so a `weather.*` condition always evaluates `unknown` → never fires (engine is conservative). Deterministic and V10-safe — but silently useless: a user authoring a weather-conditioned automation gets nothing, ever.

**Suggested change:** strengthens the S3-F8 recommendation — reject external-fact namespaces in automation conditions at `validateAutomationRule` (they cannot work), or deliberately feed facts to the engine and take the V10 stance explicitly.

---

## Resolved handoffs

| Handoff | Resolution |
|---|---|
| R18 write side: purge keeps dedup ≥ horizon (S4) | **PASS** — strict `<` on a 90-day constant; not env-forgeable; soft-delete retention (90 d) aligned with the offline horizon. History side-effect → F7. |
| Does aggregates-recompute sum per-entry hours? (S3-F2) | **YES — F4.** Server-canonical `practice_hours` double-counts the same way. |
| Backstop drift + version stamping (S3-F4) | Backstop's V6 decision table **PASS** (fill+item / equivalent no-op / drift item with both hashes, never overwrites, soft-deleted spawns not resurrected, spawns I1/I3-validated). Version attribution **FAIL** — only current `rule_version`, no `template_version` (F8). |
| Import table-name allowlist (S2) | **PASS** — fixed `RESTORE_ORDER` allowlist; unknown tables ignored with a warning; drizzle registry lookup only over known tables. |
| Superseded provenance on timer loser (S2-F1) | **CONFIRMED absent in jobs too** — no job touches it; the §7.10b `superseded` marker exists nowhere in the system. |
| Does any job issue `layout.renormalize_order`? (S2) | **NO** — the command exists and is dispatcher-handled, but no server path issues it; §7.10a's "server-issued or batched" cleanup never happens automatically (colliding fractions persist until a client sends the command). Fold into the F-series backlog as a wiring note. |

## Compliance checklist results

| Check (playbook §S5) | Result |
|---|---|
| Jobs idempotent under pg-boss retry; schedules match §12 | **PARTIAL** — logic idempotent by design (deterministic ids, converge-style upserts); `review.expire_resolved` unscheduled → F1; aggregates cadence deviates (documented) → F6/F9 |
| Backstop §10.2/V6: content equivalence, drift item, rule version at trigger time | **PASS** on the decision table; version attribution → F8/S3-F4 |
| Aggregates: consistent snapshot; no-clobber; computed_at + provenance; server-only writes | **PARTIAL** — no-clobber `setWhere` guard ✅ (DoF 10), `computed_at`/`computed_by`/`source_kind` ✅ (DoF 11); snapshot isolation → F5; correctness of hours → F4 |
| Retention V11/R18: horizon ≥ 90 d, `>=` boundary, server clock, not forceable below | **PASS** (boundary is strict-`<` on the delete = records exactly at horizon survive) |
| Suggestions §7.5: batches, replacement links, supersession, provenance | **PARTIAL** — batches ✅, supersession of prior nightly batch ✅, scheduler provenance (`source_kind='scheduler'`, `source_id=batch`) ✅; replacement links → F2 |
| review-expire: only resolved/dismissed expire; open durable | **PASS** as logic; unwired → F1 |
| Weather V10/R19/R14: neutral facts only, advisory, provider contained | **PASS** — injected `ForecastFetcher`, Open-Meteo at the edge with timeout, writes `external_facts` only; no job derives convergent state from weather (F10 notes automations can't see it at all) |
| notify/push: adapters at edge, poison handling | **PARTIAL** — adapter routing ✅; no dedup (→ F3), batch-failure granularity + expiry cleanup unverified (F9) |
| backup-snapshot §13.1 | **PASS** — versioned manifest, secrets excluded by registry construction, `command_history` non-replayable, `hlc_high_water` computed; minor field omissions (F9) |
| import-restore R20/V12: data-only, forced ownership/provenance, FK-ordered, HLC-LWW, global-id guard, dry-run | **PASS** — all verified, incl. parent-first nodes ordering and conflicts→`import_warning` items; dry-run parity nit (F9) |

## Matrix updates applied (sequential mode)

- V6 → ⚠️ kept (backstop decision table ✅ S5; `template_version` phantom persists — S3-F4/S5-F8)
- V11 → ✅ (S5: purge boundary + constants verified)
- R18 → ✅ (read side S4 + write side S5)
- R20 → server half ✅ (S5: data-only import + global-id guard + monotonicity via high-water; client floor → S8)
- V12 → server half ✅ (S5); encrypted-default on installed targets → S9
- R19 → note added (jobs side clean; the S3-F1 dispatcher gate remains the violation)
- R10 → partial (export/import/backup endpoints verified server-side; client UI + scripts → S8/S9/S10)

## Handoff items

1. **S6:** confirm DB defaults for `hlc`/`schema_version` on rows jobs insert without them (F8) — and that the default HLC sorts *below* real writes; verify the `tables` registry excludes `push_subscriptions`/auth (backup-snapshot's safety rests on it); indexes for `pastdue`'s scan and retention's `NOT EXISTS` probes.
2. **S7:** does the client run the rules engine in its overlay (R4 "spawning must work offline")? Neither server path gives the client its spawns until sync-down — if the client doesn't spawn optimistically, offline spawning does not exist. **Priority question.**
3. **S9:** does any UI offer "renormalize order" or is §7.10a cleanup entirely unreachable (see resolved-handoff table)?
4. **S10:** convergence-harness coverage of F2's double-book scenario (accept an optimize suggestion for an already-scheduled task); notification UX in the threat/quality pass; A5 (history compaction) as the F7 vehicle when prioritizing Annex A.

**Next:** Session 6 — DB schema, migrations, sync topology (`packages/db`, `infra/powersync`, compose) against §7.1/§7.3/§7.7/§7.8/§7.11, V5/V8.
