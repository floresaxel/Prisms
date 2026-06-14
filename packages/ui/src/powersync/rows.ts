/**
 * Map PowerSync's loosely-typed local rows (text/integer) to the strict core
 * entity types the selectors consume: JSON columns parsed, integer booleans
 * widened, absent columns normalized to null.
 */
import type {
  BlockerRule,
  ComputedAggregate,
  DecisionBoard,
  DecisionCriterion,
  DecisionScore,
  Edge,
  ExternalFact,
  Habit,
  HabitCompletion,
  Node,
  ScheduleBlock,
  Sprint,
  SprintMembership,
  TimeEntry,
  UserSettings,
} from '@prisms/core';

const json = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};
const bool = (value: unknown): boolean => value === 1 || value === true || value === '1';
const nbool = (value: unknown): boolean | null => (value == null ? null : bool(value));
const str = (value: unknown): string | null => (value == null ? null : String(value));

type Row = Record<string, unknown>;

export const toNode = (r: Row): Node => ({
  id: String(r['id']),
  user_id: String(r['user_id']),
  parent_id: str(r['parent_id']),
  node_type: r['node_type'] as Node['node_type'],
  title: String(r['title'] ?? ''),
  description: String(r['description'] ?? ''),
  sort_order: String(r['sort_order'] ?? ''),
  start_date: str(r['start_date']),
  due_date: str(r['due_date']),
  estimate_minutes: r['estimate_minutes'] == null ? null : Number(r['estimate_minutes']),
  completed_at: str(r['completed_at']),
  habit_id: str(r['habit_id']),
  attributes: json(r['attributes'], {}),
  created_at: String(r['created_at'] ?? ''),
  updated_at: String(r['updated_at'] ?? ''),
  deleted_at: str(r['deleted_at']),
});

export const toEdge = (r: Row): Edge => ({
  id: String(r['id']),
  user_id: String(r['user_id']),
  predecessor_id: String(r['predecessor_id']),
  successor_id: String(r['successor_id']),
  edge_type: r['edge_type'] as Edge['edge_type'],
  lag_minutes: Number(r['lag_minutes'] ?? 0),
  created_at: String(r['created_at'] ?? ''),
  updated_at: String(r['updated_at'] ?? ''),
  deleted_at: str(r['deleted_at']),
});

export const toTimeEntry = (r: Row): TimeEntry => ({
  id: String(r['id']),
  user_id: String(r['user_id']),
  task_id: String(r['task_id']),
  started_at: String(r['started_at']),
  ended_at: str(r['ended_at']),
  focus_factor: r['focus_factor'] == null ? null : Number(r['focus_factor']),
  completed_session: nbool(r['completed_session']),
  planned: bool(r['planned']),
  device_id: String(r['device_id'] ?? ''),
  created_at: String(r['created_at'] ?? ''),
  updated_at: String(r['updated_at'] ?? ''),
  deleted_at: str(r['deleted_at']),
});

export const toScheduleBlock = (r: Row): ScheduleBlock => ({
  id: String(r['id']),
  user_id: String(r['user_id']),
  task_id: String(r['task_id']),
  starts_at: String(r['starts_at']),
  ends_at: String(r['ends_at']),
  anchor_type: r['anchor_type'] as ScheduleBlock['anchor_type'],
  rrule: str(r['rrule']),
  status: r['status'] as ScheduleBlock['status'],
  suggestion_reason: str(r['suggestion_reason']),
  computed_at: str(r['computed_at']),
  external_event_id: str(r['external_event_id']),
  created_at: String(r['created_at'] ?? ''),
  updated_at: String(r['updated_at'] ?? ''),
  deleted_at: str(r['deleted_at']),
});

export const toSprint = (r: Row): Sprint => ({
  id: String(r['id']),
  user_id: String(r['user_id']),
  title: String(r['title'] ?? ''),
  starts_on: String(r['starts_on']),
  ends_on: String(r['ends_on']),
  created_at: String(r['created_at'] ?? ''),
  updated_at: String(r['updated_at'] ?? ''),
  deleted_at: str(r['deleted_at']),
});

export const toMembership = (r: Row): SprintMembership => ({
  id: String(r['id']),
  user_id: String(r['user_id']),
  sprint_id: String(r['sprint_id']),
  node_id: String(r['node_id']),
  created_at: String(r['created_at'] ?? ''),
  updated_at: String(r['updated_at'] ?? ''),
  deleted_at: str(r['deleted_at']),
});

export const toBlockerRule = (r: Row): BlockerRule => ({
  id: String(r['id']),
  user_id: String(r['user_id']),
  scope: json(r['scope'], {}),
  predicate: json(r['predicate'], {}),
  label: String(r['label'] ?? ''),
  enabled: bool(r['enabled']),
  created_at: String(r['created_at'] ?? ''),
  updated_at: String(r['updated_at'] ?? ''),
  deleted_at: str(r['deleted_at']),
});

export const toExternalFact = (r: Row): ExternalFact => ({
  id: String(r['id']),
  user_id: String(r['user_id']),
  kind: String(r['kind']),
  key: String(r['key']),
  payload: json(r['payload'], {}),
  computed_at: String(r['computed_at']),
  created_at: String(r['created_at'] ?? ''),
  updated_at: String(r['updated_at'] ?? ''),
  deleted_at: str(r['deleted_at']),
});

export const toHabit = (r: Row): Habit => ({
  id: String(r['id']),
  user_id: String(r['user_id']),
  vision_id: String(r['vision_id']),
  title: String(r['title'] ?? ''),
  rrule: String(r['rrule']),
  streak_mode: r['streak_mode'] as Habit['streak_mode'],
  daily_target_minutes: r['daily_target_minutes'] == null ? null : Number(r['daily_target_minutes']),
  mastery_target_hours: r['mastery_target_hours'] == null ? null : Number(r['mastery_target_hours']),
  level_thresholds_hours: json(r['level_thresholds_hours'], []),
  created_at: String(r['created_at'] ?? ''),
  updated_at: String(r['updated_at'] ?? ''),
  deleted_at: str(r['deleted_at']),
});

export const toHabitCompletion = (r: Row): HabitCompletion => ({
  id: String(r['id']),
  user_id: String(r['user_id']),
  habit_id: String(r['habit_id']),
  occurrence_date: String(r['occurrence_date']),
  completed_at: String(r['completed_at']),
  created_at: String(r['created_at'] ?? ''),
  updated_at: String(r['updated_at'] ?? ''),
  deleted_at: str(r['deleted_at']),
});

export const toDecisionBoard = (r: Row): DecisionBoard => ({
  id: String(r['id']),
  user_id: String(r['user_id']),
  title: String(r['title'] ?? ''),
  created_at: String(r['created_at'] ?? ''),
  updated_at: String(r['updated_at'] ?? ''),
  deleted_at: str(r['deleted_at']),
});

export const toDecisionCriterion = (r: Row): DecisionCriterion => ({
  id: String(r['id']),
  user_id: String(r['user_id']),
  board_id: String(r['board_id']),
  label: String(r['label'] ?? ''),
  weight: Number(r['weight'] ?? 1),
  created_at: String(r['created_at'] ?? ''),
  updated_at: String(r['updated_at'] ?? ''),
  deleted_at: str(r['deleted_at']),
});

export const toDecisionScore = (r: Row): DecisionScore => ({
  id: String(r['id']),
  user_id: String(r['user_id']),
  criterion_id: String(r['criterion_id']),
  project_id: String(r['project_id']),
  score: Number(r['score'] ?? 0),
  created_at: String(r['created_at'] ?? ''),
  updated_at: String(r['updated_at'] ?? ''),
  deleted_at: str(r['deleted_at']),
});

export const toComputedAggregate = (r: Row): ComputedAggregate => ({
  id: String(r['id']),
  user_id: String(r['user_id']),
  subject_kind: r['subject_kind'] as ComputedAggregate['subject_kind'],
  subject_id: str(r['subject_id']),
  metric: String(r['metric']),
  value: json(r['value'], null),
  computed_at: String(r['computed_at']),
  computed_by: r['computed_by'] as ComputedAggregate['computed_by'],
  created_at: String(r['created_at'] ?? ''),
  updated_at: String(r['updated_at'] ?? ''),
  deleted_at: str(r['deleted_at']),
});

export const toUserSettings = (r: Row): Pick<UserSettings, 'day_reset_hour' | 'timezone'> => ({
  day_reset_hour: Number(r['day_reset_hour'] ?? 4),
  timezone: String(r['timezone'] ?? 'America/New_York'),
});
