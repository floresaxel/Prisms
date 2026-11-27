/**
 * The day log's Clocked section, collapsed.
 *
 * The card shows ONE row per task with its total for the day, beside a vertical
 * bar of the whole logical day on which every clocked session is a highlighted
 * region. "All logs" opens a popup with every individual session and a taller bar.
 *
 * Highlighting works the same in both places:
 *  - hover a row (or a bar region) → every session of that TASK stays in colour,
 *    everything else — rows and bar regions alike — greys out;
 *  - click a single log (or a bar region) → only THAT session and its region stay
 *    in colour. Click it again to let go.
 * A click pin outranks hover: the pointer is still over the log just clicked, and
 * letting its hover take over would widen the pin straight back to the whole task.
 *
 * Clicking a task row on the card opens that task's details card (outside a
 * `TaskDetailProvider` it pins the task instead).
 *
 * Nothing here edits anything. The controls only change what is in view.
 */
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import { formatDayLogDuration, formatDayLogTime, type DayLogClockedEntry } from '@prisms/core';
import { Ic, Modal } from '@prisms/ui';

import {
  buildClockedDay,
  dayBounds,
  dayTicks,
  focusState,
  nowFrac,
  usableZone,
  type ClockedSegment,
  type ClockFocus,
  type DayTick,
} from '../clocked-day';
import { DayLogContext } from './DayLogContext';
import { useOptionalTaskDetail } from './TaskDetail';

const sameFocus = (a: ClockFocus, b: ClockFocus) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.kind === b.kind &&
    (a.kind === 'task' ? a.taskId === b.taskId : a.entryId === (b as { entryId: string }).entryId));

/** Hover + click-pin highlighting; the pin wins while it is set. */
function useClockFocus() {
  const [hover, setHover] = useState<ClockFocus>(null);
  const [pinned, setPinned] = useState<ClockFocus>(null);
  return {
    focus: pinned ?? hover,
    pinned,
    hover: (f: ClockFocus) => setHover(f),
    toggle: (f: ClockFocus) => setPinned((p) => (sameFocus(p, f) ? null : f)),
    clear: () => {
      setHover(null);
      setPinned(null);
    },
  };
}

/** Re-render once a minute so a running session and the "now" line keep moving. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** '2026-11-17' → 'Tue 17 Nov' (UTC parse, so the label never drifts a day). */
function dayLabel(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function DayBar({
  segments,
  ticks,
  now,
  focus,
  tall,
  testId,
  segTestId,
  describe,
  onHover,
  onPick,
}: {
  segments: ClockedSegment[];
  ticks: DayTick[];
  now: number | null;
  focus: ClockFocus;
  tall?: boolean;
  testId: string;
  segTestId: (entryId: string) => string;
  describe: (entryId: string) => string;
  onHover: (f: ClockFocus) => void;
  onPick: (f: ClockFocus) => void;
}) {
  return (
    <div className={`px-cbar${tall ? ' px-cbar--tall' : ''}`} data-testid={testId}>
      <div className="px-cbar-ticks" aria-hidden="true">
        {ticks.map((t, i) => (
          <span key={i} className="px-cbar-tick" style={{ top: `${t.frac * 100}%` }}>
            {t.label}
          </span>
        ))}
      </div>
      <div className="px-cbar-track" role="img" aria-label={`Time clocked across the day: ${segments.length} session${segments.length === 1 ? '' : 's'}`}>
        {ticks.slice(1, -1).map((t, i) => (
          <span key={i} className="px-cbar-grid" style={{ top: `${t.frac * 100}%` }} aria-hidden="true" />
        ))}
        {segments.map((s) => (
          <div
            key={s.entryId}
            className={`px-cbar-seg px-ctone-${s.tone}${s.running ? ' px-cbar-seg--live' : ''}`}
            data-testid={segTestId(s.entryId)}
            data-state={focusState(focus, s)}
            title={describe(s.entryId)}
            style={{
              top: `${s.top * 100}%`,
              height: `${s.height * 100}%`,
              left: `${(s.lane / s.lanes) * 100}%`,
              width: `${100 / s.lanes}%`,
            }}
            onMouseEnter={() => onHover({ kind: 'task', taskId: s.taskId })}
            onMouseLeave={() => onHover(null)}
            onClick={(e) => {
              e.stopPropagation();
              onPick({ kind: 'entry', entryId: s.entryId, taskId: s.taskId });
            }}
          />
        ))}
      </div>
      {/* Outside the track, which clips to its rounded corners: there, a line at
          the very top or bottom of the day read as a blob, not a marker. */}
      {now !== null && <span className="px-cbar-now" style={{ top: `${now * 100}%` }} aria-hidden="true" data-testid={`${testId}-now`} />}
    </div>
  );
}

export function ClockedSection({
  entries,
  totalMinutes,
  truncated,
  date,
  dayResetHour,
  timezone,
}: {
  entries: DayLogClockedEntry[];
  totalMinutes: number;
  /** Sessions the day log's cap left out of `entries`. */
  truncated: number;
  date: string;
  dayResetHour: number;
  timezone: string;
}) {
  const nowMs = useNow();
  const zone = useMemo(() => usableZone(timezone), [timezone]);
  const bounds = useMemo(() => dayBounds(date, dayResetHour, zone), [date, dayResetHour, zone]);
  const ticks = useMemo(() => dayTicks(date, dayResetHour, zone, bounds), [date, dayResetHour, zone, bounds]);
  const day = useMemo(() => buildClockedDay(entries, bounds, nowMs), [entries, bounds, nowMs]);
  const now = nowFrac(bounds, nowMs);
  const card = useClockFocus();
  const pop = useClockFocus();
  const [open, setOpen] = useState(false);
  // a task row on the card opens that task's details card (pins it when there is no card to open)
  const detail = useOptionalTaskDetail();

  const at = (ts: string) => formatDayLogTime(ts, timezone);
  const byId = useMemo(() => new Map(entries.map((e) => [e.entry_id, e])), [entries]);
  const rangeOf = (e: DayLogClockedEntry) => `${at(e.started_at)}–${e.ended_at === null ? 'now' : at(e.ended_at)}`;
  const describe = (entryId: string) => {
    const e = byId.get(entryId);
    if (!e) return '';
    return `${rangeOf(e)} · ${e.minutes === null ? 'running' : formatDayLogDuration(e.minutes)} · ${e.title || '(untitled)'}`;
  };
  const toneOf = new Map(day.tasks.map((t) => [t.taskId, t.tone]));
  const logs = [...entries].sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));

  function close() {
    setOpen(false);
    pop.clear();
  }

  return (
    <div className="px-daylog-sec" data-testid="daylog-clocked">
      <div className="px-daylog-lbl px-clk-head">
        <span>
          Clocked{' '}
          <span className="px-daylog-total px-num" data-testid="daylog-clocked-total">
            {formatDayLogDuration(totalMinutes)}
          </span>
        </span>
        <button type="button" className="px-btn px-clk-all" data-testid="daylog-clock-all" onClick={() => setOpen(true)}>
          <Ic name="list" /> All logs ({entries.length + truncated})
        </button>
      </div>

      <div className="px-clk-card">
        <DayBar
          segments={day.segments}
          ticks={ticks}
          now={now}
          focus={card.focus}
          testId="daylog-clock-bar"
          segTestId={(id) => `daylog-seg-${id}`}
          describe={describe}
          onHover={card.hover}
          onPick={card.toggle}
        />
        <ul className="px-clk-tasks">
          {day.tasks.map((t) => {
            const f: ClockFocus = { kind: 'task', taskId: t.taskId };
            return (
              <li key={t.taskId}>
                <button
                  type="button"
                  className="px-clk-task"
                  data-testid={`daylog-clock-task-${t.taskId}`}
                  data-state={focusState(card.focus, { taskId: t.taskId })}
                  aria-pressed={detail ? undefined : sameFocus(card.pinned, f)}
                  aria-haspopup={detail ? 'dialog' : undefined}
                  title={detail ? 'Open task details' : undefined}
                  onMouseEnter={() => card.hover(f)}
                  onMouseLeave={() => card.hover(null)}
                  onFocus={() => card.hover(f)}
                  onBlur={() => card.hover(null)}
                  onClick={() => (detail ? detail.open(t.taskId) : card.toggle(f))}
                >
                  <span className={`px-clk-sw px-ctone-${t.tone}`} aria-hidden="true" />
                  <span className="px-clk-main">
                    <span className="px-daylog-title">{t.title || '(untitled)'}</span>
                    <DayLogContext project={t.project} vision={t.vision} />
                  </span>
                  <span className="px-clk-meta">
                    {t.sessions > 1 && <span className="px-clk-sessions">{t.sessions} sessions</span>}
                    {t.running && (
                      <span className="px-daylog-mark px-daylog-mark--live" data-testid="daylog-running">
                        running
                      </span>
                    )}
                    <span className="px-daylog-dur px-num px-clk-total" data-testid="daylog-task-total">
                      {formatDayLogDuration(t.minutes)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {/* always mounted, so closing can play the Modal's blur-out */}
      {createPortal(
          <Modal
            open={open}
            size="card"
            title={`Clocked · ${dayLabel(date)}`}
            subtitle={`${formatDayLogDuration(totalMinutes)} total · ${entries.length + truncated} session${entries.length + truncated === 1 ? '' : 's'} · ${day.tasks.length} task${day.tasks.length === 1 ? '' : 's'}`}
            onClose={close}
            actions={
              <button type="button" className="px-btn" data-testid="daylog-clock-close" onClick={close}>
                Close
              </button>
            }
          >
            <div className="px-clk-pop" data-testid="daylog-clock-popup" onClick={pop.clear}>
              <p className="px-clk-hint px-muted">Hover a log to follow its task through the day · click one to single it out.</p>
              <div className="px-clk-pop-body">
                <DayBar
                  segments={day.segments}
                  ticks={ticks}
                  now={now}
                  focus={pop.focus}
                  tall
                  testId="daylog-clock-popup-bar"
                  segTestId={(id) => `daylog-popup-seg-${id}`}
                  describe={describe}
                  onHover={pop.hover}
                  onPick={pop.toggle}
                />
                <ul className="px-clk-logs">
                  {logs.map((e) => {
                    const f: ClockFocus = { kind: 'entry', entryId: e.entry_id, taskId: e.task_id };
                    return (
                      <li key={e.entry_id}>
                        <button
                          type="button"
                          className="px-clk-log"
                          data-testid={`daylog-clock-${e.entry_id}`}
                          data-state={focusState(pop.focus, { taskId: e.task_id, entryId: e.entry_id })}
                          aria-pressed={sameFocus(pop.pinned, f)}
                          onMouseEnter={() => pop.hover({ kind: 'task', taskId: e.task_id })}
                          onMouseLeave={() => pop.hover(null)}
                          onFocus={() => pop.hover({ kind: 'task', taskId: e.task_id })}
                          onBlur={() => pop.hover(null)}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            pop.toggle(f);
                          }}
                        >
                          <span className={`px-clk-sw px-ctone-${toneOf.get(e.task_id) ?? 'slate'}`} aria-hidden="true" />
                          <span className="px-daylog-time px-num">{rangeOf(e)}</span>
                          <span className="px-clk-main">
                            <span className="px-daylog-title">{e.title || '(untitled)'}</span>
                            <DayLogContext project={e.project} vision={e.vision} />
                          </span>
                          {e.minutes === null ? (
                            <span className="px-daylog-mark px-daylog-mark--live" data-testid="daylog-running">
                              running
                            </span>
                          ) : (
                            <span className="px-daylog-dur px-num" data-testid="daylog-duration">
                              {formatDayLogDuration(e.minutes)}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                  {truncated > 0 && (
                    <li className="px-daylog-row px-daylog-more" data-testid="daylog-clock-more">
                      +{truncated} more not shown
                    </li>
                  )}
                </ul>
              </div>
            </div>
          </Modal>,
          document.body,
        )}
    </div>
  );
}
