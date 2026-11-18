/**
 * Long sessions: a timer left running far longer than anyone really works.
 *
 * - Past `LONG_SESSION_WARN_MS` (6 h) a session gets a `long_session` review
 *   item (kind `over_6h`) asking whether that was intentional. It fires for a
 *   timer that is still running AND for one already closed that ran that long
 *   (e.g. clocked out offline, or clocked out between two scans).
 * - Past `AUTO_CLOCK_OUT_MS` (24 h) a still-running timer is closed by the
 *   server at exactly `started_at + 24 h` and gets a review item of kind
 *   `auto_clock_out`; any still-open `over_6h` item for it is superseded.
 *
 * From the Review inbox the user confirms the time, or fixes it with
 * `timer.adjust` (a closed entry's `ended_at`) / `timer.clock_out` at a chosen
 * time (a still-running one). `planLongSessionScan` is the pure decision the
 * `timer.long_session_scan` job applies, so it is testable without Postgres.
 */
import { domainError } from '../domain/errors';
import type { IsoDateTime, Uuid } from '../domain/primitives';
import { err, ok, type Result } from '../domain/result';
import { asEpochMillis, epochMillisToIso, isoToEpochMillis } from '../time/instant';

export const LONG_SESSION_WARN_MS = 6 * 3_600_000;
export const AUTO_CLOCK_OUT_MS = 24 * 3_600_000;
/** Closed sessions are only re-examined this far back (keeps the scan cheap). */
export const LONG_SESSION_LOOKBACK_MS = 48 * 3_600_000;
/** Client/server clock skew tolerated on a user-chosen clock-out time. */
export const CLOCK_SKEW_MS = 5 * 60_000;

export const LONG_SESSION_KINDS = ['over_6h', 'auto_clock_out'] as const;
export type LongSessionKind = (typeof LONG_SESSION_KINDS)[number];

/** The JSON `detail` of a `long_session` review item. */
export interface LongSessionDetail {
  kind: LongSessionKind;
  entry_id: Uuid;
  task_id: Uuid;
  started_at: IsoDateTime;
  /** The end the server saw when it flagged the session (null = still running). */
  ended_at: IsoDateTime | null;
}

export function parseLongSessionDetail(detail: unknown): LongSessionDetail | null {
  let d: unknown = detail;
  if (typeof d === 'string') {
    try {
      d = JSON.parse(d);
    } catch {
      return null;
    }
  }
  if (typeof d !== 'object' || d === null) return null;
  const r = d as Record<string, unknown>;
  if (!LONG_SESSION_KINDS.includes(r['kind'] as LongSessionKind)) return null;
  if (typeof r['entry_id'] !== 'string' || typeof r['task_id'] !== 'string' || typeof r['started_at'] !== 'string') return null;
  return {
    kind: r['kind'] as LongSessionKind,
    entry_id: r['entry_id'],
    task_id: r['task_id'],
    started_at: r['started_at'],
    ended_at: typeof r['ended_at'] === 'string' ? r['ended_at'] : null,
  };
}

/** Where the server caps a timer it closes automatically. */
export function autoClockOutAt(startedAt: IsoDateTime): IsoDateTime {
  return epochMillisToIso(asEpochMillis(isoToEpochMillis(startedAt) + AUTO_CLOCK_OUT_MS));
}

export interface ScanEntry {
  id: Uuid;
  task_id: Uuid;
  started_at: IsoDateTime;
  ended_at: IsoDateTime | null;
}

export interface ScanItem {
  id: Uuid;
  status: 'open' | 'resolved' | 'dismissed';
  detail: LongSessionDetail;
}

export interface LongSessionScanPlan {
  /** Still-running entries to close, with the capped end time. */
  autoClose: { entryId: Uuid; endedAt: IsoDateTime }[];
  /** New review items to create. */
  flag: LongSessionDetail[];
  /** Open `over_6h` items made moot by an auto clock-out. */
  supersede: Uuid[];
}

/**
 * Decide what one scan does for one user. Idempotent: a session is flagged at
 * most once per kind (in ANY status — a confirmed session is never re-asked),
 * and an auto-closed session is never also flagged `over_6h` afterwards.
 */
export function planLongSessionScan(entries: readonly ScanEntry[], items: readonly ScanItem[], nowMs: number): LongSessionScanPlan {
  const has = new Set(items.map((i) => `${i.detail.entry_id}:${i.detail.kind}`));
  const anyFor = new Set(items.map((i) => i.detail.entry_id));
  const plan: LongSessionScanPlan = { autoClose: [], flag: [], supersede: [] };

  for (const e of entries) {
    const start = isoToEpochMillis(e.started_at);
    if (e.ended_at === null) {
      const elapsed = nowMs - start;
      if (elapsed > AUTO_CLOCK_OUT_MS) {
        const endedAt = autoClockOutAt(e.started_at);
        plan.autoClose.push({ entryId: e.id, endedAt });
        if (!has.has(`${e.id}:auto_clock_out`)) {
          plan.flag.push({ kind: 'auto_clock_out', entry_id: e.id, task_id: e.task_id, started_at: e.started_at, ended_at: endedAt });
        }
        for (const i of items) if (i.detail.entry_id === e.id && i.detail.kind === 'over_6h' && i.status === 'open') plan.supersede.push(i.id);
      } else if (elapsed > LONG_SESSION_WARN_MS && !has.has(`${e.id}:over_6h`)) {
        plan.flag.push({ kind: 'over_6h', entry_id: e.id, task_id: e.task_id, started_at: e.started_at, ended_at: null });
      }
      continue;
    }
    const end = isoToEpochMillis(e.ended_at);
    if (end < nowMs - LONG_SESSION_LOOKBACK_MS) continue;
    if (end - start > LONG_SESSION_WARN_MS && !anyFor.has(e.id)) {
      plan.flag.push({ kind: 'over_6h', entry_id: e.id, task_id: e.task_id, started_at: e.started_at, ended_at: e.ended_at });
    }
  }
  return plan;
}

/** The review-item title for a flagged session. */
export function longSessionTitle(kind: LongSessionKind, taskTitle: string): string {
  return kind === 'auto_clock_out'
    ? `Clocked out of "${taskTitle}" automatically after 24 hours`
    : `Clocked in to "${taskTitle}" for over 6 hours — was that intentional?`;
}

/**
 * `timer.adjust`: correct when a CLOSED session ended. A running one is clocked
 * out instead (`timer.clock_out` takes any end time). The new end must follow
 * the start (I6) and can't be in the future.
 */
export function checkAdjustEntry(
  entry: { started_at: IsoDateTime; ended_at: IsoDateTime | null } | undefined,
  entryId: Uuid,
  payload: { ended_at: IsoDateTime },
  nowMs: number,
): Result<void> {
  if (!entry) return err(domainError('E_NOT_FOUND', `time entry ${entryId} does not exist`));
  if (entry.ended_at === null) {
    return err(domainError('E_TIMER_ALREADY_RUNNING', `time entry ${entryId} is still running; clock out instead`));
  }
  const end = isoToEpochMillis(payload.ended_at);
  if (!(end > isoToEpochMillis(entry.started_at))) return err(domainError('E_INVALID_INTERVAL', 'ends_at must be after starts_at (I6)'));
  if (end > nowMs + CLOCK_SKEW_MS) return err(domainError('E_INVALID_INTERVAL', 'a session cannot end in the future'));
  return ok(undefined);
}
