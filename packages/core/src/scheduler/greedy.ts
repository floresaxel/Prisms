/**
 * Greedy scheduler (§10, client mode): earliest-fit placement in stable
 * topological order (id-tiebroken) — the deterministic seed the optimize
 * mode (S9) refines. Powers drag-to-agenda hints and single-task reschedule.
 * Hard constraints and placement live in placement.ts, shared with optimize.
 */
import type { Uuid } from '../domain/primitives';
import { MS_PER_MINUTE } from '../time/duration';

import { scheduleOptimize } from './optimize';
import {
  allowedWindows,
  buildPlacementContext,
  committedSpans,
  earliestFromDeps,
  placeWithPriority,
} from './placement';
import type {
  BlockProposal,
  Interval,
  SchedulableTask,
  SchedulerInput,
  SchedulerOutput,
  Unplaceable,
} from './types';
import { expandWindows, freeRegions } from './windows';

export function scheduleGreedy(input: SchedulerInput): SchedulerOutput {
  const ctx = buildPlacementContext(input);
  const { proposals, unplaceable } = placeWithPriority(ctx, () => 0);
  return { proposals, unplaceable };
}

/**
 * Drag-to-agenda hint (§10): the free regions where `task` could be dropped,
 * given everything else committed. Unlike `scheduleGreedy` (one earliest-fit
 * proposal) this returns ALL valid regions so the UI can highlight them.
 */
export function validWindowsFor(task: SchedulableTask, input: SchedulerInput): Interval[] {
  if (task.done || !(task.estimateMinutes > 0)) return [];
  const durationMs = task.estimateMinutes * MS_PER_MINUTE;
  const occupied: Interval[] = input.committed
    .filter((b) => b.anchored || b.taskId !== task.id)
    .map((b) => ({ start: b.startsAt, end: b.endsAt }))
    .sort((a, b) => a.start - b.start);
  const allWindows = expandWindows(input.windows, input.timezone, input.horizon);
  const windows = allowedWindows(task, allWindows);
  const { earliest } = earliestFromDeps(
    task,
    durationMs,
    new Map(),
    committedSpans(input),
    new Set(),
    new Set(),
    input.horizon.from,
  );
  return freeRegions(windows, occupied, earliest, durationMs);
}

/**
 * Single-task reschedule entry point (§10): re-place one task earliest-fit.
 * Returns the proposal, or the reason it cannot be placed.
 */
export function rescheduleTask(
  taskId: Uuid,
  input: SchedulerInput,
): BlockProposal | Unplaceable {
  const task = input.tasks.find((t) => t.id === taskId);
  if (!task) return { taskId, reason: 'no_estimate' };
  const out = scheduleGreedy({ ...input, tasks: [task], mode: 'greedy' });
  return out.proposals[0] ?? out.unplaceable[0]!;
}

/** Mode dispatcher (§10): client greedy, server optimize (§11 schedule.optimize). */
export function schedule(input: SchedulerInput): SchedulerOutput {
  return input.mode === 'optimize' ? scheduleOptimize(input) : scheduleGreedy(input);
}
