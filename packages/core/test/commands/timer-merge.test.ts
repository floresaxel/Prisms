/**
 * S12: the §7.4 double clock-in observation rule (client + server share it).
 */
import { describe, expect, it } from 'vitest';

import { resolveOpenTimeEntries } from '../../src/commands/timer-merge';
import { idOf, makeEntry } from '../helpers/fixtures';

const open = (id: string, started_at: string) =>
  makeEntry({ id, task_id: idOf(99), started_at });

describe('resolveOpenTimeEntries (§7.4)', () => {
  it('returns null when 0 or 1 entries are open (nothing to resolve)', () => {
    expect(resolveOpenTimeEntries([])).toBeNull();
    expect(resolveOpenTimeEntries([open(idOf(1), '2026-06-13T10:00:00.000Z')])).toBeNull();
  });

  it('keeps the latest started_at open and closes the rest at that instant', () => {
    const a = open(idOf(1), '2026-06-13T10:00:00.000Z');
    const b = open(idOf(2), '2026-06-13T10:05:00.000Z'); // later
    const res = resolveOpenTimeEntries([a, b])!;
    expect(res.keepOpenId).toBe(b.id);
    expect(res.closures).toEqual([{ id: a.id, ended_at: '2026-06-13T10:05:00.000Z' }]);
  });

  it('is order-independent', () => {
    const a = open(idOf(1), '2026-06-13T10:00:00.000Z');
    const b = open(idOf(2), '2026-06-13T10:05:00.000Z');
    expect(resolveOpenTimeEntries([a, b])).toEqual(resolveOpenTimeEntries([b, a]));
  });

  it('breaks started_at ties by the larger id, deterministically', () => {
    const a = open(idOf(1), '2026-06-13T10:00:00.000Z');
    const b = open(idOf(2), '2026-06-13T10:00:00.000Z'); // same start, larger id
    const res = resolveOpenTimeEntries([a, b])!;
    expect(res.keepOpenId).toBe(b.id);
    expect(res.closures.map((c) => c.id)).toEqual([a.id]);
  });

  it('resolves three-way races to a single survivor', () => {
    const entries = [
      open(idOf(1), '2026-06-13T10:00:00.000Z'),
      open(idOf(2), '2026-06-13T10:10:00.000Z'), // winner
      open(idOf(3), '2026-06-13T10:05:00.000Z'),
    ];
    const res = resolveOpenTimeEntries(entries)!;
    expect(res.keepOpenId).toBe(idOf(2));
    expect(res.closures).toHaveLength(2);
    expect(res.closures.every((c) => c.ended_at === '2026-06-13T10:10:00.000Z')).toBe(true);
  });
});
