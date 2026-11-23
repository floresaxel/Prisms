/**
 * Task progress bar (§7.2, §9.2): UNION of the task's raw entry minutes
 * (`mergeTimeEntries`, §7.10b) ÷ estimate_minutes — display caps at 100%,
 * overflow shown numerically (the value carries both). Overlapping entries
 * count once, never twice (audit S3-F2) — per-entry summation is forbidden
 * as an aggregation path here.
 */
import type { Node, TimeEntry } from '../domain/entities';
import type { Uuid } from '../domain/primitives';
import { ancestorsOf, type TreeIndex } from '../graph/tree';

import { splitConcurrent } from '../merge/split-focus';
import { mergeTimeEntries } from '../merge/time-entries';

export interface ProgressValue {
  consumedMinutes: number;
  estimateMinutes: number | null;
  /** consumed/estimate, uncapped (1.5 = 150%); null without an estimate. */
  ratio: number | null;
  /** Display percent, capped to [0, 100]; 0 without an estimate. */
  percent: number;
}

function withDerived(consumedMinutes: number, estimateMinutes: number | null): ProgressValue {
  const ratio =
    estimateMinutes !== null && estimateMinutes > 0
      ? consumedMinutes / estimateMinutes
      : null;
  return {
    consumedMinutes,
    estimateMinutes,
    ratio,
    percent: ratio === null ? 0 : Math.min(100, Math.max(0, ratio * 100)),
  };
}

/**
 * `entries` must be the user's FULL list, not just this task's: while timers on
 * several tasks overlap each is credited only its split-focus share
 * (`splitConcurrent`), which depends on what else was running.
 */
export function canonicalProgress(task: Node, entries: readonly TimeEntry[]): ProgressValue {
  const own = splitConcurrent(entries).filter((e) => e.task_id === task.id);
  return withDerived(mergeTimeEntries(own).rawMinutes, task.estimate_minutes);
}

/**
 * The time counted in each PROJECT: for every live task anywhere under it (direct
 * children, tasks inside milestones, finished ones too) the same minutes
 * `canonicalProgress` reports for that task, added up. Projects with nothing
 * logged are absent from the map. Entries whose task is deleted or unknown count
 * nowhere.
 *
 * Built from the split-focus fragments (like `canonicalProgress`), so timers
 * that overlapped share their wall-clock time and no minute is counted twice
 * across the tasks of a project; `entries` must be the user's FULL list.
 */
export function loggedMinutesByProject(tree: TreeIndex, entries: readonly TimeEntry[]): Map<Uuid, number> {
  const byTask = new Map<Uuid, ReturnType<typeof splitConcurrent>>();
  for (const frag of splitConcurrent(entries)) {
    const list = byTask.get(frag.task_id);
    if (list) list.push(frag);
    else byTask.set(frag.task_id, [frag]);
  }
  const totals = new Map<Uuid, number>();
  for (const [taskId, own] of byTask) {
    if (!tree.byId.has(taskId)) continue;
    const minutes = mergeTimeEntries(own).rawMinutes;
    if (minutes <= 0) continue;
    for (const above of ancestorsOf(tree, taskId)) {
      if (above.node_type === 'project') totals.set(above.id, (totals.get(above.id) ?? 0) + minutes);
    }
  }
  return totals;
}
