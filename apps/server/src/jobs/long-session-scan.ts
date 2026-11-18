/**
 * timer.long_session_scan (cron 15 min): flag sessions that ran past 6 h and
 * clock out ones still running past 24 h — the decision is core's pure
 * `planLongSessionScan`; this module only loads the facts and applies it.
 *
 * - > 6 h  → a `long_session` review item (kind over_6h, warning) asking the
 *            user to confirm the time, plus one push notification while the
 *            timer is still running.
 * - > 24 h → the entry is closed at exactly started_at + 24 h, a review item
 *            (kind auto_clock_out) says so, and an open over_6h item for the
 *            same entry is dismissed (superseded).
 *
 * Idempotent per (entry, kind) via the items' `detail`, so re-scanning never
 * double-flags and a confirmed (resolved) session is never asked about again.
 */
import { randomUUID } from 'node:crypto';

import {
  LONG_SESSION_LOOKBACK_MS,
  LONG_SESSION_WARN_MS,
  longSessionTitle,
  parseLongSessionDetail,
  planLongSessionScan,
  type ScanEntry,
  type ScanItem,
} from '@prisms/core';
import { nodes, sync_review_items, time_entries } from '@prisms/db';
import { and, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import type { JobClock } from './clock';
import { forEachUserIsolated, type BatchOutcome } from './per-user';

export interface LongSessionNotification {
  userId: string;
  taskId: string;
  title: string;
  kind: 'over_6h' | 'auto_clock_out';
}

export interface LongSessionScanResult {
  flagged: number;
  autoClosed: number;
  superseded: number;
}

const iso = (v: string | Date): string => new Date(v).toISOString();

/** Candidate entries for every user: open > 6 h, or closed within the lookback window. */
function candidateFilter(now: number) {
  return and(
    isNull(time_entries.deleted_at),
    or(
      and(isNull(time_entries.ended_at), lte(time_entries.started_at, new Date(now - LONG_SESSION_WARN_MS).toISOString())),
      gte(time_entries.ended_at, new Date(now - LONG_SESSION_LOOKBACK_MS).toISOString()),
    ),
  );
}

export async function runLongSessionScan(
  db: PostgresJsDatabase,
  userId: string,
  clock: JobClock,
  enqueueNotify?: (n: LongSessionNotification) => void,
): Promise<LongSessionScanResult> {
  const now = clock.now();
  const nowIso = new Date(now).toISOString();

  const entryRows = await db
    .select()
    .from(time_entries)
    .where(and(eq(time_entries.user_id, userId), candidateFilter(now)));
  if (entryRows.length === 0) return { flagged: 0, autoClosed: 0, superseded: 0 };

  return db.transaction(async (tx) => {
    const itemRows = await tx
      .select()
      .from(sync_review_items)
      .where(and(eq(sync_review_items.user_id, userId), eq(sync_review_items.item_type, 'long_session'), isNull(sync_review_items.deleted_at)));
    const items: ScanItem[] = [];
    for (const r of itemRows) {
      const detail = parseLongSessionDetail(r.detail);
      if (detail) items.push({ id: r.id, status: r.status, detail });
    }
    const entries: ScanEntry[] = entryRows.map((e) => ({
      id: e.id,
      task_id: e.task_id,
      started_at: iso(e.started_at),
      ended_at: e.ended_at === null ? null : iso(e.ended_at),
    }));

    const plan = planLongSessionScan(entries, items, now);

    for (const c of plan.autoClose) {
      // Guarded on ended_at IS NULL: a clock-out that landed after we read wins.
      await tx
        .update(time_entries)
        .set({ ended_at: c.endedAt, completed_session: null, updated_at: nowIso, last_modified_by_command_id: null })
        .where(and(eq(time_entries.id, c.entryId), isNull(time_entries.ended_at)));
    }
    for (const id of plan.supersede) {
      await tx
        .update(sync_review_items)
        .set({ status: 'dismissed', resolved_at: nowIso, updated_at: nowIso })
        .where(and(eq(sync_review_items.id, id), eq(sync_review_items.status, 'open')));
    }

    const taskIds = [...new Set(plan.flag.map((f) => f.task_id))];
    const titles = new Map<string, string>();
    if (taskIds.length > 0) {
      for (const t of await tx.select({ id: nodes.id, title: nodes.title }).from(nodes).where(inArray(nodes.id, taskIds))) titles.set(t.id, t.title);
    }
    for (const f of plan.flag) {
      const taskTitle = titles.get(f.task_id) ?? 'a task';
      await tx.insert(sync_review_items).values({
        id: randomUUID(),
        user_id: userId,
        command_id: null,
        item_type: 'long_session',
        severity: 'warning',
        title: longSessionTitle(f.kind, taskTitle),
        detail: { ...f } as typeof sync_review_items.$inferInsert.detail,
        status: 'open',
        source_kind: 'server_job',
        created_at: nowIso,
        updated_at: nowIso,
      });
      // Push only when it can still change something: a running timer, or the auto clock-out.
      if (f.ended_at === null || f.kind === 'auto_clock_out') enqueueNotify?.({ userId, taskId: f.task_id, title: taskTitle, kind: f.kind });
    }
    return { flagged: plan.flag.length, autoClosed: plan.autoClose.length, superseded: plan.supersede.length };
  });
}

/** Cron entry point: only users with a candidate entry (SEC-6/F9: per-user isolated). */
export async function runLongSessionScanAll(
  db: PostgresJsDatabase,
  clock: JobClock,
  enqueueNotify?: (n: LongSessionNotification) => void,
): Promise<BatchOutcome> {
  const rows = await db.selectDistinct({ user_id: time_entries.user_id }).from(time_entries).where(candidateFilter(clock.now()));
  return forEachUserIsolated(rows, 'timer.long_session_scan', (u) => u.user_id, (u) => runLongSessionScan(db, u.user_id, clock, enqueueNotify));
}
