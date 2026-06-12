/**
 * Project phase derivation (§7.1): a project's phase aggregates its
 * descendant tasks' execution signals.
 *
 * `completed` — every task done (non-empty) · `executing` — any task ongoing
 * or done · `planned` — any task scheduled · `idle` — otherwise (including
 * projects with no tasks yet).
 *
 * Deliberately rule-free: phase only reads completion facts, open entries and
 * committed blocks — never blocker rules. Blocker rules may reference
 * `project.phase` (§9.2), so deriving phase from rule-dependent statuses
 * would recurse; deriving it from execution facts terminates by construction
 * and matches the product meaning ("has work happened / is work booked").
 */
import type { Node } from '../domain/entities';
import type { Uuid } from '../domain/primitives';
import { descendantsOf } from '../graph/tree';
import type { Instant } from '../time/instant';

import type { FactContext } from './context';

export type ProjectPhase = 'completed' | 'executing' | 'planned' | 'idle';

export function projectPhase(
  projectId: Uuid,
  ctx: FactContext,
  now: Instant,
): ProjectPhase {
  const tasks = descendantsOf(ctx.tree, projectId).filter(
    (n: Node) => n.node_type === 'task',
  );
  if (tasks.length === 0) return 'idle';

  let allDone = true;
  let anyDoneOrOngoing = false;
  let anyScheduled = false;
  for (const task of tasks) {
    const done = task.completed_at !== null;
    if (!done) allDone = false;
    if (done || ctx.openEntryFor(task.id) !== undefined) {
      anyDoneOrOngoing = true;
    } else if (ctx.hasCommittedBlockAtOrAfter(task.id, now)) {
      anyScheduled = true;
    }
  }

  if (allDone) return 'completed';
  if (anyDoneOrOngoing) return 'executing';
  if (anyScheduled) return 'planned';
  return 'idle';
}
