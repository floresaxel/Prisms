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
  completion_disposition: column.text,
  completed_in_block_id: column.text,
  habit_id: column.text,
  attributes: column.text,
  // §7.8 provenance (server-assigned, streamed via SELECT *) — surfaced so the
  // UI can answer "why does this exist?" for tasks (M9). Absent on legacy rows
  // → the mapper defaults source_kind='legacy' ("origin unknown").
  created_by_command_id: column.text,
  last_modified_by_command_id: column.text,
  source_kind: column.text,
  source_id: column.text,
  source_detail: column.text,
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
  // §7.5 suggestion lifecycle — so the agenda reflects supersession and the
  // optimistic accept can mirror the server transaction (M9).
  suggestion_batch_id: column.text,
  replaces_block_id: column.text,
  superseded_at: column.text,
  // §7.8 provenance — "why is this suggestion here?" (source_kind='scheduler').
  created_by_command_id: column.text,
  last_modified_by_command_id: column.text,
  source_kind: column.text,
  source_id: column.text,
  source_detail: column.text,
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

const tags = new Table({
  user_id: column.text,
  label: column.text,
  habit_id: column.text,
  created_at: column.text,
  updated_at: column.text,
  deleted_at: column.text,
});

const tag_placements = new Table({
  user_id: column.text,
  block_id: column.text,
  tag_id: column.text,
  created_at: column.text,
  updated_at: column.text,
  deleted_at: column.text,
});

const tag_answers = new Table({
  user_id: column.text,
  placement_id: column.text,
  value: column.text,
  answered_at: column.text,
  created_at: column.text,
  updated_at: column.text,
  deleted_at: column.text,
});

/** A markdown note on a calendar day (§6.0, J3). Synced via the lazy
 *  `journal_month` stream — a fresh device holds zero rows until a month is viewed. */
const journal_entries = new Table({
  user_id: column.text,
  entry_date: column.text,
  month_key: column.text,
  content: column.text,
  created_at: column.text,
  updated_at: column.text,
  deleted_at: column.text,
});

/** A checklist step under a task (§6.0, W3/D4). Always-on synced (the `active`
 *  tier), so the whole set is local; `useTaskSteps` reads it per task. */
const task_steps = new Table({
  user_id: column.text,
  task_id: column.text,
  title: column.text,
  done: column.integer,
  sort_order: column.text,
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
  // Annex L. SQLite has no boolean: 0/1, and ABSENT means ON (the DDL default),
  // so a client that has not synced settings yet still shows the day log.
  journal_day_log: column.integer,
  updated_at: column.text,
});

/**
 * The durable conflict/rejection inbox (§7.13). SERVER-OWNED: the dispatcher (M5)
 * and jobs (M6) create items; they stream down here (M4) for the review inbox.
 * The client never CREATES these (a rejection just drops the overlay; the item
 * arrives via sync). It only CLOSES them — via the `review.resolve`/`review.dismiss`
 * commands (M10), i.e. an overlay effect + a named envelope, never a row patch —
 * so it stays out of LOCAL_ONLY_TABLE_NAMES (it is synced, not local-only) and the
 * only-trusted-write-path invariant holds.
 */
const sync_review_items = new Table({
  user_id: column.text,
  command_id: column.text,
  item_type: column.text,
  severity: column.text,
  title: column.text,
  detail: column.text,
  status: column.text,
  created_at: column.text,
  updated_at: column.text,
  deleted_at: column.text,
});

/** The synced tables (§7.3): the canonical replica streamed down from Postgres. */
const syncedTables = {
  nodes,
  edges,
  schedule_blocks,
  time_entries,
  habits,
  habit_completions,
  tags,
  tag_placements,
  tag_answers,
  journal_entries,
  task_steps,
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
  sync_review_items,
};

export { sync_review_items };

/**
 * The synced-table contract: exactly the rows the sync rules stream down. The
 * two-layer overlay tables (below) are deliberately NOT here — they are
 * client-local and must never be uploaded as row patches (1.3 §7.2, R15).
 */
export const appSchema = new Schema(syncedTables);

// --- Two-layer client store (1.3 §7.2a, R15) — LOCAL-ONLY -------------------
// `client_commands` is the pending-command upload queue; `overlay_effects` is
// each command's optimistic row effects that the read-merge applies over the
// replica. Both are `localOnly` so PowerSync never enqueues them in the CRUD
// upload batch — the only trusted upload is the named command envelope read from
// `client_commands` (see upload-commands.ts). `sync_review_items` is NOT here: it
// is server-owned and SYNCED down (above). M5 creates the items; the client reads
// them and closes them through the `review.resolve`/`review.dismiss` commands (M10)
// — an overlay effect + envelope, never a direct row patch.

/** Pending-command queue. `id` = the client-minted UUIDv7 (V2, §7.2b). */
export const client_commands = new Table(
  {
    name: column.text,
    hlc: column.text,
    payload: column.text, // JSON
    status: column.text, // pending | applied | rejected
    created_at: column.text,
    reject_code: column.text,
    reject_reason: column.text,
    // §8/§7.11 command-envelope version axes + §7.2e causal deps, stamped at
    // enqueue (captures the minting version) and sent verbatim in the envelope
    // (R6). Local-only, so this is NOT a synced-schema change.
    command_version: column.integer,
    schema_version: column.integer,
    client_version: column.text,
    depends_on: column.text, // JSON array of prior client_commands ids (§7.2e)
  },
  { localOnly: true },
);

/** Per-command optimistic row effects merged over the replica on read (§7.2). */
export const overlay_effects = new Table(
  {
    command_id: column.text,
    hlc: column.text,
    table_name: column.text,
    row_id: column.text,
    op: column.text, // insert | update | delete
    fields: column.text, // JSON
    seq: column.integer,
    created_at: column.text,
  },
  { localOnly: true },
);

/** The local-only overlay table names — asserted absent from `appSchema`. */
export const LOCAL_ONLY_TABLE_NAMES = ['client_commands', 'overlay_effects'] as const;

/**
 * The full on-device schema: the synced replica PLUS the local-only overlay
 * tables. PowerSync is opened with this so the overlay tables exist in SQLite,
 * while `appSchema` stays the clean synced contract.
 */
export const clientSchema = new Schema({
  ...syncedTables,
  client_commands,
  overlay_effects,
});
