/**
 * aggregates.recompute (§11, cron nightly per-user after their day-reset):
 * recompute the canonical aggregates with the SAME core functions the client
 * runs incrementally, and overwrite `computed_aggregates` with
 * computed_by='server'. Client drift self-heals (§7.2): server values always
 * win on the next sync.
 *
 * One logic, two tiers (§2.4): this job is just the canonical entry point of
 * the same module the client calls.
 */
import { randomUUID } from 'node:crypto';

import {
  canonicalCompletion,
  canonicalPractice,
  canonicalStreak,
  buildTreeIndex,
  asEpochMillis,
  type Habit,
  type HabitCompletion,
  type Node as CoreNode,
  type ScheduleBlock,
  type TimeEntry,
} from '@prisms/core';
import { computed_aggregates, habits, habit_completions, nodes, schedule_blocks, time_entries, user_settings } from '@prisms/db';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import type { JobClock } from './clock';

const DEFAULT_SETTINGS = { day_reset_hour: 4, timezone: 'America/New_York' };

export interface RecomputeResult {
  habits: number;
  projects: number;
  aggregates: number;
}

export async function runAggregatesRecompute(
  db: PostgresJsDatabase,
  userId: string,
  clock: JobClock,
): Promise<RecomputeResult> {
  const now = asEpochMillis(clock.now());
  const nowIso = new Date(clock.now()).toISOString();

  const [nodeRows, entryRows, habitRows, completionRows, blockRows, settingsRow] = await Promise.all([
    db.select().from(nodes).where(eq(nodes.user_id, userId)),
    db.select().from(time_entries).where(eq(time_entries.user_id, userId)),
    db.select().from(habits).where(eq(habits.user_id, userId)),
    db.select().from(habit_completions).where(eq(habit_completions.user_id, userId)),
    db.select().from(schedule_blocks).where(eq(schedule_blocks.user_id, userId)),
    db.select().from(user_settings).where(eq(user_settings.user_id, userId)).limit(1),
  ]);

  const settings = settingsRow[0]
    ? { day_reset_hour: settingsRow[0].day_reset_hour, timezone: settingsRow[0].timezone }
    : DEFAULT_SETTINGS;
  const tree = buildTreeIndex(nodeRows as CoreNode[]);

  const upsert = async (subjectKind: 'habit' | 'node' | 'user', subjectId: string | null, metric: string, value: unknown) => {
    await db
      .insert(computed_aggregates)
      .values({
        id: randomUUID(),
        user_id: userId,
        subject_kind: subjectKind,
        subject_id: subjectId,
        metric,
        value: value as never,
        computed_at: nowIso,
        computed_by: 'server',
        updated_at: nowIso,
      })
      .onConflictDoUpdate({
        target: [computed_aggregates.user_id, computed_aggregates.subject_kind, computed_aggregates.subject_id, computed_aggregates.metric],
        set: { value: value as never, computed_at: nowIso, computed_by: 'server', updated_at: nowIso },
      });
  };

  let aggregates = 0;
  for (const habit of habitRows as Habit[]) {
    if (habit.deleted_at !== null) continue;
    const streak = canonicalStreak(
      {
        habit,
        completions: completionRows as HabitCompletion[],
        nodes: nodeRows as CoreNode[],
        schedule_blocks: blockRows as ScheduleBlock[],
        time_entries: entryRows as TimeEntry[],
        settings,
      },
      now,
    );
    await upsert('habit', habit.id, 'streak', streak);
    const practice = canonicalPractice(habit, nodeRows as CoreNode[], entryRows as TimeEntry[]);
    await upsert('habit', habit.id, 'practice_hours', practice);
    aggregates += 2;
  }

  let projects = 0;
  for (const node of nodeRows as CoreNode[]) {
    if (node.node_type !== 'project' || node.deleted_at !== null) continue;
    projects += 1;
    await upsert('node', node.id, 'progress', canonicalCompletion(node.id, tree));
    aggregates += 1;
  }

  return { habits: habitRows.filter((h) => h.deleted_at === null).length, projects, aggregates };
}

/** Cron entry point: recompute every user that has settings. */
export async function runAggregatesRecomputeAll(db: PostgresJsDatabase, clock: JobClock): Promise<number> {
  const users = await db.select({ user_id: user_settings.user_id }).from(user_settings);
  for (const u of users) await runAggregatesRecompute(db, u.user_id, clock);
  return users.length;
}
