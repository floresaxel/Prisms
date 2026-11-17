/**
 * Split focus: while timers on N tasks overlap, each task is credited 1/N of
 * that time — derived from the entries' start/stop times, so the numbers flow
 * through every aggregate (progress, practice, today) without stored weights.
 */
import { describe, expect, it } from 'vitest';

import { canonicalProgress } from '../../src/aggregates/progress';
import { canonicalPractice } from '../../src/aggregates/practice';
import { habitTodayMinutes } from '../../src/aggregates/today';
import { splitConcurrent } from '../../src/merge/split-focus';
import { mergeTimeEntries } from '../../src/merge/time-entries';
import { isoToEpochMillis } from '../../src/time/instant';
import { idOf, makeEntry, makeNode } from '../helpers/fixtures';

const A = idOf(1);
const B = idOf(2);
const C = idOf(3);
const at = (min: number) => new Date(Date.UTC(2026, 5, 13, 10, min)).toISOString();
const entry = (n: number, task: string, from: number, to: number | null, extra: object = {}) =>
  makeEntry({ id: idOf(100 + n), task_id: task, started_at: at(from), ended_at: to === null ? null : at(to), ...extra });
const task = (id: string) => makeNode({ id, node_type: 'task', estimate_minutes: 60 });
const minutesFor = (id: string, entries: ReturnType<typeof entry>[]) => canonicalProgress(task(id), entries).consumedMinutes;

describe('splitConcurrent + aggregates', () => {
  it('a lone timer is untouched (share 1, same timestamps)', () => {
    const e = entry(1, A, 0, 30);
    const [frag] = splitConcurrent([e]);
    expect(frag).toMatchObject({ id: e.id, started_at: e.started_at, ended_at: e.ended_at, share: 1 });
    expect(minutesFor(A, [e])).toBe(30);
  });

  it('two tasks fully overlapping split 50/50', () => {
    const entries = [entry(1, A, 0, 30), entry(2, B, 0, 30)];
    expect(minutesFor(A, entries)).toBe(15);
    expect(minutesFor(B, entries)).toBe(15);
  });

  it('partial overlap: alone at full rate, together at half', () => {
    // A 0–30, B 10–40 → A: 10 + 20/2 = 20; B: 20/2 + 10 = 20
    const entries = [entry(1, A, 0, 30), entry(2, B, 10, 40)];
    expect(minutesFor(A, entries)).toBe(20);
    expect(minutesFor(B, entries)).toBe(20);
  });

  it('three tasks: thirds while all run, halves while two do', () => {
    // A 0–60; B 0–30; C 0–30 → A: 30/3 + 30 = 40; B and C: 10 each
    const entries = [entry(1, A, 0, 60), entry(2, B, 0, 30), entry(3, C, 0, 30)];
    expect(minutesFor(A, entries)).toBeCloseTo(40);
    expect(minutesFor(B, entries)).toBeCloseTo(10);
    expect(minutesFor(C, entries)).toBeCloseTo(10);
  });

  it('the credited minutes always add up to the wall-clock time worked', () => {
    const entries = [entry(1, A, 0, 45), entry(2, B, 5, 20), entry(3, C, 15, 50)];
    const total = [A, B, C].reduce((s, id) => s + minutesFor(id, entries), 0);
    const wall = mergeTimeEntries(entries).rawMinutes; // union of all spans, unsplit
    expect(total).toBeCloseTo(wall);
    expect(wall).toBe(50);
  });

  it('two entries on the SAME task (offline double clock-in) are one task, not a split', () => {
    const entries = [entry(1, A, 0, 30), entry(2, A, 0, 30)];
    expect(minutesFor(A, entries)).toBe(30);
  });

  it('deleted entries and running timers are left out of the facts', () => {
    const entries = [entry(1, A, 0, 30), entry(2, B, 0, 30, { deleted_at: at(31) }), entry(3, C, 0, null)];
    expect(minutesFor(A, entries)).toBe(30);
  });

  it('with nowMs, running timers count up to now and split with each other', () => {
    const entries = [entry(1, A, 0, null), entry(2, B, 0, null)];
    const now = isoToEpochMillis(at(20));
    const frags = splitConcurrent(entries, now);
    expect(frags.every((f) => f.share === 0.5)).toBe(true);
    expect(habitTodayMinutes(entries, new Set([A]), '2026-06-13', 0, 'UTC', now)).toBeCloseTo(10);
  });

  it('practice hours use the split share', () => {
    const habit = { id: idOf(50), level_thresholds_hours: [1] } as Parameters<typeof canonicalPractice>[0];
    const practiceTask = makeNode({ id: A, node_type: 'task', habit_id: habit.id });
    const entries = [entry(1, A, 0, 60), entry(2, B, 0, 60)];
    expect(canonicalPractice(habit, [practiceTask], entries).minutes).toBeCloseTo(30);
  });
});
