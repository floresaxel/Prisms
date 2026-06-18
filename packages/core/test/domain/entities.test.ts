/**
 * S2 DoD: schema round-trip tests for every table in §6.0.
 */
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import {
  entitySchemas,
  type EntityTable,
} from '../../src/domain/entities';

const ID_A = '018f6d3e-0000-7000-8000-000000000001';
const ID_B = '018f6d3e-0000-7000-8000-000000000002';
const ID_C = '018f6d3e-0000-7000-8000-000000000003';
const USER = '018f6d3e-0000-7000-8000-00000000000a';
const T1 = '2026-06-11T12:00:00.000Z';
const T2 = '2026-06-11T13:30:00.000-04:00';
const D1 = '2026-06-11';
const D2 = '2026-06-30';

const base = {
  id: ID_A,
  user_id: USER,
  created_at: T1,
  updated_at: T1,
  deleted_at: null,
};

/** One valid row per table — the §6.0 catalog. */
const validRows: { [K in EntityTable]: unknown } = {
  nodes: {
    ...base,
    parent_id: ID_B,
    node_type: 'task',
    title: 'Write the lecture pre-brief',
    description: '',
    sort_order: 'a0V',
    start_date: D1,
    due_date: D2,
    estimate_minutes: 30,
    completed_at: null,
    habit_id: null,
    attributes: { color: 'blue', tags: ['uni', 1], nested: { a: null } },
  },
  edges: {
    ...base,
    predecessor_id: ID_B,
    successor_id: ID_C,
    edge_type: 'FS',
    lag_minutes: 0,
  },
  schedule_blocks: {
    ...base,
    task_id: ID_B,
    starts_at: T1,
    ends_at: T2,
    anchor_type: 'none',
    rrule: null,
    status: 'suggested',
    suggestion_reason: 'past_due_reschedule',
    computed_at: T1,
    external_event_id: null,
  },
  time_entries: {
    ...base,
    task_id: ID_B,
    started_at: T1,
    ended_at: null,
    focus_factor: null,
    completed_session: null,
    planned: true,
    device_id: 'device_A-1',
  },
  habits: {
    ...base,
    vision_id: ID_B,
    title: 'Practice piano',
    rrule: 'FREQ=DAILY',
    streak_mode: 'perfect_planned',
    daily_target_minutes: 120,
    mastery_target_hours: 10000,
    level_thresholds_hours: [10, 100, 1000, 10000],
  },
  habit_completions: {
    ...base,
    habit_id: ID_B,
    occurrence_date: D1,
    completed_at: T1,
  },
  tags: { ...base, label: 'on time?', habit_id: ID_B },
  tag_placements: { ...base, block_id: ID_B, tag_id: ID_C },
  tag_answers: { ...base, placement_id: ID_B, value: 'yes', answered_at: T1 },
  decision_boards: { ...base, title: 'Q3 priorities' },
  decision_criteria: {
    ...base,
    board_id: ID_B,
    label: 'Impact',
    weight: 2.5,
  },
  decision_scores: {
    ...base,
    criterion_id: ID_B,
    project_id: ID_C,
    score: 7.5,
  },
  sprints: { ...base, title: 'Sprint 24', starts_on: D1, ends_on: D2 },
  sprint_memberships: { ...base, sprint_id: ID_B, node_id: ID_C },
  automation_rules: {
    ...base,
    trigger: 'task_completed',
    conditions: { all: [{ fact: 'node.title', op: 'matches', value: 'lecture' }] },
    actions: [{ action: 'spawn_task', slot: 0, template: { title: 'Pre-brief' } }],
    enabled: true,
  },
  blocker_rules: {
    ...base,
    scope: { subtree: ID_B },
    predicate: { fact: 'weather.precip_prob', op: 'gt', value: 0.6 },
    label: 'Blocked: rain forecast',
    enabled: true,
  },
  external_facts: {
    ...base,
    kind: 'weather_forecast',
    key: 'merritt-island-fl/2026-06-12',
    payload: { high_c: 31, low_c: 24, precip_prob: 0.2, wind_kph: 14 },
    computed_at: T1,
  },
  computed_aggregates: {
    ...base,
    subject_kind: 'habit',
    subject_id: ID_B,
    metric: 'practice_hours',
    value: { hours: 1234.5, level: 3 },
    computed_at: T1,
    computed_by: 'server',
  },
  diagram_layouts: {
    ...base,
    diagram_id: ID_B,
    node_id: ID_C,
    x: 120.5,
    y: -40,
    group_id: null,
    collapsed: false,
    computed_at: null,
  },
  diagram_groups: {
    ...base,
    diagram_id: ID_B,
    label: 'Research',
    color: '#aabbcc',
  },
  command_log: {
    id: ID_A,
    user_id: USER,
    name: 'node.check_off',
    payload: { id: ID_B, completed_at: T1 },
    device_id: 'device_A-1',
    hlc: '018f6d3e0000-0001-device_A-1',
    applied_at: T1,
    result: 'applied',
    reject_reason: null,
  },
  user_settings: {
    user_id: USER,
    day_reset_hour: 4,
    timezone: 'America/New_York',
    weather_location: { lat: 28.36, lon: -80.7, label: 'Merritt Island, FL' },
    updated_at: T1,
  },
};

const tables = Object.keys(entitySchemas) as EntityTable[];

describe('entity schemas (§6.0) round-trip', () => {
  it('covers every table exactly once', () => {
    expect(tables.sort()).toEqual(Object.keys(validRows).sort());
    expect(tables).toHaveLength(22);
  });

  it.each(tables)('%s: valid row parses and round-trips unchanged', (table) => {
    const schema: z.ZodType = entitySchemas[table];
    const row = validRows[table];
    const parsed = schema.parse(row);
    expect(parsed).toEqual(row);
    // JSON round-trip is lossless too (rows travel as JSON over sync).
    expect(schema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(row);
  });

  it.each(tables)('%s: unknown columns are rejected (strict rows)', (table) => {
    const schema: z.ZodType = entitySchemas[table];
    const row = { ...(validRows[table] as Record<string, unknown>), bogus: 1 };
    expect(schema.safeParse(row).success).toBe(false);
  });
});

describe('entity schemas reject DDL CHECK violations', () => {
  const reject = (table: EntityTable, patch: Record<string, unknown>) => {
    const schema: z.ZodType = entitySchemas[table];
    const row = { ...(validRows[table] as Record<string, unknown>), ...patch };
    expect(schema.safeParse(row).success).toBe(false);
  };

  it('nodes: bad node_type', () => reject('nodes', { node_type: 'epic' }));
  it('nodes: non-integer estimate', () => reject('nodes', { estimate_minutes: 2.5 }));
  it('nodes: bad uuid', () => reject('nodes', { id: 'not-a-uuid' }));
  it('nodes: bad date', () => reject('nodes', { due_date: '2026-13-01' }));
  it('nodes: bad timestamp', () => reject('nodes', { created_at: '2026-06-11 12:00' }));
  it('edges: bad edge_type', () => reject('edges', { edge_type: 'XX' }));
  it('edges: fractional lag', () => reject('edges', { lag_minutes: 1.5 }));
  it('blocks: bad anchor_type', () => reject('schedule_blocks', { anchor_type: 'middle' }));
  it('blocks: bad status', () => reject('schedule_blocks', { status: 'draft' }));
  it('entries: focus_factor below 0.5', () => reject('time_entries', { focus_factor: 0.4 }));
  it('entries: focus_factor above 1.0', () => reject('time_entries', { focus_factor: 1.5 }));
  it('entries: bad device id', () => reject('time_entries', { device_id: 'has spaces!' }));
  it('habits: bad streak_mode', () => reject('habits', { streak_mode: 'fortnightly' }));
  it('tag_answers: bad value', () => reject('tag_answers', { value: 'maybe' }));
  it('criteria: zero weight', () => reject('decision_criteria', { weight: 0 }));
  it('scores: score over 10', () => reject('decision_scores', { score: 10.5 }));
  it('scores: negative score', () => reject('decision_scores', { score: -1 }));
  it('rules: bad trigger', () => reject('automation_rules', { trigger: 'task_deleted' }));
  it('aggregates: bad subject_kind', () =>
    reject('computed_aggregates', { subject_kind: 'project' }));
  it('aggregates: bad computed_by', () =>
    reject('computed_aggregates', { computed_by: 'cron' }));
  it('command_log: bad result', () => reject('command_log', { result: 'ok' }));
  it('command_log: malformed hlc', () => reject('command_log', { hlc: '12-34-dev' }));
  it('settings: day_reset_hour 24', () => reject('user_settings', { day_reset_hour: 24 }));
  it('settings: fractional day_reset_hour', () =>
    reject('user_settings', { day_reset_hour: 4.5 }));
  it('settings: latitude out of range', () =>
    reject('user_settings', {
      weather_location: { lat: 91, lon: 0, label: 'x' },
    }));
});
