/**
 * schedule.optimize (§11, cron nightly + enqueued on big plan changes): run
 * the optimize-mode scheduler (§10, S9) over the user's plan and write the
 * proposal diffs as `schedule_blocks(status='suggested')`. The proposals are
 * already only the changes vs the committed plan (S9 diffing); the user
 * accepts/rejects each via block.accept_suggestion / reject_suggestion.
 *
 * Idempotent: prior nightly suggestions are cleared before writing the new
 * set, so re-running converges rather than piling up.
 */
import { randomUUID } from 'node:crypto';

import { schedule } from '@prisms/core';
import { schedule_blocks, schedule_suggestion_batches, user_settings } from '@prisms/db';
import { and, eq, isNull } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import type { JobClock } from './clock';
import { forEachUserIsolated, type BatchOutcome } from './per-user';
import { loadSchedulerInput } from './scheduler-context';

export const NIGHTLY_OPTIMIZATION = 'nightly_optimization';
const HORIZON_DAYS = 7;

export interface OptimizeResult {
  suggestions: number;
  batchId: string | null;
}

export async function runScheduleOptimize(db: PostgresJsDatabase, userId: string, clock: JobClock): Promise<OptimizeResult> {
  const now = clock.now();
  const nowIso = new Date(now).toISOString();
  const horizonEnd = new Date(now + HORIZON_DAYS * 86_400_000).toISOString();
  const input = await loadSchedulerInput(db, userId, { now, mode: 'optimize' });
  // §10: the scheduler honours FS/SS/FF/SF edge placement; proposals are diffs vs committed.
  const { proposals } = schedule(input);

  // §7.5 replacement link: an optimize proposal for a task that already has a
  // FLEXIBLE committed block is a MOVE — placement treats such blocks as
  // replaceable (they aren't obstacles for their own task), so the proposal may
  // even overlap the old block. Stamp the earliest flexible committed block as
  // `replaces_block_id` so accept_suggestion soft-deletes it instead of leaving
  // the task double-booked (S5-F2). Anchored blocks are real obstacles → never
  // replaced.
  const replaceableByTask = new Map<string, { id: string; startsAt: number }>();
  for (const b of input.committed) {
    if (b.anchored) continue;
    const prev = replaceableByTask.get(b.taskId);
    if (prev === undefined || b.startsAt < prev.startsAt) {
      replaceableByTask.set(b.taskId, { id: b.id, startsAt: b.startsAt });
    }
  }

  return db.transaction(async (tx) => {
    // §7.5: a newer batch supersedes the prior non-accepted batch of this strategy;
    // mark the prior batch superseded (a syncable signal) and clear its stale
    // suggested blocks (they were never facts).
    await tx
      .update(schedule_suggestion_batches)
      .set({ superseded_at: nowIso, updated_at: nowIso })
      .where(
        and(
          eq(schedule_suggestion_batches.user_id, userId),
          eq(schedule_suggestion_batches.source, 'nightly_optimize'),
          isNull(schedule_suggestion_batches.superseded_at),
          isNull(schedule_suggestion_batches.deleted_at),
        ),
      );
    await tx
      .delete(schedule_blocks)
      .where(and(eq(schedule_blocks.user_id, userId), eq(schedule_blocks.status, 'suggested'), eq(schedule_blocks.suggestion_reason, NIGHTLY_OPTIMIZATION)));

    if (proposals.length === 0) return { suggestions: 0, batchId: null };

    const batchId = randomUUID();
    await tx.insert(schedule_suggestion_batches).values({
      id: batchId,
      user_id: userId,
      source: 'nightly_optimize',
      horizon_start: nowIso,
      horizon_end: horizonEnd,
      computed_at: nowIso,
      superseded_at: null,
      updated_at: nowIso,
      source_kind: 'server_job',
    });

    for (const proposal of proposals) {
      await tx.insert(schedule_blocks).values({
        id: randomUUID(),
        user_id: userId,
        task_id: proposal.taskId,
        starts_at: new Date(proposal.startsAt).toISOString(),
        ends_at: new Date(proposal.endsAt).toISOString(),
        anchor_type: 'none',
        status: 'suggested',
        suggestion_reason: NIGHTLY_OPTIMIZATION,
        suggestion_batch_id: batchId,
        // §7.5: if this task already has a flexible committed block, accepting the
        // proposal replaces it (soft-delete) instead of double-booking (S5-F2).
        replaces_block_id: replaceableByTask.get(proposal.taskId)?.id ?? null,
        computed_at: nowIso,
        updated_at: nowIso,
        // §7.8: scheduler suggestions carry source_kind='scheduler', source_id=batch.
        source_kind: 'scheduler',
        source_id: batchId,
      });
    }
    return { suggestions: proposals.length, batchId };
  });
}

/** Cron entry point: optimize every user that has settings (SEC-6/F9: per-user isolated). */
export async function runScheduleOptimizeAll(db: PostgresJsDatabase, clock: JobClock): Promise<BatchOutcome> {
  const users = await db.select({ user_id: user_settings.user_id }).from(user_settings);
  return forEachUserIsolated(users, 'schedule.optimize', (u) => u.user_id, (u) => runScheduleOptimize(db, u.user_id, clock));
}
