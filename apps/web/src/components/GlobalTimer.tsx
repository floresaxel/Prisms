/**
 * Global running-timer pill (web redesign W1 / D7) — in the topbar so clock-out
 * works from every screen. Under split focus several timers can run: the pill
 * leads with the most recently started one and counts the rest ("+2"); clicking
 * the lead part opens a small menu of every running timer (each with its own
 * Clock out), and the pill's button stops all of them (each gets its focus
 * review — `TimersProvider`). My Day shows every running timer as its own card.
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

import { formatElapsed } from '../format';
import { RunMark } from './RunMark';
import { useTimers } from './Timers';
import { useSecondClock } from './useSecondClock';

export function GlobalTimer() {
  const now = useSecondClock();
  const { timers } = useRunningTimers(now);
  const { clockOut } = useTimers();
  const [open, setOpen] = useState(false);
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
          <div className="px-timer-lead">{leadBody}</div>
        )}
        <button className="px-timer-stop" data-testid="timer-clock-out" onClick={() => void clockOut(timers)}>
          <Ic name="stop" /> {others > 0 ? 'Clock out all' : 'Clock out'}
        </button>
      </div>
      {menuOpen && (
        <div className="px-menu-pop px-timer-menu" role="menu" data-testid="timer-menu">
          {[...timers].reverse().map((t) => (
            <div className="px-timer-menu-row" role="menuitem" key={t.entry.id} data-testid={`timer-menu-row-${t.entry.task_id}`}>
              <span className="px-timer-menu-title">{t.task?.title ?? 'Unknown task'}</span>
              <span className="px-timer-menu-elapsed" data-testid={`timer-menu-elapsed-${t.entry.task_id}`}>{formatElapsed(t.elapsedMs)}</span>
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
