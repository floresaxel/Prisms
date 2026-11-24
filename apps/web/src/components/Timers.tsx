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
 *  - BREAK: the review's "Take a break" clocks out of EVERY running timer for
 *    5–30 minutes (`break.ts`). Clock-in is off until it ends; with a minute left
 *    a prompt (once) offers to clock back in to those tasks, its countdown runs
 *    negative for up to 10 minutes past the end, and then the break closes by
 *    itself with the tasks left clocked out. Every break is logged in the day's
 *    journal note.
 *
 * Testids: clockin-dialog, clockin-stop-<taskId>, clockin-switch, clockin-split,
 * plus the review's review-focus / review-completed / review-save (from D7), and
 * review-break, break-minutes, break-start, break-prompt(-countdown|-resume|-end).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { asEpochMillis, MAX_OPEN_TIMERS } from '@prisms/core';
import { Ic, Modal, useCommands, useNodeTree, useRunningTimers, type CommandContext, type RunningTimer } from '@prisms/ui';

import {
  BREAK_DEFAULT_MINUTES,
  BREAK_MAX_MINUTES,
  BREAK_MIN_MINUTES,
  BREAK_STEP_MINUTES,
  breakLogEnd,
  breakPhase,
  breakRemainingMs,
  formatCountdown,
  loadBreak,
  saveBreak,
  takeBreak,
  useActiveBreak,
  type ActiveBreak,
  type BreakTask,
} from '../break';
import { formatElapsed } from '../format';
import { FOCUS_MAX, FOCUS_POPUP_MIN } from '../focus-factor';
import { StepSlider } from './StepSlider';
import { Unfold } from './Unfold';
import { useSecondClock } from './useSecondClock';

/**
 * Captions under the clock-out review's focus slider: 0.3 … 1.0 in tenths, labelled
 * at its ends and middle. ×0 ("this session doesn't count") is deliberately NOT
 * offered here — only on the Review tab's session items, after the fact.
 */
const FOCUS_SCALE = ['0.3', '', '', '', '0.7', '', '', '1.0'];

/** Breaks being closed right now, by id — a second click while the first is mid-way does nothing. */
const closingBreaks = new Set<string>();

/** The numbers printed under the break slider, one per step (5, 10 … 30). */
const BREAK_SCALE = Array.from({ length: (BREAK_MAX_MINUTES - BREAK_MIN_MINUTES) / BREAK_STEP_MINUTES + 1 }, (_, i) => String(BREAK_MIN_MINUTES + i * BREAK_STEP_MINUTES));


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
  /** The break this device is on, or null. Clock-in is refused while there is one. */
  activeBreak: ActiveBreak | null;
  /** End the break now and clock back in to the tasks it clocked out of. */
  resumeFromBreak: () => Promise<void>;
  /** End the break now and stay clocked out. */
  endBreak: () => Promise<void>;
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

  // ── breaks ──
  const activeBreak = useActiveBreak(ctx.userId);
  /** The review's break picker is showing (after "Take a break"). */
  const [breakPicker, setBreakPicker] = useState(false);
  const [breakMinutes, setBreakMinutes] = useState(BREAK_DEFAULT_MINUTES);

  /**
   * Close the break `b` (once — a second tab or click finds it gone), record it
   * (`break.log` — the journal's day log shows it on the day it started; nothing
   * is written into the note), and clock back in when asked to.
   *
   * Resuming restarts the timers WHILE the break is still the break, and only then
   * closes and logs it: the topbar pill goes straight from the break to the running
   * timers instead of passing through a moment with nothing to show (it would shrink
   * away and grow back). `closingBreaks` stops a second click from starting the
   * timers twice meanwhile; the record's times were captured up front.
   */
  const closeBreak = useCallback(
    async (b: ActiveBreak, resume: boolean) => {
      const endAt = Date.now();
      if (closingBreaks.has(b.id)) return;
      closingBreaks.add(b.id);
      try {
        if (resume) {
          const running = loadBreak(ctx.userId);
          if (!running || running.id !== b.id) return;
          // They were running before the break: a task that has since become blocked
          // is taken back up as it was (force); one that is done or gone is skipped.
          for (const t of running.tasks) await commands.clockIn(t.taskId, { force: true }).catch(() => undefined);
        }
        const closed = takeBreak(ctx.userId, b.id);
        if (!closed) return;
        await commands
          .logBreak({ startedAt: new Date(closed.startedAt).toISOString(), endedAt: new Date(breakLogEnd(closed, endAt)).toISOString(), plannedMinutes: closed.minutes })
          .catch(() => undefined);
      } finally {
        closingBreaks.delete(b.id);
      }
    },
    [commands, ctx.userId],
  );  const resumeFromBreak = useCallback(async () => {
    if (activeBreak) await closeBreak(activeBreak, true);
  }, [activeBreak, closeBreak]);
  const endBreak = useCallback(async () => {
    if (activeBreak) await closeBreak(activeBreak, false);
  }, [activeBreak, closeBreak]);

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
      // no clocking in on a break (the buttons say so; this is the backstop)
      if (activeBreak) return;
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
    [timers, start, activeBreak],
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
    setBreakPicker(false);
    setReviews((q) => q.slice(1));
  }

  async function laterForAll() {
    const all = reviews;
    setReviews([]);
    setBreakPicker(false);
    for (const t of all) await stopHeld(t);
  }

  /**
   * Everything a break would clock out of: the tasks under review, then every
   * other timer still running — a break is a break from all of it.
   */
  const breakTasks = useMemo<BreakTask[]>(() => {
    const out = new Map<string, string>();
    for (const r of reviews) out.set(r.taskId, r.taskTitle);
    for (const t of timers) if (!out.has(t.entry.task_id)) out.set(t.entry.task_id, t.task?.title ?? 'task');
    return [...out].map(([taskId, title]) => ({ taskId, title }));
  }, [reviews, timers]);

  /**
   * Start a break of `breakMinutes`: the reviewed timers stop at the moment Clock
   * out was pressed (their reviews are put off, like Later), every other running
   * timer stops now, and the break begins.
   */
  async function startBreak() {
    const held = reviews;
    const tasks = breakTasks;
    const minutes = breakMinutes;
    setReviews([]);
    setBreakPicker(false);
    const heldEntries = new Set(held.map((r) => r.entryId));
    for (const r of held) await stopHeld(r);
    for (const t of timers) if (!heldEntries.has(t.entry.id)) await commands.clockOut(t.entry.id).catch(() => undefined);
    saveBreak(ctx.userId, { id: crypto.randomUUID(), startedAt: Date.now(), minutes, tasks, prompted: false });
  }

  const api = useMemo<TimersApi>(
    () => ({ requestClockIn, clockOut, activeBreak, resumeFromBreak, endBreak }),
    [requestClockIn, clockOut, activeBreak, resumeFromBreak, endBreak],
  );
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
            <button type="button" className="px-review-later" data-testid="review-later" onClick={() => void finishReview('later')}>
              Review later
            </button>
            {review?.endedAt != null && (
              <button className="px-btn" data-testid="review-cancel" title="Don't clock out — keep timing this task" onClick={() => void finishReview('cancel')}>
                Cancel
              </button>
            )}
            {reviews.length > 1 && <button className="px-btn" onClick={() => void laterForAll()}>Later for all</button>}
            <button className="px-btn px-btn--primary" data-testid="review-save" onClick={() => void finishReview('save')}>Save</button>
          </>
        }
      >
        <p className="px-muted">
          {review?.taskTitle}
          {reviews.length > 1 && ` · 1 of ${reviews.length}`}
          {review?.endedAt != null && ' · still clocked in until you save or pick Review later'}
        </p>
        <label className="px-field">
          <span data-testid="review-focus-label">
            Focus factor: ×{focus.toFixed(1)}
          </span>
          <StepSlider
            min={FOCUS_POPUP_MIN}
            max={FOCUS_MAX}
            step={0.1}
            value={focus}
            onChange={setFocus}
            valueText={`×${focus.toFixed(1)}`}
            testId="review-focus"
            ariaLabel="Focus factor"
            labels={FOCUS_SCALE}
          />
        </label>
        <div className="px-review-pills">
          <button
            type="button"
            className="px-review-pill px-review-pill--done"
            data-testid="review-completed"
            aria-pressed={completed}
            title="This session finished the task — check it off when you save"
            onClick={() => setCompleted((c) => !c)}
          >
            <Ic name="check" /> Completed this task
          </button>
          <button
            type="button"
            className="px-review-pill px-review-pill--break"
            data-testid="review-break"
            aria-expanded={breakPicker}
            title="Clock out of everything for a while, then pick back up"
            onClick={() => setBreakPicker((o) => !o)}
          >
            <Ic name="coffee" /> Take a break
          </button>
        </div>
        <Unfold open={breakPicker} testId="break-unfold">
            <div className="px-break-pick" data-testid="break-picker">
              <label className="px-field">
                <span>
                  Break for <b data-testid="break-minutes-label">{breakMinutes} min</b>
                </span>
                <StepSlider
                  min={BREAK_MIN_MINUTES}
                  max={BREAK_MAX_MINUTES}
                  step={BREAK_STEP_MINUTES}
                  value={breakMinutes}
                  onChange={setBreakMinutes}
                  testId="break-minutes"
                  ariaLabel="Break length in minutes"
                  labels={BREAK_SCALE}
                />
              </label>
              <p className="px-muted">
                Clocks out of {breakTasks.map((t) => `“${t.title}”`).join(', ')}. With a minute left you'll be asked to clock back in.
              </p>
              <button className="px-btn px-btn--primary" data-testid="break-start" onClick={() => void startBreak()}>
                Start {breakMinutes}-min break
              </button>
            </div>
        </Unfold>
      </Modal>

      {activeBreak && (
        <BreakWatcher
          key={activeBreak.id}
          userId={ctx.userId}
          brk={activeBreak}
          close={closeBreak}
        />
      )}
    </TimersContext.Provider>
  );
}

/**
 * Watches the running break once a second: with a minute left it opens the
 * "clock back in?" prompt (once per break — the flag is saved with the break, so
 * a reload or another tab does not ask again); the prompt's countdown goes
 * negative past the end; 10 minutes past the end the prompt goes away and the
 * break closes by itself, leaving the tasks clocked out.
 */
function BreakWatcher({ userId, brk, close }: { userId: string; brk: ActiveBreak; close: (b: ActiveBreak, resume: boolean) => Promise<void> }) {
  const now = useSecondClock();
  const phase = breakPhase(brk, now);
  const [promptOpen, setPromptOpen] = useState(false);
  const onResume = () => void close(brk, true);
  const onEnd = () => void close(brk, false);

  useEffect(() => {
    if (phase === 'expired') {
      setPromptOpen(false);
      void close(brk, false);
      return;
    }
    if ((phase === 'ending' || phase === 'over') && !brk.prompted) {
      saveBreak(userId, { ...brk, prompted: true });
      setPromptOpen(true);
    }
  }, [phase, brk, userId, close]);

  const left = breakRemainingMs(brk, now);
  const over = left <= -1000;
  return (
    <Modal
      open={promptOpen && phase !== 'expired'}
      title={over ? 'Your break is over' : 'Your break is almost over'}
      onClose={() => setPromptOpen(false)}
      actions={
        <>
          <button className="px-btn" data-testid="break-prompt-end" onClick={() => { setPromptOpen(false); onEnd(); }}>
            Stay clocked out
          </button>
          <button className="px-btn px-btn--primary" data-testid="break-prompt-resume" onClick={() => { setPromptOpen(false); onResume(); }}>
            Clock back in
          </button>
        </>
      }
    >
      <div data-testid="break-prompt">
        <div className={`px-break-count${over ? ' px-break-count--over' : ''}`} data-testid="break-prompt-countdown" aria-live="off">
          {formatCountdown(left)}
        </div>
        <p className="px-muted">
          {over ? 'Past the break you planned' : 'Left on your break'} · it closes by itself 10 min after the end, with nothing clocked in.
        </p>
        <p className="px-break-back">Clock back in to:</p>
        <ul className="px-break-tasks">
          {brk.tasks.map((t) => (
            <li key={t.taskId} data-testid={`break-prompt-task-${t.taskId}`}>{t.title}</li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
