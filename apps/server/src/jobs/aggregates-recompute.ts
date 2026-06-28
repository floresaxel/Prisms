/**
 * aggregates.recompute (§7.4, §11, cron nightly per-user after their day-reset):
 * recompute the canonical aggregates with the SAME core functions the client
 * runs incrementally, and overwrite `computed_aggregates` with
 * computed_by='server' / source_kind='server_job'. Client drift self-heals
 * (§7.2): server values win on the next sync.
 *
 * Reads and writes run in ONE transaction (consistent snapshot), and each upsert
 * is guarded so it never clobbers a row written AFTER this run's snapshot — i.e.
 * a concurrent command's fresher value survives (§7.4).
 *
 * One logic, two tiers (§2.4): this job is just the canonical entry point of the
 * same module the client calls.
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
  type Tag,
  type TagAnswer,
  type TagPlacement,
  type TimeEntry,
} from '@prisms/core';
import { computed_aggregates, habits, habit_completions, nodes, schedule_blocks, tags, tag_placements, tag_answers, time_entries, user_settings } from '@prisms/db';
import { and, eq, isNotNull, isNull, lte } from 'drizzle-orm';
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

  return db.transaction(async (tx) => {
    const [nodeRows, entryRows, habitRows, completionRows, blockRows, tagRows, placementRows, answerRows, settingsRow] = await Promise.all([
      tx.select().from(nodes).where(eq(nodes.user_id, userId)),
      tx.select().from(time_entries).where(eq(time_entries.user_id, userId)),
      tx.select().from(habits).where(eq(habits.user_id, userId)),
      tx.select().from(habit_completions).where(eq(habit_completions.user_id, userId)),
      tx.select().from(schedule_blocks).where(eq(schedule_blocks.user_id, userId)),
      tx.select().from(tags).where(eq(tags.user_id, userId)),
      tx.select().from(tag_placements).where(eq(tag_placements.user_id, userId)),
      tx.select().from(tag_answers).where(eq(tag_answers.user_id, userId)),
      tx.select().from(user_settings).where(eq(user_settings.user_id, userId)).limit(1),
    ]);

    const settings = settingsRow[0]
      ? { day_reset_hour: settingsRow[0].day_reset_hour, timezone: settingsRow[0].timezone }
      : DEFAULT_SETTINGS;
    const tree = buildTreeIndex(nodeRows as CoreNode[]);

    const upsert = async (subjectKind: 'habit' | 'node' | 'user', subjectId: string | null, metric: string, value: unknown) => {
      const set = { value: value as never, computed_at: nowIso, computed_by: 'server' as const, updated_at: nowIso, source_kind: 'server_job' as const };
      const ins = tx.insert(computed_aggregates).values({
        id: randomUUID(),
        user_id: userId,
        subject_kind: subjectKind,
        subject_id: subjectId,
        metric,
        value: value as never,
        computed_at: nowIso,
        computed_by: 'server',
        updated_at: nowIso,
        source_kind: 'server_job',
      });
      // §7.7 dual partial unique index: target the user-level index for a NULL
      // subject_id and the subject-level index otherwise, with matching predicates.
      // §7.4 guard (setWhere): only overwrite a row not written after this snapshot,
      // so a concurrent command's fresher value is never clobbered.
      const guard = lte(computed_aggregates.updated_at, nowIso);
      if (subjectId === null) {
        await ins.onConflictDoUpdate({
          target: [computed_aggregates.user_id, computed_aggregates.subject_kind, computed_aggregates.metric],
          targetWhere: and(isNull(computed_aggregates.subject_id), isNull(computed_aggregates.deleted_at)),
          set,
          setWhere: guard,
        });
      } else {
        await ins.onConflictDoUpdate({
          target: [computed_aggregates.user_id, computed_aggregates.subject_kind, computed_aggregates.subject_id, computed_aggregates.metric],
          targetWhere: and(isNotNull(computed_aggregates.subject_id), isNull(computed_aggregates.deleted_at)),
          set,
          setWhere: guard,
        });
      }
    };

    const tagList = tagRows as Tag[];
    const placementList = placementRows as TagPlacement[];
    const answerList = answerRows as TagAnswer[];
    const liveAnswer = new Map(answerList.filter((a) => a.deleted_at === null).map((a) => [a.placement_id, a.value]));

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
          tags: tagList,
          tag_placements: placementList,
          tag_answers: answerList,
          settings,
        },
        now,
      );
      await upsert('habit', habit.id, 'streak', streak);
      const practice = canonicalPractice(habit, nodeRows as CoreNode[], entryRows as TimeEntry[]);
      await upsert('habit', habit.id, 'practice_hours', practice);

      // tag_confirmation tally for the dashboard (§ tags / Phase 4b): yes/no/pending
      // across the habit's habit-scoped tag placements.
      const habitTagIds = new Set(tagList.filter((t) => t.deleted_at === null && t.habit_id === habit.id).map((t) => t.id));
      let yes = 0;
      let no = 0;
      let pending = 0;
      for (const pl of placementList) {
        if (pl.deleted_at !== null || !habitTagIds.has(pl.tag_id)) continue;
        const a = liveAnswer.get(pl.id);
        if (a === 'yes') yes += 1;
        else if (a === 'no') no += 1;
        else pending += 1;
      }
      await upsert('habit', habit.id, 'tag_confirmation', { yes, no, pending });
      aggregates += 3;
    }

    let projects = 0;
    for (const node of nodeRows as CoreNode[]) {
      if (node.node_type !== 'project' || node.deleted_at !== null) continue;
      projects += 1;
      await upsert('node', node.id, 'progress', canonicalCompletion(node.id, tree));
      aggregates += 1;
    }

    return { habits: habitRows.filter((h) => h.deleted_at === null).length, projects, aggregates };
  });
}

/** Cron entry point: recompute every user that has settings. */
export async function runAggregatesRecomputeAll(db: PostgresJsDatabase, clock: JobClock): Promise<number> {
  const users = await db.select({ user_id: user_settings.user_id }).from(user_settings);
  for (const u of users) await runAggregatesRecompute(db, u.user_id, clock);
  return users.length;
}
