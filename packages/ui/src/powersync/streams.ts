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

/** The parameterized journal stream name (must match sync-streams.yaml, D3). */
export const JOURNAL_MONTH_STREAM = 'journal_month';

export interface JournalMonthOptions {
  /** Seconds a month stays subscribed after its LAST hold is released (default 1h). */
  ttlSeconds?: number;
}

export interface JournalMonthSubscriptions {
  /** Hold the subscription for `monthKey` ('YYYY-MM'); returns an idempotent release. */
  hold(monthKey: string): () => void;
  /** Months currently held (introspection/tests). */
  heldMonths(): string[];
  /**
   * Has this month's FIRST SYNC finished — i.e. is "no row for that day" now a
   * fact rather than "not downloaded yet"? A reader that cannot tell the two
   * apart renders a day as empty and then corrects itself a beat later.
   * Unheld months report false. A first sync that fails still settles, so a
   * reader gated on this can never hang.
   */
  isSettled(monthKey: string): boolean;
  /** Re-render hook: notified whenever any month settles. Returns an unsubscribe. */
  onSettledChange(listener: () => void): () => void;
}

/**
 * Ref-counted subscriptions to the lazy month-bucketed `journal_month` stream
 * (D3). `hold(monthKey)` subscribes the month ONCE (however many concurrent
 * holders) with `{ month: monthKey }` as the subscription parameter, TTL 1h,
 * priority 3; the returned release drops the ref and unsubscribes only when the
 * LAST holder lets go (PowerSync's TTL then evicts the local rows). The Agenda
 * holds the visible month(s), so a fresh device pulls ZERO journal rows until it
 * actually views a month. Typed against the minimal `StreamSubscriber` so it
 * unit-tests with a mock; the real `PowerSyncDatabase` satisfies it.
 */
export function createJournalMonthSubscriptions(db: StreamSubscriber, opts: JournalMonthOptions = {}): JournalMonthSubscriptions {
  const ttl = opts.ttlSeconds ?? 3600;
  const held = new Map<string, { count: number; sub: Promise<StreamSubscription> }>();
  const settled = new Set<string>();
  const listeners = new Set<() => void>();
  const markSettled = (monthKey: string) => {
    if (settled.has(monthKey) || !held.has(monthKey)) return;
    settled.add(monthKey);
    for (const l of listeners) l();
  };
  return {
    hold(monthKey) {
      let entry = held.get(monthKey);
      if (!entry) {
        const sub = db.syncStream(JOURNAL_MONTH_STREAM, { month: monthKey }).subscribe({ ttl, priority: 3 });
        entry = { count: 0, sub };
        held.set(monthKey, entry);
        // Settle on success OR failure: a reader gated on this must never hang,
        // and a month that cannot sync is still "as known as it is going to get".
        void sub
          .then((s) => s.waitForFirstSync())
          .then(() => markSettled(monthKey))
          .catch(() => markSettled(monthKey));
      }
      entry.count += 1;
      let released = false;
      return () => {
        if (released) return; // idempotent — double release is a no-op
        released = true;
        const e = held.get(monthKey);
        if (!e) return;
        e.count -= 1;
        if (e.count <= 0) {
          held.delete(monthKey);
          // a re-hold re-subscribes, so it must wait for its own first sync again
          settled.delete(monthKey);
          void e.sub.then((s) => s.unsubscribe()).catch(() => undefined);
        }
      };
    },
    heldMonths() {
      return [...held.keys()];
    },
    isSettled(monthKey) {
      return settled.has(monthKey);
    },
    onSettledChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
