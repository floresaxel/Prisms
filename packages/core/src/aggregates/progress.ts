/**
 * Task progress bar (§7.2, §9.2): UNION of the task's raw entry minutes
 * (`mergeTimeEntries`, §7.10b) ÷ estimate_minutes — display caps at 100%,
 * overflow shown numerically (the value carries both). Overlapping entries
 * count once, never twice (audit S3-F2) — per-entry summation is forbidden
 * as an aggregation path here.
 */
import type { Node, TimeEntry } from '../domain/entities';

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
