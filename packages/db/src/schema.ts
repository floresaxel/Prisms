/**
 * Drizzle schema mirroring ARCHITECTURE.md §6.0 exactly — every table, index,
 * CHECK, FK and unique constraint. Column TS types come from @prisms/core
 * (type-only imports), and src/type-assertions.ts proves at compile time that
 * `$inferSelect` of every table equals the corresponding core entity type.
 *
 * Deliberate deviations from the literal §6.0 SQL, both mandated elsewhere in
 * the spec:
 * - `entries_open` is a UNIQUE partial index (§6.7 I5 names a "partial unique
 *   index" as the DB backstop; §6.0 showed a plain index).
 * - blocks/entries carry interval CHECKs (§6.7 I6 names a DB CHECK).
 * - `computed_aggregates` uniqueness uses NULLS NOT DISTINCT so user-level
 *   aggregates (subject_id NULL) cannot duplicate — the §11 recompute job
 *   upserts on this constraint.
 * The I1 hierarchy trigger lives in migrations/0001_hierarchy_trigger.sql
 * (triggers are not expressible in Drizzle).
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  unique,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import type {
  AnchorType,
  AutomationTrigger,
  BlockStatus,
  CommandResult,
  CompletionDisposition,
  ComputedBy,
  EdgeType,
  JsonObject,
  JsonValue,
  NodeType,
  StreakMode,
  SubjectKind,
  TagAnswerValue,
  UserSettings,
} from '@prisms/core';

const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'string' });

/** §6: every synced table carries these. */
const baseColumns = {
  id: uuid('id').primaryKey(),
  user_id: uuid('user_id').notNull(),
  created_at: timestamptz('created_at').notNull().defaultNow(),
  updated_at: timestamptz('updated_at').notNull(),
  deleted_at: timestamptz('deleted_at'),
};

// --- THE TREE ---------------------------------------------------------------

export const nodes = pgTable(
  'nodes',
  {
    ...baseColumns,
    parent_id: uuid('parent_id').references((): AnyPgColumn => nodes.id),
    node_type: text('node_type').$type<NodeType>().notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    // fractional index (e.g. 'a0', 'a1', 'a0V')
    sort_order: text('sort_order').notNull(),
    start_date: date('start_date', { mode: 'string' }),
    due_date: date('due_date', { mode: 'string' }),
    estimate_minutes: integer('estimate_minutes'),
    // FACT. NULL = not done. Only set by mutations.
    completed_at: timestamptz('completed_at'),
    // disposition of the completion: 'completed' (default) or 'obsolete' (descoped). NULL when not done.
    completion_disposition: text('completion_disposition').$type<CompletionDisposition>(),
    // committed block this task was completed in; NULL = unscheduled. Plain uuid (no FK), like habit_id.
    completed_in_block_id: uuid('completed_in_block_id'),
    // task spawned by a habit occurrence (XOR parent rule, §6.7-I3)
    habit_id: uuid('habit_id'),
    // type-specific extras only; never queried fields
    attributes: jsonb('attributes').$type<JsonObject>().notNull().default({}),
  },
  (t) => [
    check(
      'nodes_node_type_check',
      sql`${t.node_type} IN ('vision','roadmap','project','milestone','task','activity')`,
    ),
    check(
      'nodes_completion_disposition_check',
      sql`${t.completion_disposition} IN ('completed','obsolete')`,
    ),
    index('nodes_children')
      .on(t.user_id, t.parent_id, t.sort_order)
      .where(sql`${t.deleted_at} IS NULL`),
    index('nodes_by_type')
      .on(t.user_id, t.node_type)
      .where(sql`${t.deleted_at} IS NULL`),
    index('nodes_due')
      .on(t.user_id, t.due_date)
      .where(sql`${t.deleted_at} IS NULL`),
  ],
);

// --- THE GRAPH ----------------------------------------------------------------

export const edges = pgTable(
  'edges',
  {
    ...baseColumns,
    predecessor_id: uuid('predecessor_id')
      .notNull()
      .references(() => nodes.id),
    successor_id: uuid('successor_id')
      .notNull()
      .references(() => nodes.id),
    edge_type: text('edge_type').$type<EdgeType>().notNull().default('FS'),
    lag_minutes: integer('lag_minutes').notNull().default(0),
  },
  (t) => [
    check('edges_edge_type_check', sql`${t.edge_type} IN ('FS','SS','FF','SF')`),
    unique('edges_pred_succ_uq').on(t.predecessor_id, t.successor_id),
    index('edges_succ')
      .on(t.user_id, t.successor_id)
      .where(sql`${t.deleted_at} IS NULL`),
    index('edges_pred')
      .on(t.user_id, t.predecessor_id)
      .where(sql`${t.deleted_at} IS NULL`),
  ],
);

// --- SCHEDULING ----------------------------------------------------------------

export const schedule_blocks = pgTable(
  'schedule_blocks',
  {
    ...baseColumns,
    task_id: uuid('task_id')
      .notNull()
      .references(() => nodes.id),
    starts_at: timestamptz('starts_at').notNull(),
    ends_at: timestamptz('ends_at').notNull(),
    anchor_type: text('anchor_type').$type<AnchorType>().notNull().default('none'),
    // recurrence (habit-generated blocks)
    rrule: text('rrule'),
    status: text('status').$type<BlockStatus>().notNull().default('committed'),
    // e.g. 'past_due_reschedule', 'nightly_optimization'
    suggestion_reason: text('suggestion_reason'),
    // set when produced by a server job
    computed_at: timestamptz('computed_at'),
    // reserved (v2 calendar sync)
    external_event_id: text('external_event_id'),
  },
  (t) => [
    check(
      'blocks_anchor_type_check',
      sql`${t.anchor_type} IN ('none','start','end','both')`,
    ),
    check('blocks_status_check', sql`${t.status} IN ('committed','suggested')`),
    // §6.7 I6
    check('blocks_interval_check', sql`${t.ends_at} > ${t.starts_at}`),
    index('blocks_time')
      .on(t.user_id, t.starts_at)
      .where(sql`${t.deleted_at} IS NULL`),
    index('blocks_task')
      .on(t.user_id, t.task_id)
      .where(sql`${t.deleted_at} IS NULL`),
  ],
);

// --- TIME TRACKING (append-only facts) -------------------------------------------

export const time_entries = pgTable(
  'time_entries',
  {
    ...baseColumns,
    task_id: uuid('task_id')
      .notNull()
      .references(() => nodes.id),
    started_at: timestamptz('started_at').notNull(),
    // NULL = clock currently running
    ended_at: timestamptz('ended_at'),
    // set at clock-out review
    focus_factor: real('focus_factor'),
    // "was the task finished this session?"
    completed_session: boolean('completed_session'),
    // false = unplanned ad-hoc work
    planned: boolean('planned').notNull().default(true),
    // for the offline double-clock-in rule (§7.4)
    device_id: text('device_id').notNull(),
  },
  (t) => [
    check(
      'entries_focus_factor_check',
      sql`${t.focus_factor} BETWEEN 0.5 AND 1.0`,
    ),
    // §6.7 I6
    check(
      'entries_interval_check',
      sql`${t.ended_at} IS NULL OR ${t.ended_at} > ${t.started_at}`,
    ),
    // §6.7 I5 DB backstop: at most one open entry per user
    uniqueIndex('entries_open')
      .on(t.user_id)
      .where(sql`${t.ended_at} IS NULL AND ${t.deleted_at} IS NULL`),
    index('entries_task')
      .on(t.user_id, t.task_id, t.started_at)
      .where(sql`${t.deleted_at} IS NULL`),
  ],
);

// --- HABITS & SKILLS ----------------------------------------------------------------

export const habits = pgTable(
  'habits',
  {
    ...baseColumns,
    // must reference a node_type='vision'
    vision_id: uuid('vision_id')
      .notNull()
      .references(() => nodes.id),
    title: text('title').notNull(),
    // occurrence pattern
    rrule: text('rrule').notNull(),
    streak_mode: text('streak_mode').$type<StreakMode>().notNull(),
    // progress-ring target (e.g. 120 = 2h study)
    daily_target_minutes: integer('daily_target_minutes'),
    // e.g. 10000; NULL = plain habit, not a skill
    mastery_target_hours: integer('mastery_target_hours'),
    // ascending hour marks per level
    level_thresholds_hours: integer('level_thresholds_hours')
      .array()
      .notNull()
      .default([]),
  },
  (t) => [
    check(
      'habits_streak_mode_check',
      sql`${t.streak_mode} IN ('perfect_planned','daily','weekly','monthly','quarterly','yearly')`,
    ),
  ],
);

/** Append-only facts (check-offs). */
export const habit_completions = pgTable(
  'habit_completions',
  {
    ...baseColumns,
    habit_id: uuid('habit_id')
      .notNull()
      .references(() => habits.id),
    // bucketed with day-reset hour (§7.2)
    occurrence_date: date('occurrence_date', { mode: 'string' }).notNull(),
    completed_at: timestamptz('completed_at').notNull(),
  },
  (t) => [unique('habit_completions_habit_occurrence_uq').on(t.habit_id, t.occurrence_date)],
);

// --- TAGS (confirmable event tags) ---------------------------------------------------

/** Reusable tag catalog ("on time?"). */
export const tags = pgTable(
  'tags',
  {
    ...baseColumns,
    label: text('label').notNull(),
    // NULL = global tag; non-NULL scopes it to a habit. Plain uuid (no FK), like nodes.habit_id.
    habit_id: uuid('habit_id'),
  },
  (t) => [
    // partial-unique: a soft-deleted label can be reused (mirrors entries_open).
    uniqueIndex('tags_user_label_uq')
      .on(t.user_id, t.label)
      .where(sql`${t.deleted_at} IS NULL`),
    index('tags_habit')
      .on(t.user_id, t.habit_id)
      .where(sql`${t.deleted_at} IS NULL`),
  ],
);

/** A tag placed on a schedule block (so it can sit pending on the event). */
export const tag_placements = pgTable(
  'tag_placements',
  {
    ...baseColumns,
    block_id: uuid('block_id')
      .notNull()
      .references(() => schedule_blocks.id),
    tag_id: uuid('tag_id')
      .notNull()
      .references(() => tags.id),
  },
  (t) => [
    uniqueIndex('tag_placements_block_tag_uq')
      .on(t.block_id, t.tag_id)
      .where(sql`${t.deleted_at} IS NULL`),
    index('tag_placements_block')
      .on(t.user_id, t.block_id)
      .where(sql`${t.deleted_at} IS NULL`),
    index('tag_placements_tag')
      .on(t.user_id, t.tag_id)
      .where(sql`${t.deleted_at} IS NULL`),
  ],
);

/** The yes/no answer fact; pending = no live (non-deleted) row for the placement. */
export const tag_answers = pgTable(
  'tag_answers',
  {
    ...baseColumns,
    placement_id: uuid('placement_id')
      .notNull()
      .references(() => tag_placements.id),
    value: text('value').$type<TagAnswerValue>().notNull(),
    answered_at: timestamptz('answered_at').notNull(),
  },
  (t) => [
    check('tag_answers_value_check', sql`${t.value} IN ('yes','no')`),
    // one current answer per placement; re-answering is a per-field LWW update.
    uniqueIndex('tag_answers_placement_uq')
      .on(t.placement_id)
      .where(sql`${t.deleted_at} IS NULL`),
  ],
);

// --- DECISION MATRIX ----------------------------------------------------------------

export const decision_boards = pgTable('decision_boards', {
  ...baseColumns,
  title: text('title').notNull(),
});

export const decision_criteria = pgTable(
  'decision_criteria',
  {
    ...baseColumns,
    board_id: uuid('board_id')
      .notNull()
      .references(() => decision_boards.id),
    label: text('label').notNull(),
    weight: real('weight').notNull(),
  },
  (t) => [check('criteria_weight_check', sql`${t.weight} > 0`)],
);

export const decision_scores = pgTable(
  'decision_scores',
  {
    ...baseColumns,
    criterion_id: uuid('criterion_id')
      .notNull()
      .references(() => decision_criteria.id),
    project_id: uuid('project_id')
      .notNull()
      .references(() => nodes.id),
    score: real('score').notNull(),
  },
  (t) => [
    check('scores_score_check', sql`${t.score} BETWEEN 0 AND 10`),
    unique('decision_scores_criterion_project_uq').on(t.criterion_id, t.project_id),
  ],
);
// priority(project) = Σ weight×score / Σ weight   (computed in core, never stored)

// --- SPRINT / PRIORITIZED GROUP ----------------------------------------------------

export const sprints = pgTable('sprints', {
  ...baseColumns,
  title: text('title').notNull(),
  starts_on: date('starts_on', { mode: 'string' }).notNull(),
  ends_on: date('ends_on', { mode: 'string' }).notNull(),
});

export const sprint_memberships = pgTable(
  'sprint_memberships',
  {
    ...baseColumns,
    sprint_id: uuid('sprint_id')
      .notNull()
      .references(() => sprints.id),
    node_id: uuid('node_id')
      .notNull()
      .references(() => nodes.id),
  },
  (t) => [unique('sprint_memberships_sprint_node_uq').on(t.sprint_id, t.node_id)],
);

// --- AUTOMATION & BLOCKER RULES (declarative JSON, §9) -------------------------------

export const automation_rules = pgTable(
  'automation_rules',
  {
    ...baseColumns,
    trigger: text('trigger').$type<AutomationTrigger>().notNull(),
    // predicate AST, §9.2
    conditions: jsonb('conditions').$type<JsonValue>().notNull(),
    // spawn templates, §9.3
    actions: jsonb('actions').$type<JsonValue>().notNull(),
    enabled: boolean('enabled').notNull().default(true),
  },
  (t) => [
    check(
      'automation_trigger_check',
      sql`${t.trigger} IN ('task_completed','task_created')`,
    ),
  ],
);

export const blocker_rules = pgTable('blocker_rules', {
  ...baseColumns,
  // which nodes it applies to (subtree/type/tag)
  scope: jsonb('scope').$type<JsonValue>().notNull(),
  // same AST grammar; may reference external_facts
  predicate: jsonb('predicate').$type<JsonValue>().notNull(),
  // shown in UI: "Blocked: rain forecast"
  label: text('label').notNull(),
  enabled: boolean('enabled').notNull().default(true),
});

// --- EXTERNAL FACTS (server-written, sync down read-only) ------------------------------

export const external_facts = pgTable(
  'external_facts',
  {
    ...baseColumns,
    // 'weather_forecast'
    kind: text('kind').notNull(),
    // e.g. 'merritt-island-fl/2026-06-12'
    key: text('key').notNull(),
    // {high_c, low_c, precip_prob, wind_kph, ...}
    payload: jsonb('payload').$type<JsonValue>().notNull(),
    computed_at: timestamptz('computed_at').notNull(),
  },
  (t) => [unique('external_facts_user_kind_key_uq').on(t.user_id, t.kind, t.key)],
);

// --- SERVER-COMPUTED CACHES (clients read; clients also patch incrementally) -----------

export const computed_aggregates = pgTable(
  'computed_aggregates',
  {
    ...baseColumns,
    subject_kind: text('subject_kind').$type<SubjectKind>().notNull(),
    // NULL for user-level aggregates
    subject_id: uuid('subject_id'),
    // 'practice_hours','streak','progress','burndown_series','projection'
    metric: text('metric').notNull(),
    value: jsonb('value').$type<JsonValue>().notNull(),
    computed_at: timestamptz('computed_at').notNull(),
    computed_by: text('computed_by').$type<ComputedBy>().notNull(),
  },
  (t) => [
    check(
      'aggregates_subject_kind_check',
      sql`${t.subject_kind} IN ('habit','node','user')`,
    ),
    check(
      'aggregates_computed_by_check',
      sql`${t.computed_by} IN ('client','server')`,
    ),
    unique('computed_aggregates_subject_metric_uq')
      .on(t.user_id, t.subject_kind, t.subject_id, t.metric)
      .nullsNotDistinct(),
  ],
);

// --- DIAGRAM PRESENTATION (never affects semantics) -------------------------------------

export const diagram_layouts = pgTable(
  'diagram_layouts',
  {
    ...baseColumns,
    // the node whose subtree the diagram shows
    diagram_id: uuid('diagram_id').notNull(),
    node_id: uuid('node_id')
      .notNull()
      .references(() => nodes.id),
    x: real('x').notNull(),
    y: real('y').notNull(),
    // visual grouping container
    group_id: uuid('group_id'),
    collapsed: boolean('collapsed').notNull().default(false),
    // set when produced by the layout job
    computed_at: timestamptz('computed_at'),
  },
  (t) => [unique('diagram_layouts_diagram_node_uq').on(t.diagram_id, t.node_id)],
);

export const diagram_groups = pgTable('diagram_groups', {
  ...baseColumns,
  diagram_id: uuid('diagram_id').notNull(),
  label: text('label').notNull(),
  color: text('color'),
});

// --- COMMAND LOG (audit; written server-side on every applied mutation) -----------------

export const command_log = pgTable(
  'command_log',
  {
    // client-generated command id (idempotency key)
    id: uuid('id').primaryKey(),
    user_id: uuid('user_id').notNull(),
    name: text('name').notNull(),
    payload: jsonb('payload').$type<JsonValue>().notNull(),
    device_id: text('device_id').notNull(),
    // hybrid logical clock, §7.3
    hlc: text('hlc').notNull(),
    applied_at: timestamptz('applied_at').notNull().defaultNow(),
    result: text('result').$type<CommandResult>().notNull(),
    reject_reason: text('reject_reason'),
  },
  (t) => [
    check(
      'command_log_result_check',
      sql`${t.result} IN ('applied','rejected','noop')`,
    ),
  ],
);

// --- SETTINGS ----------------------------------------------------------------------------

export const user_settings = pgTable(
  'user_settings',
  {
    user_id: uuid('user_id').primaryKey(),
    day_reset_hour: smallint('day_reset_hour').notNull().default(4),
    timezone: text('timezone').notNull().default('America/New_York'),
    // {lat, lon, label}
    weather_location: jsonb('weather_location').$type<
      NonNullable<UserSettings['weather_location']>
    >(),
    updated_at: timestamptz('updated_at').notNull(),
  },
  (t) => [
    check(
      'settings_day_reset_hour_check',
      sql`${t.day_reset_hour} BETWEEN 0 AND 23`,
    ),
  ],
);

// --- CONVERGENCE: per-field HLC last-writer (server-internal; never synced) ----------
// Tracks the HLC of the last writer of each mutable field so the dispatcher
// can resolve same-field conflicts by HLC, not arrival order (§7.3). Not a
// §6.0 domain table: excluded from sync-rules and the core type assertions.
export const command_field_versions = pgTable(
  'command_field_versions',
  {
    user_id: uuid('user_id').notNull(),
    table_name: text('table_name').notNull(),
    row_id: uuid('row_id').notNull(),
    field: text('field').notNull(),
    hlc: text('hlc').notNull(),
  },
  (t) => [primaryKey({ columns: [t.table_name, t.row_id, t.field] })],
);

// --- PUSH SUBSCRIPTIONS (server-internal; never synced) -------------------------------
// Per-device push endpoints for notify.dispatch (§11, §12.3): Web Push
// endpoints + keys, or an Expo push token. Not a §6.0 domain table.
export const push_subscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey(),
    user_id: uuid('user_id').notNull(),
    device_id: text('device_id').notNull(),
    kind: text('kind').$type<'web' | 'expo'>().notNull(),
    endpoint: text('endpoint').notNull(), // web push URL or expo token
    keys: jsonb('keys').$type<{ p256dh?: string; auth?: string }>(), // web push only
    created_at: timestamptz('created_at').notNull().defaultNow(),
    updated_at: timestamptz('updated_at').notNull(),
    deleted_at: timestamptz('deleted_at'),
  },
  (t) => [
    check('push_subscriptions_kind_check', sql`${t.kind} IN ('web','expo')`),
    unique('push_subscriptions_endpoint_uq').on(t.user_id, t.endpoint),
  ],
);

/** Every table, keyed by SQL name — used by the seed, tests, and later the server. */
export const tables = {
  nodes,
  edges,
  schedule_blocks,
  time_entries,
  habits,
  habit_completions,
  tags,
  tag_placements,
  tag_answers,
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
  command_log,
  user_settings,
} as const;
