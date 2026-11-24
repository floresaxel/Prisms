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
 * On a break the SAME pill becomes the break pill: "On break", the time left
 * (negative once it has run over) and Resume.
 *
 * One pill, animated as one thing (theme.css `.px-timer-pill`):
 *  - it GROWS in when a timer starts (or a break begins) and SHRINKS away when
 *    the last one stops — it stays mounted for `PILL_EXIT_MS` after it has
 *    nothing to show, so it can leave;
 *  - its WIDTH follows its content (a longer task name, "+2", "Clock out all", a
 *    10:00 that was 9:59) — measured, since `auto` cannot be transitioned;
 *  - its COLOUR eases between blue (running), amber (break) and red (over);
 *  - switching between running and break CROSSFADES the old content out under the
 *    new, while the width and colour do their move.
 * All of it is off under `prefers-reduced-motion` (no waiting, no ghost).
 *
 * The pulsing mark and the counter are the same as My Day's run card: the same
 * `RunMark` (same size, ring and phase) and the shared `useSecondClock`, so both
 * surfaces beat and tick together.
 *
 * Load-bearing testids preserved from Worklist: running-timer, timer-elapsed,
 * timer-clock-out (the review's testids now live in Timers.tsx); the break's:
 * break-pill, break-countdown, break-resume. The outgoing "ghost" of a crossfade
 * carries NONE of them (and is inert), so a test or a user only ever sees one.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { Ic, useRunningTimers, type RunningTimer } from '@prisms/ui';

import { breakEndsAt, breakRemainingMs, formatCountdown, type ActiveBreak } from '../break';
import { formatElapsed } from '../format';
import { RunMark } from './RunMark';
import { useTaskDetail } from './TaskDetail';
import { useTimers } from './Timers';
import { useSecondClock } from './useSecondClock';

/** How long the shrink-out takes (the `.px-timer-pill` transition) — the pill stays mounted this long after it starts leaving. */
export const PILL_EXIT_MS = 260;
/**
 * How long the pill waits, with nothing to show, before it starts to leave. A change of
 * what it shows is not instant (Resume ends the break a moment before the timers
 * restart; Take a break stops them a moment before the break begins), and without the
 * wait the pill would blink out and back in across that gap.
 */
const PILL_LEAVE_DELAY_MS = 80;
/** How long the outgoing content of a running ⇄ break switch lingers under the new. */
const PILL_GHOST_MS = 200;
/** The pill's border, both sides (1.5px each) — added to its content's width. */
const PILL_BORDER_PX = 3;

type RunView = { kind: 'run'; timers: readonly RunningTimer[]; lead: RunningTimer; others: number };
type BreakView = { kind: 'break'; brk: ActiveBreak; left: number };
type PillView = RunView | BreakView;

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * Mount `active` content with room to animate in and out: `mounted` stays true
 * for `exitMs` after `active` drops, and `shown` is the target the CSS moves
 * towards (false while entering and leaving). Content that is there from the
 * first render starts shown — a page load does not replay the entrance.
 */
function usePresence(active: boolean, exitMs: number, leaveDelayMs: number): { mounted: boolean; shown: boolean } {
  const [mounted, setMounted] = useState(active);
  const [shown, setShown] = useState(active);
  useEffect(() => {
    if (active) {
      setMounted(true);
      if (reducedMotion()) {
        setShown(true);
        return;
      }
      // two frames: let the hidden state paint first, or there is nothing to move from
      let b = 0;
      const a = requestAnimationFrame(() => {
        b = requestAnimationFrame(() => setShown(true));
      });
      return () => {
        cancelAnimationFrame(a);
        cancelAnimationFrame(b);
      };
    }
    if (reducedMotion()) {
      setShown(false);
      setMounted(false);
      return;
    }
    const hide = setTimeout(() => setShown(false), leaveDelayMs);
    const unmount = setTimeout(() => setMounted(false), leaveDelayMs + exitMs);
    return () => {
      clearTimeout(hide);
      clearTimeout(unmount);
    };
  }, [active, exitMs, leaveDelayMs]);
  return { mounted, shown };
}

export function GlobalTimer() {
  const now = useSecondClock();
  const { timers } = useRunningTimers(now);
  const { clockOut, activeBreak, resumeFromBreak } = useTimers();
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

  // What the pill shows right now: a running timer, else the break, else nothing.
  const view: PillView | null = lead
    ? { kind: 'run', timers, lead, others }
    : activeBreak
      ? { kind: 'break', brk: activeBreak, left: breakRemainingMs(activeBreak, now) }
      : null;
  const { mounted, shown } = usePresence(view !== null, PILL_EXIT_MS, PILL_LEAVE_DELAY_MS);
  // On its way out the pill keeps showing what it last had.
  const lastView = useRef<PillView | null>(null);
  if (view) lastView.current = view;
  const current = view ?? lastView.current;

  // The menu only exists while there is more than one timer to choose between.
  const menuOpen = open && view?.kind === 'run' && view.others > 0;
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

  // Running ⇄ break: keep the outgoing content, frozen, to fade out under the new.
  const [ghost, setGhost] = useState<PillView | null>(null);
  const before = useRef<PillView | null>(null);
  const kind = current?.kind ?? null;
  useEffect(() => {
    const was = before.current;
    if (current && was && was.kind !== current.kind && !reducedMotion()) {
      setGhost(was);
      const t = setTimeout(() => setGhost(null), PILL_GHOST_MS);
      return () => clearTimeout(t);
    }
    // keyed on kind alone: only a change of kind is a switch, not every tick
  }, [kind]);
  useEffect(() => {
    before.current = current;
  });

  // The pill's width follows its content's: measured, because `auto` cannot be animated.
  const inner = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const measure = () => setWidth(el.offsetWidth + PILL_BORDER_PX); // offsetWidth: unaffected by the scale of an entrance
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [mounted]);

  if (!mounted || !current) return null;

  const isBreak = current.kind === 'break';
  const over = current.kind === 'break' && current.left <= -1000;
  const ends = current.kind === 'break' ? new Date(breakEndsAt(current.brk)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  const back = current.kind === 'break' ? current.brk.tasks.map((t) => t.title).join(', ') : '';
  const pillWidth = !shown ? 0 : width ?? undefined;

  const body = (v: PillView, ghostCopy: boolean) =>
    v.kind === 'run' ? (
      <RunBody v={v} ghost={ghostCopy} menuOpen={menuOpen} onToggleMenu={() => setOpen((o) => !o)} onOpenTask={openTask} onClockOut={() => void clockOut(v.timers)} />
    ) : (
      <BreakBody v={v} ghost={ghostCopy} back={v.brk.tasks.map((t) => t.title).join(', ')} onResume={() => void resumeFromBreak()} />
    );

  return (
    <div className="px-timer-wrap" ref={wrap}>
      <div
        className={`px-timer-pill${isBreak ? ' px-break-pill' : ''}${over ? ' px-break-pill--over' : ''}`}
        data-testid={isBreak ? 'break-pill' : 'running-timer'}
        data-shown={shown}
        title={isBreak ? `Break until ${ends} · then back to ${back}` : undefined}
        style={{ width: pillWidth }}
      >
        <div className={`px-pill-inner${ghost ? ' px-pill-inner--swap' : ''}`} ref={inner}>
          {body(current, false)}
        </div>
        {ghost && (
          <div className="px-pill-inner px-pill-ghost" aria-hidden="true" inert>
            {body(ghost, true)}
          </div>
        )}
      </div>
      {menuOpen && view?.kind === 'run' && (
        <div className="px-menu-pop px-timer-menu" role="menu" data-testid="timer-menu">
          {[...view.timers].reverse().map((t) => (
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

/** The pill's running content: mark, task, "+N", elapsed, and Clock out. `ghost` = the frozen outgoing copy. */
function RunBody({
  v,
  ghost,
  menuOpen,
  onToggleMenu,
  onOpenTask,
  onClockOut,
}: {
  v: RunView;
  ghost: boolean;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onOpenTask: (taskId: string) => void;
  onClockOut: () => void;
}) {
  const { lead, others, timers } = v;
  const id = (testId: string) => (ghost ? undefined : testId);
  const leadBody = (
    <>
      <RunMark tone="white" testId={id('timer-mark')} />
      <span className="px-timer-pill-task">{lead.task?.title ?? 'Unknown task'}</span>
      {others > 0 && <span className="px-timer-pill-more" data-testid={id('timer-more')}>+{others}</span>}
      <span className="px-timer-pill-elapsed" data-testid={id('timer-elapsed')}>{formatElapsed(lead.elapsedMs)}</span>
      {others > 0 && <Ic name="chevd" className="px-timer-caret" />}
    </>
  );
  return (
    <>
      {others > 0 ? (
        <button
          className="px-timer-lead px-timer-lead--btn"
          data-testid={id('timer-menu-toggle')}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`${timers.length} timers running — show them`}
          tabIndex={ghost ? -1 : undefined}
          onClick={onToggleMenu}
        >
          {leadBody}
        </button>
      ) : (
        // one timer: the pill's task opens that task's card
        <button
          className="px-timer-lead px-timer-lead--btn"
          data-testid={id('timer-open-task')}
          aria-haspopup="dialog"
          title={lead.task?.title || 'Open task details'} // the whole title: the pill cuts it short
          tabIndex={ghost ? -1 : undefined}
          onClick={() => onOpenTask(lead.entry.task_id)}
        >
          {leadBody}
        </button>
      )}
      <button className="px-timer-stop" data-testid={id('timer-clock-out')} tabIndex={ghost ? -1 : undefined} onClick={onClockOut}>
        <Ic name="stop" /> {others > 0 ? 'Clock out all' : 'Clock out'}
      </button>
    </>
  );
}

/**
 * The pill's content on a break: "On break", the time left (negative once it has
 * run over, when the pill turns red), and Resume — which ends the break and
 * clocks back in to the tasks it stopped.
 */
function BreakBody({ v, ghost, back, onResume }: { v: BreakView; ghost: boolean; back: string; onResume: () => void }) {
  const id = (testId: string) => (ghost ? undefined : testId);
  return (
    <>
      <span className="px-timer-lead">
        <Ic name="coffee" className="px-ic px-break-cup" />
        <span className="px-timer-pill-task">On break</span>
        <span className="px-timer-pill-elapsed" data-testid={id('break-countdown')}>{formatCountdown(v.left)}</span>
      </span>
      <button
        className="px-timer-stop"
        data-testid={id('break-resume')}
        title={`End the break and clock back in to ${back}`}
        tabIndex={ghost ? -1 : undefined}
        onClick={onResume}
      >
        <Ic name="play" /> Resume
      </button>
    </>
  );
}
