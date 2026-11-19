/**
 * Journal tags across the client sync layer: the optimistic effect predicts the
 * canonical list the server will store, and the row mapper reads whatever
 * PowerSync holds (JSON text) without ever throwing on a dirty value.
 */
import { describe, expect, it } from 'vitest';

import { buildOptimisticEffects } from '../src/powersync/effects';
import { toJournalEntry } from '../src/powersync/rows';
import { appSchema } from '../src/powersync/schema';

const ctx = { userId: 'u1', deviceId: 'web-1', now: '2026-06-27T00:00:00.000Z' };

const columnsOf = (name: string) =>
  appSchema.tables.find((t) => t.name === name)?.columns.map((c) => c.name) ?? [];

describe('replica schema — tags', () => {
  // Regression: the column sat on decision_boards, so the replica view of a note
  // dropped its tags and a tag showed only while the note's own write was still
  // in the overlay.
  it('declares tags on journal_entries, where the server stores them', () => {
    expect(columnsOf('journal_entries')).toContain('tags');
  });
  it('does not declare tags on decision_boards, which has no such column', () => {
    expect(columnsOf('decision_boards')).not.toContain('tags');
  });
});

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