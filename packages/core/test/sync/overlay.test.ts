/**
 * M0 — two-layer overlay merge + trust-field stripping (1.3 §7.2, §7.2c).
 * Pure unit tests: the merge is the read-path contract the spike proves.
 */
import { describe, expect, it } from 'vitest';

import {
  buildRenameEffect,
  buildUpdateEffect,
  mergeRow,
  mergeTable,
  stripTrustFields,
  TRUST_FIELDS,
  type OverlayEffect,
} from '../../src/sync/overlay';

const hlc = (n: number): string => `${n.toString(16).padStart(12, '0')}-0000-dev-a`;

const effect = (over: Partial<OverlayEffect> & Pick<OverlayEffect, 'op'>): OverlayEffect => ({
  command_id: 'c1',
  hlc: hlc(1),
  table: 'nodes',
  row_id: 'n1',
  fields: {},
  seq: 0,
  ...over,
});

describe('stripTrustFields (§7.2c)', () => {
  it('removes every server-owned trust field', () => {
    const dirty = {
      id: 'n1',
      title: 'keep me',
      user_id: 'attacker',
      created_at: 'x',
      updated_at: 'x',
      deleted_at: 'x',
      hlc: 'forged',
      schema_version: 99,
      created_by_command_id: 'forged',
      last_modified_by_command_id: 'forged',
      source_kind: 'system',
      source_id: 'x',
      source_detail: { a: 1 },
      computed_by: 'server',
    };
    expect(stripTrustFields(dirty)).toEqual({ id: 'n1', title: 'keep me' });
  });

  it('keeps the row id and fact timestamps a command legitimately sets', () => {
    const payload = { id: 'n1', completed_at: '2026-06-13T10:00:00.000Z', started_at: '2026-06-13T09:00:00.000Z' };
    expect(stripTrustFields(payload)).toEqual(payload);
  });

  it('does not mutate the input', () => {
    const input = { title: 'x', user_id: 'u' };
    stripTrustFields(input);
    expect(input).toEqual({ title: 'x', user_id: 'u' });
  });

  it('passes non-objects through unchanged', () => {
    expect(stripTrustFields(null)).toBeNull();
    expect(stripTrustFields(5 as unknown)).toBe(5);
    expect(stripTrustFields(['a'] as unknown)).toEqual(['a']);
  });

  it('TRUST_FIELDS does not list the row id or fact timestamps', () => {
    expect(TRUST_FIELDS).not.toContain('id');
    expect(TRUST_FIELDS).not.toContain('completed_at');
    expect(TRUST_FIELDS).toContain('user_id');
  });
});

describe('mergeRow (§7.2)', () => {
  it('returns the replica unchanged when there are no effects', () => {
    const row = { id: 'n1', title: 'canonical' };
    expect(mergeRow(row, [])).toEqual(row);
  });

  it('patches the named field of an update over the replica (rename)', () => {
    const row = { id: 'n1', title: 'old', description: 'keep' };
    const merged = mergeRow(row, [effect({ op: 'update', fields: { title: 'new' } })]);
    expect(merged).toEqual({ id: 'n1', title: 'new', description: 'keep' });
  });

  it('seeds an overlay-only insert when no replica row exists yet', () => {
    const merged = mergeRow(null, [effect({ op: 'insert', fields: { id: 'n1', title: 'fresh' } })]);
    expect(merged).toEqual({ id: 'n1', title: 'fresh' });
  });

  it('tombstones the row on delete', () => {
    expect(mergeRow({ id: 'n1', title: 'x' }, [effect({ op: 'delete' })])).toBeNull();
  });

  it('applies effects in (hlc, seq) order regardless of array order', () => {
    const earlier = effect({ op: 'update', hlc: hlc(1), fields: { title: 'early' } });
    const later = effect({ op: 'update', hlc: hlc(2), fields: { title: 'late' } });
    expect(mergeRow({ id: 'n1' }, [later, earlier])).toEqual({ id: 'n1', title: 'late' });
    expect(mergeRow({ id: 'n1' }, [earlier, later])).toEqual({ id: 'n1', title: 'late' });
  });

  it('orders same-hlc effects by seq (intra-command fixpoint)', () => {
    const first = effect({ op: 'update', seq: 0, fields: { title: 'a', n: 1 } });
    const second = effect({ op: 'update', seq: 1, fields: { title: 'b' } });
    expect(mergeRow({ id: 'n1' }, [second, first])).toEqual({ id: 'n1', title: 'b', n: 1 });
  });
});

describe('mergeTable (§7.2)', () => {
  it('patches matching replica rows and leaves others untouched', () => {
    const replica = [
      { id: 'n1', title: 'A' },
      { id: 'n2', title: 'B' },
    ];
    const merged = mergeTable(replica, [effect({ op: 'update', row_id: 'n1', fields: { title: 'A*' } })]);
    expect(merged).toEqual([
      { id: 'n1', title: 'A*' },
      { id: 'n2', title: 'B' },
    ]);
  });

  it('appends overlay-only inserts and drops deletes', () => {
    const replica = [{ id: 'n1', title: 'A' }];
    const merged = mergeTable(replica, [
      effect({ op: 'delete', row_id: 'n1' }),
      effect({ op: 'insert', row_id: 'n2', fields: { id: 'n2', title: 'new' } }),
    ]);
    expect(merged).toEqual([{ id: 'n2', title: 'new' }]);
  });

  // The bug this pins: a clock-out (an UPDATE of `ended_at`) pending on a time
  // entry whose row was not in hand — its table had not been read yet at boot —
  // became a "row" of that one column. A time entry with no start threw in the
  // status index and blanked the app on every reload.
  it('does not turn an update with no row under it into a row', () => {
    const clockOut = effect({ op: 'update', table: 'time_entries', row_id: 'e1', fields: { ended_at: '2026-06-13T10:00:00.000Z' } });
    expect(mergeTable([], [clockOut])).toEqual([]);
    // …and it is the same update that patches the row once the row is there
    expect(mergeTable([{ id: 'e1', started_at: '2026-06-13T09:00:00.000Z', ended_at: null }], [clockOut])).toEqual([
      { id: 'e1', started_at: '2026-06-13T09:00:00.000Z', ended_at: '2026-06-13T10:00:00.000Z' },
    ]);
  });

  it('leaves the other rows alone when one update has nothing to patch', () => {
    const merged = mergeTable(
      [{ id: 'n1', title: 'A' }],
      [effect({ op: 'update', row_id: 'gone', fields: { title: 'orphan' } }), effect({ op: 'update', row_id: 'n1', fields: { title: 'A*' } })],
    );
    expect(merged).toEqual([{ id: 'n1', title: 'A*' }]);
  });

  it('still seeds a row from a pending insert, with its later updates applied — in either array order', () => {
    const insert = effect({ op: 'insert', hlc: hlc(1), row_id: 'e1', fields: { id: 'e1', started_at: 's' } });
    const update = effect({ op: 'update', hlc: hlc(2), row_id: 'e1', fields: { ended_at: 'e' } });
    expect(mergeTable([], [insert, update])).toEqual([{ id: 'e1', started_at: 's', ended_at: 'e' }]);
    expect(mergeTable([], [update, insert])).toEqual([{ id: 'e1', started_at: 's', ended_at: 'e' }]);
  });

  it('still shows an update that carries the whole row — the D5 rewrite of an insert onto the server id', () => {
    // A pending insert the server applied onto a DIFFERENT row (two devices made
    // the same day's note) is rewritten in place to an update of the server's
    // row, keeping every column. Until that row downloads, it IS the row.
    const rewritten = effect({ op: 'update', table: 'journal_entries', row_id: 'idB', fields: { id: 'idB', entry_date: '2026-06-11', content: 'from A' } });
    expect(mergeTable([], [rewritten])).toEqual([{ id: 'idB', entry_date: '2026-06-11', content: 'from A' }]);
    // …while a patch that names some OTHER id is still only a patch
    const stray = effect({ op: 'update', row_id: 'n9', fields: { id: 'other', title: 'x' } });
    expect(mergeTable([], [stray])).toEqual([]);
  });

  it('upsert: the pending update IS the row until the canonical one arrives (user_settings)', () => {
    // the server creates the settings row on the first settings.update, so on a
    // device that has never synced one, the optimistic toggle has no row to patch
    const toggle = effect({ op: 'update', table: 'user_settings', row_id: 'u1', fields: { journal_day_log: 0 } });
    expect(mergeTable([], [toggle], { upsert: true })).toEqual([{ journal_day_log: 0 }]);
    expect(mergeTable([{ id: 'u1', timezone: 'UTC', journal_day_log: 1 }], [toggle], { upsert: true })).toEqual([
      { id: 'u1', timezone: 'UTC', journal_day_log: 0 },
    ]);
  });

  it('keys rows by a custom identity column', () => {
    const merged = mergeTable([{ key: 'a', v: 1 }], [effect({ op: 'update', row_id: 'a', fields: { v: 2 } })], { idKey: 'key' });
    expect(merged).toEqual([{ key: 'a', v: 2 }]);
  });
});

describe('buildRenameEffect / buildUpdateEffect (M0 slice)', () => {
  it('builds a minimal-field nodes.title update', () => {
    const e = buildRenameEffect({ commandId: 'c1', hlc: hlc(7), nodeId: 'n1', title: 'Renamed' });
    expect(e).toEqual({
      command_id: 'c1',
      hlc: hlc(7),
      table: 'nodes',
      row_id: 'n1',
      op: 'update',
      fields: { title: 'Renamed' },
      seq: 0,
    });
  });

  it('buildUpdateEffect carries only the named fields', () => {
    const e = buildUpdateEffect({ commandId: 'c1', hlc: hlc(1), table: 'nodes', rowId: 'n1', fields: { description: 'd' } });
    expect(e.op).toBe('update');
    expect(e.fields).toEqual({ description: 'd' });
  });
});
