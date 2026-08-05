/**
 * Map PowerSync's loosely-typed local rows (text/integer) to the strict core
 * entity types the selectors consume: JSON columns parsed, integer booleans
 * widened, absent columns normalized to null.
 */
import {
  LEGACY_HLC,
  type AutomationRule,
  type BlockerRule,
  type ComputedAggregate,
  type DecisionBoard,
  type DecisionCriterion,
  type DecisionScore,
  type DiagramGroup,
  type DiagramLayout,
  type Edge,
  type ExternalFact,
  type Habit,
  type HabitCompletion,
  type JournalEntry,
  type Node,
  type ScheduleBlock,
  type SourceKind,
  type Sprint,
  type SprintMembership,
  type Tag,
  type TagAnswer,
  type TagPlacement,
  type TaskStep,
  type TimeEntry,
  type UserSettings,
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

/**
 * The 1.3 convergence columns (§7.1/§7.8/§7.11). Until M8 adds them to the
 * PowerSync local schema they are usually absent locally, so each defaults to
 * the legacy sentinel — the per-row values become meaningful once synced.
 */
const syncFields = (r: Row) => ({
  hlc: String(r['hlc'] ?? LEGACY_HLC),
  schema_version: r['schema_version'] == null ? 1 : Number(r['schema_version']),
  created_by_command_id: str(r['created_by_command_id']),
  last_modified_by_command_id: str(r['last_modified_by_command_id']),
  source_kind: (r['source_kind'] ?? 'legacy') as SourceKind,
  source_id: str(r['source_id']),
  source_detail: json(r['source_detail'], {}),
});

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
  completion_disposition: r['completion_disposition'] == null ? null : (r['completion_disposition'] as Node['completion_disposition']),
  completed_in_block_id: str(r['completed_in_block_id']),
  habit_id: str(r['habit_id']),
  attributes: json(r['attributes'], {}),
  created_at: String(r['created_at'] ?? ''),
  updated_at: String(r['updated_at'] ?? ''),
  deleted_at: str(r['deleted_at']),
  ...syncFields(r),
});

export const toTaskStep = (r: Row): TaskStep => ({
  id: String(r['id']),
  user_id: String(r['user_id']),
  task_id: String(r['task_id']),
  title: String(r['title'] ?? ''),
  done: bool(r['done']),
  sort_order: String(r['sort_order'] ?? ''),
  created_at: String(r['created_at'] ?? ''),
  updated_at: String(r['updated_at'] ?? ''),
  deleted_at: str(r['deleted_at']),
  ...syncFields(r),
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
  ...syncFields(r),
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
  ...syncFields(r),
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
  suggestion_batch_id: str(r['suggestion_batch_id']),
  replaces_block_id: str(r['replaces_block_id']),
  superseded_at: str(r['superseded_at']),
  created_at: String(r['created_at'] ?? ''),
  updated_at: String(r['updated_at'] ?? ''),
  deleted_at: str(r['deleted_at']),
  ...syncFields(r),
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
  ...syncFields(r),
});

export const toMembership = (r: Row): SprintMembership => ({
  id: String(r['id']),
  user_id: String(r['user_id']),
  sprint_id: String(r['sprint_id']),
  node_id: String(r['node_id']),
  created_at: String(r['created_at'] ?? ''),
  updated_at: String(r['updated_at'] ?? ''),
  deleted_at: str(r['deleted_at']),
  ...syncFields(r),
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
  ...syncFields(r),
});

export const toAutomationRule = (r: Row): AutomationRule => ({
  id: String(r['id']),
  user_id: String(r['user_id']),
  trigger: r['trigger'] as AutomationRule['trigger'],
  conditions: json(r['conditions'], {}),
  actions: json(r['actions'], []),
  enabled: bool(r['enabled']),
  rule_version: r['rule_version'] == null ? 1 : Number(r['rule_version']),
  created_at: String(r['created_at'] ?? ''),
  updated_at: String(r['updated_at'] ?? ''),
  deleted_at: str(r['deleted_at']),
  ...syncFields(r),
});

export const toDiagramLayout = (r: Row): DiagramLayout => ({
  id: String(r['id']),
  user_id: String(r['user_id']),
  diagram_id: String(r['diagram_id']),
  node_id: String(r['node_id']),
  x: Number(r['x'] ?? 0),
  y: Number(r['y'] ?? 0),
  group_id: str(r['group_id']),
  collapsed: bool(r['collapsed']),
  computed_at: str(r['computed_at']),
  created_at: String(r['created_at'] ?? ''),
  updated_at: String(r['updated_at'] ?? ''),
  deleted_at: str(r['deleted_at']),
  ...syncFields(r),
});

export const toDiagramGroup = (r: Row): DiagramGroup => ({
  id: String(r['id']),
  user_id: String(r['user_id']),
  diagram_id: String(r['diagram_id']),
  label: String(r['label'] ?? ''),
  color: str(r['color']),
  created_at: String(r['created_at'] ?? ''),
  updated_at: String(r['updated_at'] ?? ''),
  deleted_at: str(r['deleted_at']),
  ...syncFields(r),
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
  ...syncFields(r),
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
  ...syncFields(r),
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
  ...syncFields(r),
});

export const toTag = (r: Row): Tag => ({
  id: String(r['id']),
  user_id: String(r['user_id']),
  label: String(r['label'] ?? ''),
  habit_id: str(r['habit_id']),
  created_at: String(r['created_at'] ?? ''),
  updated_at: String(r['updated_at'] ?? ''),
  deleted_at: str(r['deleted_at']),
  ...syncFields(r),
});

export const toTagPlacement = (r: Row): TagPlacement => ({
  id: String(r['id']),
  user_id: String(r['user_id']),
  block_id: String(r['block_id']),
  tag_id: String(r['tag_id']),
  created_at: String(r['created_at'] ?? ''),
  updated_at: String(r['updated_at'] ?? ''),
  deleted_at: str(r['deleted_at']),
  ...syncFields(r),
});

export const toTagAnswer = (r: Row): TagAnswer => ({
  id: String(r['id']),
  user_id: String(r['user_id']),
  placement_id: String(r['placement_id']),
  value: r['value'] as TagAnswer['value'],
  answered_at: String(r['answered_at']),
  created_at: String(r['created_at'] ?? ''),
  updated_at: String(r['updated_at'] ?? ''),
  deleted_at: str(r['deleted_at']),
  ...syncFields(r),
});

export const toJournalEntry = (r: Row): JournalEntry => ({
  id: String(r['id']),
  user_id: String(r['user_id']),
  entry_date: String(r['entry_date']),
  month_key: String(r['month_key'] ?? ''),
  content: String(r['content'] ?? ''),
  locked: bool(r['locked']),
  created_at: String(r['created_at'] ?? ''),
  updated_at: String(r['updated_at'] ?? ''),
  deleted_at: str(r['deleted_at']),
  ...syncFields(r),
});

export const toDecisionBoard = (r: Row): DecisionBoard => ({
  id: String(r['id']),
  user_id: String(r['user_id']),
  title: String(r['title'] ?? ''),
  created_at: String(r['created_at'] ?? ''),
  updated_at: String(r['updated_at'] ?? ''),
  deleted_at: str(r['deleted_at']),
  ...syncFields(r),
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
  ...syncFields(r),
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
  ...syncFields(r),
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
  ...syncFields(r),
});

export const toUserSettings = (
  r: Row,
): Pick<UserSettings, 'day_reset_hour' | 'timezone' | 'weather_location' | 'journal_day_log'> => ({
  day_reset_hour: Number(r['day_reset_hour'] ?? 4),
  timezone: String(r['timezone'] ?? 'America/New_York'),
  weather_location: json(r['weather_location'], null) as UserSettings['weather_location'],
  // Annex L is opt-OUT: only an explicit 0 turns it off. A row synced before the
  // column existed (or a device that has not synced settings) reads as ON.
  journal_day_log: r['journal_day_log'] === null || r['journal_day_log'] === undefined
    ? true
    : Number(r['journal_day_log']) !== 0,
});
