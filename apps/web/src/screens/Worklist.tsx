/**
 * Worklist (§1.2): available items — clock in / out, check off, delete. Reads
 * derived status from local SQLite (PowerSync reactive query → core selector);
 * every action is an optimistic local write.
 *
 * S16 adds: the single global running-timer bar (I5 — clock-in is disabled
 * everywhere while a timer runs, so a second timer is impossible in the UI), a
 * clock-out → focus-review modal (factor ×0.5–1.0 + "completed?"), per-task
 * progress bars (§7.2), and time-left-in-day / time-left-in-task indicators.
 */
import { useEffect, useState } from 'react';

import { asEpochMillis, type Instant } from '@prisms/core';
import {
  List,
  ListItem,
  Modal,
  useCommands,
  useDayTimeLeft,
  useNextBlockMinutes,
  useRunningTimer,
  useWorklist,
  type CommandContext,
  type WorklistItem,
} from '@prisms/ui';

import { formatElapsed, formatMinutes } from '../format';

interface ReviewTarget {
  entryId: string;
  taskId: string;
  taskTitle: string;
}

function ProgressBar({ item }: { item: WorklistItem }) {
  const { progress } = item;
  if (progress.estimateMinutes === null) return <span className="px-muted">no estimate</span>;
  const over = progress.ratio !== null && progress.ratio > 1;
  // §7.2: bar caps at 100%, overflow shown numerically (uncapped %).
  const pct = Math.round((progress.ratio ?? 0) * 100);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div className="px-progress" data-testid={`progress-${item.task.id}`}>
        <div className={`px-progress-fill${over ? ' px-progress-fill--over' : ''}`} style={{ width: `${progress.percent}%` }} />
      </div>
      <span className="px-muted" data-testid={`progress-pct-${item.task.id}`} style={over ? { color: 'var(--px-danger)' } : undefined}>
        {pct}%
      </span>
    </div>
  );
}

export function Worklist({ ctx }: { ctx: CommandContext }) {
  const [now, setNow] = useState<Instant>(asEpochMillis(Date.now()));
  useEffect(() => {
    const t = setInterval(() => setNow(asEpochMillis(Date.now())), 1000);
    return () => clearInterval(t);
  }, []);

  const items = useWorklist(now);
  const running = useRunningTimer(now);
  const dayLeft = useDayTimeLeft(now);
  const nextBlock = useNextBlockMinutes(now);
  const commands = useCommands(ctx);

  const [review, setReview] = useState<ReviewTarget | null>(null);
  const [focus, setFocus] = useState(1.0);
  const [completed, setCompleted] = useState(false);
  const [checkOff, setCheckOff] = useState<{ id: string; title: string } | null>(null);

  async function finishCheckOff(disposition: 'completed' | 'obsolete') {
    if (!checkOff) return;
    await commands.checkOff(checkOff.id, { disposition });
    setCheckOff(null);
  }

  async function clockOut(entryId: string, taskId: string, taskTitle: string) {
    await commands.clockOut(entryId);
    setFocus(1.0);
    setCompleted(false);
    setReview({ entryId, taskId, taskTitle });
  }

  async function submitReview() {
    if (!review) return;
    await commands.review({ entryId: review.entryId, focusFactor: focus, completedSession: completed, taskId: review.taskId });
    setReview(null);
  }

  return (
    <section>
      <h1>Worklist</h1>
      <p className="px-muted">
        Available items — clock in, check off, or delete.{' '}
        <span data-testid="day-left">{formatMinutes(dayLeft)} left today</span>
        {nextBlock !== null && <> · <span data-testid="next-block">next block in {formatMinutes(nextBlock)}</span></>}
      </p>

      {running && (
        <div className="px-timerbar" data-testid="running-timer">
          <span className="px-badge px-badge--ongoing">running</span>
          <span className="px-timerbar-task">{running.task?.title ?? 'Unknown task'}</span>
          <span className="px-timerbar-elapsed" data-testid="timer-elapsed">{formatElapsed(running.elapsedMs)}</span>
          <button
            className="px-btn"
            data-testid="timer-clock-out"
            onClick={() => void clockOut(running.entry.id, running.entry.task_id, running.task?.title ?? 'task')}
          >
            Clock out
          </button>
        </div>
      )}

      <div data-testid="worklist">
        <List empty="No available tasks — everything is done or blocked.">
          {items.map((item) => (
            <ListItem
              key={item.task.id}
              leading={<span className={`px-badge px-badge--${item.status}`}>{item.status}</span>}
              trailing={
                <>
                  {item.minutesLeftInTask !== null && (
                    <span className="px-muted" data-testid={`task-left-${item.task.id}`}>
                      {formatMinutes(item.minutesLeftInTask)} left
                    </span>
                  )}
                  {item.openEntryId ? (
                    <button className="px-btn" onClick={() => void clockOut(item.openEntryId!, item.task.id, item.task.title)}>
                      Clock out
                    </button>
                  ) : (
                    <button
                      className="px-btn"
                      disabled={running !== null}
                      title={running !== null ? 'A timer is already running' : undefined}
                      data-testid={`clock-in-${item.task.id}`}
                      onClick={() => void commands.clockIn(item.task.id)}
                    >
                      Clock in
                    </button>
                  )}
                  <button className="px-btn px-btn--primary" onClick={() => setCheckOff({ id: item.task.id, title: item.task.title })} data-testid={`check-${item.task.id}`}>
                    Done
                  </button>
                  <button className="px-btn px-btn--danger" onClick={() => void commands.softDelete(item.task.id)} aria-label="delete">×</button>
                </>
              }
            >
              {item.task.title}
              <div style={{ marginTop: 6 }}>
                <ProgressBar item={item} />
              </div>
            </ListItem>
          ))}
        </List>
      </div>

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

      <Modal
        open={checkOff !== null}
        title="Check off task"
        onClose={() => setCheckOff(null)}
        actions={
          <>
            <button className="px-btn" onClick={() => setCheckOff(null)}>Cancel</button>
            <button className="px-btn" data-testid="checkoff-obsolete" onClick={() => void finishCheckOff('obsolete')}>Obsolete</button>
            <button className="px-btn px-btn--primary" data-testid="checkoff-completed" onClick={() => void finishCheckOff('completed')}>Completed</button>
          </>
        }
      >
        <p className="px-muted">{checkOff?.title}</p>
        <p>Did you finish this task, or is it no longer relevant?</p>
      </Modal>
    </section>
  );
}
