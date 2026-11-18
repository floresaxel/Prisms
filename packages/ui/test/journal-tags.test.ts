/**
 * Journal tags across the client sync layer: the optimistic effect predicts the
 * canonical list the server will store, and the row mapper reads whatever
 * PowerSync holds (JSON text) without ever throwing on a dirty value.
 */
import { describe, expect, it } from 'vitest';

import { buildOptimisticEffects } from '../src/powersync/effects';
import { toJournalEntry } from '../src/powersync/rows';

const ctx = { userId: 'u1', deviceId: 'web-1', now: '2026-06-27T00:00:00.000Z' };

describe('journal.set_tags — optimistic effect', () => {
  it('patches the existing row with the CANONICAL list, as JSON text', () => {
    const [fx, ...rest] = buildOptimisticEffects('journal.set_tags', { id: 'row-1', tags: ['Work', '#health', 'work'] }, ctx);
    expect(rest).toHaveLength(0);
    expect(fx).toMatchObject({ table: 'journal_entries', row_id: 'row-1', op: 'update' });
    expect(fx!.fields).toEqual({ tags: JSON.stringify(['work', 'health']) });
  });

  it('never mints a row: it is an update, not an insert', () => {
    const [fx] = buildOptimisticEffects('journal.set_tags', { id: 'row-1', tags: [] }, ctx);
    expect(fx!.op).toBe('update');
    expect(fx!.fields).toEqual({ tags: '[]' });
  });
});

describe('toJournalEntry — tags', () => {
  const row = (tags: unknown) => ({ id: 'r', entry_date: '2026-06-27', month_key: '2026-06', content: 'x', tags });

  it('parses the JSON text', () => {
    expect(toJournalEntry(row('["work","health"]')).tags).toEqual(['work', 'health']);
  });
  it('reads a missing, empty or malformed value as untagged', () => {
    for (const bad of [undefined, null, '', 'not json', '{"a":1}', '42']) {
      expect(toJournalEntry(row(bad)).tags).toEqual([]);
    }
  });
  it('re-canonicalises what it reads, so a hand-edited row cannot show a duplicate chip', () => {
    expect(toJournalEntry(row('["Work","work"," #Health "]')).tags).toEqual(['work', 'health']);
  });
});