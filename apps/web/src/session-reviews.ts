/**
 * Sessions waiting for their review: clocked out with "Review later" (or put off
 * by a break), so they have no focus multiple yet. The Review tab lists each as a
 * regular review item — set the multiple, then Clear — and the nav badge counts
 * them with the inbox.
 *
 * Derived from the time entries themselves (a session is pending until a
 * `timer.review` gives it a multiple), so it follows the user across devices with
 * nothing extra to sync. Reaches back as far as the clock-in log does.
 */
import { useEffect, useMemo, useState } from 'react';

import { asEpochMillis } from '@prisms/core';
import { useRecentSessions, type LoggedSession } from '@prisms/ui';

export function usePendingSessionReviews(): LoggedSession[] {
  // a minute's resolution is plenty: this only needs "the last two weeks"
  const [now, setNow] = useState(() => asEpochMillis(Date.now()));
  useEffect(() => {
    const t = setInterval(() => setNow(asEpochMillis(Date.now())), 60_000);
    return () => clearInterval(t);
  }, []);
  const sessions = useRecentSessions(now);
  return useMemo(() => sessions.filter((s) => !s.reviewed), [sessions]);
}
