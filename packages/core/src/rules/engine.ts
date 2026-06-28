/**
 * Rules engine (§9) — pure transactional output: returns the rows to write;
 * the server automation backstop commits them atomically in Postgres (§9.1,
 * R4).
 *
 * Determinism (§2.7, §9.4): output ids are UUIDv5 over
 * `rule_id:trigger_node_id:slot`, timestamps derive from the triggering
 * fact (completed_at for task_completed, created_at for task_created),
 * rules evaluate in id order and slots ascending — duplicate server backstop
 * runs for the same trigger produce byte-identical rows.
 *
 * Fixpoint: spawned tasks are `task_created` events for the next wave, up to
 * MAX_DEPTH cascade levels; deeper matches set `depthLimited` and stop.
 * Replay safety: outputs whose rows already exist (same UUIDv5 id, or the
 * same dependency pair) are skipped — re-running a trigger is a no-op, and
 * partially-synced outputs are completed rather than duplicated.
 */
import type { AutomationRule, Edge, Node } from '../domain/entities';
import { SYNC_ROW_DEFAULTS } from '../domain/entities';
import { uuidV5 } from '../domain/ids';
import type { IsoDateTime, Uuid } from '../domain/primitives';
import { findEdgeBetween } from '../graph/dag';
import { sortOrdersBetween } from '../graph/order';
import { buildFactContext, type FactRows } from '../status/context';
import { evalPredicate } from '../status/predicate';
import { isoToEpochMillis } from '../time/instant';

import {
  automationActionsSchema,
  interpolate,
  resolveTriggerDate,
  type AutomationAction,
} from './actions';

export const MAX_DEPTH = 5;

export interface TriggerEvent {
  kind: 'task_completed' | 'task_created';
  node: Node;
}

export interface RulesEngineInput {
  trigger: TriggerEvent;
  rules: readonly AutomationRule[];
  /** The local fact set — spawned rows are layered on top per wave. */
  rows: FactRows;
}

/** Per-spawned-row attribution (§7.8 provenance: which rule + slot produced it). */
export interface SpawnProvenance {
  /** The spawned node or edge id. */
  id: Uuid;
  rule_id: Uuid;
  slot: number;
}

export interface RulesEngineOutput {
  nodes: Node[];
  edges: Edge[];
  /** Rule ids that fired, in execution order (audit/debug). */
  firedRuleIds: Uuid[];
  /** True when a cascade reached MAX_DEPTH and was cut off. */
  depthLimited: boolean;
  /** Attribution for each spawned node/edge id → its producing rule + slot (§7.8). */
  provenance: SpawnProvenance[];
}

/** §9.4: spawned.id = uuidv5(PRISMS_NS, rule_id + ':' + trigger_node_id + ':' + slot). */
export function spawnedTaskId(ruleId: Uuid, triggerNodeId: Uuid, slot: number): Uuid {
  return uuidV5(`${ruleId}:${triggerNodeId}:${slot}`);
}

/** Deterministic id for the edge a slot's `edge_from_slot` produces. */
export function spawnedEdgeId(ruleId: Uuid, triggerNodeId: Uuid, slot: number): Uuid {
  return uuidV5(`${ruleId}:${triggerNodeId}:${slot}:edge`);
}

/** The instant every §9.3 computation on this trigger reads (never the wall clock). */
function triggerInstantIso(trigger: TriggerEvent): IsoDateTime {
  if (trigger.kind === 'task_completed' && trigger.node.completed_at !== null) {
    return trigger.node.completed_at;
  }
  return trigger.node.created_at;
}

export function runAutomations(input: RulesEngineInput): RulesEngineOutput {
  const enabledRules = input.rules
    .filter((rule) => rule.deleted_at === null && rule.enabled)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const spawnedNodes: Node[] = [];
  const spawnedEdges: Edge[] = [];
  const firedRuleIds: Uuid[] = [];
  const spawnedProvenance: SpawnProvenance[] = [];

  let queue: TriggerEvent[] = [input.trigger];
  let wave = 1;

  while (queue.length > 0 && wave <= MAX_DEPTH) {
    // Context for this wave: base rows + everything spawned so far.
    const ctx = buildFactContext({
      ...input.rows,
      nodes: [...input.rows.nodes, ...spawnedNodes],
      edges: [...(input.rows.edges ?? []), ...spawnedEdges],
    });
    const nextQueue: TriggerEvent[] = [];

    for (const trigger of queue) {
      const baseIso = triggerInstantIso(trigger);
      const baseInstant = isoToEpochMillis(baseIso);

      for (const rule of enabledRules) {
        if (rule.trigger !== trigger.kind) continue;
        // Unknown (offline-unverifiable) conditions do not fire — spawning is
        // the conservative direction here, unlike blockers (§9.2).
        if (evalPredicate(rule.conditions, trigger.node, ctx, baseInstant) !== 'true') {
          continue;
        }
        const parsedActions = automationActionsSchema.safeParse(rule.actions);
        if (!parsedActions.success) continue; // malformed stored rule: skip deterministically

        const actions = [...parsedActions.data].sort((a, b) => a.slot - b.slot);
        const slotOrders = sortOrdersBetween(null, null, actions.length);
        const nodeIdBySlot = new Map<number, Uuid>();
        let fired = false;

        actions.forEach((action: AutomationAction, index) => {
          const id = spawnedTaskId(rule.id, trigger.node.id, action.slot);
          nodeIdBySlot.set(action.slot, id);

          const existing =
            ctx.node(id) ?? spawnedNodes.find((n) => n.id === id);
          if (existing !== undefined) {
            // Replay: the row is already there. Still cascade through it so a
            // re-run completes partially-synced descendants (all dedupe).
            nextQueue.push({ kind: 'task_created', node: existing });
          } else {
            const template = action.template;
            const parentMode = template.parent ?? 'same_as_trigger';
            const node: Node = {
              id,
              user_id: trigger.node.user_id,
              created_at: baseIso,
              updated_at: baseIso,
              deleted_at: null,
              ...SYNC_ROW_DEFAULTS,
              parent_id:
                parentMode === 'same_as_trigger' ? trigger.node.parent_id : parentMode,
              node_type: 'task',
              title: interpolate(template.title, trigger.node),
              description:
                template.description === undefined
                  ? ''
                  : interpolate(template.description, trigger.node),
              sort_order: slotOrders[index]!,
              start_date: null,
              due_date:
                template.due === undefined
                  ? null
                  : resolveTriggerDate(template.due, trigger.node, ctx),
              estimate_minutes: template.estimate_minutes ?? null,
              completed_at: null,
              completion_disposition: null,
              completed_in_block_id: null,
              habit_id:
                parentMode === 'same_as_trigger' ? trigger.node.habit_id : null,
              attributes: {},
            };
            spawnedNodes.push(node);
            spawnedProvenance.push({ id, rule_id: rule.id, slot: action.slot });
            fired = true;
            nextQueue.push({ kind: 'task_created', node });
          }

          const fromSlot = action.template.edge_from_slot;
          if (fromSlot !== undefined) {
            const predecessorId = nodeIdBySlot.get(fromSlot) ??
              spawnedTaskId(rule.id, trigger.node.id, fromSlot);
            const successorId = id;
            const edgeExists =
              findEdgeBetween(ctx.edgeIndex, predecessorId, successorId) !== undefined ||
              spawnedEdges.some(
                (e) => e.predecessor_id === predecessorId && e.successor_id === successorId,
              );
            if (!edgeExists) {
              const edgeId = spawnedEdgeId(rule.id, trigger.node.id, action.slot);
              spawnedEdges.push({
                id: edgeId,
                user_id: trigger.node.user_id,
                created_at: baseIso,
                updated_at: baseIso,
                deleted_at: null,
                ...SYNC_ROW_DEFAULTS,
                predecessor_id: predecessorId,
                successor_id: successorId,
                edge_type: action.template.edge_type ?? 'FS',
                lag_minutes: action.template.lag_minutes ?? 0,
              });
              spawnedProvenance.push({ id: edgeId, rule_id: rule.id, slot: action.slot });
              fired = true;
            }
          }
        });

        if (fired) firedRuleIds.push(rule.id);
      }
    }

    queue = nextQueue;
    wave += 1;
  }

  // Triggers left after MAX_DEPTH waves were not executed. The flag is set
  // only when one of them would actually have fired a rule (precise, no
  // false alarm when the cascade merely *ended* on the last allowed wave).
  let depthLimited = false;
  if (queue.length > 0) {
    const ctx = buildFactContext({
      ...input.rows,
      nodes: [...input.rows.nodes, ...spawnedNodes],
      edges: [...(input.rows.edges ?? []), ...spawnedEdges],
    });
    depthLimited = queue.some((trigger) =>
      enabledRules.some(
        (rule) =>
          rule.trigger === trigger.kind &&
          evalPredicate(
            rule.conditions,
            trigger.node,
            ctx,
            isoToEpochMillis(triggerInstantIso(trigger)),
          ) === 'true',
      ),
    );
  }

  return { nodes: spawnedNodes, edges: spawnedEdges, firedRuleIds, depthLimited, provenance: spawnedProvenance };
}
