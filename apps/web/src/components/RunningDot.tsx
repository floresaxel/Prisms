/**
 * The pulsing "this task's timer is live" dot, for task lists (Tasks, Agenda): the
 * same mark as My Day's run card and the task card, small, in front of the title.
 *
 * `useRunningTaskIds` reads the running set ONCE per screen; rows are handed a
 * boolean, so a long list does not each open a timer subscription. Only WHICH
 * tasks are running matters here (not elapsed time), so the clock is read once.
 */
import { useMemo, useState } from 'react';

import { asEpochMillis } from '@prisms/core';
import { useRunningTimers } from '@prisms/ui';

import { RunMark } from './RunMark';

export function useRunningTaskIds(): ReadonlySet<string> {
  const [at] = useState(() => asEpochMillis(Date.now()));
  const { timers } = useRunningTimers(at);
  return useMemo(() => new Set(timers.map((t) => t.entry.task_id)), [timers]);
}

export function RunningDot({ running }: { running: boolean }) {
  if (!running) return null;
  return (
    <span className="px-rdot" title="Clocked in" data-testid="running-dot">
      <RunMark tone="blue" size={10} wave={false} />
    </span>
  );
}
