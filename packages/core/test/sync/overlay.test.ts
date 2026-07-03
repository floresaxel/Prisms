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
