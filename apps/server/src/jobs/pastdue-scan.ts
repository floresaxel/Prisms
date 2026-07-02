/**
 * pastdue.scan (§11, cron 15 min): find incomplete tasks whose due date has
 * passed and that have no committed block still ahead, attach exactly one
 * suggested replacement block (greedy earliest-fit, §10), and enqueue a
 * warning notification (§11 notify.dispatch). Accept/reject is a plain
 * mutation (§2.6), so it works offline.
 *
 * Idempotent: a task that already has a `past_due_reschedule` suggestion is
 * skipped, so re-scanning never produces a second suggestion row.
 */
import { randomUUID } from 'node:crypto';

import { asEpochMillis, bucketDate, rescheduleTask } from '@prisms/core';
import { nodes, schedule_blocks, schedule_suggestion_batches, user_settings } from '@prisms/db';
import { and, eq, isNotNull, isNull, lt } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import type { JobClock } from './clock';
import { loadSchedulerInput } from './scheduler-context';

export const PAST_DUE_RESCHEDULE = 'past_due_reschedule';

export interface PastDueNotification {
  userId: string;
  taskId: string;
  title: string;
}

export interface PastDueResult {
  pastDue: number;
  suggested: number;
  notifications: PastDueNotification[];
}

export async function runPastdueScan(
  db: PostgresJsDatabase,
  userId: string,
  clock: JobClock,
  enqueueNotify?: (n: PastDueNotification) => void,
): Promise<PastDueResult> {
  const now = clock.now();
  const nowMs = asEpochMillis(now);
  const nowIso = new Date(now).toISOString();

  const settingsRow = (await db.select().from(user_settings).where(eq(user_settings.user_id, userId)).limit(1))[0];
  const settings = settingsRow ?? { day_reset_hour: 4, timezone: 'America/New_York' };
  const today = bucketDate(nowMs, settings.day_reset_hour, settings.timezone);

  // Past-due filter pushed to SQL (S5-F6): only incomplete tasks with a due date
  // already before today reach the JS pass, which then drops those still holding
  // a future committed block.
  const taskRows = await db
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.user_id, userId),
        eq(nodes.node_type, 'task'),
        isNull(nodes.completed_at),
        isNull(nodes.deleted_at),
        isNotNull(nodes.due_date),
        lt(nodes.due_date, today),
      ),
    );
  const blockRows = await db.select().from(schedule_blocks).where(and(eq(schedule_blocks.user_id, userId), isNull(schedule_blocks.deleted_at)));

  // a committed block still ahead means it's already (re)scheduled
  const hasFutureCommitted = new Set<string>();
  const hasPastDueSuggestion = new Set<string>();
  for (const block of blockRows) {
    if (block.status === 'committed' && new Date(block.ends_at).getTime() > now) hasFutureCommitted.add(block.task_id);
    if (block.status === 'suggested' && block.suggestion_reason === PAST_DUE_RESCHEDULE) hasPastDueSuggestion.add(block.task_id);
  }

  const pastDue = taskRows.filter((t) => !hasFutureCommitted.has(t.id));
  if (pastDue.length === 0) return { pastDue: 0, suggested: 0, notifications: [] };

  const input = await loadSchedulerInput(db, userId, { now, mode: 'greedy' });

  return db.transaction(async (tx) => {
    // Reuse the active past_due batch (idempotent across scans); create it lazily on
    // the first new suggestion. §7.8: suggestions carry source_kind='scheduler'.
    let batchId = (
      await tx
        .select({ id: schedule_suggestion_batches.id })
        .from(schedule_suggestion_batches)
        .where(
          and(
            eq(schedule_suggestion_batches.user_id, userId),
            eq(schedule_suggestion_batches.source, 'past_due'),
            isNull(schedule_suggestion_batches.superseded_at),
            isNull(schedule_suggestion_batches.deleted_at),
          ),
        )
        .limit(1)
    )[0]?.id as string | undefined;

    let suggested = 0;
    // §11: warn ONCE, when the past_due_reschedule suggestion is first created —
    // not on every 15-min scan (S5-F3). A task that already has a suggestion is
    // skipped, so no re-notify; a task we can't slot yet gets neither suggestion
    // nor spam this round.
    const notifications: PastDueNotification[] = [];
    for (const task of pastDue) {
      if (hasPastDueSuggestion.has(task.id)) continue; // exactly one suggestion per task

      const result = rescheduleTask(task.id, { ...input, tasks: input.tasks.map((t) => (t.id === task.id ? { ...t, notBefore: nowMs } : t)) });
      if (!('startsAt' in result)) continue;

      if (batchId === undefined) {
        batchId = randomUUID();
        await tx.insert(schedule_suggestion_batches).values({
          id: batchId,
          user_id: userId,
          source: 'past_due',
          horizon_start: nowIso,
          horizon_end: new Date(nowMs + 7 * 86_400_000).toISOString(),
          computed_at: nowIso,
          superseded_at: null,
          updated_at: nowIso,
          source_kind: 'server_job',
        });
      }
      await tx.insert(schedule_blocks).values({
        id: randomUUID(),
        user_id: userId,
        task_id: task.id,
        starts_at: new Date(result.startsAt).toISOString(),
        ends_at: new Date(result.endsAt).toISOString(),
        anchor_type: 'none',
        status: 'suggested',
        suggestion_reason: PAST_DUE_RESCHEDULE,
        suggestion_batch_id: batchId,
        computed_at: nowIso,
        updated_at: nowIso,
        source_kind: 'scheduler',
        source_id: batchId,
      });
      suggested += 1;
      const notification: PastDueNotification = { userId, taskId: task.id, title: task.title };
      notifications.push(notification);
      enqueueNotify?.(notification);
    }
    return { pastDue: pastDue.length, suggested, notifications };
  });
}

/** Cron entry point: scan every user that has settings. */
export async function runPastdueScanAll(
  db: PostgresJsDatabase,
  clock: JobClock,
  enqueueNotify?: (n: PastDueNotification) => void,
): Promise<number> {
  const users = await db.select({ user_id: user_settings.user_id }).from(user_settings);
  for (const u of users) await runPastdueScan(db, u.user_id, clock, enqueueNotify);
  return users.length;
}
