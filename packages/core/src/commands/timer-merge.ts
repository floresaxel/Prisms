/**
 * The §7.4 double clock-in merge rule — the ONE special conflict resolution —
 * under split focus (I5: one open entry per TASK, ≤ MAX_OPEN_TIMERS per user).
 *
 * Two devices clock in while offline (each sees I5 hold locally). After sync
 * the user can have:
 *   1. two open entries on the SAME task — keep the one with the latest
 *      `started_at`; close the other at that `started_at`;
 *   2. more than MAX_OPEN_TIMERS tasks running — keep the latest-started
 *      MAX_OPEN_TIMERS; close each extra at the `started_at` of the earliest
 *      entry that is kept, i.e. the moment the set went over the limit.
 * Ties on `started_at` break by id so device and server agree byte-for-byte.
 * Closures carry `completed_session = NULL` (set by the caller).
 *
 * The server applies this on upload; clients apply the SAME function to what
 * they display, so the UI never shows a set the server would not keep (§7.4).
 */
import type { TimeEntry } from '../domain/entities';
import type { IsoDateTime, Uuid } from '../domain/primitives';

/** How many timers may run at once (split focus). */
export const MAX_OPEN_TIMERS = 5;

export interface TimerResolution {
  /** The entries that stay open. */
  keepOpenIds: Uuid[];
  /** Entries to auto-close, each at the given time. */
  closures: { id: Uuid; ended_at: IsoDateTime }[];
}

type OpenEntry = Pick<TimeEntry, 'id' | 'task_id' | 'started_at'>;

/** Latest started first; ties → the larger id first. */
const latestFirst = (a: OpenEntry, b: OpenEntry): number =>
  a.started_at !== b.started_at ? (a.started_at > b.started_at ? -1 : 1) : a.id > b.id ? -1 : a.id < b.id ? 1 : 0;

/**
 * Resolves a set of OPEN time entries (ended_at === null). Returns null when the
 * set already satisfies I5 (nothing to close). Deterministic and
 * order-independent.
 */
export function resolveOpenTimeEntries(
  open: readonly OpenEntry[],
  limit: number = MAX_OPEN_TIMERS,
): TimerResolution | null {
  const closures: { id: Uuid; ended_at: IsoDateTime }[] = [];

  // 1. one per task: the latest-started wins.
  const byTask = new Map<Uuid, OpenEntry[]>();
  for (const e of open) {
    const list = byTask.get(e.task_id);
    if (list) list.push(e);
    else byTask.set(e.task_id, [e]);
  }
  const winners: OpenEntry[] = [];
  for (const list of byTask.values()) {
    const sorted = [...list].sort(latestFirst);
    const winner = sorted[0]!;
    winners.push(winner);
    for (const loser of sorted.slice(1)) closures.push({ id: loser.id, ended_at: winner.started_at });
  }

  // 2. at most `limit` tasks: the latest-started win.
  winners.sort(latestFirst);
  const kept = winners.slice(0, limit);
  const extra = winners.slice(limit);
  if (extra.length > 0) {
    const overAt = kept[kept.length - 1]!.started_at; // the earliest kept start
    for (const e of extra) closures.push({ id: e.id, ended_at: overAt });
  }

  if (closures.length === 0) return null;
  closures.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { keepOpenIds: kept.map((e) => e.id).sort(), closures };
}
