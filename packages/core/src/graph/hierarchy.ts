/**
 * Hierarchy typing — invariants I1 and I2 (ARCHITECTURE.md §6.7).
 *
 * I1: parent of roadmap=vision, project=roadmap, milestone=project,
 *     task=milestone or project; `activity` has no parent. Tasks may also be
 *     parentless (habit-spawned) — whether that is *justified* is I3's job
 *     (see justify.ts), not a typing concern.
 *
 * Because every legal parent type sits strictly closer to the vision root
 * than its child type, a fully I1-valid tree can never contain a parent
 * cycle; `validateNodeMove` still guards the move endpoint explicitly so a
 * single command can never introduce one.
 */
import type { NodeType } from '../domain/entities';
import { domainError } from '../domain/errors';
import type { Uuid } from '../domain/primitives';
import { err, ok, type Result } from '../domain/result';
import { getNode, subtreeOf, type TreeIndex } from './tree';

/** I1 matrix: which parent types are legal for each child type. */
export const ALLOWED_PARENT_TYPES: Record<NodeType, readonly NodeType[]> = {
  vision: [],
  roadmap: ['vision'],
  project: ['roadmap'],
  milestone: ['project'],
  task: ['milestone', 'project'],
  activity: [],
};

/** I1 matrix: which child types may have parent_id = NULL. */
export const PARENTLESS_ALLOWED: Record<NodeType, boolean> = {
  vision: true,
  roadmap: false,
  project: false,
  milestone: false,
  task: true, // habit-spawned tasks; I3 enforces the habit_id xor
  activity: true,
};

/** I2: max non-deleted vision nodes per user. */
export const MAX_VISIONS = 4;

/**
 * I1 for `node.create` / `node.retype` / `node.move`: is `parentId` a legal
 * parent for a node of type `childType`?
 */
export function validateNodeParent(
  index: TreeIndex,
  childType: NodeType,
  parentId: Uuid | null,
): Result<void> {
  if (parentId === null) {
    if (PARENTLESS_ALLOWED[childType]) return ok(undefined);
    return err(
      domainError(
        'E_HIERARCHY',
        `a ${childType} requires a ${ALLOWED_PARENT_TYPES[childType].join(' or ')} parent (I1)`,
      ),
    );
  }
  const parent = getNode(index, parentId);
  if (parent === undefined) {
    return err(domainError('E_NOT_FOUND', `parent ${parentId} does not exist`));
  }
  if (!ALLOWED_PARENT_TYPES[childType].includes(parent.node_type)) {
    return err(
      domainError(
        'E_HIERARCHY',
        ALLOWED_PARENT_TYPES[childType].length === 0
          ? `a ${childType} cannot have a parent (I1)`
          : `a ${childType} cannot be a child of a ${parent.node_type} (I1)`,
      ),
    );
  }
  return ok(undefined);
}

/**
 * I1 for `node.move`: typing plus the endpoint guards (no self-parenting,
 * no moving a node underneath its own subtree).
 */
export function validateNodeMove(
  index: TreeIndex,
  nodeId: Uuid,
  newParentId: Uuid | null,
): Result<void> {
  const node = getNode(index, nodeId);
  if (node === undefined) {
    return err(domainError('E_NOT_FOUND', `node ${nodeId} does not exist`));
  }
  if (newParentId !== null) {
    if (newParentId === nodeId) {
      return err(domainError('E_HIERARCHY', 'a node cannot be its own parent (I1)'));
    }
    if (subtreeOf(index, nodeId).some((n) => n.id === newParentId)) {
      return err(
        domainError(
          'E_HIERARCHY',
          'a node cannot be moved under its own descendant (I1)',
        ),
      );
    }
  }
  return validateNodeParent(index, node.node_type, newParentId);
}

/** Live vision count (the index only holds live rows). */
export function countVisions(index: TreeIndex): number {
  let count = 0;
  for (const node of index.byId.values()) {
    if (node.node_type === 'vision') count += 1;
  }
  return count;
}

/** I2 for creating (or retyping into) a vision. */
export function validateVisionLimit(index: TreeIndex): Result<void> {
  if (countVisions(index) >= MAX_VISIONS) {
    return err(
      domainError('E_MAX_VISIONS', `at most ${MAX_VISIONS} visions per user (I2)`),
    );
  }
  return ok(undefined);
}
