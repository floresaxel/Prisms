/**
 * Justification — invariant I3 and the §12.2 rendering check.
 *
 * Two related but distinct questions:
 *
 * - `validateTaskJustification` (I3, command-time): a task has exactly one
 *   justification — an ancestor PROJECT xor `habit_id`. Activities are
 *   exempt until promoted.
 *
 * - `isJustified` (§12.2, render-time): does the node's ancestry reach a
 *   VISION (or is it habit-linked)? Calendar blocks of unjustified tasks
 *   render dark grey. A task can satisfy I3 yet be unjustified for
 *   rendering — e.g. its project subtree was detached from any vision by
 *   offline edits elsewhere.
 */
import type { Node } from '../domain/entities';
import { domainError } from '../domain/errors';
import type { Uuid } from '../domain/primitives';
import { err, ok, type Result } from '../domain/result';
import { ancestorsOf, getNode, type TreeIndex } from './tree';

/** §12.2: ancestry reaches a vision, or the node is habit-linked. */
export function isJustified(index: TreeIndex, nodeId: Uuid): boolean {
  const node = getNode(index, nodeId);
  if (node === undefined) return false;
  if (node.habit_id !== null) return true;
  if (node.node_type === 'vision') return true;
  return ancestorsOf(index, nodeId).some((a) => a.node_type === 'vision');
}

function reachesProject(index: TreeIndex, startId: Uuid): boolean {
  const start = getNode(index, startId);
  if (start === undefined) return false;
  if (start.node_type === 'project') return true;
  return ancestorsOf(index, startId).some((a) => a.node_type === 'project');
}

/**
 * I3 for `node.create` / `node.move` / `activity.promote`. Pass the
 * candidate field values (for a move, the node with its NEW parent_id).
 */
export function validateTaskJustification(
  index: TreeIndex,
  candidate: Pick<Node, 'node_type' | 'parent_id' | 'habit_id'>,
): Result<void> {
  if (candidate.node_type !== 'task') return ok(undefined); // activities exempt until promoted
  const viaHabit = candidate.habit_id !== null;
  const viaProject =
    candidate.parent_id !== null && reachesProject(index, candidate.parent_id);
  if (viaHabit && viaProject) {
    return err(
      domainError(
        'E_JUSTIFICATION',
        'a task cannot have both an ancestor project and a habit_id (I3)',
      ),
    );
  }
  if (!viaHabit && !viaProject) {
    return err(
      domainError(
        'E_JUSTIFICATION',
        'a task needs exactly one justification: an ancestor project or a habit_id (I3)',
      ),
    );
  }
  return ok(undefined);
}
