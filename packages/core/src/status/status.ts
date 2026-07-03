/**
 * The status function (§7.1) — normative algorithm, implemented exactly.
 *
 * Statuses are never stored; this derives them from facts on every read
 * (microseconds, §12.2). Precedence is exactly:
 * done > ongoing > blocked > scheduled > prioritized > available.
 *
 * Completing a predecessor therefore unblocks successors instantly and
 * offline with no rule firing and no write to the successor (R4).
 */
import type { Node } from '../domain/entities';
import { incomingEdges } from '../graph/dag';
import { getNode } from '../graph/tree';
import { addMinutes } from '../time/duration';
import type { Instant } from '../time/instant';

import type { FactContext } from './context';
import { evaluateBlockerRules, type PredicateInterpolation } from './predicate';

export type TaskStatus =
  | 'done'
  | 'ongoing'
  | 'blocked'
  | 'scheduled'
  | 'prioritized'
  | 'available';

/** Highest first. */
export const STATUS_PRECEDENCE: readonly TaskStatus[] = [
  'done',
  'ongoing',
  'blocked',
  'scheduled',
  'prioritized',
  'available',
];

/**
 * Dependency gate (§7.1 isBlocked part a).
 * FS: predecessor must be complete. SS: predecessor must have started (any
 * entry) or be complete. FF/SF gate completion/scheduling, not availability.
 * A positive lag holds the successor until completed_at + lag.
 * Dangling/deleted predecessors cannot block (their obligations died with
 * them — soft-delete semantics).
 */
export function dependencyBlocked(
  task: Node,
  ctx: FactContext,
  now: Instant,
): boolean {
  for (const edge of incomingEdges(ctx.edgeIndex, task.id)) {
    const predecessor = getNode(ctx.tree, edge.predecessor_id);
    if (!predecessor) continue;
    switch (edge.edge_type) {
      case 'FS':
        if (predecessor.completed_at === null) return true;
        break;
      case 'SS': {
        const started = ctx.hasAnyEntry(predecessor.id) || predecessor.completed_at !== null;
        if (!started) return true;
        // §7.6: SS blocks availability until the predecessor's START + lag. When
        // it has started but not completed, gate on the earliest start; a
        // completed predecessor is handled by the uniform completed_at + lag
        // clause below (which the spec applies uniformly — status.test).
        if (
          edge.lag_minutes > 0 &&
          predecessor.completed_at === null
        ) {
          const startedAt = ctx.earliestEntryStart(predecessor.id);
          if (startedAt !== undefined && now < addMinutes(startedAt, edge.lag_minutes)) {
            return true;
          }
        }
        break;
      }
      case 'FF':
      case 'SF':
        break;
    }
    if (
      edge.lag_minutes > 0 &&
      predecessor.completed_at !== null &&
      now < addMinutes(predecessor.completed_at, edge.lag_minutes)
    ) {
      return true;
    }
  }
  return false;
}

/** §7.1 isBlocked: dependency gate, then declarative blocker rules (§9.2). */
export function isBlocked(
  task: Node,
  ctx: FactContext,
  now: Instant,
  interp: PredicateInterpolation = {},
): boolean {
  if (dependencyBlocked(task, ctx, now)) return true;
  return evaluateBlockerRules(task, ctx, now, interp).blocked;
}

/**
 * Acceptance-safe blocked check (§10.3, R19/V10) — the variant a command
 * applier (server dispatcher, client pre-flight) MUST use to decide whether to
 * reject `timer.clock_in` on a blocked task. Identical to `isBlocked` EXCEPT it
 * excludes blocker rules that read an external fact (weather): external-fact
 * state is advisory and must never cause a command to be rejected or diverge.
 *
 * Consequence (define consistently so two devices converge, §8): a task blocked
 * ONLY by weather clocks in WITHOUT `force`; a task blocked by a dependency or a
 * non-external blocker rule still requires `force`. The display path
 * (`taskStatus`, badges) keeps the full evaluation, so weather still shows the
 * task blocked / "unverified".
 */
export function isBlockedForAcceptance(
  task: Node,
  ctx: FactContext,
  now: Instant,
  interp: PredicateInterpolation = {},
): boolean {
  if (dependencyBlocked(task, ctx, now)) return true;
  return evaluateBlockerRules(task, ctx, now, interp, { excludeExternalFacts: true }).blocked;
}

/** §7.1 taskStatus — the exact normative sequence. */
export function taskStatus(task: Node, ctx: FactContext, now: Instant): TaskStatus {
  if (task.completed_at !== null) return 'done';
  if (ctx.openEntryFor(task.id) !== undefined) return 'ongoing';
  if (isBlocked(task, ctx, now)) return 'blocked';
  if (ctx.hasCommittedBlockAtOrAfter(task.id, now)) return 'scheduled';
  if (ctx.inActiveSprint(task.id, now)) return 'prioritized';
  return 'available';
}
