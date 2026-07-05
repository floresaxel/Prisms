/**
 * My Day (§1.2, web redesign W2/D5) — the re-skinned worklist. Three sections:
 * Available now (white cards, sorted by parent-project priority from the decision
 * board), Blocked and Done today (muted, collapsed by default, state per view in
 * localStorage). A running task lifts into an amber run banner (clock-out is the
 * global topbar pill, D7). A right rail shows today's plan (with suggestion accept/
 * reject) and a habit summary. Client-side project filter chips scope the list.
 *
 * Load-bearing testids preserved from the old Worklist: worklist, clock-in-*,
 * check-*, progress-* + progress-pct-*, force-clock-in-*, checkoff-* (D8).
 */
import { useEffect, useState } from 'react';

import { asEpochMillis, bucketDate, type Instant } from '@prisms/core';
import {
  Modal,
  Skeleton,
  useAgenda,
  useBlockedTasks,
  useCommands,
  useDayTimeLeft,
  useDoneToday,
  useFactContext,
  useHabits,
  useIsHydrated,
  useMyDayAvailable,
  useRunningTimer,
  useTimeBlocksForDay,
  Ic,
  type CommandContext,
  type MyDayItem,
} from '@prisms/ui';

import { WhyButton } from '../components/Why';
import { formatElapsed, formatMinutes } from '../format';

const DOT_TONES = ['teal', 'blue', 'amber', 'green'] as const;
type DotTone = (typeof DOT_TONES)[number];

/** Stable per-project dot colour (the mock tints each project) derived from its id. */
function projectTone(projectId: string | null): DotTone {
  if (!projectId) return 'blue';
  let h = 0;
  for (let i = 0; i < projectId.length; i++) h = (h * 31 + projectId.charCodeAt(i)) >>> 0;
  return DOT_TONES[h % DOT_TONES.length]!;
}

function fmtClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Collapse state persisted per view (D5); sections start collapsed. */
function useCollapsed(key: string): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(key) !== '0';
    } catch {
      return true;
    }
  });
  const toggle = () =>
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(key, next ? '1' : '0');
      } catch {
        /* private mode — in-memory only */
      }
      return next;
    });
  return [collapsed, toggle];
}

function ProgressCell({ item }: { item: MyDayItem }) {
  const { progress } = item;
  const id = item.task.id;
  if (progress.estimateMinutes === null) {
    return <div className="px-pbar-sm px-muted" style={{ fontSize: 11 }}>no estimate</div>;
  }
  const over = progress.ratio !== null && progress.ratio > 1;
  const pct = Math.round((progress.ratio ?? 0) * 100);
  const label = progress.consumedMinutes <= 0 ? 'not started' : `${formatMinutes(progress.consumedMinutes)} logged`;
  return (
    <div className="px-pbar-sm">
      <div className="px-pbar-lbl">
        <span>{label}</span>
        <span data-testid={`progress-pct-${id}`} style={over ? { color: 'var(--px-danger)' } : undefined}>{pct}%</span>
      </div>
      <div className="px-pbar-trk">
        <div className={`px-pbar-fil${over ? ' px-pbar-fil--over' : ''}`} data-testid={`progress-${id}`} style={{ width: `${progress.percent}%` }} />
      </div>
    </div>
  );
}

function AvailableRow({ item, running, todayDate, onCheck, onClockIn }: { item: MyDayItem; running: boolean; todayDate: string; onCheck: () => void; onClockIn: () => void }) {
  const id = item.task.id;
  const dueToday = item.task.due_date === todayDate;
  return (
    <li className="px-trow" data-testid={`myday-row-${id}`} data-project={item.projectId ?? ''}>
      <button className="px-ckb" data-testid={`check-${id}`} aria-label="check off" onClick={onCheck}><Ic name="check" /></button>
      <div className="px-t-main">
        <div className="px-t-title">
          {item.task.title}
          <WhyButton row={item.task} testId={`why-task-${id}`} />
        </div>
        <div className="px-t-meta">
          {item.projectTitle && (
            <span className="px-proj"><span className={`px-pdot px-pdot--${projectTone(item.projectId)}`} />{item.projectTitle}</span>
          )}
          {item.progress.estimateMinutes !== null && <span>est {formatMinutes(item.progress.estimateMinutes)}</span>}
          {item.priority !== null && <span className="px-prio" title="Parent-project priority — Projects › Decisions">prio {item.priority.toFixed(1)}</span>}
        </div>
      </div>
      <ProgressCell item={item} />
      {item.task.due_date && <span className={`px-due${dueToday ? ' px-due--today' : ''}`}>{dueToday ? 'Today' : item.task.due_date.slice(5)}</span>}
      <button
        className="px-btn px-btn--sm"
        disabled={running}
        title={running ? 'A timer is already running — clock out from the topbar' : undefined}
        data-testid={`clock-in-${id}`}
        onClick={onClockIn}
      >
        <Ic name="play" /> Clock in
      </button>
    </li>
  );
}

export function MyDay({ ctx, onNavigate }: { ctx: CommandContext; onNavigate?: (href: string) => void }) {
  // Two clocks: `now` (1 s) drives the live run-banner elapsed; `nowMin` (60 s)
  // drives the heavier status/agenda/habit reads so they don't recompute per second.
  const [now, setNow] = useState<Instant>(asEpochMillis(Date.now()));
  const [nowMin, setNowMin] = useState<Instant>(asEpochMillis(Date.now()));
  useEffect(() => {
    const t = setInterval(() => setNow(asEpochMillis(Date.now())), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const t = setInterval(() => setNowMin(asEpochMillis(Date.now())), 60_000);
    return () => clearInterval(t);
  }, []);

  const ctxFacts = useFactContext();
  const commands = useCommands(ctx);
  const hydrated = useIsHydrated();
  const running = useRunningTimer(now);

  const allActionable = useMyDayAvailable(nowMin);
  const blocked = useBlockedTasks(nowMin);
  const done = useDoneToday(nowMin);
  const dayLeft = useDayTimeLeft(nowMin);
  const timeBlocks = useTimeBlocksForDay(nowMin);
  const agenda = useAgenda(nowMin);
  const habits = useHabits(nowMin);

  const runningItem = running ? allActionable.find((it) => it.openEntryId === running.entry.id) ?? null : null;
  const available = allActionable.filter((it) => !(running && it.openEntryId === running.entry.id));

  const [projectFilter, setProjectFilter] = useState<string | null>(null); // null = All
  // chip set = the projects present in the available list, in priority order.
  const projectChips = Array.from(
    available.reduce((m, it) => {
      if (it.projectId && it.projectTitle && !m.has(it.projectId)) m.set(it.projectId, it.projectTitle);
      return m;
    }, new Map<string, string>()),
  );
  const filtered = projectFilter ? available.filter((it) => it.projectId === projectFilter) : available;

  const [blockedCollapsed, toggleBlocked] = useCollapsed('prisms.myday.blocked');
  const [doneCollapsed, toggleDone] = useCollapsed('prisms.myday.done');

  const plannedMin = timeBlocks.reduce((sum, b) => sum + (b.endsAt - b.startsAt) / 60_000, 0);
  const dateLabel = new Date(now).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });

  // ── check-off modal (carried from the worklist) ──
  const [checkOff, setCheckOff] = useState<{ id: string; title: string; scheduled: boolean; blockId: string | null } | null>(null);
  const [pickedBlock, setPickedBlock] = useState<string | null>(null);
  function openCheckOff(item: MyDayItem) {
    setCheckOff({ id: item.task.id, title: item.task.title, scheduled: item.scheduled, blockId: item.committedBlockId });
    setPickedBlock(null);
  }
  async function finishCheckOff(disposition: 'completed' | 'obsolete') {
    if (!checkOff) return;
    const completedInBlockId = checkOff.scheduled ? checkOff.blockId : pickedBlock;
    await commands.checkOff(checkOff.id, { disposition, completedInBlockId });
    setCheckOff(null);
  }

  return (
    <section>
      <div className="px-page-head">
        <h1>My Day</h1>
        <span className="px-page-sub">{dateLabel}</span>
        <div className="px-head-actions">
          <button className="px-btn px-btn--sm" onClick={() => onNavigate?.('/agenda')}><Ic name="cal" /> Open agenda</button>
        </div>
      </div>

      <div className="px-hdr-chips">
        <span className="px-chip"><Ic name="clock" /> Time left today <b className="px-num" data-testid="day-left">{formatMinutes(dayLeft)}</b></span>
        <span className="px-chip"><Ic name="cal" /> Planned <b className="px-num">{formatMinutes(Math.round(plannedMin))}</b></span>
        <span className="px-chip"><Ic name="check" /> Done <b data-testid="chip-done">{done.length}</b></span>
        {blocked.length > 0 && (
          <span className="px-chip px-chip--warn"><Ic name="alert" /> <b data-testid="chip-blocked">{blocked.length} blocked</b></span>
        )}
      </div>

      <div className="px-day-cols">
        <div className="px-day-left">
          {running && (
            <div className="px-run-banner" data-testid="run-banner">
              <span className="px-dot" />
              <div>
                <div className="px-run-title">{running.task?.title ?? 'Running task'}</div>
                <div className="px-run-sub">
                  {runningItem?.projectTitle && (
                    <span className="px-proj"><span className={`px-pdot px-pdot--${projectTone(runningItem.projectId)}`} />{runningItem.projectTitle} · </span>
                  )}
                  clocked in {fmtClock(running.entry.started_at)} · one timer at a time
                </div>
              </div>
              {runningItem && runningItem.progress.estimateMinutes !== null && <ProgressCell item={runningItem} />}
              <div className="px-run-clock">{formatElapsed(running.elapsedMs)}</div>
            </div>
          )}

          <div className="px-sec">
            Available now <span className="px-sec-cnt">· {filtered.length}</span>
            {projectChips.length > 1 && (
              <span className="px-fchips" data-testid="myday-filters">
                <button className={`px-fchip${projectFilter === null ? ' px-fchip--on' : ''}`} data-testid="filter-all" onClick={() => setProjectFilter(null)}>All</button>
                {projectChips.map(([pid, title]) => (
                  <button key={pid} className={`px-fchip${projectFilter === pid ? ' px-fchip--on' : ''}`} data-testid={`filter-${pid}`} onClick={() => setProjectFilter(pid)}>
                    <span className={`px-pdot px-pdot--${projectTone(pid)}`} />{title}
                  </button>
                ))}
              </span>
            )}
            <span className="px-sec-ln" />
            <span className="px-sort-note" title="Default order: parent-project priority from Projects › Decisions"><Ic name="scale" /> sorted by priority</span>
          </div>
          <ul className="px-rows" data-testid="worklist">
            {filtered.length === 0 &&
              (hydrated ? (
                <li className="px-trow px-muted">Nothing available — everything is done, blocked, or filtered out.</li>
              ) : (
                <li className="px-trow"><Skeleton testId="worklist-skeleton" /></li>
              ))}
            {filtered.map((item) => (
              <AvailableRow
                key={item.task.id}
                item={item}
                running={running !== null}
                todayDate={ctxFacts.today(nowMin)}
                onCheck={() => openCheckOff(item)}
                onClockIn={() => void commands.clockIn(item.task.id)}
              />
            ))}
          </ul>

          {blocked.length > 0 && (
            <>
              <button className="px-sec px-sec--clps" data-testid="sec-blocked" aria-expanded={!blockedCollapsed} onClick={toggleBlocked} style={{ color: 'var(--px-red)' }}>
                <Ic name="chevd" className="px-ic px-sec-cv" /> Blocked <span className="px-sec-cnt">· {blocked.length}</span><span className="px-sec-ln" />
              </button>
              <ul className={`px-rows px-rows--muted${blockedCollapsed ? ' px-hide' : ''}`} data-testid="blocked-list">
                {blocked.map((b) => (
                  <li className="px-trow" key={b.task.id}>
                    <span className="px-ckb" style={{ opacity: 0.4 }}><Ic name="check" /></span>
                    <div className="px-t-main">
                      <div className="px-t-title" style={{ color: 'var(--px-text-dim)' }}>{b.task.title}</div>
                      {b.blockedBy.length > 0 && <div className="px-t-meta" data-testid={`blocked-by-${b.task.id}`}>{b.blockedBy.join(', ')}</div>}
                    </div>
                    {b.blockedBy.length > 0 && <span className="px-tag px-tag--red"><Ic name="alert" />{b.blockedBy[0]}</span>}
                    <button
                      className="px-btn px-btn--sm px-btn--danger"
                      disabled={running !== null}
                      title={running !== null ? 'A timer is already running' : 'Override the blocker and start the timer'}
                      data-testid={`force-clock-in-${b.task.id}`}
                      onClick={() => void commands.clockIn(b.task.id, { force: true })}
                    >
                      Force clock in
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          {done.length > 0 && (
            <>
              <button className="px-sec px-sec--clps" data-testid="sec-done" aria-expanded={!doneCollapsed} onClick={toggleDone} style={{ color: 'var(--px-green)' }}>
                <Ic name="chevd" className="px-ic px-sec-cv" /> Done today <span className="px-sec-cnt">· {done.length}</span><span className="px-sec-ln" />
              </button>
              <ul className={`px-rows px-rows--muted${doneCollapsed ? ' px-hide' : ''}`} data-testid="done-list">
                {done.map((d) => (
                  <li className="px-trow px-trow--done" key={d.task.id}>
                    <span className="px-ckb px-ckb--done"><Ic name="check" /></span>
                    <div className="px-t-main">
                      <div className="px-t-title">{d.task.title}</div>
                      <div className="px-t-meta">{d.consumedMinutes > 0 ? `${formatMinutes(Math.round(d.consumedMinutes))} logged` : 'completed'}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <div className="px-day-rail">
          <TodayPlan agenda={agenda} now={nowMin} ctxFacts={ctxFacts} commands={commands} onNavigate={onNavigate} />
          <HabitsToday habits={habits} onNavigate={onNavigate} />
        </div>
      </div>

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

/** Right-rail "Today's plan": today's blocks with suggestion accept/reject (D5). */
function TodayPlan({
  agenda,
  now,
  ctxFacts,
  commands,
  onNavigate,
}: {
  agenda: ReturnType<typeof useAgenda>;
  now: Instant;
  ctxFacts: ReturnType<typeof useFactContext>;
  commands: ReturnType<typeof useCommands>;
  onNavigate?: (href: string) => void;
}) {
  const today = ctxFacts.today(now);
  const blocks = agenda.blocks
    .filter((b) => !b.superseded && bucketDate(b.startsAt, ctxFacts.dayResetHour, ctxFacts.timezone) === today)
    .sort((a, b) => a.startsAt - b.startsAt);

  return (
    <div className="px-card">
      <div className="px-card-h">Today’s plan <span className="px-hint">from Agenda</span></div>
      <div style={{ padding: '4px 0 6px' }}>
        {blocks.length === 0 && <div className="px-rail-block" style={{ borderStyle: 'dashed' }}><span className="px-grow px-muted">Nothing planned yet.</span></div>}
        {blocks.map((b) => {
          const node = ctxFacts.tree.byId.get(b.taskId);
          const isHabit = node?.habit_id != null;
          const now2 = b.startsAt <= now && now <= b.endsAt;
          const tone = b.status === 'suggested' ? 'sugg' : b.anchored ? 'anchored' : isHabit ? 'habit' : 'committed';
          const range = `${fmtClock(new Date(b.startsAt).toISOString())} – ${fmtClock(new Date(b.endsAt).toISOString())}`;
          return (
            <div className={`px-rail-block px-rail-block--${tone}`} key={b.id}>
              <span className="px-rail-time">{range}</span>
              <span className="px-grow">{b.title}</span>
              {b.status === 'suggested' ? (
                <span className="px-mini-act">
                  <button className="px-mini-btn px-mini-btn--ok" data-testid={`rail-accept-${b.id}`} title="Accept suggestion" onClick={() => void commands.acceptSuggestion(b.id)}><Ic name="check" /></button>
                  <button className="px-mini-btn px-mini-btn--no" data-testid={`rail-reject-${b.id}`} title="Reject suggestion" onClick={() => void commands.rejectSuggestion(b.id)}><Ic name="x" /></button>
                </span>
              ) : b.anchored ? (
                <Ic name="lock" style={{ color: 'var(--px-slate)', width: 13, height: 13 }} />
              ) : now2 ? (
                <span className="px-tag px-tag--amber">now</span>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="px-rail-foot"><button className="px-linklike" onClick={() => onNavigate?.('/agenda')}>Open the week →</button></div>
    </div>
  );
}

/** Right-rail habit summary (read-only; toggle happens on the Habits screen). */
function HabitsToday({ habits, onNavigate }: { habits: ReturnType<typeof useHabits>; onNavigate?: (href: string) => void }) {
  const doneCount = habits.filter((h) => h.doneToday).length;
  return (
    <div className="px-card">
      <div className="px-card-h">Habits today <span className="px-hint">{doneCount} of {habits.length} done</span></div>
      <div>
        {habits.length === 0 && <div className="px-rail-habit px-muted">No habits yet.</div>}
        {habits.map((h) => (
          <div className="px-rail-habit" key={h.habit.id}>
            {h.ringFill !== null && !h.doneToday ? (
              <span className="px-ring-sm">
                <svg width="26" height="26" viewBox="0 0 38 38">
                  <circle cx="19" cy="19" r="15.5" strokeWidth="5" fill="none" stroke="var(--px-surface-2)" />
                  <circle cx="19" cy="19" r="15.5" strokeWidth="5" fill="none" stroke="var(--px-teal)" strokeDasharray={`${(h.ringFill * 97.4).toFixed(1)} 97.4`} strokeLinecap="round" />
                </svg>
              </span>
            ) : (
              <span className={`px-mini-ckb${h.doneToday ? ' px-mini-ckb--done' : ''}`}><Ic name="check" /></span>
            )}
            <span>{h.habit.title}</span>
            {h.dailyTargetMinutes != null && !h.doneToday && (
              <span style={{ color: 'var(--px-faint)', fontSize: 11 }}>{Math.round(h.todayMinutes)} / {h.dailyTargetMinutes} m</span>
            )}
            <span className="px-streak"><Ic name="flame" />{h.streak.current}</span>
          </div>
        ))}
      </div>
      <div className="px-rail-foot"><button className="px-linklike" onClick={() => onNavigate?.('/habits')}>All habits →</button></div>
    </div>
  );
}
