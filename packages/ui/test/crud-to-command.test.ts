/** S15: the PowerSync CRUD → §8.1 command bridge (§7.3). */
import { describe, expect, it } from 'vitest';

import { crudToCommand, type CrudLike } from '../src/powersync/crud-to-command';

const entry = (over: Partial<CrudLike> & Pick<CrudLike, 'op' | 'table' | 'id'>): CrudLike => ({ opData: null, ...over });

describe('nodes', () => {
  it('PUT → node.create with only the create fields', () => {
    const c = crudToCommand(
      entry({
        op: 'PUT',
        table: 'nodes',
        id: 'n1',
        opData: { node_type: 'task', title: 'T', sort_order: 'a0', parent_id: 'p1', estimate_minutes: 60, user_id: 'u', created_at: 'x', completed_at: null },
      }),
    );
    expect(c).toEqual({
      name: 'node.create',
      payload: { id: 'n1', node_type: 'task', title: 'T', sort_order: 'a0', parent_id: 'p1', estimate_minutes: 60 },
    });
  });

  it('infers the verb from the changed column (per-field patches)', () => {
    const t = '2026-06-13T12:00:00.000Z';
    expect(crudToCommand(entry({ op: 'PATCH', table: 'nodes', id: 'n1', opData: { completed_at: t, updated_at: t } }))).toEqual({
      name: 'node.check_off',
      payload: { id: 'n1', completed_at: t },
    });
    expect(crudToCommand(entry({ op: 'PATCH', table: 'nodes', id: 'n1', opData: { completed_at: null, updated_at: t } }))).toEqual({
      name: 'node.uncheck',
      payload: { id: 'n1' },
    });
    expect(crudToCommand(entry({ op: 'PATCH', table: 'nodes', id: 'n1', opData: { title: 'New', updated_at: t } }))).toEqual({
      name: 'node.rename',
      payload: { id: 'n1', title: 'New' },
    });
    expect(crudToCommand(entry({ op: 'PATCH', table: 'nodes', id: 'n1', opData: { deleted_at: t, updated_at: t } }))).toEqual({
      name: 'node.soft_delete',
      payload: { id: 'n1' },
    });
    expect(crudToCommand(entry({ op: 'PATCH', table: 'nodes', id: 'n1', opData: { parent_id: 'p2', sort_order: 'a5', updated_at: t } }))).toEqual({
      name: 'node.move',
      payload: { id: 'n1', new_parent_id: 'p2', sort_order: 'a5' },
    });
    expect(crudToCommand(entry({ op: 'PATCH', table: 'nodes', id: 'n1', opData: { estimate_minutes: 90, updated_at: t } }))).toEqual({
      name: 'node.set_estimate',
      payload: { id: 'n1', estimate_minutes: 90 },
    });
  });

  it('DELETE maps to soft_delete (we never hard-delete)', () => {
    expect(crudToCommand(entry({ op: 'DELETE', table: 'nodes', id: 'n1' }))).toEqual({ name: 'node.soft_delete', payload: { id: 'n1' } });
  });

  it('node_type + parent_id together → activity.promote (not a plain retype)', () => {
    const t = '2026-06-14T10:00:00.000Z';
    expect(
      crudToCommand(entry({ op: 'PATCH', table: 'nodes', id: 'a1', opData: { node_type: 'task', parent_id: 'p1', habit_id: null, updated_at: t } })),
    ).toEqual({ name: 'activity.promote', payload: { id: 'a1', parent_id: 'p1' } });
  });

  it('node_type + habit_id together → activity.promote onto the habit', () => {
    const t = '2026-06-14T10:00:00.000Z';
    expect(
      crudToCommand(entry({ op: 'PATCH', table: 'nodes', id: 'a1', opData: { node_type: 'task', parent_id: null, habit_id: 'h1', updated_at: t } })),
    ).toEqual({ name: 'activity.promote', payload: { id: 'a1', habit_id: 'h1' } });
  });

  it('a node_type-only patch is still a plain retype', () => {
    const t = '2026-06-14T10:00:00.000Z';
    expect(crudToCommand(entry({ op: 'PATCH', table: 'nodes', id: 'n1', opData: { node_type: 'project', updated_at: t } }))).toEqual({
      name: 'node.retype',
      payload: { id: 'n1', node_type: 'project' },
    });
  });

  it('an updated_at-only patch translates to nothing', () => {
    expect(crudToCommand(entry({ op: 'PATCH', table: 'nodes', id: 'n1', opData: { updated_at: 'x' } }))).toBeNull();
  });
});

describe('time_entries', () => {
  it('PUT → timer.clock_in; ended_at patch → clock_out; focus patch → review', () => {
    expect(crudToCommand(entry({ op: 'PUT', table: 'time_entries', id: 'e1', opData: { task_id: 't1', started_at: 's', planned: 1 } }))).toEqual({
      name: 'timer.clock_in',
      payload: { entry_id: 'e1', task_id: 't1', started_at: 's', planned: true },
    });
    expect(crudToCommand(entry({ op: 'PATCH', table: 'time_entries', id: 'e1', opData: { ended_at: 'x', updated_at: 'x' } }))).toEqual({
      name: 'timer.clock_out',
      payload: { entry_id: 'e1', ended_at: 'x' },
    });
    expect(crudToCommand(entry({ op: 'PATCH', table: 'time_entries', id: 'e1', opData: { focus_factor: 0.9, completed_session: 1, updated_at: 'x' } }))).toEqual({
      name: 'timer.review',
      payload: { entry_id: 'e1', focus_factor: 0.9, completed_session: true },
    });
  });
});

describe('user_settings + unknown tables', () => {
  it('settings patch → settings.update with only changed fields', () => {
    expect(crudToCommand(entry({ op: 'PATCH', table: 'user_settings', id: 'u1', opData: { day_reset_hour: 5, updated_at: 'x' } }))).toEqual({
      name: 'settings.update',
      payload: { day_reset_hour: 5 },
    });
  });

  it('a table with no client mutations returns null', () => {
    expect(crudToCommand(entry({ op: 'PATCH', table: 'computed_aggregates', id: 'a1', opData: { value: '{}' } }))).toBeNull();
  });
});
