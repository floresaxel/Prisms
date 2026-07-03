/**
 * Command invariant checks (§6.7) — the SAME pure functions the client runs
 * offline and the server re-runs on upload (§8 step 3). Each takes the
 * already-loaded fact set (built by the caller from local SQLite or Postgres)
 * plus the parsed payload, and returns Result<void, DomainError> with the
 * machine-readable code the API surfaces.
 *
 * Graph/typing invariants delegate to the S4 validators; rule self-trigger to
 * the S7 validator. What lives here is the per-command wiring: which checks a
 * verb runs and against which candidate values.
 */
import type { AutomationRule, Node, NodeType } from '../domain/entities';
import { domainError } from '../domain/errors';
import { minutesBetween, MS_PER_MINUTE } from '../time/duration';
import type { IsoDateTime, Uuid } from '../domain/primitives';
import { err, ok, type Result } from '../domain/result';
import { isoToEpochMillis, type Instant } from '../time/instant';
import { incomingEdges, validateEdge, type EdgeIndex } from '../graph/dag';
import type { FactContext } from '../status/context';
import {
  ALLOWED_PARENT_TYPES,
  validateNodeMove,
  validateNodeParent,
  validateVisionLimit,
} from '../graph/hierarchy';
import { validateTaskJustification } from '../graph/justify';
import { getNode, type TreeIndex } from '../graph/tree';
import { validateAutomationRule, type RuleCandidate } from '../rules/validate';

const notFound = (kind: string, id: Uuid): Result<void> =>
  err(domainError('E_NOT_FOUND', `${kind} ${id} does not exist`));

const doneImmutable = (id: Uuid): Result<void> =>
  err(domainError('E_DONE_IMMUTABLE', `task ${id} is done and cannot be scheduled or clocked into (I8)`));

const badInterval = err(
  domainError('E_INVALID_INTERVAL', 'ends_at must be after starts_at (I6)'),
);

// --- nodes ------------------------------------------------------------------

export function checkNodeCreate(
  tree: TreeIndex,
  payload: {
    node_type: NodeType;
    parent_id?: Uuid | null;
    habit_id?: Uuid | null;
  },
): Result<void> {
  const parentId = payload.parent_id ?? null;
  const habitId = payload.habit_id ?? null;
  if (payload.node_type === 'vision') {
    const limit = validateVisionLimit(tree);
    if (!limit.ok) return limit;
  }
  const typing = validateNodeParent(tree, payload.node_type, parentId);
  if (!typing.ok) return typing;
  return validateTaskJustification(tree, {
    node_type: payload.node_type,
    parent_id: parentId,
    habit_id: habitId,
  });
}

export function checkNodeMove(
  tree: TreeIndex,
  payload: { id: Uuid; new_parent_id: Uuid | null },
): Result<void> {
  const node = getNode(tree, payload.id);
  if (!node) return notFound('node', payload.id);
  // I1: typing + endpoint guards (no self/descendant parent).
  const move = validateNodeMove(tree, payload.id, payload.new_parent_id);
  if (!move.ok) return move;
  // I3: re-justify the moved node against its NEW parent.
  return validateTaskJustification(tree, {
    node_type: node.node_type,
    parent_id: payload.new_parent_id,
    habit_id: node.habit_id,
  });
}

export function checkNodeRetype(
  tree: TreeIndex,
  payload: { id: Uuid; node_type: NodeType },
): Result<void> {
  const node = getNode(tree, payload.id);
  if (!node) return notFound('node', payload.id);
  if (node.node_type === payload.node_type) return ok(undefined);
  // I2 when promoting into a vision (the node is not yet counted as one).
  if (payload.node_type === 'vision') {
    const limit = validateVisionLimit(tree);
    if (!limit.ok) return limit;
  }
  // I1: the node's own parent must accept the new type…
  const ownTyping = validateNodeParent(tree, payload.node_type, node.parent_id);
  if (!ownTyping.ok) return ownTyping;
  // …and every existing child must still accept it as their parent (§8: orphaning
  // a child type is its own machine-readable rejection).
  for (const child of tree.childrenByParent.get(node.id) ?? []) {
    if (!ALLOWED_PARENT_TYPES[child.node_type].includes(payload.node_type)) {
      return err(
        domainError(
          'E_INVALID_RETYPE_CHILDREN',
          `retyping to ${payload.node_type} would orphan a ${child.node_type} child (I1)`,
        ),
      );
    }
  }
  // I3 when the result is a task.
  if (payload.node_type === 'task') {
    return validateTaskJustification(tree, {
      node_type: 'task',
      parent_id: node.parent_id,
      habit_id: node.habit_id,
    });
  }
  return ok(undefined);
}

export function checkActivityPromote(
  tree: TreeIndex,
  payload: { id: Uuid; parent_id?: Uuid; habit_id?: Uuid },
): Result<void> {
  const node = getNode(tree, payload.id);
  if (!node) return notFound('activity', payload.id);
  if (node.node_type !== 'activity') {
    return err(domainError('E_HIERARCHY', `node ${payload.id} is not an activity`));
  }
  const parentId = payload.parent_id ?? null;
  const habitId = payload.habit_id ?? null;
  // a promoted activity becomes a task: I1 parent typing + I3 justification.
  const typing = validateNodeParent(tree, 'task', parentId);
  if (!typing.ok) return typing;
  return validateTaskJustification(tree, { node_type: 'task', parent_id: parentId, habit_id: habitId });
}

// --- edges ------------------------------------------------------------------

export function checkEdgeCreate(
  tree: TreeIndex,
  edges: EdgeIndex,
  payload: { predecessor_id: Uuid; successor_id: Uuid },
): Result<void> {
  return validateEdge(tree, edges, payload);
}

// --- blocks -----------------------------------------------------------------

function intervalOk(starts: IsoDateTime, ends: IsoDateTime): boolean {
  return minutesBetween(starts, ends) > 0;
}

export function checkBlockCreate(
  task: Node | undefined,
  taskId: Uuid,
  payload: { starts_at: IsoDateTime; ends_at: IsoDateTime },
): Result<void> {
  if (!task) return notFound('task', taskId);
  if (task.completed_at !== null) return doneImmutable(taskId); // I8
  if (!intervalOk(payload.starts_at, payload.ends_at)) return badInterval; // I6
  return ok(undefined);
}

export function checkBlockMove(
  block: { anchor_type: string; task_id: Uuid } | undefined,
  blockId: Uuid,
  task: Node | undefined,
  payload: { starts_at: IsoDateTime; ends_at: IsoDateTime },
): Result<void> {
  if (!block) return notFound('block', blockId);
  if (block.anchor_type !== 'none') {
    return err(domainError('E_ANCHORED_IMMUTABLE', 'an anchored block cannot be moved (I7)'));
  }
  if (task && task.completed_at !== null) return doneImmutable(block.task_id); // I8
  if (!intervalOk(payload.starts_at, payload.ends_at)) return badInterval; // I6
  return ok(undefined);
}

// --- completion gates (§7.6, the completion surface of edge semantics) ------

/**
 * §7.6 completion: a task cannot be completed while a dependency requirement is
 * unmet. FS and FF require the predecessor COMPLETED (+ lag); SF requires it
 * STARTED. SS gates availability, not completion. A dangling/deleted
 * predecessor cannot block (its obligation died with it). The error identifies
 * the blocking edge type and predecessor.
 */
export function checkCompletion(
  task: Node,
  ctx: FactContext,
  now: Instant,
): Result<void> {
  const blocked = (edgeType: string, predId: Uuid): Result<void> =>
    err(
      domainError(
        'E_COMPLETION_BLOCKED',
        `cannot complete ${task.id}: ${edgeType} predecessor ${predId} requirement unmet (§7.6)`,
        { edge_type: edgeType, predecessor_id: predId },
      ),
    );
  for (const edge of incomingEdges(ctx.edgeIndex, task.id)) {
    const pred = getNode(ctx.tree, edge.predecessor_id);
    if (!pred) continue;
    const lagMs = edge.lag_minutes * MS_PER_MINUTE;
    switch (edge.edge_type) {
      case 'FS':
      case 'FF':
        if (pred.completed_at === null) return blocked(edge.edge_type, pred.id);
        if (now < isoToEpochMillis(pred.completed_at) + lagMs) return blocked(edge.edge_type, pred.id);
        break;
      case 'SF': {
        // "started" = any time entry exists, or the predecessor is complete (§7.6).
        if (!ctx.hasAnyEntry(pred.id) && pred.completed_at === null) return blocked(edge.edge_type, pred.id);
        // §7.6: SF blocks completion until the predecessor's START + lag. Gate on
        // the earliest recorded start when an entry exists; a lag-less SF is
        // satisfied by any start (above).
        if (edge.lag_minutes > 0) {
          const startedAt = ctx.earliestEntryStart(pred.id);
          if (startedAt !== undefined && now < startedAt + lagMs) return blocked(edge.edge_type, pred.id);
        }
        break;
      }
      case 'SS':
        break;
    }
  }
  return ok(undefined);
}

// --- time tracking ----------------------------------------------------------

export function checkClockIn(
  task: Node | undefined,
  taskId: Uuid,
  hasOpenEntry: boolean,
): Result<void> {
  if (!task) return notFound('task', taskId);
  if (task.completed_at !== null) return doneImmutable(taskId); // I8
  if (hasOpenEntry) {
    // I5: at most one open entry per user (the §7.4 merge resolves genuine
    // offline races; a same-device second clock-in is a straight rejection).
    return err(domainError('E_TIMER_ALREADY_RUNNING', 'another timer is already running (I5)'));
  }
  return ok(undefined);
}

export function checkClockOut(
  entry: { started_at: IsoDateTime; ended_at: IsoDateTime | null } | undefined,
  entryId: Uuid,
  payload: { ended_at: IsoDateTime },
): Result<void> {
  if (!entry) return notFound('time entry', entryId);
  if (entry.ended_at !== null) {
    return err(domainError('E_TIMER_NOT_RUNNING', `time entry ${entryId} is already closed`));
  }
  if (!intervalOk(entry.started_at, payload.ended_at)) return badInterval; // I6
  return ok(undefined);
}

// --- habits -----------------------------------------------------------------

export function checkHabitVision(tree: TreeIndex, visionId: Uuid): Result<void> {
  const vision = getNode(tree, visionId);
  if (!vision) return notFound('vision', visionId);
  if (vision.node_type !== 'vision') {
    return err(domainError('E_HIERARCHY', `habit must reference a vision, not a ${vision.node_type}`));
  }
  return ok(undefined);
}

// --- automation rules -------------------------------------------------------

export function checkRule(
  candidate: RuleCandidate,
  existingRules: readonly AutomationRule[],
): Result<void> {
  return validateAutomationRule(candidate, existingRules);
}
