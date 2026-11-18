/**
 * Clock-out + the focus-review it triggers, shared by every place that can stop
 * the running timer (the topbar pill and My Day's run banner). Each caller owns
 * its own review state, so only the button that was clicked opens a modal.
 *
 * Load-bearing testids: review-focus, review-completed, review-save.
 */
import { useState, type ReactNode } from 'react';

import { Modal, useCommands, type CommandContext, type RunningTimer } from '@prisms/ui';

interface ReviewTarget {
  entryId: string;
  taskId: string;
  taskTitle: string;
}

export function useClockOutFlow(ctx: CommandContext, running: RunningTimer | null): { clockOut: () => Promise<void>; reviewModal: ReactNode } {
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

  const reviewModal = (
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
        <input type="range" min={0.5} max={1.0} step={0.1} value={focus} data-testid="review-focus" onChange={(e) => setFocus(Number(e.target.value))} />
      </label>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={completed} data-testid="review-completed" onChange={(e) => setCompleted(e.target.checked)} />
        Completed this task
      </label>
    </Modal>
  );

  return { clockOut, reviewModal };
}
