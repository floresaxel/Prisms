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
import { schedule_blocks, user_settings } from '@prisms/db';
import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import type { JobClock } from './clock';
import { loadSchedulerInput } from './scheduler-context';

export const NIGHTLY_OPTIMIZATION = 'nightly_optimization';

export interface OptimizeResult {
  suggestions: number;
}

export async function runScheduleOptimize(db: PostgresJsDatabase, userId: string, clock: JobClock): Promise<OptimizeResult> {
  const now = clock.now();
  const nowIso = new Date(now).toISOString();
  const input = await loadSchedulerInput(db, userId, { now, mode: 'optimize' });
  const { proposals } = schedule(input);

  return db.transaction(async (tx) => {
    // clear the previous nightly suggestions (hard delete; they were never facts)
    await tx
      .delete(schedule_blocks)
      .where(and(eq(schedule_blocks.user_id, userId), eq(schedule_blocks.status, 'suggested'), eq(schedule_blocks.suggestion_reason, NIGHTLY_OPTIMIZATION)));

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
        computed_at: nowIso,
        updated_at: nowIso,
      });
    }
    return { suggestions: proposals.length };
  });
}

/** Cron entry point: optimize every user that has settings. */
export async function runScheduleOptimizeAll(db: PostgresJsDatabase, clock: JobClock): Promise<number> {
  const users = await db.select({ user_id: user_settings.user_id }).from(user_settings);
  for (const u of users) await runScheduleOptimize(db, u.user_id, clock);
  return users.length;
}
