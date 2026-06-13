/**
 * Greedy scheduler (§10, client mode). Earliest-fit placement honoring the
 * hard constraints: anchored blocks never move (I7) and are never overlapped
 * (I9); no proposal overlaps another or any obstacle; dependency order with
 * lag; task time-windows; nothing scheduled for done tasks (I8).
 *
 * Deterministic by construction (§10): tasks are placed in a stable
 * topological order (ties broken by id), windows expand in a stable order,
 * and the only "clock" is the injected `horizon.from`. Identical inputs ⇒
 * identical output, so two devices agree offline.
 */
import type { Uuid } from '../domain/primitives';
import { MS_PER_MINUTE } from '../time/duration';
import type { EpochMillis } from '../time/instant';

import type {
  BlockProposal,
  Interval,
  SchedulableTask,
  SchedulerInput,
  SchedulerOutput,
  Unplaceable,
} from './types';
import { earliestFit, expandWindows, freeRegions, insertSorted, type ConcreteWindow } from './windows';

const cmpId = (a: Uuid, b: Uuid): number => (a < b ? -1 : a > b ? 1 : 0);

function allowedWindows(
  task: SchedulableTask,
  all: readonly ConcreteWindow[],
): ConcreteWindow[] {
  const ids = task.allowedWindowIds;
  if (!ids || ids.length === 0) return [...all];
  const set = new Set(ids);
  return all.filter((w) => set.has(w.windowId));
}

/** Kahn topological sort over in-batch dependencies; ties + cycle output stable by id. */
function topoOrder(tasks: readonly SchedulableTask[]): {
  order: SchedulableTask[];
  cyclic: Uuid[];
} {
  const byId = new Map(tasks.map((t) => [t.id, t]));
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
    .sort(cmpId);
  const order: SchedulableTask[] = [];
  const emitted = new Set<Uuid>();

  while (ready.length > 0) {
    const id = ready.shift()!;
    emitted.add(id);
    order.push(byId.get(id)!);
    for (const succ of (successors.get(id) ?? []).slice().sort(cmpId)) {
      const next = (indegree.get(succ) ?? 0) - 1;
      indegree.set(succ, next);
      if (next === 0) {
        // keep `ready` sorted
        let lo = 0;
        let hi = ready.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (cmpId(ready[mid]!, succ) < 0) lo = mid + 1;
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
function committedSpans(input: SchedulerInput): Map<Uuid, Interval> {
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

function earliestFromDeps(
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
      // a batch predecessor that itself failed to place blocks this task;
      // an unknown/done/external predecessor imposes no timing constraint.
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

export function scheduleGreedy(input: SchedulerInput): SchedulerOutput {
  const proposals: BlockProposal[] = [];
  const unplaceable: Unplaceable[] = [];
  const unplaceableIds = new Set<Uuid>();
  const reject = (taskId: Uuid, reason: Unplaceable['reason']) => {
    unplaceable.push({ taskId, reason });
    unplaceableIds.add(taskId);
  };

  // Triage: done (I8) and unsized tasks never reach placement.
  const schedulable: SchedulableTask[] = [];
  for (const task of input.tasks) {
    if (task.done) reject(task.id, 'done');
    else if (!(task.estimateMinutes > 0)) reject(task.id, 'no_estimate');
    else schedulable.push(task);
  }
  const scheduledIds = new Set(schedulable.map((t) => t.id));

  // Obstacles: anchored blocks always (I7/I9); flexible blocks of tasks NOT
  // being replanned. A replanned task's own flexible block is freed.
  const occupied: Interval[] = input.committed
    .filter((b) => b.anchored || !scheduledIds.has(b.taskId))
    .map((b) => ({ start: b.startsAt, end: b.endsAt }))
    .sort((a, b) => a.start - b.start);

  const allWindows = expandWindows(input.windows, input.timezone, input.horizon);
  const committed = committedSpans(input);
  const { order, cyclic } = topoOrder(schedulable);
  for (const id of cyclic) reject(id, 'dependency_cycle');

  const placement = new Map<Uuid, Interval>();
  for (const task of order) {
    if (unplaceableIds.has(task.id)) continue; // cyclic
    const durationMs = task.estimateMinutes * MS_PER_MINUTE;

    const { earliest, blocked } = earliestFromDeps(
      task,
      durationMs,
      placement,
      committed,
      scheduledIds,
      unplaceableIds,
      input.horizon.from,
    );
    if (blocked) {
      reject(task.id, 'dependency_unplaceable');
      continue;
    }

    const windows = allowedWindows(task, allWindows);
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

/** Mode dispatcher (§10). `optimize` arrives in S9. */
export function schedule(input: SchedulerInput): SchedulerOutput {
  if (input.mode === 'optimize') {
    throw new Error('TODO(s09): optimize mode is built in S9');
  }
  return scheduleGreedy(input);
}
