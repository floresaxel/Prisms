/**
 * The complete §8.1 mutation catalog as Zod payload schemas — the single
 * source of truth shared by client and server (§3, §8). Every schema is a
 * `strictObject`, so a payload can only ever carry the fields the verb names:
 * there is no generic "update entity" endpoint and a full-row write is
 * impossible by construction (principle 8; DoD schema test).
 *
 * Invariant checks (§6.7) are NOT here — they need the surrounding fact set
 * and live in invariants.ts. These schemas are pure shape + range validation.
 */
import { z } from 'zod';

import {
  anchorTypeSchema,
  completionDispositionSchema,
  edgeTypeSchema,
  nodeTypeSchema,
  streakModeSchema,
  tagAnswerValueSchema,
} from '../domain/entities';
import { isoDateSchema, isoDateTimeSchema, jsonValueSchema, uuidSchema } from '../domain/primitives';
import { settingsUpdateSchema } from './settings';

const idOnly = z.strictObject({ id: uuidSchema });

// --- nodes (the tree) -------------------------------------------------------

export const nodeCreateSchema = z.strictObject({
  id: uuidSchema,
  node_type: nodeTypeSchema,
  title: z.string(),
  sort_order: z.string().min(1),
  parent_id: uuidSchema.nullable().optional(),
  habit_id: uuidSchema.nullable().optional(),
  description: z.string().optional(),
  start_date: isoDateSchema.nullable().optional(),
  due_date: isoDateSchema.nullable().optional(),
  estimate_minutes: z.number().int().positive().nullable().optional(),
  attributes: z.record(z.string(), jsonValueSchema).optional(),
});

export const nodeRenameSchema = z.strictObject({ id: uuidSchema, title: z.string() });
export const nodeSetDescriptionSchema = z.strictObject({ id: uuidSchema, description: z.string() });
export const nodeMoveSchema = z.strictObject({
  id: uuidSchema,
  new_parent_id: uuidSchema.nullable(),
  sort_order: z.string().min(1),
});
export const nodeRetypeSchema = z.strictObject({ id: uuidSchema, node_type: nodeTypeSchema });
export const nodeSetDatesSchema = z
  .strictObject({
    id: uuidSchema,
    start_date: isoDateSchema.nullable().optional(),
    due_date: isoDateSchema.nullable().optional(),
  })
  .refine((p) => 'start_date' in p || 'due_date' in p, 'set_dates needs at least one date');
export const nodeSetEstimateSchema = z.strictObject({
  id: uuidSchema,
  estimate_minutes: z.number().int().positive().nullable(),
});
export const nodeReorderSchema = z.strictObject({ id: uuidSchema, sort_order: z.string().min(1) });
export const nodeCheckOffSchema = z.strictObject({
  id: uuidSchema,
  completed_at: isoDateTimeSchema,
  // optional for back-compat (§16): absent ⇒ server defaults to 'completed'.
  disposition: completionDispositionSchema.optional(),
  // optional (§16): the block this was completed in; null/absent ⇒ unscheduled.
  completed_in_block_id: uuidSchema.nullable().optional(),
});
export const nodeUncheckSchema = idOnly;
export const nodeSoftDeleteSchema = idOnly;

export const activityPromoteSchema = z
  .strictObject({
    id: uuidSchema,
    parent_id: uuidSchema.optional(),
    habit_id: uuidSchema.optional(),
  })
  .refine(
    (p) => (p.parent_id === undefined) !== (p.habit_id === undefined),
    'activity.promote needs exactly one of parent_id or habit_id (I3)',
  );

// --- edges (the graph) ------------------------------------------------------

export const edgeCreateSchema = z.strictObject({
  id: uuidSchema,
  predecessor_id: uuidSchema,
  successor_id: uuidSchema,
  edge_type: edgeTypeSchema.optional(),
  lag_minutes: z.number().int().optional(),
});
export const edgeDeleteSchema = idOnly;

// --- schedule blocks --------------------------------------------------------

export const blockCreateSchema = z.strictObject({
  id: uuidSchema,
  task_id: uuidSchema,
  starts_at: isoDateTimeSchema,
  ends_at: isoDateTimeSchema,
  anchor_type: anchorTypeSchema.optional(),
});
export const blockMoveSchema = z.strictObject({
  id: uuidSchema,
  starts_at: isoDateTimeSchema,
  ends_at: isoDateTimeSchema,
});
export const blockSetAnchorSchema = z.strictObject({ id: uuidSchema, anchor_type: anchorTypeSchema });
export const blockDeleteSchema = idOnly;
export const blockAcceptSuggestionSchema = idOnly;
export const blockRejectSuggestionSchema = idOnly;

// --- time tracking ----------------------------------------------------------

export const timerClockInSchema = z.strictObject({
  entry_id: uuidSchema,
  task_id: uuidSchema,
  started_at: isoDateTimeSchema,
  planned: z.boolean().optional(),
  /** §8: override the blocked-task guard (ongoing then wins precedence). */
  force: z.boolean().optional(),
});
export const timerClockOutSchema = z.strictObject({ entry_id: uuidSchema, ended_at: isoDateTimeSchema });
export const timerReviewSchema = z.strictObject({
  entry_id: uuidSchema,
  focus_factor: z.number().min(0.5).max(1.0),
  completed_session: z.boolean(),
});

// --- habits & skills --------------------------------------------------------

export const habitCreateSchema = z.strictObject({
  id: uuidSchema,
  vision_id: uuidSchema,
  title: z.string(),
  rrule: z.string().min(1),
  streak_mode: streakModeSchema,
  daily_target_minutes: z.number().int().positive().nullable().optional(),
  mastery_target_hours: z.number().int().positive().nullable().optional(),
  level_thresholds_hours: z.array(z.number().int().nonnegative()).optional(),
});
export const habitUpdateSchema = z
  .strictObject({
    id: uuidSchema,
    title: z.string().optional(),
    rrule: z.string().min(1).optional(),
    streak_mode: streakModeSchema.optional(),
    daily_target_minutes: z.number().int().positive().nullable().optional(),
    mastery_target_hours: z.number().int().positive().nullable().optional(),
    level_thresholds_hours: z.array(z.number().int().nonnegative()).optional(),
  })
  .refine((p) => Object.keys(p).length > 1, 'habit.update needs at least one field');
export const habitDeleteSchema = idOnly;
export const habitCheckOffSchema = z.strictObject({
  id: uuidSchema,
  habit_id: uuidSchema,
  occurrence_date: isoDateSchema,
  completed_at: isoDateTimeSchema,
});

// --- sprints ----------------------------------------------------------------

export const sprintCreateSchema = z.strictObject({
  id: uuidSchema,
  title: z.string(),
  starts_on: isoDateSchema,
  ends_on: isoDateSchema,
});
export const sprintAddNodeSchema = z.strictObject({
  id: uuidSchema,
  sprint_id: uuidSchema,
  node_id: uuidSchema,
});
export const sprintRemoveNodeSchema = idOnly; // membership row id
export const sprintDeleteSchema = idOnly;

// --- decision board ---------------------------------------------------------

export const boardCreateSchema = z.strictObject({ id: uuidSchema, title: z.string() });
export const criterionCreateSchema = z.strictObject({
  id: uuidSchema,
  board_id: uuidSchema,
  label: z.string(),
  weight: z.number().positive(),
});
export const criterionSetWeightSchema = z.strictObject({ id: uuidSchema, weight: z.number().positive() });
export const scoreSetSchema = z.strictObject({
  id: uuidSchema,
  criterion_id: uuidSchema,
  project_id: uuidSchema,
  score: z.number().min(0).max(10),
});

// --- tags (confirmable event tags) ------------------------------------------

export const tagCreateSchema = z.strictObject({
  id: uuidSchema,
  label: z.string(),
  habit_id: uuidSchema.nullable().optional(),
});
export const tagRenameSchema = z.strictObject({ id: uuidSchema, label: z.string() });
export const tagDeleteSchema = idOnly;
export const tagPlaceSchema = z.strictObject({
  id: uuidSchema,
  block_id: uuidSchema,
  tag_id: uuidSchema,
});
export const tagUnplaceSchema = idOnly; // placement row id
// Upsert keyed by placement_id (the score.set shape); carries the client row id
// so client and server converge. Named *Payload to avoid colliding with the
// entity `tagAnswerSchema` at the barrel.
export const tagAnswerPayloadSchema = z.strictObject({
  id: uuidSchema,
  placement_id: uuidSchema,
  value: tagAnswerValueSchema,
  answered_at: isoDateTimeSchema,
});
export const tagClearAnswerSchema = idOnly; // answer row id

// --- journal (a note on any calendar day) -----------------------------------
// Upsert keyed by entry_date (the tag.answer shape): carries the client row id
// so two devices writing the same day converge. `month_key` is server-derived
// (entry_date.slice(0,7)), NEVER in the payload. Emoji are plain Unicode; the
// 100k cap counts UTF-16 code units (§D4).
export const journalWriteSchema = z.strictObject({
  id: uuidSchema,
  entry_date: isoDateSchema,
  content: z.string().max(100_000),
});
export const journalDeleteSchema = idOnly; // journal entry row id

// --- automation & blocker rules ---------------------------------------------

export const ruleCreateSchema = z.strictObject({
  id: uuidSchema,
  trigger: z.enum(['task_completed', 'task_created']),
  conditions: jsonValueSchema,
  actions: jsonValueSchema,
  enabled: z.boolean().optional(),
});
export const ruleUpdateSchema = z
  .strictObject({
    id: uuidSchema,
    trigger: z.enum(['task_completed', 'task_created']).optional(),
    conditions: jsonValueSchema.optional(),
    actions: jsonValueSchema.optional(),
  })
  .refine((p) => Object.keys(p).length > 1, 'rule.update needs at least one field');
export const ruleToggleSchema = z.strictObject({ id: uuidSchema, enabled: z.boolean() });
export const ruleDeleteSchema = idOnly;

export const blockerCreateSchema = z.strictObject({
  id: uuidSchema,
  scope: jsonValueSchema,
  predicate: jsonValueSchema,
  label: z.string(),
  enabled: z.boolean().optional(),
});
export const blockerUpdateSchema = z
  .strictObject({
    id: uuidSchema,
    scope: jsonValueSchema.optional(),
    predicate: jsonValueSchema.optional(),
    label: z.string().optional(),
  })
  .refine((p) => Object.keys(p).length > 1, 'blocker.update needs at least one field');
export const blockerToggleSchema = z.strictObject({ id: uuidSchema, enabled: z.boolean() });
export const blockerDeleteSchema = idOnly;

// --- diagram layout & groups ------------------------------------------------

export const layoutSetPositionSchema = z.strictObject({
  diagram_id: uuidSchema,
  node_id: uuidSchema,
  x: z.number(),
  y: z.number(),
  group_id: uuidSchema.nullable().optional(),
});
export const layoutSetCollapsedSchema = z.strictObject({
  diagram_id: uuidSchema,
  node_id: uuidSchema,
  collapsed: z.boolean(),
});
/**
 * Deterministic sort_order cleanup over `(sort_order, hlc)` (§7.10a). Carries
 * the sibling group (`parent_id`, null = roots) and its children in canonical
 * order; the server (or a batch job) reassigns clean, evenly-spaced fractions.
 * Idempotent and provenance-tagged (server-assigned). See merge/renormalize.ts.
 */
export const layoutRenormalizeOrderSchema = z.strictObject({
  parent_id: uuidSchema.nullable(),
  node_ids: z.array(uuidSchema).min(1),
});
export const groupCreateSchema = z.strictObject({
  id: uuidSchema,
  diagram_id: uuidSchema,
  label: z.string(),
  color: z.string().nullable().optional(),
});
export const groupUpdateSchema = z
  .strictObject({
    id: uuidSchema,
    label: z.string().optional(),
    color: z.string().nullable().optional(),
  })
  .refine((p) => Object.keys(p).length > 1, 'group.update needs at least one field');
export const groupDeleteSchema = idOnly;

// --- review inbox (§7.13) ---------------------------------------------------
// Closing a durable conflict/rejection item. The item row is server-owned and
// synced down; the client CLOSES it through a command (not a row patch), so the
// only trusted write path still holds — the server flips `status`+`resolved_at`,
// re-applies authoritatively, and the canonical row reconciles the overlay away.
export const reviewResolveSchema = idOnly; // review item id
export const reviewDismissSchema = idOnly; // review item id

/**
 * The catalog: verb name → payload schema. The dispatcher rejects any name
 * not present here with E_UNKNOWN_COMMAND, and parses with the schema (E_PARSE).
 */
export const COMMAND_SCHEMAS = {
  'node.create': nodeCreateSchema,
  'node.rename': nodeRenameSchema,
  'node.set_description': nodeSetDescriptionSchema,
  'node.move': nodeMoveSchema,
  'node.retype': nodeRetypeSchema,
  'node.set_dates': nodeSetDatesSchema,
  'node.set_estimate': nodeSetEstimateSchema,
  'node.reorder': nodeReorderSchema,
  'node.check_off': nodeCheckOffSchema,
  'node.uncheck': nodeUncheckSchema,
  'node.soft_delete': nodeSoftDeleteSchema,
  'activity.promote': activityPromoteSchema,
  'edge.create': edgeCreateSchema,
  'edge.delete': edgeDeleteSchema,
  'block.create': blockCreateSchema,
  'block.move': blockMoveSchema,
  'block.set_anchor': blockSetAnchorSchema,
  'block.delete': blockDeleteSchema,
  'block.accept_suggestion': blockAcceptSuggestionSchema,
  'block.reject_suggestion': blockRejectSuggestionSchema,
  'timer.clock_in': timerClockInSchema,
  'timer.clock_out': timerClockOutSchema,
  'timer.review': timerReviewSchema,
  'habit.create': habitCreateSchema,
  'habit.update': habitUpdateSchema,
  'habit.delete': habitDeleteSchema,
  'habit.check_off': habitCheckOffSchema,
  'sprint.create': sprintCreateSchema,
  'sprint.add_node': sprintAddNodeSchema,
  'sprint.remove_node': sprintRemoveNodeSchema,
  'sprint.delete': sprintDeleteSchema,
  'board.create': boardCreateSchema,
  'criterion.create': criterionCreateSchema,
  'criterion.set_weight': criterionSetWeightSchema,
  'score.set': scoreSetSchema,
  'tag.create': tagCreateSchema,
  'tag.rename': tagRenameSchema,
  'tag.delete': tagDeleteSchema,
  'tag.place': tagPlaceSchema,
  'tag.unplace': tagUnplaceSchema,
  'tag.answer': tagAnswerPayloadSchema,
  'tag.clear_answer': tagClearAnswerSchema,
  'journal.write': journalWriteSchema,
  'journal.delete': journalDeleteSchema,
  'rule.create': ruleCreateSchema,
  'rule.update': ruleUpdateSchema,
  'rule.toggle': ruleToggleSchema,
  'rule.delete': ruleDeleteSchema,
  'blocker.create': blockerCreateSchema,
  'blocker.update': blockerUpdateSchema,
  'blocker.toggle': blockerToggleSchema,
  'blocker.delete': blockerDeleteSchema,
  'layout.set_position': layoutSetPositionSchema,
  'layout.set_collapsed': layoutSetCollapsedSchema,
  'layout.renormalize_order': layoutRenormalizeOrderSchema,
  'group.create': groupCreateSchema,
  'group.update': groupUpdateSchema,
  'group.delete': groupDeleteSchema,
  'review.resolve': reviewResolveSchema,
  'review.dismiss': reviewDismissSchema,
  'settings.update': settingsUpdateSchema,
} as const;

export type CommandName = keyof typeof COMMAND_SCHEMAS;
export const COMMAND_NAMES = Object.keys(COMMAND_SCHEMAS) as CommandName[];

export function isCommandName(name: string): name is CommandName {
  return name in COMMAND_SCHEMAS;
}
