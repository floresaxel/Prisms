/**
 * Global running-timer pill + focus-review modal (web redesign W1 / D7). The
 * single running timer (I5) used to live in Worklist; it now sits in the topbar
 * so clock-out — and the focus-review it triggers — works from every screen.
 * Rendered as one node passed to `Layout.timer`; the pill sits in the topbar
 * while the modal is a fixed overlay, so its DOM position is irrelevant.
 *
 * Load-bearing testids preserved from Worklist: running-timer, timer-elapsed,
 * timer-clock-out, review-focus, review-completed, review-save.
 */
import { useEffect, useState } from 'react';

import { asEpochMillis, type Instant } from '@prisms/core';
import { Ic, useRunningTimer, type CommandContext } from '@prisms/ui';

import { formatElapsed } from '../format';
import { useClockOutFlow } from './ClockOutFlow';
import { RunMark } from './RunMark';

export function GlobalTimer({ ctx }: { ctx: CommandContext }) {
  const [now, setNow] = useState<Instant>(asEpochMillis(Date.now()));
  useEffect(() => {
    const t = setInterval(() => setNow(asEpochMillis(Date.now())), 1000);
    return () => clearInterval(t);
  }, []);

  const running = useRunningTimer(now);
  const { clockOut, reviewModal } = useClockOutFlow(ctx, running);

  return (
    <>
      {running && (
        <div className="px-timer-pill" data-testid="running-timer">
          <RunMark tone="white" size={12} testId="timer-mark" />
          <span className="px-timer-pill-task">{running.task?.title ?? 'Unknown task'}</span>
          <span className="px-timer-pill-elapsed" data-testid="timer-elapsed">{formatElapsed(running.elapsedMs)}</span>
          <button className="px-timer-stop" data-testid="timer-clock-out" onClick={() => void clockOut()}>
            <Ic name="stop" /> Clock out
          </button>
        </div>
      )}

      {reviewModal}
    </>
  );
}
