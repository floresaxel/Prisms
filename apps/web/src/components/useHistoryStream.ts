/**
 * Holds the lazy `history` sync stream (sync-streams.yaml Tier 2, where
 * soft-deleted rows live) open while a view needs it, and reports whether its
 * first sync has landed — for Tasks › Recently deleted.
 *
 * Offline-first: the view shows whatever deleted rows are already on the device
 * at once; this only tells "nothing deleted" apart from "not here yet". It
 * never waits longer than HISTORY_WAIT_MS: while sync is down (offline, or the
 * server refusing an expired sign-in token, which a skewed clock causes) the
 * first sync never ends, and a permanent "Loading…" says nothing.
 *
 * The subscription is held as soon as it exists, so leaving the view mid-wait
 * still releases it (PowerSync's TTL then evicts the rows).
 */
import { useEffect, useState } from 'react';

import { HISTORY_STREAM, type StreamSubscriber, type StreamSubscription } from '@prisms/ui';

export const HISTORY_WAIT_MS = 6000;

/** waiting → synced (first sync landed) | stalled (it hasn't in HISTORY_WAIT_MS, or failed). */
export type HistoryState = 'waiting' | 'synced' | 'stalled';

export function useHistoryStream(db: StreamSubscriber): HistoryState {
  const [state, setState] = useState<HistoryState>('waiting');
  useEffect(() => {
    const abort = new AbortController();
    let sub: StreamSubscription | null = null;
    const stall = setTimeout(() => setState((s) => (s === 'waiting' ? 'stalled' : s)), HISTORY_WAIT_MS);
    db.syncStream(HISTORY_STREAM)
      .subscribe({ ttl: 3600, priority: 3 })
      .then(async (s) => {
        if (abort.signal.aborted) {
          s.unsubscribe();
          return;
        }
        sub = s;
        await s.waitForFirstSync(abort.signal);
        if (!abort.signal.aborted) setState('synced');
      })
      .catch(() => {
        if (!abort.signal.aborted) setState('stalled');
      });
    return () => {
      abort.abort();
      clearTimeout(stall);
      sub?.unsubscribe();
    };
  }, [db]);
  return state;
}

/**
 * Why the list may be incomplete, or null when it isn't (or it's too early to
 * say). Not being connected is known at once; anything else shows once the
 * first sync has stalled.
 */
export function historyNotice(state: HistoryState, connected: boolean): string | null {
  if (state === 'synced') return null;
  if (!connected) return "The app isn't connected to the sync server. Tasks deleted on this device are listed; ones deleted on your other devices appear once it reconnects.";
  if (state === 'stalled') return "Deletions from your other devices haven't arrived from the server. Tasks deleted on this device are listed. If this lasts, the app isn't syncing; check the sync status at the top.";
  return null;
}
