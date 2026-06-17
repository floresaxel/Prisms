/**
 * Project completion % (§7.2): weighted by estimate_minutes (fallback weight
 * 1) over descendant tasks' completed_at.
 *
 * Obsolete tasks (completed_at set, completion_disposition='obsolete') are
 * descoped: they leave the denominator entirely (neither completed nor total),
 * so an obsoleted task doesn't drag a project toward looking incomplete.
 */
import type { Node } from '../domain/entities';
import type { Uuid } from '../domain/primitives';
import { descendantsOf, type TreeIndex } from '../graph/tree';

export interface CompletionValue {
  completedWeight: number;
  totalWeight: number;
  /** 0 when the project has no tasks. */
  percent: number;
}

export function taskWeight(task: Node): number {
  return task.estimate_minutes ?? 1;
}

function withDerived(completedWeight: number, totalWeight: number): CompletionValue {
  return {
    completedWeight,
    totalWeight,
    percent: totalWeight > 0 ? (completedWeight / totalWeight) * 100 : 0,
  };
}

export function canonicalCompletion(projectId: Uuid, tree: TreeIndex): CompletionValue {
  let total = 0;
  let completed = 0;
  for (const node of descendantsOf(tree, projectId)) {
    if (node.node_type !== 'task') continue;
    if (node.completion_disposition === 'obsolete') continue; // descoped: out of the denominator
    const weight = taskWeight(node);
    total += weight;
    if (node.completed_at !== null) completed += weight;
  }
  return withDerived(completed, total);
}

/** A completion-state transition for a task already counted in totalWeight. */
export interface CompletionToggle {
  weight: number;
  completed: boolean;
}

export function incrementalCompletion(
  prev: CompletionValue,
  toggle: CompletionToggle,
): CompletionValue {
  const delta = toggle.completed ? toggle.weight : -toggle.weight;
  return withDerived(prev.completedWeight + delta, prev.totalWeight);
}
