/**
 * M8 — the optimistic overlay effect builder for the full §8.1 catalog
 * (1.3 §7.2). Proves, without a browser:
 *  - each command maps to the minimal row effect(s) it makes locally;
 *  - the loose PowerSync representation is preserved (JSON columns are TEXT,
 *    booleans are 0/1) so the merged read feeds the row mappers cleanly;
 *  - inserts seed a complete-enough row; updates are minimal-field; soft-deletes
 *    drop the row from the merged read;
 *  - every CommandName is handled (runtime coverage + compile-time exhaustive).
 */
import { describe, expect, it } from 'vitest';

import { COMMAND_SCHEMAS, mergeTable, type CommandName, type OverlayEffect } from '@prisms/core';

import { buildAcceptSuggestionEffects, buildOptimisticEffects, type AcceptSuggestionBlock, type EffectSpec } from '../src/powersync/effects';
import { toAutomationRule, toNode, toTimeEntry } from '../src/powersync/rows';

const ctx = { userId: 'u1', deviceId: 'dev-1', now: '2026-06-28T00:00:00.000Z' };

/** Stamp specs into full OverlayEffects so they can feed mergeTable. */
const stamp = (specs: EffectSpec[]): OverlayEffect[] =>
  specs.map((s, seq) => ({ command_id: 'cmd-1', hlc: '000000000001-0000-dev-1', table: s.table, row_id: s.row_id, op: s.op, fields: s.fields, seq }));

describe('buildOptimisticEffects — inserts seed a complete row', () => {
  it('node.create → one insert with all named columns, JSON attributes as TEXT', () => {
    const [eff, ...rest] = buildOptimisticEffects('node.create', { id: 'n1', node_type: 'task', title: 'T', sort_order: 'a0', parent_id: 'p1', attributes: { x: 1 } }, ctx);
    expect(rest).toHaveLength(0);
    expect(eff).toMatchObject({ table: 'nodes', row_id: 'n1', op: 'insert' });
    expect(eff!.fields).toMatchObject({ id: 'n1', user_id: 'u1', parent_id: 'p1', node_type: 'task', title: 'T', description: '', sort_order: 'a0', estimate_minutes: null, habit_id: null });
    expect(eff!.fields['attributes']).toBe('{"x":1}'); // JSON text, not an object
    expect(eff!.fields['created_at']).toBe(ctx.now);
  });

  it('timer.clock_in → insert with device_id from ctx and planned as integer', () => {
    const [eff] = buildOptimisticEffects('timer.clock_in', { entry_id: 'e1', task_id: 't1', started_at: '2026-06-28T10:00:00.000Z' }, ctx);
    expect(eff).toMatchObject({ table: 'time_entries', row_id: 'e1', op: 'insert' });
    expect(eff!.fields).toMatchObject({ task_id: 't1', started_at: '2026-06-28T10:00:00.000Z', planned: 1, device_id: 'dev-1' });
  });

  it('inserts predict source_kind="user" for overlay display (§7.8) — so a just-created row is not "origin unknown"', () => {
    const [node] = buildOptimisticEffects('node.create', { id: 'n1', node_type: 'task', title: 'T', sort_order: 'a0' }, ctx);
    expect(node!.fields['source_kind']).toBe('user');
    const [block] = buildOptimisticEffects('block.create', { id: 'b1', task_id: 't1', starts_at: '2026-06-28T10:00:00.000Z', ends_at: '2026-06-28T11:00:00.000Z' }, ctx);
    expect(block!.fields['source_kind']).toBe('user');
  });
});

describe('buildOptimisticEffects — updates are minimal-field (§2.8)', () => {
  it('node.rename → exactly {title}, no system columns', () => {
    const effs = buildOptimisticEffects('node.rename', { id: 'n1', title: 'New' }, ctx);
    expect(effs).toEqual([{ table: 'nodes', row_id: 'n1', op: 'update', fields: { title: 'New' } }]);
  });

  it('node.move → renames new_parent_id to the parent_id column + sort_order', () => {
    const [eff] = buildOptimisticEffects('node.move', { id: 'n1', new_parent_id: 'p2', sort_order: 'a1' }, ctx);
    expect(eff!.fields).toEqual({ parent_id: 'p2', sort_order: 'a1' });
  });

  it('node.check_off → completed_at + default disposition; carries an explicit null block id', () => {
    const [eff] = buildOptimisticEffects('node.check_off', { id: 'n1', completed_at: '2026-06-28T11:00:00.000Z', completed_in_block_id: null }, ctx);
    expect(eff!.fields).toEqual({ completed_at: '2026-06-28T11:00:00.000Z', completion_disposition: 'completed', completed_in_block_id: null });
  });

  it('settings.update → keyed on the user id (the server settings PK)', () => {
    const effs = buildOptimisticEffects('settings.update', { day_reset_hour: 5 }, ctx);
    expect(effs).toEqual([{ table: 'user_settings', row_id: 'u1', op: 'update', fields: { day_reset_hour: 5 } }]);
  });
});

describe('buildOptimisticEffects — soft-deletes drop the row', () => {
  it('node.soft_delete → op delete (the row vanishes from the merged read)', () => {
    expect(buildOptimisticEffects('node.soft_delete', { id: 'n1' }, ctx)).toEqual([{ table: 'nodes', row_id: 'n1', op: 'delete', fields: {} }]);
  });
  it('edge.delete / tag.unplace → op delete', () => {
    expect(buildOptimisticEffects('edge.delete', { id: 'e1' }, ctx)[0]!.op).toBe('delete');
    expect(buildOptimisticEffects('tag.unplace', { id: 'tp1' }, ctx)[0]!.op).toBe('delete');
  });
});

describe('buildOptimisticEffects — special cases', () => {
  it('layout.renormalize_order → one sort_order update per node, in canonical order', () => {
    const effs = buildOptimisticEffects('layout.renormalize_order', { node_ids: ['a', 'b', 'c'] }, ctx);
    expect(effs).toHaveLength(3);
    expect(effs.map((e) => e.row_id)).toEqual(['a', 'b', 'c']);
    for (const e of effs) {
      expect(e).toMatchObject({ table: 'nodes', op: 'update' });
      expect(typeof e.fields['sort_order']).toBe('string');
    }
    // distinct, ascending fractional keys (deterministic renormalization)
    const orders = effs.map((e) => e.fields['sort_order'] as string);
    expect(new Set(orders).size).toBe(3);
    expect([...orders].sort()).toEqual(orders);
  });

  it('layout.set_position / set_collapsed → no payload row id, so no overlay here (live writer supplies it)', () => {
    expect(buildOptimisticEffects('layout.set_position', { diagram_id: 'd', node_id: 'n', x: 1, y: 2 }, ctx)).toEqual([]);
    expect(buildOptimisticEffects('layout.set_collapsed', { diagram_id: 'd', node_id: 'n', collapsed: true }, ctx)).toEqual([]);
  });

  it('score.set → an upsert insert (create-or-patch by the carried row id)', () => {
    const [eff] = buildOptimisticEffects('score.set', { id: 's1', criterion_id: 'c1', project_id: 'pr1', score: 3 }, ctx);
    expect(eff).toMatchObject({ table: 'decision_scores', row_id: 's1', op: 'insert' });
    expect(eff!.fields).toMatchObject({ id: 's1', criterion_id: 'c1', project_id: 'pr1', score: 3 });
  });

  it('block.accept_suggestion (base) → promote + clear ALL suggestion metadata (mirrors §7.5)', () => {
    const effs = buildOptimisticEffects('block.accept_suggestion', { id: 'b1' }, ctx);
    expect(effs).toEqual([
      { table: 'schedule_blocks', row_id: 'b1', op: 'update', fields: { status: 'committed', suggestion_reason: null, suggestion_batch_id: null, replaces_block_id: null, superseded_at: null } },
    ]);
  });
});

describe('buildAcceptSuggestionEffects — mirrors the server §7.5 transaction', () => {
  const block = (over: Partial<AcceptSuggestionBlock> & { id: string }): AcceptSuggestionBlock => ({
    task_id: 'task-1', status: 'suggested', starts_at: '2026-07-01T14:00:00.000Z', ends_at: '2026-07-01T15:00:00.000Z',
    replaces_block_id: null, superseded_at: null, deleted_at: null, ...over,
  });

  it('promotes the accepted suggestion, clearing suggestion metadata', () => {
    const effs = buildAcceptSuggestionEffects([block({ id: 'b1' })], 'b1', ctx.now);
    expect(effs).toEqual([
      { table: 'schedule_blocks', row_id: 'b1', op: 'update', fields: { status: 'committed', suggestion_reason: null, suggestion_batch_id: null, replaces_block_id: null, superseded_at: null } },
    ]);
  });

  it('soft-deletes the flexible block it replaces (DoD: the replaced block resolves)', () => {
    const effs = buildAcceptSuggestionEffects([block({ id: 'b1', replaces_block_id: 'old' })], 'b1', ctx.now);
    expect(effs).toContainEqual({ table: 'schedule_blocks', row_id: 'old', op: 'delete', fields: {} });
  });

  it('supersedes overlapping LIVE sibling suggestions for the same task', () => {
    const blocks = [
      block({ id: 'b1' }), // 14:00–15:00
      block({ id: 'b2', starts_at: '2026-07-01T14:30:00.000Z', ends_at: '2026-07-01T15:30:00.000Z' }), // overlaps → superseded
      block({ id: 'b3', starts_at: '2026-07-01T16:00:00.000Z', ends_at: '2026-07-01T17:00:00.000Z' }), // no overlap → untouched
      block({ id: 'b4', task_id: 'other', starts_at: '2026-07-01T14:30:00.000Z', ends_at: '2026-07-01T15:30:00.000Z' }), // other task → untouched
      block({ id: 'b5', starts_at: '2026-07-01T14:30:00.000Z', ends_at: '2026-07-01T15:30:00.000Z', superseded_at: '2026-06-01T00:00:00Z' }), // already superseded → untouched
    ];
    const effs = buildAcceptSuggestionEffects(blocks, 'b1', ctx.now);
    // the promote (b1) clears superseded_at to null; only a sibling supersede stamps a timestamp.
    const superseded = effs.filter((e) => typeof e.fields['superseded_at'] === 'string').map((e) => e.row_id);
    expect(superseded).toEqual(['b2']);
    expect(effs.find((e) => e.row_id === 'b2')!.fields['superseded_at']).toBe(ctx.now);
  });

  it('unknown id → still emits the promote (server is authoritative)', () => {
    expect(buildAcceptSuggestionEffects([], 'missing', ctx.now)).toHaveLength(1);
  });
});

describe('representation round-trips through the row mappers (rows.ts)', () => {
  it('rule.create JSON columns survive merge → toAutomationRule (TEXT, not dropped)', () => {
    const specs = buildOptimisticEffects(
      'rule.create',
      { id: 'r1', trigger: 'task_completed', conditions: { all: [] }, actions: [{ action: 'spawn_task', slot: 0, template: { title: 'X', parent: 'same_as_trigger' } }], enabled: true },
      ctx,
    );
    const merged = mergeTable([], stamp(specs));
    expect(merged).toHaveLength(1);
    const rule = toAutomationRule(merged[0]!);
    expect(rule.conditions).toEqual({ all: [] });
    expect(rule.actions).toEqual([{ action: 'spawn_task', slot: 0, template: { title: 'X', parent: 'same_as_trigger' } }]);
    expect(rule.enabled).toBe(true); // integer 1 widened back to boolean
  });

  it('node.create insert merges into an empty replica → a renderable node', () => {
    const specs = buildOptimisticEffects('node.create', { id: 'n1', node_type: 'task', title: 'Fresh', sort_order: 'a0', parent_id: 'p1' }, ctx);
    const node = toNode(mergeTable([], stamp(specs))[0]!);
    expect(node).toMatchObject({ id: 'n1', user_id: 'u1', node_type: 'task', title: 'Fresh', sort_order: 'a0', parent_id: 'p1', attributes: {} });
  });

  it('node.rename update patches an existing replica row without clobber', () => {
    const replica = [{ id: 'n1', user_id: 'u1', title: 'Old', description: 'keep', sort_order: 'a0' }];
    const specs = buildOptimisticEffects('node.rename', { id: 'n1', title: 'New' }, ctx);
    const merged = mergeTable(replica, stamp(specs));
    expect(merged[0]).toMatchObject({ title: 'New', description: 'keep', sort_order: 'a0' });
  });

  it('timer.review completed_session widens to a boolean for toTimeEntry', () => {
    const specs = buildOptimisticEffects('timer.review', { entry_id: 'e1', focus_factor: 0.8, completed_session: true }, ctx);
    const replica = [{ id: 'e1', user_id: 'u1', task_id: 't1', started_at: '2026-06-28T10:00:00.000Z', ended_at: '2026-06-28T11:00:00.000Z' }];
    const entry = toTimeEntry(mergeTable(replica, stamp(specs))[0]!);
    expect(entry.completed_session).toBe(true);
    expect(entry.focus_factor).toBe(0.8);
  });
});

describe('full catalog coverage', () => {
  // a permissive payload carrying every id-ish field any verb reads.
  const anyPayload = {
    id: 'x', entry_id: 'x', node_ids: ['a', 'b'], node_id: 'n', diagram_id: 'd', placement_id: 'pl',
    title: 't', label: 'l', sort_order: 'a0', node_type: 'task', trigger: 'task_completed',
  };

  it('every CommandName produces an array (no throw) — runtime exhaustiveness', () => {
    const names = Object.keys(COMMAND_SCHEMAS) as CommandName[];
    expect(names.length).toBeGreaterThan(50);
    for (const name of names) {
      const effs = buildOptimisticEffects(name, anyPayload, ctx);
      expect(Array.isArray(effs), `${name} returns EffectSpec[]`).toBe(true);
      for (const e of effs) {
        expect(['insert', 'update', 'delete']).toContain(e.op);
        expect(typeof e.table).toBe('string');
        expect(e.row_id.length).toBeGreaterThan(0);
      }
    }
  });
});
