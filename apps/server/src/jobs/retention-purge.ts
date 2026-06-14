/**
 * retention.purge (§11, cron weekly): hard-delete rows soft-deleted more than
 * 90 days ago. Sync requires soft deletes, so rows linger with `deleted_at`
 * set; this reclaims them once no client could still need the tombstone.
 *
 * Deletes referencing tables before referenced ones (FKs are NO ACTION), and
 * purges a node only when nothing still references it — a node whose deleted
 * subtree/edges are not yet old enough waits for a later run.
 */
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import type { JobClock } from './clock';

export const RETENTION_DAYS = 90;

/** Soft-delete tables in FK-safe (referencing-first) order; nodes handled separately. */
const PURGE_ORDER = [
  'habit_completions',
  'decision_scores',
  'decision_criteria',
  'sprint_memberships',
  'diagram_layouts',
  'diagram_groups',
  'schedule_blocks',
  'time_entries',
  'edges',
  'habits',
  'decision_boards',
  'sprints',
  'automation_rules',
  'blocker_rules',
  'external_facts',
  'computed_aggregates',
] as const;

export interface PurgeResult {
  cutoff: string;
  deleted: Record<string, number>;
}

export async function runRetentionPurge(
  db: PostgresJsDatabase,
  clock: JobClock,
): Promise<PurgeResult> {
  const cutoff = new Date(clock.now() - RETENTION_DAYS * 86_400_000).toISOString();
  const deleted: Record<string, number> = {};

  for (const table of PURGE_ORDER) {
    const res = await db.execute(
      sql`DELETE FROM ${sql.identifier(table)} WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoff}`,
    );
    deleted[table] = res.count ?? 0;
  }

  // nodes last, only those nothing references any more (live or tombstoned).
  const res = await db.execute(sql`
    DELETE FROM nodes n
    WHERE n.deleted_at IS NOT NULL AND n.deleted_at < ${cutoff}
      AND NOT EXISTS (SELECT 1 FROM nodes c WHERE c.parent_id = n.id)
      AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.predecessor_id = n.id OR e.successor_id = n.id)
      AND NOT EXISTS (SELECT 1 FROM schedule_blocks b WHERE b.task_id = n.id)
      AND NOT EXISTS (SELECT 1 FROM time_entries t WHERE t.task_id = n.id)
      AND NOT EXISTS (SELECT 1 FROM habits h WHERE h.vision_id = n.id)
      AND NOT EXISTS (SELECT 1 FROM decision_scores s WHERE s.project_id = n.id)
      AND NOT EXISTS (SELECT 1 FROM sprint_memberships m WHERE m.node_id = n.id)
      AND NOT EXISTS (SELECT 1 FROM diagram_layouts l WHERE l.node_id = n.id)
  `);
  deleted['nodes'] = res.count ?? 0;

  return { cutoff, deleted };
}
