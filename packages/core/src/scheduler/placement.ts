/**
 * Shared placement core for both scheduler modes (§10). Greedy and optimize
 * differ only in the task *priority* they feed the topological placer; the
 * earliest-fit machinery, obstacle handling, and hard-constraint guarantees
 * (anchored never moved/overlapped I7/I9, dependency order+lag, windows, done
 * exclusion I8) live here and are identical for both.
 */
import type { Uuid } from '../domain/primitives';
import { MS_PER_MINUTE } from '../time/duration';
import type { EpochMillis } from '../time/instant';

import type {
  BlockProposal,
  Interval,
  SchedulableTask,
  SchedulerInput,
  Unplaceable,
} from './types';
import { earliestFit, expandWindows, insertSorted, type ConcreteWindow } from './windows';

export const cmpId = (a: Uuid, b: Uuid): number => (a < b ? -1 : a > b ? 1 : 0);

export function allowedWindows(
  task: SchedulableTask,
  all: readonly ConcreteWindow[],
): ConcreteWindow[] {
  const ids = task.allowedWindowIds;
  if (!ids || ids.length === 0) return [...all];
  const set = new Set(ids);
  return all.filter((w) => set.has(w.windowId));
}

/**
 * Kahn topological sort over in-batch dependencies. The ready-queue and
 * successor processing pick the lowest `priorityOf` value first, ties broken
 * by id — so every result is a valid dependency order, and equal priorities
 * reproduce the deterministic greedy id-order. Optimize searches over
 * priorities; the produced order is always feasible by construction.
 */
export function topoOrder(
  tasks: readonly SchedulableTask[],
  priorityOf: (task: SchedulableTask) => number = () => 0,
): { order: SchedulableTask[]; cyclic: Uuid[] } {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const priority = new Map<Uuid, number>(tasks.map((t) => [t.id, priorityOf(t)]));
  const cmp = (a: Uuid, b: Uuid): number =>
    (priority.get(a)! - priority.get(b)!) || cmpId(a, b);

  const indegree = new Map<Uuid, number>(tasks.map((t) => [t.id, 0]));
  const successors = new Map<Uuid, Uuid[]>();
  for (const task of tasks) {
    const preds = new Set<Uuid>();
    for (const dep of task.dependencies ?? []) {
      if (byId.has(dep.predecessorId) && dep.predecessorId !== task.id) {
        preds.add(dep.predecessorId);
      }
    }
    for (const pred of preds) {
      indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1);
      const list = successors.get(pred);
      if (list) list.push(task.id);
      else successors.set(pred, [task.id]);
    }
  }

  const ready = tasks
    .filter((t) => (indegree.get(t.id) ?? 0) === 0)
    .map((t) => t.id)
    .sort(cmp);
  const order: SchedulableTask[] = [];
  const emitted = new Set<Uuid>();

  while (ready.length > 0) {
    const id = ready.shift()!;
    emitted.add(id);
    order.push(byId.get(id)!);
    for (const succ of (successors.get(id) ?? []).slice().sort(cmp)) {
      const next = (indegree.get(succ) ?? 0) - 1;
      indegree.set(succ, next);
      if (next === 0) {
        let lo = 0;
        let hi = ready.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (cmp(ready[mid]!, succ) < 0) lo = mid + 1;
          else hi = mid;
        }
        ready.splice(lo, 0, succ);
      }
    }
  }
  const cyclic = tasks.filter((t) => !emitted.has(t.id)).map((t) => t.id).sort(cmpId);
  return { order, cyclic };
}

/** min start / max end across a task's committed blocks — the dependency anchor. */
export function committedSpans(input: SchedulerInput): Map<Uuid, Interval> {
  const spans = new Map<Uuid, Interval>();
  for (const block of input.committed) {
    const existing = spans.get(block.taskId);
    if (!existing) {
      spans.set(block.taskId, { start: block.startsAt, end: block.endsAt });
    } else {
      existing.start = Math.min(existing.start, block.startsAt);
      existing.end = Math.max(existing.end, block.endsAt);
    }
  }
  return spans;
}

export function earliestFromDeps(
  task: SchedulableTask,
  durationMs: number,
  placement: ReadonlyMap<Uuid, Interval>,
  committed: ReadonlyMap<Uuid, Interval>,
  inBatch: ReadonlySet<Uuid>,
  unplaceable: ReadonlySet<Uuid>,
  floor: number,
): { earliest: number; blocked: boolean } {
  let earliest = floor;
  if (task.notBefore !== undefined) earliest = Math.max(earliest, task.notBefore);
  for (const dep of task.dependencies ?? []) {
    const span = placement.get(dep.predecessorId) ?? committed.get(dep.predecessorId);
    if (!span) {
      if (inBatch.has(dep.predecessorId) && unplaceable.has(dep.predecessorId)) {
        return { earliest, blocked: true };
      }
      continue;
    }
    const lag = dep.lagMinutes * MS_PER_MINUTE;
    let bound: number;
    switch (dep.edgeType) {
      case 'FS':
        bound = span.end + lag;
        break;
      case 'SS':
        bound = span.start + lag;
        break;
      case 'FF':
        bound = span.end + lag - durationMs;
        break;
      case 'SF':
        bound = span.start + lag - durationMs;
        break;
    }
    if (bound > earliest) earliest = bound;
  }
  return { earliest, blocked: false };
}

/** Static inputs to a local-search run: computed once, reused across placements. */
export interface PlacementContext {
  input: SchedulerInput;
  schedulable: SchedulableTask[];
  occupiedSeed: Interval[];
  allWindows: ConcreteWindow[];
  committed: Map<Uuid, Interval>;
  scheduledIds: Set<Uuid>;
  triage: Unplaceable[];
}

export function buildPlacementContext(input: SchedulerInput): PlacementContext {
  const triage: Unplaceable[] = [];
  const schedulable: SchedulableTask[] = [];
  for (const task of input.tasks) {
    if (task.done) triage.push({ taskId: task.id, reason: 'done' });
    else if (!(task.estimateMinutes > 0)) triage.push({ taskId: task.id, reason: 'no_estimate' });
    else schedulable.push(task);
  }
  const scheduledIds = new Set(schedulable.map((t) => t.id));
  const occupiedSeed: Interval[] = input.committed
    .filter((b) => b.anchored || !scheduledIds.has(b.taskId))
    .map((b) => ({ start: b.startsAt, end: b.endsAt }))
    .sort((a, b) => a.start - b.start);
  return {
    input,
    schedulable,
    occupiedSeed,
    allWindows: expandWindows(input.windows, input.timezone, input.horizon),
    committed: committedSpans(input),
    scheduledIds,
    triage,
  };
}

export interface PlacementResult {
  proposals: BlockProposal[];
  unplaceable: Unplaceable[];
  placement: Map<Uuid, Interval>;
}

/** Place the context's schedulable tasks in `priorityOf` order, earliest-fit. */
export function placeWithPriority(
  ctx: PlacementContext,
  priorityOf: (task: SchedulableTask) => number,
): PlacementResult {
  const proposals: BlockProposal[] = [];
  const unplaceable: Unplaceable[] = [...ctx.triage];
  const unplaceableIds = new Set<Uuid>(unplaceable.map((u) => u.taskId));
  const reject = (taskId: Uuid, reason: Unplaceable['reason']) => {
    unplaceable.push({ taskId, reason });
    unplaceableIds.add(taskId);
  };

  const { order, cyclic } = topoOrder(ctx.schedulable, priorityOf);
  for (const id of cyclic) reject(id, 'dependency_cycle');

  const occupied = ctx.occupiedSeed.slice();
  const placement = new Map<Uuid, Interval>();
  for (const task of order) {
    if (unplaceableIds.has(task.id)) continue;
    const durationMs = task.estimateMinutes * MS_PER_MINUTE;
    const { earliest, blocked } = earliestFromDeps(
      task,
      durationMs,
      placement,
      ctx.committed,
      ctx.scheduledIds,
      unplaceableIds,
      ctx.input.horizon.from,
    );
    if (blocked) {
      reject(task.id, 'dependency_unplaceable');
      continue;
    }
    const windows = allowedWindows(task, ctx.allWindows);
    if (windows.length === 0 || windows.every((w) => w.end - w.start < durationMs)) {
      reject(task.id, 'no_window_fits');
      continue;
    }
    const start = earliestFit(windows, occupied, earliest, durationMs);
    if (start === null) {
      reject(task.id, 'horizon_full');
      continue;
    }
    const interval = { start, end: start + durationMs };
    placement.set(task.id, interval);
    insertSorted(occupied, interval);
    proposals.push({
      taskId: task.id,
      startsAt: start as EpochMillis,
      endsAt: interval.end as EpochMillis,
    });
  }

  proposals.sort((a, b) => a.startsAt - b.startsAt || cmpId(a.taskId, b.taskId));
  return { proposals, unplaceable, placement };
}
