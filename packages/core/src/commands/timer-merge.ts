/**
 * The §7.4 double clock-in merge rule — the ONE special conflict resolution.
 *
 * Two devices clock in while offline (each sees no open entry locally, so I5
 * holds on each device). After sync both entries are open. The deterministic
 * resolution: keep the entry with the latest `started_at` open; close every
 * other at that latest `started_at` with `completed_session = NULL`. Ties on
 * `started_at` break by id so device and server agree byte-for-byte.
 *
 * The server applies this on upload; clients apply the SAME function locally
 * the moment they observe two open entries after sync, so the UI never shows
 * two running timers even before the server responds (§7.4).
 */
import type { TimeEntry } from '../domain/entities';
import type { IsoDateTime, Uuid } from '../domain/primitives';

export interface TimerResolution {
  /** The entry that stays open (latest started_at). */
  keepOpenId: Uuid;
  /** Entries to auto-close, each at the kept entry's started_at. */
  closures: { id: Uuid; ended_at: IsoDateTime }[];
}

/**
 * Resolves a set of OPEN time entries (ended_at === null). Returns null when
 * there is nothing to resolve (0 or 1 open). Deterministic: latest
 * started_at wins, ties broken by the larger id.
 */
export function resolveOpenTimeEntries(
  open: readonly Pick<TimeEntry, 'id' | 'started_at'>[],
): TimerResolution | null {
  if (open.length <= 1) return null;
  let winner = open[0]!;
  for (const entry of open) {
    if (
      entry.started_at > winner.started_at ||
      (entry.started_at === winner.started_at && entry.id > winner.id)
    ) {
      winner = entry;
    }
  }
  const closures = open
    .filter((entry) => entry.id !== winner.id)
    .map((entry) => ({ id: entry.id, ended_at: winner.started_at }));
  return { keepOpenId: winner.id, closures };
}
