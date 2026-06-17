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

  it('check_off carries the completion disposition when present (Phase 2)', () => {
    const t = '2026-06-13T12:00:00.000Z';
    // obsolete check-off (completed_at + disposition both set in one write)
    expect(crudToCommand(entry({ op: 'PATCH', table: 'nodes', id: 'n1', opData: { completed_at: t, completion_disposition: 'obsolete', updated_at: t } }))).toEqual({
      name: 'node.check_off',
      payload: { id: 'n1', completed_at: t, disposition: 'obsolete' },
    });
    // legacy/plain check-off without a disposition column → no disposition field (server defaults 'completed')
    expect(crudToCommand(entry({ op: 'PATCH', table: 'nodes', id: 'n1', opData: { completed_at: t, updated_at: t } }))).toEqual({
      name: 'node.check_off',
      payload: { id: 'n1', completed_at: t },
    });
  });

  it('check_off carries the completed-in block, including an explicit null = unscheduled (Phase 3)', () => {
    const t = '2026-06-13T12:00:00.000Z';
    expect(crudToCommand(entry({ op: 'PATCH', table: 'nodes', id: 'n1', opData: { completed_at: t, completed_in_block_id: 'b1', updated_at: t } }))).toEqual({
      name: 'node.check_off',
      payload: { id: 'n1', completed_at: t, completed_in_block_id: 'b1' },
    });
    expect(crudToCommand(entry({ op: 'PATCH', table: 'nodes', id: 'n1', opData: { completed_at: t, completed_in_block_id: null, updated_at: t } }))).toEqual({
      name: 'node.check_off',
      payload: { id: 'n1', completed_at: t, completed_in_block_id: null },
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

describe('schedule_blocks', () => {
  const t = '2026-06-15T09:00:00.000Z';
  const end = '2026-06-15T10:00:00.000Z';

  it('PUT → block.create with the create fields', () => {
    expect(
      crudToCommand(entry({ op: 'PUT', table: 'schedule_blocks', id: 'b1', opData: { task_id: 'k1', starts_at: t, ends_at: end, anchor_type: 'none', status: 'committed' } })),
    ).toEqual({ name: 'block.create', payload: { id: 'b1', task_id: 'k1', starts_at: t, ends_at: end, anchor_type: 'none' } });
  });

  it('starts_at/ends_at patch → block.move', () => {
    expect(
      crudToCommand(entry({ op: 'PATCH', table: 'schedule_blocks', id: 'b1', opData: { starts_at: t, ends_at: end, updated_at: t } })),
    ).toEqual({ name: 'block.move', payload: { id: 'b1', starts_at: t, ends_at: end } });
  });

  it('status patch → block.accept_suggestion', () => {
    expect(
      crudToCommand(entry({ op: 'PATCH', table: 'schedule_blocks', id: 'b1', opData: { status: 'committed', suggestion_reason: null, updated_at: t } })),
    ).toEqual({ name: 'block.accept_suggestion', payload: { id: 'b1' } });
  });

  it('anchor_type patch → block.set_anchor', () => {
    expect(
      crudToCommand(entry({ op: 'PATCH', table: 'schedule_blocks', id: 'b1', opData: { anchor_type: 'both', updated_at: t } })),
    ).toEqual({ name: 'block.set_anchor', payload: { id: 'b1', anchor_type: 'both' } });
  });

  it('soft-delete (reject/delete) → block.delete', () => {
    expect(
      crudToCommand(entry({ op: 'PATCH', table: 'schedule_blocks', id: 'b1', opData: { deleted_at: t, updated_at: t } })),
    ).toEqual({ name: 'block.delete', payload: { id: 'b1' } });
    expect(crudToCommand(entry({ op: 'DELETE', table: 'schedule_blocks', id: 'b1' }))).toEqual({ name: 'block.delete', payload: { id: 'b1' } });
  });
});

describe('habits + habit_completions', () => {
  const t = '2026-06-15T09:00:00.000Z';

  it('PUT → habit.create, parsing level_thresholds_hours JSON text → array', () => {
    expect(
      crudToCommand(entry({ op: 'PUT', table: 'habits', id: 'h1', opData: { vision_id: 'v1', title: 'Piano', rrule: 'FREQ=DAILY', streak_mode: 'daily', daily_target_minutes: 30, mastery_target_hours: 100, level_thresholds_hours: '[1,10,100]' } })),
    ).toEqual({
      name: 'habit.create',
      payload: { id: 'h1', vision_id: 'v1', title: 'Piano', rrule: 'FREQ=DAILY', streak_mode: 'daily', daily_target_minutes: 30, mastery_target_hours: 100, level_thresholds_hours: [1, 10, 100] },
    });
  });

  it('PATCH changed fields → habit.update (level thresholds parsed)', () => {
    expect(
      crudToCommand(entry({ op: 'PATCH', table: 'habits', id: 'h1', opData: { daily_target_minutes: 45, level_thresholds_hours: '[2,20]', updated_at: t } })),
    ).toEqual({ name: 'habit.update', payload: { id: 'h1', daily_target_minutes: 45, level_thresholds_hours: [2, 20] } });
  });

  it('PATCH updated_at-only → null; soft-delete → habit.delete', () => {
    expect(crudToCommand(entry({ op: 'PATCH', table: 'habits', id: 'h1', opData: { updated_at: t } }))).toBeNull();
    expect(crudToCommand(entry({ op: 'PATCH', table: 'habits', id: 'h1', opData: { deleted_at: t, updated_at: t } }))).toEqual({ name: 'habit.delete', payload: { id: 'h1' } });
    expect(crudToCommand(entry({ op: 'DELETE', table: 'habits', id: 'h1' }))).toEqual({ name: 'habit.delete', payload: { id: 'h1' } });
  });

  it('completion PUT → habit.check_off; non-PUT → null (append-only facts)', () => {
    expect(
      crudToCommand(entry({ op: 'PUT', table: 'habit_completions', id: 'c1', opData: { habit_id: 'h1', occurrence_date: '2026-06-15', completed_at: t } })),
    ).toEqual({ name: 'habit.check_off', payload: { id: 'c1', habit_id: 'h1', occurrence_date: '2026-06-15', completed_at: t } });
    expect(crudToCommand(entry({ op: 'PATCH', table: 'habit_completions', id: 'c1', opData: { deleted_at: t } }))).toBeNull();
  });
});

describe('decision board', () => {
  const t = '2026-06-15T09:00:00.000Z';

  it('board PUT → board.create; PATCH ignored', () => {
    expect(crudToCommand(entry({ op: 'PUT', table: 'decision_boards', id: 'b1', opData: { title: 'Priorities' } }))).toEqual({
      name: 'board.create', payload: { id: 'b1', title: 'Priorities' },
    });
    expect(crudToCommand(entry({ op: 'PATCH', table: 'decision_boards', id: 'b1', opData: { title: 'X', updated_at: t } }))).toBeNull();
  });

  it('criterion PUT → criterion.create; weight PATCH → criterion.set_weight', () => {
    expect(crudToCommand(entry({ op: 'PUT', table: 'decision_criteria', id: 'c1', opData: { board_id: 'b1', label: 'Impact', weight: 3 } }))).toEqual({
      name: 'criterion.create', payload: { id: 'c1', board_id: 'b1', label: 'Impact', weight: 3 },
    });
    expect(crudToCommand(entry({ op: 'PATCH', table: 'decision_criteria', id: 'c1', opData: { weight: 5, updated_at: t } }))).toEqual({
      name: 'criterion.set_weight', payload: { id: 'c1', weight: 5 },
    });
  });

  it('score PUT and score PATCH both → score.set with the upsert key fields', () => {
    expect(crudToCommand(entry({ op: 'PUT', table: 'decision_scores', id: 's1', opData: { criterion_id: 'c1', project_id: 'p1', score: 7 } }))).toEqual({
      name: 'score.set', payload: { id: 's1', criterion_id: 'c1', project_id: 'p1', score: 7 },
    });
    // update re-states criterion_id/project_id so the patch carries them
    expect(crudToCommand(entry({ op: 'PATCH', table: 'decision_scores', id: 's1', opData: { criterion_id: 'c1', project_id: 'p1', score: 9, updated_at: t } }))).toEqual({
      name: 'score.set', payload: { id: 's1', criterion_id: 'c1', project_id: 'p1', score: 9 },
    });
  });
});

describe('tags (confirmable event tags)', () => {
  const t = '2026-06-15T09:00:00.000Z';

  it('tag PUT → tag.create; label PATCH → tag.rename; delete → tag.delete', () => {
    expect(crudToCommand(entry({ op: 'PUT', table: 'tags', id: 'g1', opData: { label: 'on time?', habit_id: 'h1' } }))).toEqual({
      name: 'tag.create', payload: { id: 'g1', label: 'on time?', habit_id: 'h1' },
    });
    expect(crudToCommand(entry({ op: 'PATCH', table: 'tags', id: 'g1', opData: { label: 'on schedule?', updated_at: t } }))).toEqual({
      name: 'tag.rename', payload: { id: 'g1', label: 'on schedule?' },
    });
    expect(crudToCommand(entry({ op: 'PATCH', table: 'tags', id: 'g1', opData: { deleted_at: t } }))).toEqual({ name: 'tag.delete', payload: { id: 'g1' } });
    expect(crudToCommand(entry({ op: 'DELETE', table: 'tags', id: 'g1' }))).toEqual({ name: 'tag.delete', payload: { id: 'g1' } });
  });

  it('placement PUT → tag.place; soft-delete/DELETE → tag.unplace', () => {
    expect(crudToCommand(entry({ op: 'PUT', table: 'tag_placements', id: 'pl1', opData: { block_id: 'b1', tag_id: 'g1' } }))).toEqual({
      name: 'tag.place', payload: { id: 'pl1', block_id: 'b1', tag_id: 'g1' },
    });
    expect(crudToCommand(entry({ op: 'PATCH', table: 'tag_placements', id: 'pl1', opData: { deleted_at: t } }))).toEqual({ name: 'tag.unplace', payload: { id: 'pl1' } });
    expect(crudToCommand(entry({ op: 'DELETE', table: 'tag_placements', id: 'pl1' }))).toEqual({ name: 'tag.unplace', payload: { id: 'pl1' } });
  });

  it('answer PUT and value PATCH both → tag.answer with placement_id; clear → tag.clear_answer', () => {
    expect(crudToCommand(entry({ op: 'PUT', table: 'tag_answers', id: 'a1', opData: { placement_id: 'pl1', value: 'yes', answered_at: t } }))).toEqual({
      name: 'tag.answer', payload: { id: 'a1', placement_id: 'pl1', value: 'yes', answered_at: t },
    });
    // re-answering re-states placement_id so the patch carries the upsert key
    expect(crudToCommand(entry({ op: 'PATCH', table: 'tag_answers', id: 'a1', opData: { value: 'no', answered_at: t, placement_id: 'pl1', updated_at: t } }))).toEqual({
      name: 'tag.answer', payload: { id: 'a1', placement_id: 'pl1', value: 'no', answered_at: t },
    });
    expect(crudToCommand(entry({ op: 'PATCH', table: 'tag_answers', id: 'a1', opData: { deleted_at: t } }))).toEqual({ name: 'tag.clear_answer', payload: { id: 'a1' } });
  });
});

describe('edges (the dependency graph)', () => {
  const t = '2026-06-15T09:00:00.000Z';
  it('PUT → edge.create; soft-delete/DELETE → edge.delete', () => {
    expect(crudToCommand(entry({ op: 'PUT', table: 'edges', id: 'e1', opData: { predecessor_id: 'a', successor_id: 'b', edge_type: 'FS', lag_minutes: 0 } }))).toEqual({
      name: 'edge.create', payload: { id: 'e1', predecessor_id: 'a', successor_id: 'b', edge_type: 'FS', lag_minutes: 0 },
    });
    expect(crudToCommand(entry({ op: 'PATCH', table: 'edges', id: 'e1', opData: { deleted_at: t } }))).toEqual({ name: 'edge.delete', payload: { id: 'e1' } });
    expect(crudToCommand(entry({ op: 'DELETE', table: 'edges', id: 'e1' }))).toEqual({ name: 'edge.delete', payload: { id: 'e1' } });
  });
});

describe('diagram layout & groups', () => {
  const t = '2026-06-15T09:00:00.000Z';
  it('position patch → layout.set_position; collapsed patch → layout.set_collapsed (collapsed wins)', () => {
    expect(crudToCommand(entry({ op: 'PATCH', table: 'diagram_layouts', id: 'l1', opData: { diagram_id: 'd', node_id: 'n', x: 12, y: 34, group_id: null, updated_at: t } }))).toEqual({
      name: 'layout.set_position', payload: { diagram_id: 'd', node_id: 'n', x: 12, y: 34, group_id: null },
    });
    // a collapse write seeds x=0,y=0 on insert → must still map to set_collapsed
    expect(crudToCommand(entry({ op: 'PUT', table: 'diagram_layouts', id: 'l1', opData: { diagram_id: 'd', node_id: 'n', x: 0, y: 0, collapsed: 1 } }))).toEqual({
      name: 'layout.set_collapsed', payload: { diagram_id: 'd', node_id: 'n', collapsed: true },
    });
  });
  it('group PUT → group.create; label patch → group.update; delete → group.delete', () => {
    expect(crudToCommand(entry({ op: 'PUT', table: 'diagram_groups', id: 'g1', opData: { diagram_id: 'd', label: 'G', color: null } }))).toEqual({
      name: 'group.create', payload: { id: 'g1', diagram_id: 'd', label: 'G', color: null },
    });
    expect(crudToCommand(entry({ op: 'PATCH', table: 'diagram_groups', id: 'g1', opData: { label: 'G2', updated_at: t } }))).toEqual({ name: 'group.update', payload: { id: 'g1', label: 'G2' } });
    expect(crudToCommand(entry({ op: 'PATCH', table: 'diagram_groups', id: 'g1', opData: { deleted_at: t } }))).toEqual({ name: 'group.delete', payload: { id: 'g1' } });
  });
});

describe('automation & blocker rules (JSON columns parsed)', () => {
  const t = '2026-06-15T09:00:00.000Z';
  it('rule PUT → rule.create (conditions/actions parsed); enabled patch → rule.toggle', () => {
    expect(crudToCommand(entry({ op: 'PUT', table: 'automation_rules', id: 'r1', opData: { trigger: 'task_completed', conditions: '{"all":[]}', actions: '[{"action":"spawn_task","slot":0,"template":{"title":"X"}}]', enabled: 1 } }))).toEqual({
      name: 'rule.create',
      payload: { id: 'r1', trigger: 'task_completed', conditions: { all: [] }, actions: [{ action: 'spawn_task', slot: 0, template: { title: 'X' } }], enabled: true },
    });
    expect(crudToCommand(entry({ op: 'PATCH', table: 'automation_rules', id: 'r1', opData: { enabled: 0, updated_at: t } }))).toEqual({ name: 'rule.toggle', payload: { id: 'r1', enabled: false } });
    expect(crudToCommand(entry({ op: 'PATCH', table: 'automation_rules', id: 'r1', opData: { deleted_at: t } }))).toEqual({ name: 'rule.delete', payload: { id: 'r1' } });
  });
  it('blocker PUT → blocker.create (scope/predicate parsed); enabled patch → blocker.toggle', () => {
    expect(crudToCommand(entry({ op: 'PUT', table: 'blocker_rules', id: 'b1', opData: { scope: '{}', predicate: '{"all":[]}', label: 'L', enabled: 1 } }))).toEqual({
      name: 'blocker.create', payload: { id: 'b1', scope: {}, predicate: { all: [] }, label: 'L', enabled: true },
    });
    expect(crudToCommand(entry({ op: 'PATCH', table: 'blocker_rules', id: 'b1', opData: { enabled: 0, updated_at: t } }))).toEqual({ name: 'blocker.toggle', payload: { id: 'b1', enabled: false } });
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
