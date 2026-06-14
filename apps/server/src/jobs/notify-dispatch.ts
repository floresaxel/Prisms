/**
 * notify.dispatch (§11, enqueued by other jobs): deliver a notification to all
 * of a user's registered push targets, routing each to the matching adapter
 * (Web Push or Expo). Server push is the closed-app path; clients also fire
 * local notifications (§11), so a missing/failed channel degrades gracefully.
 */
import { push_subscriptions } from '@prisms/db';
import { and, eq, isNull } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import type { PushAdapters, PushNotification } from './push';

export interface NotifyJob {
  userId: string;
  notification: PushNotification;
}

export interface NotifyResult {
  targets: number;
  sent: number;
  failed: number;
}

export async function runNotifyDispatch(db: PostgresJsDatabase, job: NotifyJob, adapters: PushAdapters): Promise<NotifyResult> {
  const subs = await db
    .select()
    .from(push_subscriptions)
    .where(and(eq(push_subscriptions.user_id, job.userId), isNull(push_subscriptions.deleted_at)));

  let sent = 0;
  let failed = 0;
  for (const sub of subs) {
    const adapter = adapters[sub.kind];
    if (!adapter) {
      failed += 1;
      continue;
    }
    const result = await adapter.send({ kind: sub.kind, endpoint: sub.endpoint, keys: sub.keys }, job.notification);
    if (result.ok) sent += 1;
    else failed += 1;
  }
  return { targets: subs.length, sent, failed };
}
