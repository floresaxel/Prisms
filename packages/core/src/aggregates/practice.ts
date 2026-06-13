/**
 * Practice hours + levels for a skill (§7.2): Σ effectiveHours over entries
 * of tasks with `habit_id = skill`; level = count of level_thresholds_hours
 * passed. Incremental form is order-independent (a commutative sum).
 */
import type { Habit, Node, TimeEntry } from '../domain/entities';
import type { Uuid } from '../domain/primitives';

import { effectiveMinutes } from './effective';

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
  let minutes = 0;
  for (const entry of entries) {
    if (entry.deleted_at !== null) continue;
    if (!tasks.has(entry.task_id)) continue;
    minutes += effectiveMinutes(entry);
  }
  return withDerived(minutes, habit);
}

/** Folds one newly closed entry into a previous value (any order). */
export function incrementalPractice(
  prev: PracticeValue,
  entry: TimeEntry,
  habit: Habit,
  habitTasks: ReadonlySet<Uuid>,
): PracticeValue {
  if (entry.deleted_at !== null || !habitTasks.has(entry.task_id)) return prev;
  return withDerived(prev.minutes + effectiveMinutes(entry), habit);
}

export const emptyPractice = (habit: Habit): PracticeValue => withDerived(0, habit);
