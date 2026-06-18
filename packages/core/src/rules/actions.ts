/**
 * Automation actions (§9.3): the `automation_rules.actions` jsonb grammar —
 * spawn_task templates with `{trigger.*}` interpolation, trigger-relative
 * dates, and slot-relative dependency edges.
 *
 * All time math reads the triggering fact's timestamps, never the wall clock
 * (§9.3) — duplicate server backstop runs are mathematically identical.
 */
import { z } from 'zod';

import type { Node } from '../domain/entities';
import { edgeTypeSchema } from '../domain/entities';
import { uuidSchema, type IsoDate } from '../domain/primitives';
import type { FactContext } from '../status/context';
import { parseIsoDurationMs } from '../time/duration';
import { isoToEpochMillis, type EpochMillis } from '../time/instant';

export const spawnTaskTemplateSchema = z.strictObject({
  /** Supports `{trigger.title}` / `{trigger.description}` / `{trigger.type}` / `{trigger.id}`. */
  title: z.string().min(1),
  description: z.string().optional(),
  estimate_minutes: z.number().int().positive().optional(),
  /**
   * 'same_as_trigger' (default) copies the trigger's justification — both
   * parent_id and habit_id (§6.7 I3 holds because the trigger held it). An
   * explicit uuid re-parents under that node.
   */
  parent: z.union([z.literal('same_as_trigger'), uuidSchema]).optional(),
  /** Trigger-relative date, e.g. 'trigger.completed_at + P2D' (§9.3). */
  due: z.string().optional(),
  /** Dependency from an earlier slot's spawned task to this one. */
  edge_from_slot: z.number().int().nonnegative().optional(),
  edge_type: edgeTypeSchema.optional(),
  lag_minutes: z.number().int().optional(),
});
export type SpawnTaskTemplate = z.infer<typeof spawnTaskTemplateSchema>;

export const automationActionSchema = z.strictObject({
  action: z.literal('spawn_task'),
  slot: z.number().int().nonnegative(),
  template: spawnTaskTemplateSchema,
});
export type AutomationAction = z.infer<typeof automationActionSchema>;

export const automationActionsSchema = z
  .array(automationActionSchema)
  .min(1)
  .max(20)
  .superRefine((actions, ctx) => {
    const slots = new Set<number>();
    for (const action of actions) {
      if (slots.has(action.slot)) {
        ctx.addIssue({ code: 'custom', message: `duplicate slot ${action.slot}` });
      }
      slots.add(action.slot);
    }
    for (const action of actions) {
      const from = action.template.edge_from_slot;
      if (from === undefined) continue;
      if (from === action.slot) {
        ctx.addIssue({ code: 'custom', message: `slot ${action.slot} cannot depend on itself` });
      } else if (!slots.has(from)) {
        ctx.addIssue({
          code: 'custom',
          message: `edge_from_slot ${from} does not exist in this action list`,
        });
      }
    }
  });

const INTERPOLATION_REGEX = /\{trigger\.(\w+)\}/g;

/** `{trigger.*}` placeholders; unknown ones stay literal (visible, deterministic). */
export function interpolate(template: string, trigger: Node): string {
  return template.replace(INTERPOLATION_REGEX, (whole, field: string) => {
    switch (field) {
      case 'title':
        return trigger.title;
      case 'description':
        return trigger.description;
      case 'type':
        return trigger.node_type;
      case 'id':
        return trigger.id;
      default:
        return whole;
    }
  });
}

const DATE_EXPRESSION_REGEX =
  /^trigger\.(completed_at|created_at)(?:\s*([+-])\s*(\S+))?$/;

/**
 * Resolves a §9.3 trigger-relative date expression to the user's civil date
 * (instant + offset, then day-bucketed — a 23:30 completion plus P2D lands on
 * the local date the user expects). Returns null when the expression is
 * malformed or references a timestamp the trigger does not carry (e.g.
 * completed_at on a task_created trigger) — the spawned task simply gets no
 * due date, deterministically.
 */
export function resolveTriggerDate(
  expression: string,
  trigger: Node,
  ctx: FactContext,
): IsoDate | null {
  const match = DATE_EXPRESSION_REGEX.exec(expression.trim());
  if (!match) return null;
  const [, field, sign, duration] = match;
  const base = field === 'completed_at' ? trigger.completed_at : trigger.created_at;
  if (base === null) return null;
  let instant = isoToEpochMillis(base);
  if (duration !== undefined) {
    const ms = parseIsoDurationMs(duration);
    if (ms === null) return null;
    instant = (instant + (sign === '-' ? -ms : ms)) as EpochMillis;
  }
  return ctx.today(instant);
}
