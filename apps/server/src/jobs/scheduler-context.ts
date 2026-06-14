/**
 * Shared loader: turn a user's DB rows into a core SchedulerInput (§10), used
 * by both schedule.optimize and pastdue.scan. Loads non-done sized tasks with
 * their dependency edges, committed blocks as obstacles, active-sprint
 * membership (an optimize soft signal), and the user's timezone.
 *
 * There is no window-config table in §6.0, so a sensible default daytime
 * window is used until one exists.
 */
import {
  asEpochMillis,
  bucketDate,
  DEFAULT_WINDOWS,
  type CommittedBlock,
  type EdgeType,
  type SchedulableTask,
  type SchedulerDependency,
  type SchedulerInput,
  type SchedulerMode,
} from '@prisms/core';
import { edges, nodes, schedule_blocks, sprint_memberships, sprints, user_settings } from '@prisms/db';
import { and, eq, isNull } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

// DEFAULT_WINDOWS now lives in @prisms/core (shared with the client agenda).
export { DEFAULT_WINDOWS } from '@prisms/core';

const DEFAULT_SETTINGS = { day_reset_hour: 4, timezone: 'America/New_York' };

export interface SchedulerContextOptions {
  now: number;
  horizonDays?: number;
  mode: SchedulerMode;
}

export async function loadSchedulerInput(
  db: PostgresJsDatabase,
  userId: string,
  options: SchedulerContextOptions,
): Promise<SchedulerInput> {
  const horizonDays = options.horizonDays ?? 14;
  const [nodeRows, edgeRows, blockRows, sprintRows, membershipRows, settingsRow] = await Promise.all([
    db.select().from(nodes).where(and(eq(nodes.user_id, userId), isNull(nodes.deleted_at))),
    db.select().from(edges).where(and(eq(edges.user_id, userId), isNull(edges.deleted_at))),
    db.select().from(schedule_blocks).where(and(eq(schedule_blocks.user_id, userId), isNull(schedule_blocks.deleted_at))),
    db.select().from(sprints).where(and(eq(sprints.user_id, userId), isNull(sprints.deleted_at))),
    db.select().from(sprint_memberships).where(and(eq(sprint_memberships.user_id, userId), isNull(sprint_memberships.deleted_at))),
    db.select().from(user_settings).where(eq(user_settings.user_id, userId)).limit(1),
  ]);

  const settings = settingsRow[0] ?? DEFAULT_SETTINGS;
  const today = bucketDate(asEpochMillis(options.now), settings.day_reset_hour, settings.timezone);

  // active-sprint members (an optimize preference)
  const activeSprintIds = new Set<string>();
  for (const sprint of sprintRows) {
    if (sprint.starts_on <= today && today <= sprint.ends_on) activeSprintIds.add(sprint.id);
  }
  const sprintMemberNodeIds = new Set<string>();
  for (const m of membershipRows) {
    if (activeSprintIds.has(m.sprint_id)) sprintMemberNodeIds.add(m.node_id);
  }

  // dependencies grouped by successor task
  const depsBySuccessor = new Map<string, SchedulerDependency[]>();
  for (const edge of edgeRows) {
    const list = depsBySuccessor.get(edge.successor_id) ?? [];
    list.push({ predecessorId: edge.predecessor_id, edgeType: edge.edge_type as EdgeType, lagMinutes: edge.lag_minutes });
    depsBySuccessor.set(edge.successor_id, list);
  }

  const tasks: SchedulableTask[] = [];
  for (const node of nodeRows) {
    if (node.node_type !== 'task' || node.completed_at !== null) continue;
    if (node.estimate_minutes === null || node.estimate_minutes <= 0) continue;
    tasks.push({
      id: node.id,
      estimateMinutes: node.estimate_minutes,
      dueDate: node.due_date,
      dependencies: depsBySuccessor.get(node.id),
      sprintMember: sprintMemberNodeIds.has(node.id),
    });
  }

  const committed: CommittedBlock[] = blockRows
    .filter((b) => b.status === 'committed')
    .map((b) => ({
      id: b.id,
      taskId: b.task_id,
      startsAt: asEpochMillis(new Date(b.starts_at).getTime()),
      endsAt: asEpochMillis(new Date(b.ends_at).getTime()),
      anchored: b.anchor_type !== 'none',
    }));

  return {
    tasks,
    committed,
    windows: DEFAULT_WINDOWS,
    timezone: settings.timezone,
    horizon: { from: asEpochMillis(options.now), to: asEpochMillis(options.now + horizonDays * 86_400_000) },
    mode: options.mode,
  };
}
