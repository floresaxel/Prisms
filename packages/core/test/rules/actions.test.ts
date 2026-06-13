/**
 * S7: action templates (§9.3) — interpolation, trigger-relative dates,
 * and the actions schema (slot uniqueness, edge_from_slot integrity).
 */
import { describe, expect, it } from 'vitest';

import {
  automationActionsSchema,
  interpolate,
  resolveTriggerDate,
} from '../../src/rules/actions';
import { buildFactContext } from '../../src/status/context';
import { idOf, makeNode } from '../helpers/fixtures';

const trigger = makeNode({
  id: idOf(1),
  node_type: 'task',
  title: 'Lecture 4: Dynamics',
  description: 'ch. 3',
  parent_id: idOf(99),
  created_at: '2026-06-10T09:00:00.000Z',
  completed_at: '2026-06-12T23:30:00.000Z',
});

describe('interpolate (§9.3)', () => {
  it('substitutes known trigger placeholders', () => {
    expect(interpolate('Pre-brief: {trigger.title}', trigger)).toBe(
      'Pre-brief: Lecture 4: Dynamics',
    );
    expect(interpolate('{trigger.type} / {trigger.id}', trigger)).toBe(
      `task / ${idOf(1)}`,
    );
    expect(interpolate('notes: {trigger.description}', trigger)).toBe('notes: ch. 3');
  });

  it('leaves unknown placeholders literal (deterministic, visible)', () => {
    expect(interpolate('x {trigger.bogus} y', trigger)).toBe('x {trigger.bogus} y');
    expect(interpolate('no placeholders', trigger)).toBe('no placeholders');
  });
});

describe('resolveTriggerDate (§9.3 trigger-relative dates)', () => {
  // default settings: reset hour 4, America/New_York
  const ctx = buildFactContext({ nodes: [trigger] });

  it('reads the triggering fact, never the wall clock', () => {
    // completed 2026-06-12T23:30Z = 19:30 NY ⇒ bucket 06-12; +P2D ⇒ 06-14
    expect(resolveTriggerDate('trigger.completed_at + P2D', trigger, ctx)).toBe(
      '2026-06-14',
    );
    // created 2026-06-10T09:00Z = 05:00 NY ⇒ bucket 06-10
    expect(resolveTriggerDate('trigger.created_at', trigger, ctx)).toBe('2026-06-10');
  });

  it('supports subtraction and hour/week durations', () => {
    expect(resolveTriggerDate('trigger.completed_at - P1D', trigger, ctx)).toBe(
      '2026-06-11',
    );
    expect(resolveTriggerDate('trigger.completed_at + P1W', trigger, ctx)).toBe(
      '2026-06-19',
    );
  });

  it('returns null for a timestamp the trigger lacks or a malformed expression', () => {
    const created = makeNode({ id: idOf(2), node_type: 'task', completed_at: null });
    const cctx = buildFactContext({ nodes: [created] });
    expect(resolveTriggerDate('trigger.completed_at + P2D', created, cctx)).toBeNull();
    expect(resolveTriggerDate('trigger.completed_at + P2M', trigger, ctx)).toBeNull();
    expect(resolveTriggerDate('garbage', trigger, ctx)).toBeNull();
  });
});

describe('automationActionsSchema', () => {
  const valid = [
    { action: 'spawn_task', slot: 0, template: { title: 'A', estimate_minutes: 30 } },
    {
      action: 'spawn_task',
      slot: 1,
      template: { title: 'B', edge_from_slot: 0, edge_type: 'FS' },
    },
  ];

  it('accepts the §9.3 lecture actions', () => {
    expect(automationActionsSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects duplicate slots', () => {
    const dup = [
      { action: 'spawn_task', slot: 0, template: { title: 'A' } },
      { action: 'spawn_task', slot: 0, template: { title: 'B' } },
    ];
    expect(automationActionsSchema.safeParse(dup).success).toBe(false);
  });

  it('rejects edge_from_slot referencing a missing or self slot', () => {
    const missing = [{ action: 'spawn_task', slot: 0, template: { title: 'A', edge_from_slot: 9 } }];
    expect(automationActionsSchema.safeParse(missing).success).toBe(false);
    const selfRef = [{ action: 'spawn_task', slot: 0, template: { title: 'A', edge_from_slot: 0 } }];
    expect(automationActionsSchema.safeParse(selfRef).success).toBe(false);
  });

  it('rejects empty and unknown-field templates', () => {
    expect(automationActionsSchema.safeParse([]).success).toBe(false);
    const unknown = [{ action: 'spawn_task', slot: 0, template: { title: 'A', foo: 1 } }];
    expect(automationActionsSchema.safeParse(unknown).success).toBe(false);
  });
});
