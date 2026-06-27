/**
 * M1 — versioning primitives (1.3 §7.11): additive-only schema check + the
 * client-too-old floor gate.
 */
import { describe, expect, it } from 'vitest';

import {
  COMMAND_VERSION,
  ROW_SCHEMA_VERSION,
  defaultCommandMeta,
  isAdditiveSchemaChange,
  isClientTooOld,
  type TableShape,
} from '../../src/sync/version';

const col = (type: string, nullable = false, hasDefault = false) => ({ type, nullable, hasDefault });

const base: TableShape = {
  id: col('uuid'),
  title: col('text'),
  count: col('integer', false, true),
};

describe('isAdditiveSchemaChange (§7.11)', () => {
  it('accepts a new nullable column', () => {
    const next: TableShape = { ...base, note: col('text', true) };
    expect(isAdditiveSchemaChange(base, next).ok).toBe(true);
  });

  it('accepts a new NOT-NULL column that has a default', () => {
    const next: TableShape = { ...base, hlc: col('text', false, true) };
    expect(isAdditiveSchemaChange(base, next).ok).toBe(true);
  });

  it('rejects a new NOT-NULL column without a default', () => {
    const next: TableShape = { ...base, hlc: col('text', false, false) };
    const r = isAdditiveSchemaChange(base, next);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('E_SCHEMA_NOT_ADDITIVE');
  });

  it('rejects a removed column', () => {
    const next: TableShape = { id: base['id']!, title: base['title']! };
    expect(isAdditiveSchemaChange(base, next).ok).toBe(false);
  });

  it('rejects a type change', () => {
    const next: TableShape = { ...base, count: col('text', false, true) };
    expect(isAdditiveSchemaChange(base, next).ok).toBe(false);
  });

  it('rejects tightening a nullable column to NOT NULL', () => {
    const prev: TableShape = { ...base, note: col('text', true) };
    const next: TableShape = { ...base, note: col('text', false) };
    expect(isAdditiveSchemaChange(prev, next).ok).toBe(false);
  });

  it('lists every breaking change in details', () => {
    const next: TableShape = { id: base['id']!, title: col('integer') };
    const r = isAdditiveSchemaChange(base, next);
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.error.details as { breaking: string[] }).breaking.length).toBeGreaterThanOrEqual(2);
  });
});

describe('isClientTooOld + defaults', () => {
  it('flags a client below the floor only', () => {
    expect(isClientTooOld(1, 2)).toBe(true);
    expect(isClientTooOld(2, 2)).toBe(false);
    expect(isClientTooOld(3, 2)).toBe(false);
  });

  it('defaultCommandMeta carries the current versions and given depends_on', () => {
    expect(defaultCommandMeta(['a', 'b'])).toEqual({
      command_version: COMMAND_VERSION,
      schema_version: ROW_SCHEMA_VERSION,
      depends_on: ['a', 'b'],
    });
    expect(defaultCommandMeta().depends_on).toEqual([]);
  });
});
