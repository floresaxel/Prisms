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
import { Ic, Modal, useCommands, useRunningTimer, type CommandContext } from '@prisms/ui';

import { formatElapsed } from '../format';

interface ReviewTarget {
  entryId: string;
  taskId: string;
  taskTitle: string;
}

export function GlobalTimer({ ctx }: { ctx: CommandContext }) {
  const [now, setNow] = useState<Instant>(asEpochMillis(Date.now()));
  useEffect(() => {
    const t = setInterval(() => setNow(asEpochMillis(Date.now())), 1000);
    return () => clearInterval(t);
  }, []);

  const running = useRunningTimer(now);
  const commands = useCommands(ctx);

  const [review, setReview] = useState<ReviewTarget | null>(null);
  const [focus, setFocus] = useState(1.0);
  const [completed, setCompleted] = useState(false);

  async function clockOut() {
    if (!running) return;
    const target: ReviewTarget = { entryId: running.entry.id, taskId: running.entry.task_id, taskTitle: running.task?.title ?? 'task' };
    await commands.clockOut(target.entryId);
    setFocus(1.0);
    setCompleted(false);
    setReview(target);
  }

  async function submitReview() {
    if (!review) return;
    await commands.review({ entryId: review.entryId, focusFactor: focus, completedSession: completed, taskId: review.taskId });
    setReview(null);
  }

  return (
    <>
      {running && (
        <div className="px-timer-pill" data-testid="running-timer">
          <span className="px-dot" />
          <span className="px-timer-pill-task">{running.task?.title ?? 'Unknown task'}</span>
          <span className="px-timer-pill-elapsed" data-testid="timer-elapsed">{formatElapsed(running.elapsedMs)}</span>
          <button className="px-timer-stop" data-testid="timer-clock-out" onClick={() => void clockOut()}>
            <Ic name="stop" /> Clock out
          </button>
        </div>
      )}

      <Modal
        open={review !== null}
        title="Session review"
        onClose={() => setReview(null)}
        actions={
          <>
            <button className="px-btn" onClick={() => setReview(null)}>Skip</button>
            <button className="px-btn px-btn--primary" data-testid="review-save" onClick={() => void submitReview()}>Save</button>
          </>
        }
      >
        <p className="px-muted">{review?.taskTitle}</p>
        <label className="px-field">
          Focus factor: ×{focus.toFixed(1)}
          <input
            type="range"
            min={0.5}
            max={1.0}
            step={0.1}
            value={focus}
            data-testid="review-focus"
            onChange={(e) => setFocus(Number(e.target.value))}
          />
        </label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={completed} data-testid="review-completed" onChange={(e) => setCompleted(e.target.checked)} />
          Completed this task
        </label>
      </Modal>
    </>
  );
}
