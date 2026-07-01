/**
 * Sync-stream tiers (1.3 §7.3; M14). Tier 0/1 (`bootstrap`/`active`) auto-subscribe
 * on connect (the live working set). Tier 2 (`history` — soft-deleted time-entry
 * history + large/old data) is `auto_subscribe: false` in sync-streams.yaml, so it
 * is subscribed LAZILY here, on demand, and evicted after a TTL once nothing holds
 * it. Reads already tolerate its rows being absent until then.
 *
 * Uses the PowerSync client stream-subscription API (`db.syncStream(name)
 * .subscribe(...)`, alpha in the SDK). Typed structurally so the helper doesn't
 * depend on the SDK's alpha type surface; the real `PowerSyncDatabase` satisfies it.
 */

/** The Tier 2 stream name (must match sync-streams.yaml). */
export const HISTORY_STREAM = 'history';

/** A live subscription handle — hold it while you need the data, then unsubscribe. */
export interface StreamSubscription {
  waitForFirstSync(abort?: AbortSignal): Promise<void>;
  unsubscribe(): void;
}

/** The minimal slice of a PowerSync db needed to subscribe a stream. */
export interface StreamSubscriber {
  syncStream(
    name: string,
    params?: Record<string, unknown>,
  ): { subscribe(options?: { ttl?: number; priority?: 0 | 1 | 2 | 3 }): Promise<StreamSubscription> };
}

export interface HistorySubscribeOptions {
  /** Seconds the stream stays subscribed after the handle is released (default 1h). */
  ttlSeconds?: number;
  /** Await the first sync of the stream before resolving. */
  waitForFirstSync?: boolean;
}

/**
 * Lazily subscribe the Tier 2 `history` stream. Returns an unsubscribe function;
 * call it when the history view closes so the TTL starts and the rows are
 * eventually evicted from the local replica.
 */
export async function subscribeHistory(db: StreamSubscriber, opts: HistorySubscribeOptions = {}): Promise<() => void> {
  const sub = await db.syncStream(HISTORY_STREAM).subscribe({ ttl: opts.ttlSeconds ?? 3600, priority: 3 });
  if (opts.waitForFirstSync) await sub.waitForFirstSync();
  return () => sub.unsubscribe();
}
