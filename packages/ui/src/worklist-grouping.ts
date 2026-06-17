/**
 * Pure worklist grouping (Phase 4a) — kept out of hooks.ts so it can be
 * unit-tested without pulling in React/PowerSync. The WorklistItem type import
 * is type-only (erased at runtime), so importing this module is React-free.
 */
import type { WorklistItem } from './hooks';

export interface WorklistGroup {
  key: 'scheduled' | 'unscheduled';
  title: string;
  items: WorklistItem[];
}

/** Split worklist items into Scheduled (have a committed block) vs Unscheduled. */
export function groupWorklistBySchedule(items: readonly WorklistItem[]): WorklistGroup[] {
  const scheduled = items.filter((i) => i.scheduled);
  const unscheduled = items.filter((i) => !i.scheduled);
  const groups: WorklistGroup[] = [];
  if (scheduled.length > 0) groups.push({ key: 'scheduled', title: 'Scheduled', items: scheduled });
  if (unscheduled.length > 0) groups.push({ key: 'unscheduled', title: 'Unscheduled', items: unscheduled });
  return groups;
}
