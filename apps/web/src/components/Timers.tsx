/**
 * Split-focus timers (I5: up to MAX_OPEN_TIMERS at once, one per task). One
 * controller for every screen, so a clock-in from My Day and a clock-out from
 * the topbar pill go through the same two dialogs:
 *
 *  - CLOCK-IN: when a timer already runs, ask before starting another — clock
 *    out of the ticked running tasks and start this one, or run them all
 *    together and split the logged time equally (`splitConcurrent`). At the
 *    limit, "run together" is off: something has to stop first.
 *  - REVIEW: every clock-out queues the focus review (§1.2) — one at a time,
 *    with "Later for all" when several stopped together.
 *
 * Testids: clockin-dialog, clockin-stop-<taskId>, clockin-switch, clockin-split,
 * plus the review's review-focus / review-completed / review-save (from D7).
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { asEpochMillis, MAX_OPEN_TIMERS } from '@prisms/core';
import { Modal, useCommands, useNodeTree, useRunningTimers, type CommandContext, type RunningTimer } from '@prisms/ui';

import { formatElapsed } from '../format';

interface ReviewTarget {
  entryId: string;
  taskId: string;
  taskTitle: string;
  /**
   * When the user pressed Clock out, while the timer is still running underneath
   * the review (Save / Later stops it then, at THIS time; Cancel leaves it running
   * as if nothing happened). null once the timer is already stopped — the
   * clock-out-and-switch path — where there is nothing left to cancel.
   */
  endedAt: string | null;
}

interface ClockInRequest {
  taskId: string;
  force: boolean;
}

export interface TimersApi {
  /** Start a timer — directly when none runs, otherwise via the split-or-switch question. */
  requestClockIn: (taskId: string, opts?: { force?: boolean }) => void;
  /**
   * Clock out of these timers: each gets its focus review first, and the timer
   * stops (at the moment of the call) when the review is saved or put off with Later — its
   * Cancel button leaves the timer running.
   */
  clockOut: (timers: readonly RunningTimer[]) => Promise<void>;
}

const TimersContext = createContext<TimersApi | null>(null);

export function useTimers(): TimersApi {
  const api = useContext(TimersContext);
  if (!api) throw new Error('useTimers must be used inside <TimersProvider>');
  return api;
}

export function TimersProvider({ ctx, children }: { ctx: CommandContext; children: ReactNode }) {
  const commands = useCommands(ctx);
  const tree = useNodeTree();
  // the dialog reads the running set at the moment it opens; no per-second tick here
  const [now, setNow] = useState(() => asEpochMillis(Date.now()));
  const { timers } = useRunningTimers(now);

  const [request, setRequest] = useState<ClockInRequest | null>(null);
  const [toStop, setToStop] = useState<Set<string>>(new Set());
  const [reviews, setReviews] = useState<ReviewTarget[]>([]);
  const [focus, setFocus] = useState(1.0);
  const [completed, setCompleted] = useState(false);

  const clockOut = useCallback(
    async (stopping: readonly RunningTimer[], opts?: { immediate?: boolean }) => {
      const targets: ReviewTarget[] = [];
      const pressedAt = new Date().toISOString();
      for (const t of stopping) {
        // The review decides: the timer keeps running until Save / Later stops it (at the
        // moment of this click), so Cancel can leave it running. A switch stops it now —
        // the new clock-in must not count against the timer limit while this one lingers.
        if (opts?.immediate) await commands.clockOut(t.entry.id);
        targets.push({ entryId: t.entry.id, taskId: t.entry.task_id, taskTitle: t.task?.title ?? 'task', endedAt: opts?.immediate ? null : pressedAt });
      }
      if (targets.length === 0) return;
      setReviews((q) => {
        if (q.length === 0) {
          setFocus(1.0);
          setCompleted(false);
        }
        return [...q, ...targets];
      });
    },
    [commands],
  );

  const start = useCallback(
    (taskId: string, force: boolean) => commands.clockIn(taskId, force ? { force: true } : undefined).catch(() => undefined),
    [commands],
  );

  const requestClockIn = useCallback(
    (taskId: string, opts?: { force?: boolean }) => {
      const at = asEpochMillis(Date.now());
      setNow(at);
      // `timers` is from the last render; a clock-in only happens on a click, after one
      if (timers.length === 0) {
        void start(taskId, opts?.force === true);
        return;
      }
      setToStop(new Set(timers.map((t) => t.entry.id))); // all ticked by default
      setRequest({ taskId, force: opts?.force === true });
    },
    [timers, start],
  );

  async function confirm(mode: 'switch' | 'split') {
    if (!request) return;
    const req = request;
    setRequest(null);
    if (mode === 'switch') await clockOut(timers.filter((t) => toStop.has(t.entry.id)), { immediate: true });
    await start(req.taskId, req.force);
  }

  /** Stop a timer the review was holding open, at the moment Clock out was pressed. */
  const stopHeld = useCallback((t: ReviewTarget) => (t.endedAt === null ? Promise.resolve() : commands.clockOut(t.entryId, t.endedAt)), [commands]);

  /** Save / Later stop the timer (if still running) and take the next review; Cancel leaves it running. */
  async function finishReview(action: 'save' | 'later' | 'cancel') {
    const head = reviews[0];
    if (!head) return;
    if (action !== 'cancel') await stopHeld(head);
    if (action === 'save') await commands.review({ entryId: head.entryId, focusFactor: focus, completedSession: completed, taskId: head.taskId });
    setFocus(1.0);
    setCompleted(false);
    setReviews((q) => q.slice(1));
  }

  async function laterForAll() {
    const all = reviews;
    setReviews([]);
    for (const t of all) await stopHeld(t);
  }

  const api = useMemo<TimersApi>(() => ({ requestClockIn, clockOut }), [requestClockIn, clockOut]);
  const atLimit = timers.length >= MAX_OPEN_TIMERS;
  const ticked = timers.filter((t) => toStop.has(t.entry.id)).length;
  const newTitle = request ? (tree.byId.get(request.taskId)?.title ?? 'this task') : '';
  const review = reviews[0] ?? null;

  return (
    <TimersContext.Provider value={api}>
      {children}

      <Modal
        open={request !== null}
        title={`Clock in to “${newTitle}”`}
        onClose={() => setRequest(null)}
        actions={
          <>
            <button className="px-btn" onClick={() => setRequest(null)}>Cancel</button>
            <button
              className="px-btn"
              data-testid="clockin-split"
              disabled={atLimit}
              title={atLimit ? `${MAX_OPEN_TIMERS} timers are the most that can run at once` : undefined}
              onClick={() => void confirm('split')}
            >
              Split {timers.length + 1} ways
            </button>
            <button className="px-btn px-btn--primary" data-testid="clockin-switch" disabled={ticked === 0} onClick={() => void confirm('switch')}>
              {ticked === timers.length ? 'Clock out & switch' : `Clock out ${ticked} & switch`}
            </button>
          </>
        }
      >
        <div data-testid="clockin-dialog">
          <p className="px-modal-sub">
            {timers.length === 1 ? 'A timer is already running.' : `${timers.length} timers are already running.`} Clock out of
            the ticked ones and switch, or keep them running and split your focus — the time logged is shared equally between
            every running task.
          </p>
          <ul className="px-clockin-list">
            {timers.map((t) => (
              <li key={t.entry.id}>
                <label className="px-clockin-item">
                  <input
                    type="checkbox"
                    data-testid={`clockin-stop-${t.entry.task_id}`}
                    checked={toStop.has(t.entry.id)}
                    onChange={(e) =>
                      setToStop((s) => {
                        const next = new Set(s);
                        if (e.target.checked) next.add(t.entry.id);
                        else next.delete(t.entry.id);
                        return next;
                      })
                    }
                  />
                  <span className="px-clockin-title">{t.task?.title ?? 'Running task'}</span>
                  <span className="px-clockin-elapsed">{formatElapsed(t.elapsedMs)}</span>
                </label>
              </li>
            ))}
          </ul>
          {atLimit && <p className="px-muted">{MAX_OPEN_TIMERS} timers are the most that can run at once — clock out of at least one.</p>}
        </div>
      </Modal>

      <Modal
        open={request === null && review !== null}
        title="Session review"
        // Esc / backdrop: back out when the timer can still be kept, otherwise it is a Later
        onClose={() => void finishReview(review?.endedAt != null ? 'cancel' : 'later')}
        actions={
          <>
            {review?.endedAt != null && (
              <button className="px-btn" data-testid="review-cancel" title="Don't clock out — keep timing this task" onClick={() => void finishReview('cancel')}>
                Cancel
              </button>
            )}
            {reviews.length > 1 && <button className="px-btn" onClick={() => void laterForAll()}>Later for all</button>}
            <button className="px-btn" data-testid="review-later" onClick={() => void finishReview('later')}>Later</button>
            <button className="px-btn px-btn--primary" data-testid="review-save" onClick={() => void finishReview('save')}>Save</button>
          </>
        }
      >
        <p className="px-muted">
          {review?.taskTitle}
          {reviews.length > 1 && ` · 1 of ${reviews.length}`}
          {review?.endedAt != null && ' · still clocked in until you save or pick Later'}
        </p>
        <label className="px-field">
          Focus factor: ×{focus.toFixed(1)}
          <input type="range" min={0.5} max={1.0} step={0.1} value={focus} data-testid="review-focus" onChange={(e) => setFocus(Number(e.target.value))} />
        </label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={completed} data-testid="review-completed" onChange={(e) => setCompleted(e.target.checked)} />
          Completed this task
        </label>
      </Modal>
    </TimersContext.Provider>
  );
}
