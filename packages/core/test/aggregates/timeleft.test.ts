/** S6: time-left trio goldens (§7.2), including a DST transition day. */
import { describe, expect, it } from 'vitest';

import {
  minutesLeftInDay,
  minutesLeftInTask,
  minutesUntilNextBlock,
  nextDayReset,
} from '../../src/aggregates/timeleft';
import { epochMillisToIso, isoToEpochMillis } from '../../src/time/instant';
import { idOf, makeBlock, makeEntry, makeNode } from '../helpers/fixtures';

const SETTINGS = { day_reset_hour: 4, timezone: 'America/New_York' };

describe('minutesLeftInDay (§7.2: next day-reset − now)', () => {
  it('counts down to 04:00 local next day', () => {
    // 2026-06-12T16:00Z = noon New York; next reset 2026-06-13T04:00-04:00 = 08:00Z
    const now = isoToEpochMillis('2026-06-12T16:00:00.000Z');
    expect(epochMillisToIso(nextDayReset(now, SETTINGS))).toBe('2026-06-13T08:00:00.000Z');
    expect(minutesLeftInDay(now, SETTINGS)).toBe(16 * 60);
  });

  it('before the reset hour the day ends at TODAY 04:00 local', () => {
    // 03:00 New York = 07:00Z, bucket is still yesterday ⇒ reset in 60 minutes
    const now = isoToEpochMillis('2026-06-12T07:00:00.000Z');
    expect(minutesLeftInDay(now, SETTINGS)).toBe(60);
  });

  it('spring-forward day: absolute time to the next reset shrinks by the skipped hour', () => {
    // 2026-03-08 02:00→03:00 EST→EDT. At 01:00 EST (06:00Z, bucket 03-07)
    // the next reset is 03-08T04:00 EDT = 08:00Z ⇒ 120 absolute minutes,
    // though the wall clock shows a 3-hour gap.
    const now = isoToEpochMillis('2026-03-08T06:00:00.000Z');
    expect(epochMillisToIso(nextDayReset(now, SETTINGS))).toBe('2026-03-08T08:00:00.000Z');
    expect(minutesLeftInDay(now, SETTINGS)).toBe(120);
  });

  it('fall-back day: the repeated hour stretches the day', () => {
    // 2026-11-01 02:00 EDT → 01:00 EST. At 00:30 EDT (04:30Z, bucket 10-31)
    // next reset 11-01T04:00 EST = 09:00Z ⇒ 270 minutes (4.5h wall: 00:30→04:00 incl. repeat)
    const now = isoToEpochMillis('2026-11-01T04:30:00.000Z');
    expect(minutesLeftInDay(now, SETTINGS)).toBe(270);
  });
});

describe('minutesLeftInTask', () => {
  it('estimate − consumed raw minutes; negative when over; null without estimate', () => {
    const task = makeNode({ id: idOf(1), node_type: 'task', estimate_minutes: 120 });
    const entries = [
      makeEntry({
        id: idOf(2),
        task_id: task.id,
        started_at: '2026-06-12T10:00:00.000Z',
        ended_at: '2026-06-12T11:30:00.000Z',
      }),
    ];
    expect(minutesLeftInTask(task, entries)).toBe(30);
    expect(minutesLeftInTask({ ...task, estimate_minutes: 60 }, entries)).toBe(-30);
    expect(minutesLeftInTask({ ...task, estimate_minutes: null }, entries)).toBeNull();
  });
});

describe('minutesUntilNextBlock', () => {
  const now = isoToEpochMillis('2026-06-12T16:00:00.000Z');
  const blocks = [
    makeBlock({
      id: idOf(1),
      task_id: idOf(10),
      starts_at: '2026-06-12T18:00:00.000Z',
      ends_at: '2026-06-12T19:00:00.000Z',
    }),
    makeBlock({
      id: idOf(2),
      task_id: idOf(11),
      starts_at: '2026-06-12T17:00:00.000Z',
      ends_at: '2026-06-12T17:30:00.000Z',
    }),
    makeBlock({
      id: idOf(3),
      task_id: idOf(12),
      starts_at: '2026-06-12T09:00:00.000Z', // past
      ends_at: '2026-06-12T10:00:00.000Z',
    }),
    makeBlock({
      id: idOf(4),
      task_id: idOf(13),
      starts_at: '2026-06-12T16:30:00.000Z',
      ends_at: '2026-06-12T17:00:00.000Z',
      status: 'suggested', // proposals don't count (§2.6)
    }),
  ];

  it('finds the earliest upcoming committed block, globally or per task', () => {
    expect(minutesUntilNextBlock(blocks, now)).toBe(60);
    expect(minutesUntilNextBlock(blocks, now, idOf(10))).toBe(120);
    expect(minutesUntilNextBlock(blocks, now, idOf(12))).toBeNull();
    expect(minutesUntilNextBlock([], now)).toBeNull();
  });
});
