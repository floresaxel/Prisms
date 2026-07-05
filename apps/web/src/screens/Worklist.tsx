/**
 * Worklist (§1.2): available items — clock in / out, check off, delete. Reads
 * derived status from local SQLite (PowerSync reactive query → core selector);
 * every action is an optimistic local write.
 *
 * S16 keeps: clock-in is disabled everywhere while a timer runs (I5 — a second
 * timer is impossible in the UI), per-task progress bars (§7.2), and time-left-
 * in-day / time-left-in-task indicators. The running-timer pill and its clock-out
 * → focus-review modal now live in the shell topbar (GlobalTimer, D7).
 */
import { useEffect, useState } from 'react';

import { asEpochMillis, type Instant } from '@prisms/core';
import {
  List,
  ListItem,
  Modal,
  Skeleton,
  useBlockedTasks,
  useCommands,
  useDayTimeLeft,
  useIsHydrated,
  useNextBlockMinutes,
  useGroupedWorklist,
  useRunningTimer,
  useTimeBlocksForDay,
  type CommandContext,
  type WorklistItem,
} from '@prisms/ui';

import { WhyButton } from '../components/Why';
import { formatMinutes } from '../format';

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

  const groups = useGroupedWorklist(now);
  const blocked = useBlockedTasks(now);
  const running = useRunningTimer(now);
  const dayLeft = useDayTimeLeft(now);
  const nextBlock = useNextBlockMinutes(now);
  const commands = useCommands(ctx);
  const hydrated = useIsHydrated();

  const timeBlocks = useTimeBlocksForDay(now);
  const [checkOff, setCheckOff] = useState<{ id: string; title: string; scheduled: boolean; blockId: string | null } | null>(null);
  // for an unscheduled task: which time block (if any) it was completed in.
  const [pickedBlock, setPickedBlock] = useState<string | null>(null);

  function openCheckOff(item: WorklistItem) {
    setCheckOff({ id: item.task.id, title: item.task.title, scheduled: item.scheduled, blockId: item.committedBlockId });
    setPickedBlock(null);
  }

  async function finishCheckOff(disposition: 'completed' | 'obsolete') {
    if (!checkOff) return;
    // scheduled tasks auto-associate with their committed block; unscheduled use the picked block (null = unscheduled).
    const completedInBlockId = checkOff.scheduled ? checkOff.blockId : pickedBlock;
    await commands.checkOff(checkOff.id, { disposition, completedInBlockId });
    setCheckOff(null);
  }

  return (
    <section>
      <h1>Worklist</h1>
      <p className="px-muted">
        Available items — clock in, check off, or delete.{' '}
        <span data-testid="day-left">{formatMinutes(dayLeft)} left today</span>
        {nextBlock !== null && <> · <span data-testid="next-block">next block in {formatMinutes(nextBlock)}</span></>}
      </p>

      <div data-testid="worklist">
        {groups.length === 0 &&
          (hydrated ? (
            <div className="px-list-empty">No available tasks — everything is done or blocked.</div>
          ) : (
            <Skeleton testId="worklist-skeleton" />
          ))}
        {groups.map((group) => (
          <div key={group.key} data-testid={`worklist-group-${group.key}`}>
            <h3 className="px-muted" style={{ margin: '10px 0 4px' }}>{group.title}</h3>
            <List>
              {group.items.map((item) => (
                <ListItem
                  key={item.task.id}
              leading={
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span className={`px-badge px-badge--${item.status}`}>{item.status}</span>
                  {item.unverified.length > 0 && (
                    <span
                      className="px-badge px-badge--unverified"
                      data-testid={`weather-unverified-${item.task.id}`}
                      title={`Advisory only — not blocking: ${item.unverified.join(', ')}`}
                    >
                      weather unverified
                    </span>
                  )}
                </span>
              }
              trailing={
                <>
                  {item.minutesLeftInTask !== null && (
                    <span className="px-muted" data-testid={`task-left-${item.task.id}`}>
                      {formatMinutes(item.minutesLeftInTask)} left
                    </span>
                  )}
                  <WhyButton row={item.task} testId={`why-task-${item.task.id}`} />
                  <button
                    className="px-btn"
                    disabled={running !== null}
                    title={running !== null ? 'A timer is already running — clock out from the topbar' : undefined}
                    data-testid={`clock-in-${item.task.id}`}
                    onClick={() => void commands.clockIn(item.task.id)}
                  >
                    Clock in
                  </button>
                  <button className="px-btn px-btn--primary" onClick={() => openCheckOff(item)} data-testid={`check-${item.task.id}`}>
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
        ))}
      </div>

      {blocked.length > 0 && (
        <div data-testid="blocked-list" style={{ marginTop: 18 }}>
          <h3 className="px-muted" style={{ margin: '10px 0 4px' }}>Blocked</h3>
          <p className="px-muted" style={{ marginTop: 0, fontSize: 13 }}>
            Held by a blocker rule. Clocking in with force overrides it — the task then becomes <em>ongoing</em>.
          </p>
          <List>
            {blocked.map((b) => (
              <ListItem
                key={b.task.id}
                leading={<span className="px-badge px-badge--blocked">blocked</span>}
                trailing={
                  <>
                    <WhyButton row={b.task} testId={`why-task-${b.task.id}`} />
                    <button
                      className="px-btn px-btn--danger"
                      disabled={running !== null}
                      title={running !== null ? 'A timer is already running' : 'Override the blocker and start the timer'}
                      data-testid={`force-clock-in-${b.task.id}`}
                      onClick={() => void commands.clockIn(b.task.id, { force: true })}
                    >
                      Force clock in
                    </button>
                  </>
                }
              >
                {b.task.title}
                {b.blockedBy.length > 0 && (
                  <div className="px-muted" data-testid={`blocked-by-${b.task.id}`} style={{ marginTop: 4, fontSize: 12 }}>
                    Blocked by: {b.blockedBy.join(', ')}
                  </div>
                )}
                {b.unverified.length > 0 && (
                  <div className="px-muted" style={{ marginTop: 2, fontSize: 12 }}>
                    Weather unverified (advisory): {b.unverified.join(', ')}
                  </div>
                )}
              </ListItem>
            ))}
          </List>
        </div>
      )}

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
        {checkOff && !checkOff.scheduled && (
          <label className="px-field" style={{ display: 'block', marginTop: 8 }}>
            Completed in which time block?
            <select
              data-testid="checkoff-block"
              value={pickedBlock ?? ''}
              onChange={(e) => setPickedBlock(e.target.value === '' ? null : e.target.value)}
              style={{ display: 'block', marginTop: 4, width: '100%' }}
            >
              <option value="">Unscheduled (no block)</option>
              {timeBlocks.map((b) => (
                <option key={b.id} value={b.id}>
                  {new Date(b.startsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} — {b.title}
                </option>
              ))}
            </select>
          </label>
        )}
        {checkOff?.scheduled && <p className="px-muted" data-testid="checkoff-autoblock">Logged to its scheduled block.</p>}
      </Modal>
    </section>
  );
}
