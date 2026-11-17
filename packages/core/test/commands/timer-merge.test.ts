/**
 * S12: the §7.4 double clock-in observation rule (client + server share it),
 * under split focus — one open entry per task, ≤ MAX_OPEN_TIMERS per user.
 */
import { describe, expect, it } from 'vitest';

import { MAX_OPEN_TIMERS, resolveOpenTimeEntries } from '../../src/commands/timer-merge';
import { idOf, makeEntry } from '../helpers/fixtures';

/** All on ONE task (idOf(99)) unless a task is given. */
const open = (id: string, started_at: string, task = idOf(99)) => makeEntry({ id, task_id: task, started_at });
const at = (min: number) => `2026-06-13T10:${String(min).padStart(2, '0')}:00.000Z`;

describe('resolveOpenTimeEntries (§7.4, split focus)', () => {
  it('returns null when the open set already satisfies I5', () => {
    expect(resolveOpenTimeEntries([])).toBeNull();
    expect(resolveOpenTimeEntries([open(idOf(1), at(0))])).toBeNull();
    // different tasks may run together (split focus)
    expect(resolveOpenTimeEntries([open(idOf(1), at(0), idOf(91)), open(idOf(2), at(5), idOf(92))])).toBeNull();
  });

  it('same task twice: keeps the latest started_at open and closes the other at that instant', () => {
    const a = open(idOf(1), at(0));
    const b = open(idOf(2), at(5)); // later
    const res = resolveOpenTimeEntries([a, b])!;
    expect(res.keepOpenIds).toEqual([b.id]);
    expect(res.closures).toEqual([{ id: a.id, ended_at: at(5) }]);
  });

  it('is order-independent', () => {
    const a = open(idOf(1), at(0));
    const b = open(idOf(2), at(5));
    const c = open(idOf(3), at(7), idOf(92));
    expect(resolveOpenTimeEntries([a, b, c])).toEqual(resolveOpenTimeEntries([c, b, a]));
  });

  it('breaks started_at ties by the larger id, deterministically', () => {
    const a = open(idOf(1), at(0));
    const b = open(idOf(2), at(0)); // same start, larger id
    const res = resolveOpenTimeEntries([a, b])!;
    expect(res.keepOpenIds).toEqual([b.id]);
    expect(res.closures.map((c) => c.id)).toEqual([a.id]);
  });

  it('resolves a three-way race on one task to a single survivor', () => {
    const res = resolveOpenTimeEntries([open(idOf(1), at(0)), open(idOf(2), at(10)), open(idOf(3), at(5))])!;
    expect(res.keepOpenIds).toEqual([idOf(2)]);
    expect(res.closures).toHaveLength(2);
    expect(res.closures.every((c) => c.ended_at === at(10))).toBe(true);
  });

  it(`over ${MAX_OPEN_TIMERS} tasks: the latest-started stay; extras close when the set went over`, () => {
    // seven tasks started a minute apart → the first two are extra
    const entries = Array.from({ length: MAX_OPEN_TIMERS + 2 }, (_, i) => open(idOf(i + 1), at(i), idOf(90 + i)));
    const res = resolveOpenTimeEntries(entries)!;
    expect(res.keepOpenIds).toHaveLength(MAX_OPEN_TIMERS);
    expect(res.keepOpenIds).not.toContain(idOf(1));
    expect(res.keepOpenIds).not.toContain(idOf(2));
    // the earliest KEPT entry started at minute 2
    expect(res.closures).toEqual([
      { id: idOf(1), ended_at: at(2) },
      { id: idOf(2), ended_at: at(2) },
    ]);
  });
});
