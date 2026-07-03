/**
 * review.expire_resolved (§12, cron weekly): soft-delete sync_review_items that
 * have been resolved or dismissed longer than the review-retention window. Open
 * items survive at any age; recently-closed ones stay inside the horizon so the
 * user can still see what happened. Soft delete (not hard) so the tombstone syncs
 * the dismissal to every device; retention.purge reclaims the row later.
 */
import { sync_review_items } from '@prisms/db';
import { and, isNotNull, isNull, lt, ne } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import type { JobClock } from './clock';

export const REVIEW_RESOLVED_RETENTION_DAYS = 30;

export interface ReviewExpireResult {
  expired: number;
}

export async function runReviewExpireResolved(db: PostgresJsDatabase, clock: JobClock): Promise<ReviewExpireResult> {
  const nowIso = new Date(clock.now()).toISOString();
  const cutoff = new Date(clock.now() - REVIEW_RESOLVED_RETENTION_DAYS * 86_400_000).toISOString();

  const res = await db
    .update(sync_review_items)
    .set({ deleted_at: nowIso, updated_at: nowIso })
    .where(
      and(
        ne(sync_review_items.status, 'open'), // resolved or dismissed (terminal)
        isNotNull(sync_review_items.resolved_at),
        lt(sync_review_items.resolved_at, cutoff),
        isNull(sync_review_items.deleted_at),
      ),
    );

  return { expired: res.count ?? 0 };
}
