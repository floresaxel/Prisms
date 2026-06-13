/**
 * Task progress bar (§7.2): Σ raw entry minutes ÷ estimate_minutes — display
 * caps at 100%, overflow shown numerically (the value carries both).
 */
import type { Node, TimeEntry } from '../domain/entities';

import { rawMinutes } from './effective';

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
  let consumed = 0;
  for (const entry of entries) {
    if (entry.deleted_at !== null || entry.task_id !== task.id) continue;
    consumed += rawMinutes(entry);
  }
  return withDerived(consumed, task.estimate_minutes);
}

/** Folds one newly closed entry for this task (any order). */
export function incrementalProgress(prev: ProgressValue, entry: TimeEntry): ProgressValue {
  if (entry.deleted_at !== null) return prev;
  return withDerived(prev.consumedMinutes + rawMinutes(entry), prev.estimateMinutes);
}

export const emptyProgress = (task: Node): ProgressValue =>
  withDerived(0, task.estimate_minutes);
