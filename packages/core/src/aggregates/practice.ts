/**
 * Practice hours + levels for a skill (§7.2, §9.2): entries of tasks with
 * `habit_id = skill` are unioned PER TASK via `mergeTimeEntries` (§7.10b),
 * then summed across tasks; level = count of level_thresholds_hours passed.
 * Overlapping entries on the same task (two devices clocked in AND out
 * offline) count once, never twice (audit S3-F2/S5-F4) — per-entry summation
 * is forbidden as an aggregation path here.
 */
import type { Habit, Node, TimeEntry } from '../domain/entities';
import type { Uuid } from '../domain/primitives';

import { mergeTimeEntries } from '../merge/time-entries';

export interface PracticeValue {
  minutes: number;
  hours: number;
  level: number;
  /** Next level mark in hours, or null at max level. */
  nextThresholdHours: number | null;
}

function withDerived(minutes: number, habit: Habit): PracticeValue {
  const hours = minutes / 60;
  const thresholds = habit.level_thresholds_hours;
  const level = thresholds.filter((t) => hours >= t).length;
  return {
    minutes,
    hours,
    level,
    nextThresholdHours: level < thresholds.length ? thresholds[level]! : null,
  };
}

/** Task ids justified by this habit (the entries that count as practice). */
export function habitTaskIds(habit: Habit, nodes: readonly Node[]): Set<Uuid> {
  const ids = new Set<Uuid>();
  for (const node of nodes) {
    if (node.deleted_at === null && node.habit_id === habit.id) ids.add(node.id);
  }
  return ids;
}

export function canonicalPractice(
  habit: Habit,
  nodes: readonly Node[],
  entries: readonly TimeEntry[],
): PracticeValue {
  const tasks = habitTaskIds(habit, nodes);
  const byTask = new Map<Uuid, TimeEntry[]>();
  for (const entry of entries) {
    if (entry.deleted_at !== null) continue;
    if (!tasks.has(entry.task_id)) continue;
    const list = byTask.get(entry.task_id);
    if (list === undefined) byTask.set(entry.task_id, [entry]);
    else list.push(entry);
  }
  let minutes = 0;
  for (const list of byTask.values()) minutes += mergeTimeEntries(list).effectiveMinutes;
  return withDerived(minutes, habit);
}
