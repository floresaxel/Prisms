/**
 * Long sessions: the pure scan decision (> 6 h flag, > 24 h auto clock-out) and
 * the timer.adjust check the client and server both run.
 */
import { describe, expect, it } from 'vitest';

import {
  autoClockOutAt,
  checkAdjustEntry,
  isoToEpochMillis,
  parseLongSessionDetail,
  planLongSessionScan,
  type LongSessionDetail,
  type ScanEntry,
  type ScanItem,
} from '../../src/index';

const H = 3_600_000;
const NOW = isoToEpochMillis('2026-11-17T12:00:00.000Z');
const at = (hoursAgo: number): string => new Date(NOW - hoursAgo * H).toISOString();

const entry = (id: string, startedHoursAgo: number, endedHoursAgo: number | null = null): ScanEntry => ({
  id,
  task_id: `task-${id}`,
  started_at: at(startedHoursAgo),
  ended_at: endedHoursAgo === null ? null : at(endedHoursAgo),
});
const item = (id: string, e: ScanEntry, kind: LongSessionDetail['kind'], status: ScanItem['status'] = 'open'): ScanItem => ({
  id,
  status,
  detail: { kind, entry_id: e.id, task_id: e.task_id, started_at: e.started_at, ended_at: e.ended_at },
});

describe('planLongSessionScan', () => {
  it('leaves a session at or under 6 h alone', () => {
    const plan = planLongSessionScan([entry('a', 5.9), entry('b', 6)], [], NOW);
    expect(plan).toEqual({ autoClose: [], flag: [], supersede: [] });
  });

  it('flags a running session past 6 h once, and never re-asks after it is confirmed', () => {
    const e = entry('a', 6.5);
    const first = planLongSessionScan([e], [], NOW);
    expect(first.flag).toEqual([{ kind: 'over_6h', entry_id: 'a', task_id: 'task-a', started_at: e.started_at, ended_at: null }]);
    expect(first.autoClose).toEqual([]);
    expect(planLongSessionScan([e], [item('i1', e, 'over_6h')], NOW).flag).toEqual([]);
    expect(planLongSessionScan([e], [item('i1', e, 'over_6h', 'resolved')], NOW).flag).toEqual([]);
  });

  it('flags a CLOSED session that ran past 6 h (clocked out between scans / offline)', () => {
    const e = entry('a', 10, 3); // ran 7 h
    expect(planLongSessionScan([e], [], NOW).flag.map((f) => f.kind)).toEqual(['over_6h']);
    // outside the lookback window: ignored
    expect(planLongSessionScan([entry('old', 80, 72)], [], NOW).flag).toEqual([]);
  });

  it('auto clocks out a session past 24 h at exactly start + 24 h, flags it, and supersedes the open 6 h item', () => {
    const e = entry('a', 30);
    const plan = planLongSessionScan([e], [item('i6', e, 'over_6h')], NOW);
    expect(plan.autoClose).toEqual([{ entryId: 'a', endedAt: autoClockOutAt(e.started_at) }]);
    expect(isoToEpochMillis(plan.autoClose[0]!.endedAt) - isoToEpochMillis(e.started_at)).toBe(24 * H);
    expect(plan.flag).toEqual([{ kind: 'auto_clock_out', entry_id: 'a', task_id: 'task-a', started_at: e.started_at, ended_at: plan.autoClose[0]!.endedAt }]);
    expect(plan.supersede).toEqual(['i6']);
  });

  it('does not supersede a 6 h item the user already confirmed, and does not double-flag the auto clock-out', () => {
    const e = entry('a', 30);
    const plan = planLongSessionScan([e], [item('i6', e, 'over_6h', 'resolved'), item('i24', e, 'auto_clock_out')], NOW);
    expect(plan.supersede).toEqual([]);
    expect(plan.flag).toEqual([]);
  });

  it('an auto-closed session (now closed at 24 h) is not flagged again as over_6h', () => {
    const e = entry('a', 25, 1); // closed by a previous scan at start + 24 h
    expect(planLongSessionScan([e], [item('i24', e, 'auto_clock_out')], NOW).flag).toEqual([]);
  });
});

describe('parseLongSessionDetail', () => {
  it('reads a JSON string or object and rejects anything else', () => {
    const d = { kind: 'over_6h', entry_id: 'e', task_id: 't', started_at: at(7), ended_at: null };
    expect(parseLongSessionDetail(JSON.stringify(d))).toEqual(d);
    expect(parseLongSessionDetail(d)).toEqual(d);
    expect(parseLongSessionDetail({ ...d, kind: 'nope' })).toBeNull();
    expect(parseLongSessionDetail('not json')).toBeNull();
    expect(parseLongSessionDetail(null)).toBeNull();
  });
});

describe('checkAdjustEntry (timer.adjust)', () => {
  const closed = { started_at: at(10), ended_at: at(1) };

  it('accepts an end after the start and not in the future', () => {
    expect(checkAdjustEntry(closed, 'e', { ended_at: at(8) }, NOW).ok).toBe(true);
  });

  it('rejects a missing entry, a running one, an end before the start (I6), and a future end', () => {
    const code = (r: ReturnType<typeof checkAdjustEntry>) => (r.ok ? null : r.error.code);
    expect(code(checkAdjustEntry(undefined, 'e', { ended_at: at(8) }, NOW))).toBe('E_NOT_FOUND');
    expect(code(checkAdjustEntry({ started_at: at(10), ended_at: null }, 'e', { ended_at: at(8) }, NOW))).toBe('E_TIMER_ALREADY_RUNNING');
    expect(code(checkAdjustEntry(closed, 'e', { ended_at: at(11) }, NOW))).toBe('E_INVALID_INTERVAL');
    expect(code(checkAdjustEntry(closed, 'e', { ended_at: at(10) }, NOW))).toBe('E_INVALID_INTERVAL');
    expect(code(checkAdjustEntry(closed, 'e', { ended_at: at(-1) }, NOW))).toBe('E_INVALID_INTERVAL');
  });
});
