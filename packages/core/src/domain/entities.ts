/**
 * Entity row schemas — single source of truth for every table in
 * ARCHITECTURE.md §6.0. Field names match SQL column names exactly; the
 * Drizzle schema (packages/db, s03) must satisfy these types at compile time.
 *
 * Shape policy: schemas mirror the DDL — column types, NULLability, enums,
 * and CHECK constraints. Business invariants (§6.7) and per-command payload
 * rules live in core/src/commands (s11), never here.
 *
 * jsonb AST columns (rule conditions/actions/scope/predicate) are typed as
 * opaque JSON here by design — the row schema mirrors the jsonb column. The
 * typed §9.2 predicate AST and §9.3 action templates are validated where they
 * run: status/predicate (s05) and rules/validate (s07).
 */
import { z } from 'zod';

import {
  deviceIdSchema,
  hlcStringSchema,
  isoDateSchema,
  isoDateTimeSchema,
  jsonObjectSchema,
  jsonValueSchema,
  uuidSchema,
} from './primitives';

/** Columns every synced table carries (§6): ids, audit timestamps, soft delete. */
const baseRow = {
  id: uuidSchema,
  user_id: uuidSchema,
  created_at: isoDateTimeSchema,
  updated_at: isoDateTimeSchema,
  deleted_at: isoDateTimeSchema.nullable(),
};

// --- THE TREE ---------------------------------------------------------------

export const NODE_TYPES = [
  'vision',
  'roadmap',
  'project',
  'milestone',
  'task',
  'activity',
] as const;
export const nodeTypeSchema = z.enum(NODE_TYPES);
export type NodeType = z.infer<typeof nodeTypeSchema>;

/** How a task was checked off: finished, or descoped as no-longer-relevant. */
export const COMPLETION_DISPOSITIONS = ['completed', 'obsolete'] as const;
export const completionDispositionSchema = z.enum(COMPLETION_DISPOSITIONS);
export type CompletionDisposition = z.infer<typeof completionDispositionSchema>;

export const nodeSchema = z.strictObject({
  ...baseRow,
  parent_id: uuidSchema.nullable(),
  node_type: nodeTypeSchema,
  title: z.string(),
  description: z.string(),
  /** Fractional index, e.g. 'a0', 'a1', 'a0V' (generation arrives in s04). */
  sort_order: z.string(),
  start_date: isoDateSchema.nullable(),
  due_date: isoDateSchema.nullable(),
  estimate_minutes: z.number().int().nullable(),
  /** FACT: NULL = not done. Only set by mutations (§6). */
  completed_at: isoDateTimeSchema.nullable(),
  /** Set with completed_at at check-off: 'completed' (default) or 'obsolete' (descoped). NULL when not done. */
  completion_disposition: completionDispositionSchema.nullable(),
  /** The committed block this task was completed in; NULL = completed unscheduled (Phase 3). */
  completed_in_block_id: uuidSchema.nullable(),
  /** Task spawned by a habit occurrence; XOR parent rule is invariant I3. */
  habit_id: uuidSchema.nullable(),
  attributes: jsonObjectSchema,
});
export type Node = z.infer<typeof nodeSchema>;

// --- THE GRAPH ----------------------------------------------------------------

export const EDGE_TYPES = ['FS', 'SS', 'FF', 'SF'] as const;
export const edgeTypeSchema = z.enum(EDGE_TYPES);
export type EdgeType = z.infer<typeof edgeTypeSchema>;

export const edgeSchema = z.strictObject({
  ...baseRow,
  predecessor_id: uuidSchema,
  successor_id: uuidSchema,
  edge_type: edgeTypeSchema,
  /** May be negative (lead time); §7.1 only gates on lag > 0. */
  lag_minutes: z.number().int(),
});
export type Edge = z.infer<typeof edgeSchema>;

// --- SCHEDULING ----------------------------------------------------------------

export const ANCHOR_TYPES = ['none', 'start', 'end', 'both'] as const;
export const anchorTypeSchema = z.enum(ANCHOR_TYPES);
export type AnchorType = z.infer<typeof anchorTypeSchema>;

export const BLOCK_STATUSES = ['committed', 'suggested'] as const;
export const blockStatusSchema = z.enum(BLOCK_STATUSES);
export type BlockStatus = z.infer<typeof blockStatusSchema>;

export const scheduleBlockSchema = z.strictObject({
  ...baseRow,
  task_id: uuidSchema,
  starts_at: isoDateTimeSchema,
  ends_at: isoDateTimeSchema,
  anchor_type: anchorTypeSchema,
  /** Recurrence for habit-generated blocks (RRULE string). */
  rrule: z.string().nullable(),
  status: blockStatusSchema,
  /** e.g. 'past_due_reschedule', 'nightly_optimization'. */
  suggestion_reason: z.string().nullable(),
  /** Set when produced by a server job (§2 principle 5). */
  computed_at: isoDateTimeSchema.nullable(),
  /** Reserved for v2 calendar sync. */
  external_event_id: z.string().nullable(),
});
export type ScheduleBlock = z.infer<typeof scheduleBlockSchema>;

// --- TIME TRACKING (append-only facts) -------------------------------------------

export const timeEntrySchema = z.strictObject({
  ...baseRow,
  task_id: uuidSchema,
  started_at: isoDateTimeSchema,
  /** NULL = clock currently running (one open entry per user, invariant I5). */
  ended_at: isoDateTimeSchema.nullable(),
  /** CHECK (focus_factor BETWEEN 0.5 AND 1.0); set at clock-out review. */
  focus_factor: z.number().min(0.5).max(1).nullable(),
  completed_session: z.boolean().nullable(),
  /** false = unplanned ad-hoc work. */
  planned: z.boolean(),
  /** For the offline double-clock-in rule (§7.4). */
  device_id: deviceIdSchema,
});
export type TimeEntry = z.infer<typeof timeEntrySchema>;

// --- HABITS & SKILLS ----------------------------------------------------------------

export const STREAK_MODES = [
  'perfect_planned',
  'daily',
  'weekly',
  'monthly',
  'quarterly',
  'yearly',
] as const;
export const streakModeSchema = z.enum(STREAK_MODES);
export type StreakMode = z.infer<typeof streakModeSchema>;

export const habitSchema = z.strictObject({
  ...baseRow,
  /** Must reference a node_type='vision' row (enforced by commands, s11). */
  vision_id: uuidSchema,
  title: z.string(),
  rrule: z.string(),
  streak_mode: streakModeSchema,
  /** Progress-ring target (e.g. 120 = 2h study). */
  daily_target_minutes: z.number().int().nullable(),
  /** e.g. 10000; NULL = plain habit, not a skill. */
  mastery_target_hours: z.number().int().nullable(),
  /** Ascending hour marks per level (ordering enforced by habit commands, s11). */
  level_thresholds_hours: z.array(z.number().int()),
});
export type Habit = z.infer<typeof habitSchema>;

export const habitCompletionSchema = z.strictObject({
  ...baseRow,
  habit_id: uuidSchema,
  /** Bucketed with the day-reset hour (§7.2 bucketDate). */
  occurrence_date: isoDateSchema,
  completed_at: isoDateTimeSchema,
});
export type HabitCompletion = z.infer<typeof habitCompletionSchema>;

// --- TAGS (confirmable event tags) ---------------------------------------------------

export const TAG_ANSWER_VALUES = ['yes', 'no'] as const;
export const tagAnswerValueSchema = z.enum(TAG_ANSWER_VALUES);
export type TagAnswerValue = z.infer<typeof tagAnswerValueSchema>;

/** Reusable tag catalog ("on time?"); placed on schedule blocks and answered yes/no. */
export const tagSchema = z.strictObject({
  ...baseRow,
  label: z.string(),
  /** NULL = global tag; non-NULL scopes it to a habit (feeds that habit's metrics later). */
  habit_id: uuidSchema.nullable(),
});
export type Tag = z.infer<typeof tagSchema>;

/** A tag placed on a schedule block — lets the tag sit pending on the event. */
export const tagPlacementSchema = z.strictObject({
  ...baseRow,
  block_id: uuidSchema,
  tag_id: uuidSchema,
});
export type TagPlacement = z.infer<typeof tagPlacementSchema>;

/** The yes/no answer fact for a placement; pending = no live (non-deleted) row. */
export const tagAnswerSchema = z.strictObject({
  ...baseRow,
  placement_id: uuidSchema,
  /** CHECK (value IN ('yes','no')). */
  value: tagAnswerValueSchema,
  /** When the user answered (a fact, so it is stored). */
  answered_at: isoDateTimeSchema,
});
export type TagAnswer = z.infer<typeof tagAnswerSchema>;

// --- DECISION MATRIX ----------------------------------------------------------------

export const decisionBoardSchema = z.strictObject({
  ...baseRow,
  title: z.string(),
});
export type DecisionBoard = z.infer<typeof decisionBoardSchema>;

export const decisionCriterionSchema = z.strictObject({
  ...baseRow,
  board_id: uuidSchema,
  label: z.string(),
  /** CHECK (weight > 0). */
  weight: z.number().positive(),
});
export type DecisionCriterion = z.infer<typeof decisionCriterionSchema>;

export const decisionScoreSchema = z.strictObject({
  ...baseRow,
  criterion_id: uuidSchema,
  project_id: uuidSchema,
  /** CHECK (score BETWEEN 0 AND 10). */
  score: z.number().min(0).max(10),
});
export type DecisionScore = z.infer<typeof decisionScoreSchema>;

// --- SPRINT / PRIORITIZED GROUP --------------------------------------------------------

export const sprintSchema = z.strictObject({
  ...baseRow,
  title: z.string(),
  starts_on: isoDateSchema,
  ends_on: isoDateSchema,
});
export type Sprint = z.infer<typeof sprintSchema>;

export const sprintMembershipSchema = z.strictObject({
  ...baseRow,
  sprint_id: uuidSchema,
  node_id: uuidSchema,
});
export type SprintMembership = z.infer<typeof sprintMembershipSchema>;

// --- AUTOMATION & BLOCKER RULES (declarative JSON, §9) ------------------------------------

export const AUTOMATION_TRIGGERS = ['task_completed', 'task_created'] as const;
export const automationTriggerSchema = z.enum(AUTOMATION_TRIGGERS);
export type AutomationTrigger = z.infer<typeof automationTriggerSchema>;

export const automationRuleSchema = z.strictObject({
  ...baseRow,
  trigger: automationTriggerSchema,
  /** §9.2 predicate AST as stored (jsonb); typed-validated in status/predicate. */
  conditions: jsonValueSchema,
  /** §9.3 spawn templates as stored (jsonb); typed-validated in rules/validate. */
  actions: jsonValueSchema,
  enabled: z.boolean(),
});
export type AutomationRule = z.infer<typeof automationRuleSchema>;

export const blockerRuleSchema = z.strictObject({
  ...baseRow,
  /** Which nodes it applies to (subtree/type/tag) as stored (jsonb). */
  scope: jsonValueSchema,
  /** §9.2 AST (may reference external_facts) as stored; evaluated in status/predicate. */
  predicate: jsonValueSchema,
  /** Shown in UI: "Blocked: rain forecast". */
  label: z.string(),
  enabled: z.boolean(),
});
export type BlockerRule = z.infer<typeof blockerRuleSchema>;

// --- EXTERNAL FACTS (server-written, sync down read-only) -----------------------------------

export const externalFactSchema = z.strictObject({
  ...baseRow,
  /** e.g. 'weather_forecast'. */
  kind: z.string().min(1),
  /** e.g. 'merritt-island-fl/2026-06-12'. */
  key: z.string().min(1),
  payload: jsonValueSchema,
  computed_at: isoDateTimeSchema,
});
export type ExternalFact = z.infer<typeof externalFactSchema>;

// --- SERVER-COMPUTED CACHES -------------------------------------------------------------

export const SUBJECT_KINDS = ['habit', 'node', 'user'] as const;
export const subjectKindSchema = z.enum(SUBJECT_KINDS);
export type SubjectKind = z.infer<typeof subjectKindSchema>;

export const COMPUTED_BY = ['client', 'server'] as const;
export const computedBySchema = z.enum(COMPUTED_BY);
export type ComputedBy = z.infer<typeof computedBySchema>;

export const computedAggregateSchema = z.strictObject({
  ...baseRow,
  subject_kind: subjectKindSchema,
  /** NULL for user-level aggregates. */
  subject_id: uuidSchema.nullable(),
  /** 'practice_hours' | 'streak' | 'progress' | 'burndown_series' | 'projection' (open set). */
  metric: z.string().min(1),
  value: jsonValueSchema,
  computed_at: isoDateTimeSchema,
  computed_by: computedBySchema,
});
export type ComputedAggregate = z.infer<typeof computedAggregateSchema>;

// --- DIAGRAM PRESENTATION (never affects semantics) -------------------------------------------

export const diagramLayoutSchema = z.strictObject({
  ...baseRow,
  /** The node whose subtree the diagram shows. */
  diagram_id: uuidSchema,
  node_id: uuidSchema,
  x: z.number(),
  y: z.number(),
  group_id: uuidSchema.nullable(),
  collapsed: z.boolean(),
  /** Set when produced by the layout job (s14). */
  computed_at: isoDateTimeSchema.nullable(),
});
export type DiagramLayout = z.infer<typeof diagramLayoutSchema>;

export const diagramGroupSchema = z.strictObject({
  ...baseRow,
  diagram_id: uuidSchema,
  label: z.string(),
  color: z.string().nullable(),
});
export type DiagramGroup = z.infer<typeof diagramGroupSchema>;

// --- COMMAND LOG (audit; server-side only, not synced) ------------------------------------------

export const COMMAND_RESULTS = ['applied', 'rejected', 'noop'] as const;
export const commandResultSchema = z.enum(COMMAND_RESULTS);
export type CommandResult = z.infer<typeof commandResultSchema>;

/** Note: no updated_at/deleted_at — the log is append-only (§6.0). */
export const commandLogEntrySchema = z.strictObject({
  /** Client-generated command id (idempotency key, §8). */
  id: uuidSchema,
  user_id: uuidSchema,
  name: z.string().min(1),
  payload: jsonValueSchema,
  device_id: deviceIdSchema,
  hlc: hlcStringSchema,
  applied_at: isoDateTimeSchema,
  result: commandResultSchema,
  reject_reason: z.string().nullable(),
});
export type CommandLogEntry = z.infer<typeof commandLogEntrySchema>;

// --- SETTINGS -------------------------------------------------------------------------------------

export const weatherLocationSchema = z.strictObject({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  label: z.string(),
});
export type WeatherLocation = z.infer<typeof weatherLocationSchema>;

/** Note: user_id is the PK; no id/created_at/deleted_at (§6.0). */
export const userSettingsSchema = z.strictObject({
  user_id: uuidSchema,
  /** CHECK (day_reset_hour BETWEEN 0 AND 23). */
  day_reset_hour: z.number().int().min(0).max(23),
  /** IANA zone name; validated against the platform tz db at the command boundary (s11). */
  timezone: z.string().min(1),
  weather_location: weatherLocationSchema.nullable(),
  updated_at: isoDateTimeSchema,
});
export type UserSettings = z.infer<typeof userSettingsSchema>;

// --- REGISTRY -------------------------------------------------------------------------------------

/** Every §6.0 table, keyed by SQL table name (s03 asserts Drizzle parity against this). */
export const entitySchemas = {
  nodes: nodeSchema,
  edges: edgeSchema,
  schedule_blocks: scheduleBlockSchema,
  time_entries: timeEntrySchema,
  habits: habitSchema,
  habit_completions: habitCompletionSchema,
  tags: tagSchema,
  tag_placements: tagPlacementSchema,
  tag_answers: tagAnswerSchema,
  decision_boards: decisionBoardSchema,
  decision_criteria: decisionCriterionSchema,
  decision_scores: decisionScoreSchema,
  sprints: sprintSchema,
  sprint_memberships: sprintMembershipSchema,
  automation_rules: automationRuleSchema,
  blocker_rules: blockerRuleSchema,
  external_facts: externalFactSchema,
  computed_aggregates: computedAggregateSchema,
  diagram_layouts: diagramLayoutSchema,
  diagram_groups: diagramGroupSchema,
  command_log: commandLogEntrySchema,
  user_settings: userSettingsSchema,
} as const;

export type EntityTable = keyof typeof entitySchemas;
