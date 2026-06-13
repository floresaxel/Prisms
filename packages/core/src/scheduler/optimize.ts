/**
 * Optimize scheduler (§10 soft objectives, §11 schedule.optimize). Runs a
 * deterministic stochastic local search over the greedy seed, exploring task
 * priorities (which the shared placer turns into feasible dependency orders),
 * keeping the best-scoring plan. Hard constraints are inherited from
 * placement.ts and never violated. Output is diffed against the current
 * committed plan — only changed blocks are emitted as suggestions (§2.6).
 *
 * Deterministic by construction: the only randomness is the injected Rng
 * (default: a fixed seed), so identical inputs ⇒ identical output, and the
 * server's nightly run matches what a client would compute (§10).
 */
import type { Uuid } from '../domain/primitives';
import { bucketDate, localInstant } from '../time/bucket';
import { addDays, daysBetween } from '../time/dates';
import { MS_PER_MINUTE } from '../time/duration';
import { createSeededRng, type Rng } from '../time/rng';

import {
  buildPlacementContext,
  placeWithPriority,
  type PlacementResult,
} from './placement';
import type {
  BlockProposal,
  ObjectiveWeights,
  SchedulableTask,
  SchedulerInput,
  SchedulerOutput,
} from './types';

export const DEFAULT_WEIGHTS: ObjectiveWeights = {
  dueDate: 2,
  sprint: 0.5,
  fragmentation: 0.2,
  dailyTarget: 1,
  unplaceable: 1_000_000,
};

const DEFAULT_SEED = 0x5c4ed;
const DEFAULT_ITERATIONS = 150;

/** Higher is better. Pure function of the placement + task metadata. */
function scoreProposals(
  proposals: readonly BlockProposal[],
  unplaceableCount: number,
  taskById: ReadonlyMap<Uuid, SchedulableTask>,
  weights: ObjectiveWeights,
  timezone: string,
  horizonFrom: number,
): number {
  let score = -weights.unplaceable * unplaceableCount;

  for (const p of proposals) {
    const task = taskById.get(p.taskId);
    if (!task) continue;
    const durationMin = (p.endsAt - p.startsAt) / MS_PER_MINUTE;

    if (task.dueDate) {
      // a block should end by the close of its due date (next local midnight)
      const dueEnd = localInstant(addDays(task.dueDate, 1), 0, timezone);
      const lateMin = Math.max(0, (p.endsAt - dueEnd) / MS_PER_MINUTE);
      score -= weights.dueDate * lateMin;
    }
    if (task.sprintMember) {
      score -= weights.sprint * ((p.startsAt - horizonFrom) / MS_PER_MINUTE);
    }
    if (task.dailyTargetMinutes && task.dailyTargetMinutes > 0) {
      score += weights.dailyTarget * Math.min(durationMin, task.dailyTargetMinutes);
    }
  }

  // fragmentation: idle gaps between consecutive same-day blocks
  const sorted = [...proposals].sort((a, b) => a.startsAt - b.startsAt);
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (
      cur.startsAt > prev.endsAt &&
      bucketDate(prev.endsAt, 0, timezone) === bucketDate(cur.startsAt, 0, timezone)
    ) {
      score -= weights.fragmentation * ((cur.startsAt - prev.endsAt) / MS_PER_MINUTE);
    }
  }
  return score;
}

/** Public scorer over a SchedulerOutput — used by callers and the regression suite. */
export function scorePlan(
  output: SchedulerOutput,
  input: SchedulerInput,
  weights: ObjectiveWeights = DEFAULT_WEIGHTS,
): number {
  const taskById = new Map(input.tasks.map((t) => [t.id, t]));
  return scoreProposals(
    output.proposals,
    output.unplaceable.length,
    taskById,
    weights,
    input.timezone,
    input.horizon.from,
  );
}

/** Uniform int in [0, bound) from the injected Rng. */
function rngInt(rng: Rng, bound: number): number {
  if (bound <= 1) return 0;
  const b = rng.randomBytes(4);
  const v = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  return v % bound;
}

export function scheduleOptimize(input: SchedulerInput): SchedulerOutput {
  const weights = { ...DEFAULT_WEIGHTS, ...input.optimize?.weights };
  const rng = input.optimize?.rng ?? createSeededRng(DEFAULT_SEED);
  const iterations = input.optimize?.iterations ?? DEFAULT_ITERATIONS;
  const ctx = buildPlacementContext(input);
  const taskById = new Map(input.tasks.map((t) => [t.id, t]));
  const tz = input.timezone;
  const horizonFrom = input.horizon.from;
  const score = (result: PlacementResult): number =>
    scoreProposals(result.proposals, result.unplaceable.length, taskById, weights, tz, horizonFrom);

  // seed 1: the greedy plan (all priorities equal → id order).
  const greedyPrio = new Map<Uuid, number>(ctx.schedulable.map((t) => [t.id, 0]));
  let best = placeWithPriority(ctx, () => 0);
  let bestPrio = greedyPrio;
  let bestScore = score(best);

  // seed 2: a due-date/sprint heuristic ordering.
  const horizonDate = bucketDate(horizonFrom, 0, tz);
  const heuristicPrio = new Map<Uuid, number>(
    ctx.schedulable.map((t) => {
      const dueRank = t.dueDate ? daysBetween(horizonDate, t.dueDate) : 100_000;
      return [t.id, dueRank - (t.sprintMember ? 1_000_000 : 0)];
    }),
  );
  const heuristic = placeWithPriority(ctx, (t) => heuristicPrio.get(t.id) ?? 0);
  const heuristicScore = score(heuristic);
  if (heuristicScore > bestScore) {
    best = heuristic;
    bestPrio = heuristicPrio;
    bestScore = heuristicScore;
  }

  // stochastic hill-climb: nudge one task's priority, accept non-worsening
  // moves as the new current, track the global best.
  let curPrio = new Map(bestPrio);
  let curScore = bestScore;
  const ids = ctx.schedulable.map((t) => t.id);
  for (let i = 0; i < iterations && ids.length > 0; i += 1) {
    const trialPrio = new Map(curPrio);
    const pick = ids[rngInt(rng, ids.length)]!;
    const delta = rngInt(rng, 2_001) - 1_000;
    trialPrio.set(pick, (trialPrio.get(pick) ?? 0) + delta);
    const trial = placeWithPriority(ctx, (t) => trialPrio.get(t.id) ?? 0);
    const trialScore = score(trial);
    if (trialScore >= curScore) {
      curPrio = trialPrio;
      curScore = trialScore;
      if (trialScore > bestScore) {
        best = trial;
        bestScore = trialScore;
      }
    }
  }

  // diff vs the current committed plan: only changed blocks become suggestions.
  const unchanged = new Set(
    input.committed
      .filter((b) => !b.anchored)
      .map((b) => `${b.taskId}|${b.startsAt}|${b.endsAt}`),
  );
  const proposals = best.proposals.filter(
    (p) => !unchanged.has(`${p.taskId}|${p.startsAt}|${p.endsAt}`),
  );
  return { proposals, unplaceable: best.unplaceable };
}
