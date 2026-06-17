/** Phase 4a: the pure scheduled/unscheduled worklist split. */
import { describe, expect, it } from 'vitest';

import { groupWorklistBySchedule } from '../src/worklist-grouping';
import type { WorklistItem } from '../src/hooks';

const item = (id: string, scheduled: boolean): WorklistItem =>
  ({ task: { id }, scheduled } as unknown as WorklistItem);

describe('groupWorklistBySchedule', () => {
  it('splits into Scheduled then Unscheduled, preserving order within each', () => {
    const groups = groupWorklistBySchedule([item('a', true), item('b', false), item('c', true)]);
    expect(groups.map((g) => g.key)).toEqual(['scheduled', 'unscheduled']);
    expect(groups[0]!.items.map((i) => i.task.id)).toEqual(['a', 'c']);
    expect(groups[1]!.items.map((i) => i.task.id)).toEqual(['b']);
  });

  it('omits an empty group; returns [] when there are no items', () => {
    expect(groupWorklistBySchedule([item('a', false)]).map((g) => g.key)).toEqual(['unscheduled']);
    expect(groupWorklistBySchedule([item('a', true)]).map((g) => g.key)).toEqual(['scheduled']);
    expect(groupWorklistBySchedule([])).toEqual([]);
  });
});
