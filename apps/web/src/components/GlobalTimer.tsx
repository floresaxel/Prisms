/**
 * Global running-timer pill (web redesign W1 / D7) — in the topbar so clock-out
 * works from every screen. Under split focus several timers can run: the pill
 * leads with the most recently started one and counts the rest ("+2"); its
 * button stops all of them (each gets its focus review — `TimersProvider`).
 * My Day shows every running timer as its own card with its own Clock out.
 *
 * Load-bearing testids preserved from Worklist: running-timer, timer-elapsed,
 * timer-clock-out (the review's testids now live in Timers.tsx).
 */
import { useEffect, useState } from 'react';

import { asEpochMillis, type Instant } from '@prisms/core';
import { Ic, ThresholdMark, useRunningTimers } from '@prisms/ui';

import { formatElapsed } from '../format';
import { useTimers } from './Timers';

export function GlobalTimer() {
  const [now, setNow] = useState<Instant>(asEpochMillis(Date.now()));
  useEffect(() => {
    const t = setInterval(() => setNow(asEpochMillis(Date.now())), 1000);
    return () => clearInterval(t);
  }, []);

  const { timers } = useRunningTimers(now);
  const { clockOut } = useTimers();
  const lead = timers.at(-1);
  if (!lead) return null;
  const others = timers.length - 1;

  return (
    <div className="px-timer-pill" data-testid="running-timer" title={others > 0 ? `Split focus: ${timers.map((t) => t.task?.title ?? 'task').join(', ')}` : undefined}>
      <ThresholdMark size={14} tone="white" compact />
      <span className="px-timer-pill-task">{lead.task?.title ?? 'Unknown task'}</span>
      {others > 0 && <span className="px-timer-pill-more" data-testid="timer-more">+{others}</span>}
      <span className="px-timer-pill-elapsed" data-testid="timer-elapsed">{formatElapsed(lead.elapsedMs)}</span>
      <button className="px-timer-stop" data-testid="timer-clock-out" onClick={() => void clockOut(timers)}>
        <Ic name="stop" /> {others > 0 ? 'Clock out all' : 'Clock out'}
      </button>
    </div>
  );
}
