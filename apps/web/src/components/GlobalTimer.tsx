/**
 * Global running-timer pill (web redesign W1 / D7) — in the topbar so clock-out
 * works from every screen. Under split focus several timers can run: the pill
 * leads with the most recently started one and counts the rest ("+2"); clicking
 * the lead part opens a small menu of every running timer (each with its own
 * Clock out), and the pill's button stops all of them (each gets its focus
 * review — `TimersProvider`). Clicking the task — the pill's own when one timer
 * runs, a row of the menu when several — opens that task's details card.
 * My Day shows every running timer as its own card.
 *
 * The pulsing mark and the counter are the same as My Day's run card: the same
 * `RunMark` (same size, ring and phase) and the shared `useSecondClock`, so both
 * surfaces beat and tick together.
 *
 * Load-bearing testids preserved from Worklist: running-timer, timer-elapsed,
 * timer-clock-out (the review's testids now live in Timers.tsx).
 */
import { useEffect, useRef, useState } from 'react';

import { Ic, useRunningTimers } from '@prisms/ui';

import { breakEndsAt, breakRemainingMs, formatCountdown } from '../break';
import { formatElapsed } from '../format';
import { RunMark } from './RunMark';
import { useTaskDetail } from './TaskDetail';
import { useTimers } from './Timers';
import { useSecondClock } from './useSecondClock';

export function GlobalTimer() {
  const now = useSecondClock();
  const { timers } = useRunningTimers(now);
  const { clockOut, activeBreak } = useTimers();
  const detail = useTaskDetail();
  const [open, setOpen] = useState(false);
  /** Open a running task's details card (closing the menu if it was open). */
  const openTask = (taskId: string) => {
    setOpen(false);
    detail.open(taskId);
  };
  const wrap = useRef<HTMLDivElement>(null);
  const lead = timers.at(-1);
  const others = timers.length - 1;
  // the menu only exists while there is more than one timer to choose between
  const menuOpen = open && others > 0;

  useEffect(() => {
    if (!menuOpen) return;
    const onDownOutside = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDownOutside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDownOutside);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  // On a break nothing runs (here): the pill counts the break down instead.
  if (activeBreak && !lead) return <BreakPill now={now} />;
  if (!lead) return null;

  const leadBody = (
    <>
      <RunMark tone="white" testId="timer-mark" />
      <span className="px-timer-pill-task">{lead.task?.title ?? 'Unknown task'}</span>
      {others > 0 && <span className="px-timer-pill-more" data-testid="timer-more">+{others}</span>}
      <span className="px-timer-pill-elapsed" data-testid="timer-elapsed">{formatElapsed(lead.elapsedMs)}</span>
      {others > 0 && <Ic name="chevd" className="px-timer-caret" />}
    </>
  );

  return (
    <div className="px-timer-wrap" ref={wrap}>
      <div className="px-timer-pill" data-testid="running-timer">
        {others > 0 ? (
          <button
            className="px-timer-lead px-timer-lead--btn"
            data-testid="timer-menu-toggle"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`${timers.length} timers running — show them`}
            onClick={() => setOpen((o) => !o)}
          >
            {leadBody}
          </button>
        ) : (
          // one timer: the pill's task opens that task's card
          <button
            className="px-timer-lead px-timer-lead--btn"
            data-testid="timer-open-task"
            aria-haspopup="dialog"
            title={lead.task?.title || 'Open task details'} // the whole title: the pill cuts it short
            onClick={() => openTask(lead.entry.task_id)}
          >
            {leadBody}
          </button>
        )}
        <button className="px-timer-stop" data-testid="timer-clock-out" onClick={() => void clockOut(timers)}>
          <Ic name="stop" /> {others > 0 ? 'Clock out all' : 'Clock out'}
        </button>
      </div>
      {menuOpen && (
        <div className="px-menu-pop px-timer-menu" role="menu" data-testid="timer-menu">
          {[...timers].reverse().map((t) => (
            <div className="px-timer-menu-row" key={t.entry.id} data-testid={`timer-menu-row-${t.entry.task_id}`}>
              <button
                className="px-timer-menu-open"
                role="menuitem"
                data-testid={`timer-menu-open-${t.entry.task_id}`}
                title={t.task?.title || 'Open task details'} // the whole title: the row cuts it short
                onClick={() => openTask(t.entry.task_id)}
              >
                <span className="px-timer-menu-title">{t.task?.title ?? 'Unknown task'}</span>
                <span className="px-timer-menu-elapsed" data-testid={`timer-menu-elapsed-${t.entry.task_id}`}>{formatElapsed(t.elapsedMs)}</span>
              </button>
              <button
                className="px-timer-menu-stop"
                data-testid={`timer-menu-stop-${t.entry.task_id}`}
                aria-label={`Clock out of ${t.task?.title ?? 'this task'}`}
                onClick={() => void clockOut([t])}
              >
                <Ic name="stop" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The topbar while on a break: "On break", the time left (negative once it has
 * run over, in red), and Resume — which ends the break and clocks back in to the
 * tasks it stopped.
 */
function BreakPill({ now }: { now: number }) {
  const { activeBreak, resumeFromBreak } = useTimers();
  if (!activeBreak) return null;
  const left = breakRemainingMs(activeBreak, now);
  const over = left <= -1000;
  const ends = new Date(breakEndsAt(activeBreak)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const back = activeBreak.tasks.map((t) => t.title).join(', ');
  return (
    <div className="px-timer-wrap">
      <div className={`px-timer-pill px-break-pill${over ? ' px-break-pill--over' : ''}`} data-testid="break-pill" title={`Break until ${ends} · then back to ${back}`}>
        <span className="px-timer-lead">
          <Ic name="coffee" className="px-ic px-break-cup" />
          <span className="px-timer-pill-task">On break</span>
          <span className="px-timer-pill-elapsed" data-testid="break-countdown">{formatCountdown(left)}</span>
        </span>
        <button className="px-timer-stop" data-testid="break-resume" title={`End the break and clock back in to ${back}`} onClick={() => void resumeFromBreak()}>
          <Ic name="play" /> Resume
        </button>
      </div>
    </div>
  );
}
