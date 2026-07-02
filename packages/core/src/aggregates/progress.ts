/**
 * Task progress bar (§7.2, §9.2): UNION of the task's raw entry minutes
 * (`mergeTimeEntries`, §7.10b) ÷ estimate_minutes — display caps at 100%,
 * overflow shown numerically (the value carries both). Overlapping entries
 * count once, never twice (audit S3-F2) — per-entry summation is forbidden
 * as an aggregation path here.
 */
import type { Node, TimeEntry } from '../domain/entities';

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

export function canonicalProgress(task: Node, entries: readonly TimeEntry[]): ProgressValue {
  const own = entries.filter((e) => e.deleted_at === null && e.task_id === task.id);
  return withDerived(mergeTimeEntries(own).rawMinutes, task.estimate_minutes);
}
