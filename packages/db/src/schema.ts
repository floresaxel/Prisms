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
  ReviewItemType,
  ReviewSeverity,
  ReviewStatus,
  SourceKind,
  StreakMode,
  SubjectKind,
  SuggestionBatchSource,
  TagAnswerValue,
  UserSettings,
} from '@prisms/core';

const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'string' });

// Sentinel HLC for legacy (pre-migration) rows — sorts before any real HLC.
const LEGACY_HLC = '000000000000-0000-legacy';

/**
 * §6 base columns PLUS the 1.3 convergence columns (§7.1 per-row hlc, §7.11 row
 * schema_version, §7.8 provenance). All server-assigned; every column ships a
 * DB-level DEFAULT so the migration is live-DB-safe on a populated table
 * (legacy rows backfill to the sentinel hlc, floor schema_version, and
 * source_kind='legacy' = "origin unknown").
 */
const baseColumns = {
  id: uuid('id').primaryKey(),
  user_id: uuid('user_id').notNull(),
  created_at: timestamptz('created_at').notNull().defaultNow(),
  updated_at: timestamptz('updated_at').notNull(),
  deleted_at: timestamptz('deleted_at'),
  hlc: text('hlc').notNull().default(LEGACY_HLC),
  schema_version: integer('schema_version').notNull().default(1),
  created_by_command_id: uuid('created_by_command_id'),
  last_modified_by_command_id: uuid('last_modified_by_command_id'),
  source_kind: text('source_kind').$type<SourceKind>().notNull().default('legacy'),
  source_id: uuid('source_id'),
  source_detail: jsonb('source_detail').$type<JsonObject>().notNull().default({}),
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
    // §7.7 partial unique: a soft-deleted edge can be recreated.
    uniqueIndex('edges_pred_succ_uq')
      .on(t.predecessor_id, t.successor_id)
      .where(sql`${t.deleted_at} IS NULL`),
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
    // suggestion lifecycle (§7.5)
    suggestion_batch_id: uuid('suggestion_batch_id'),
    replaces_block_id: uuid('replaces_block_id'),
    superseded_at: timestamptz('superseded_at'),
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
  (t) => [
    // §7.7 partial unique: a soft-deleted completion can be recreated.
    uniqueIndex('habit_completions_habit_occurrence_uq')
      .on(t.habit_id, t.occurrence_date)
      .where(sql`${t.deleted_at} IS NULL`),
  ],
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
    // §7.7 partial unique: a soft-deleted score can be recreated.
    uniqueIndex('decision_scores_criterion_project_uq')
      .on(t.criterion_id, t.project_id)
      .where(sql`${t.deleted_at} IS NULL`),
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
  (t) => [
    // §7.7 partial unique: a soft-deleted membership can be recreated.
    uniqueIndex('sprint_memberships_sprint_node_uq')
      .on(t.sprint_id, t.node_id)
      .where(sql`${t.deleted_at} IS NULL`),
  ],
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
    // bumped on rule.update; recorded in spawned-row provenance (§10.2)
    rule_version: integer('rule_version').notNull().default(1),
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
    // §7.7 dual partial unique for nullable subject_id: user-level (subject_id
    // NULL) vs subject-level, both excluding soft-deleted rows.
    uniqueIndex('computed_aggregates_user_metric_uq')
      .on(t.user_id, t.subject_kind, t.metric)
      .where(sql`${t.subject_id} IS NULL AND ${t.deleted_at} IS NULL`),
    uniqueIndex('computed_aggregates_subject_metric_uq')
      .on(t.user_id, t.subject_kind, t.subject_id, t.metric)
      .where(sql`${t.subject_id} IS NOT NULL AND ${t.deleted_at} IS NULL`),
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
  (t) => [
    // §7.7 partial unique: a soft-deleted layout can be recreated.
    uniqueIndex('diagram_layouts_diagram_node_uq')
      .on(t.diagram_id, t.node_id)
      .where(sql`${t.deleted_at} IS NULL`),
  ],
);

export const diagram_groups = pgTable('diagram_groups', {
  ...baseColumns,
  diagram_id: uuid('diagram_id').notNull(),
  label: text('label').notNull(),
  color: text('color'),
});

// --- SUGGESTION BATCHES (§7.5) ----------------------------------------------------------
// suggestion_batch_id / replaces_block_id / command_id are plain uuids (no FK),
// matching the as-built style for cross-entity links (habit_id, completed_in_block_id).

export const schedule_suggestion_batches = pgTable(
  'schedule_suggestion_batches',
  {
    ...baseColumns,
    source: text('source').$type<SuggestionBatchSource>().notNull(),
    horizon_start: timestamptz('horizon_start').notNull(),
    horizon_end: timestamptz('horizon_end').notNull(),
    computed_at: timestamptz('computed_at').notNull(),
    superseded_at: timestamptz('superseded_at'),
  },
  (t) => [
    check(
      'suggestion_batches_source_check',
      sql`${t.source} IN ('past_due','nightly_optimize','manual_optimize')`,
    ),
    index('suggestion_batches_user')
      .on(t.user_id, t.computed_at)
      .where(sql`${t.deleted_at} IS NULL`),
  ],
);

// --- REVIEW INBOX (§7.13) ---------------------------------------------------------------

export const sync_review_items = pgTable(
  'sync_review_items',
  {
    ...baseColumns,
    command_id: uuid('command_id'),
    item_type: text('item_type').$type<ReviewItemType>().notNull(),
    severity: text('severity').$type<ReviewSeverity>().notNull(),
    title: text('title').notNull(),
    detail: jsonb('detail').$type<JsonObject>().notNull().default({}),
    status: text('status').$type<ReviewStatus>().notNull().default('open'),
    resolved_at: timestamptz('resolved_at'),
  },
  (t) => [
    check(
      'review_items_type_check',
      sql`${t.item_type} IN ('command_rejection','dependency_rejection','hlc_conflict','stale_suggestion','automation_backstop','automation_drift','schema_version_block','import_warning','sync_warning')`,
    ),
    check('review_items_severity_check', sql`${t.severity} IN ('info','warning','error')`),
    check('review_items_status_check', sql`${t.status} IN ('open','resolved','dismissed')`),
    index('review_items_user_status')
      .on(t.user_id, t.status)
      .where(sql`${t.deleted_at} IS NULL`),
  ],
);

// --- JOURNAL (a note on any calendar day, §6.0) -----------------------------------------

/**
 * One live markdown note per `(user_id, entry_date)` — the §7.7 partial unique
 * index is the arbiter. `month_key` (entry_date's 'YYYY-MM', server-derived) is
 * the equality key of the lazy `journal_month` sync stream (§7.3), so a fresh
 * device pulls zero journal rows until a month is viewed. Not a node_type.
 */
export const journal_entries = pgTable(
  'journal_entries',
  {
    ...baseColumns,
    entry_date: date('entry_date', { mode: 'string' }).notNull(),
    // 'YYYY-MM' of entry_date; server-derived (never client-supplied).
    month_key: text('month_key').notNull(),
    // CommonMark markdown; emoji ride through as plain Unicode.
    content: text('content').notNull().default(''),
  },
  (t) => [
    // [0-9] not \d — Drizzle's sql template is JS; \d would lose its backslash.
    check('journal_entries_month_key_check', sql`${t.month_key} ~ '^[0-9]{4}-[0-9]{2}$'`),
    // §7.7 partial unique: one live note per day; a soft-deleted day can be re-created.
    uniqueIndex('journal_entries_user_date_uq')
      .on(t.user_id, t.entry_date)
      .where(sql`${t.deleted_at} IS NULL`),
    index('journal_entries_month')
      .on(t.user_id, t.month_key)
      .where(sql`${t.deleted_at} IS NULL`),
  ],
);

/**
 * A checklist step under a task (§6.0, W3/D4). Separate synced table — NOT a
 * node type — so steps never enter the worklist/scheduler/StatusIndex/burndown.
 * `task_id`'s parent must be node_type='task' (dispatcher-enforced); `sort_order`
 * is the same fractional index as nodes. Deleting a task soft-deletes its steps.
 */
export const task_steps = pgTable(
  'task_steps',
  {
    ...baseColumns,
    task_id: uuid('task_id')
      .notNull()
      .references(() => nodes.id),
    title: text('title').notNull(),
    done: boolean('done').notNull().default(false),
    sort_order: text('sort_order').notNull(),
  },
  (t) => [index('task_steps_task_idx').on(t.user_id, t.task_id).where(sql`${t.deleted_at} IS NULL`)],
);

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
    // command-envelope versions + causal/provenance links (§7.2e/§7.2f)
    command_version: integer('command_version').notNull().default(1),
    schema_version: integer('schema_version').notNull().default(1),
    client_version: text('client_version'),
    effects: jsonb('effects').$type<JsonValue>().notNull().default([]),
    parent_command_id: uuid('parent_command_id'),
    triggering_command_id: uuid('triggering_command_id'),
    depends_on: uuid('depends_on').array().notNull().default([]),
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
    // Annex L built-in automation, opt-OUT: existing rows get it ON at migration.
    journal_day_log: boolean('journal_day_log').notNull().default(true),
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
  schedule_suggestion_batches,
  sync_review_items,
  journal_entries,
  task_steps,
  command_log,
  user_settings,
} as const;
