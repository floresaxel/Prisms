/**
 * PowerSync local schema (§7.3, §12.3): mirrors the synced server tables for
 * the on-device SQLite. PowerSync stores loosely (text/integer); timestamps
 * and jsonb live as text and are parsed by core selectors. Every table the
 * sync rules stream down (§7.3) is present except command_log and the
 * server-internal ones.
 */
import { Schema, Table, column } from '@powersync/common';

const nodes = new Table({
  user_id: column.text,
  parent_id: column.text,
  node_type: column.text,
  title: column.text,
  description: column.text,
  sort_order: column.text,
  start_date: column.text,
  due_date: column.text,
  estimate_minutes: column.integer,
  completed_at: column.text,
  habit_id: column.text,
  attributes: column.text,
  created_at: column.text,
  updated_at: column.text,
  deleted_at: column.text,
});

const edges = new Table({
  user_id: column.text,
  predecessor_id: column.text,
  successor_id: column.text,
  edge_type: column.text,
  lag_minutes: column.integer,
  created_at: column.text,
  updated_at: column.text,
  deleted_at: column.text,
});

const schedule_blocks = new Table({
  user_id: column.text,
  task_id: column.text,
  starts_at: column.text,
  ends_at: column.text,
  anchor_type: column.text,
  rrule: column.text,
  status: column.text,
  suggestion_reason: column.text,
  computed_at: column.text,
  external_event_id: column.text,
  created_at: column.text,
  updated_at: column.text,
  deleted_at: column.text,
});

const time_entries = new Table({
  user_id: column.text,
  task_id: column.text,
  started_at: column.text,
  ended_at: column.text,
  focus_factor: column.real,
  completed_session: column.integer,
  planned: column.integer,
  device_id: column.text,
  created_at: column.text,
  updated_at: column.text,
  deleted_at: column.text,
});

const habits = new Table({
  user_id: column.text,
  vision_id: column.text,
  title: column.text,
  rrule: column.text,
  streak_mode: column.text,
  daily_target_minutes: column.integer,
  mastery_target_hours: column.integer,
  level_thresholds_hours: column.text,
  created_at: column.text,
  updated_at: column.text,
  deleted_at: column.text,
});

const habit_completions = new Table({
  user_id: column.text,
  habit_id: column.text,
  occurrence_date: column.text,
  completed_at: column.text,
  created_at: column.text,
  updated_at: column.text,
  deleted_at: column.text,
});

const decision_boards = new Table({
  user_id: column.text,
  title: column.text,
  created_at: column.text,
  updated_at: column.text,
  deleted_at: column.text,
});

const decision_criteria = new Table({
  user_id: column.text,
  board_id: column.text,
  label: column.text,
  weight: column.real,
  created_at: column.text,
  updated_at: column.text,
  deleted_at: column.text,
});

const decision_scores = new Table({
  user_id: column.text,
  criterion_id: column.text,
  project_id: column.text,
  score: column.real,
  created_at: column.text,
  updated_at: column.text,
  deleted_at: column.text,
});

const sprints = new Table({
  user_id: column.text,
  title: column.text,
  starts_on: column.text,
  ends_on: column.text,
  created_at: column.text,
  updated_at: column.text,
  deleted_at: column.text,
});

const sprint_memberships = new Table({
  user_id: column.text,
  sprint_id: column.text,
  node_id: column.text,
  created_at: column.text,
  updated_at: column.text,
  deleted_at: column.text,
});

const automation_rules = new Table({
  user_id: column.text,
  trigger: column.text,
  conditions: column.text,
  actions: column.text,
  enabled: column.integer,
  created_at: column.text,
  updated_at: column.text,
  deleted_at: column.text,
});

const blocker_rules = new Table({
  user_id: column.text,
  scope: column.text,
  predicate: column.text,
  label: column.text,
  enabled: column.integer,
  created_at: column.text,
  updated_at: column.text,
  deleted_at: column.text,
});

const external_facts = new Table({
  user_id: column.text,
  kind: column.text,
  key: column.text,
  payload: column.text,
  computed_at: column.text,
  created_at: column.text,
  updated_at: column.text,
  deleted_at: column.text,
});

const computed_aggregates = new Table({
  user_id: column.text,
  subject_kind: column.text,
  subject_id: column.text,
  metric: column.text,
  value: column.text,
  computed_at: column.text,
  computed_by: column.text,
  created_at: column.text,
  updated_at: column.text,
  deleted_at: column.text,
});

const diagram_layouts = new Table({
  user_id: column.text,
  diagram_id: column.text,
  node_id: column.text,
  x: column.real,
  y: column.real,
  group_id: column.text,
  collapsed: column.integer,
  computed_at: column.text,
  created_at: column.text,
  updated_at: column.text,
  deleted_at: column.text,
});

const diagram_groups = new Table({
  user_id: column.text,
  diagram_id: column.text,
  label: column.text,
  color: column.text,
  created_at: column.text,
  updated_at: column.text,
  deleted_at: column.text,
});

const user_settings = new Table({
  day_reset_hour: column.integer,
  timezone: column.text,
  weather_location: column.text,
  updated_at: column.text,
});

export const appSchema = new Schema({
  nodes,
  edges,
  schedule_blocks,
  time_entries,
  habits,
  habit_completions,
  decision_boards,
  decision_criteria,
  decision_scores,
  sprints,
  sprint_memberships,
  automation_rules,
  blocker_rules,
  external_facts,
  computed_aggregates,
  diagram_layouts,
  diagram_groups,
  user_settings,
});
