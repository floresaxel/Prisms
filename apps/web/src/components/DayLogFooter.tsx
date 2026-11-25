/**
 * The generated "Day log" footer (Annex L) under a journal day.
 *
 * NOT EDITABLE: it renders no input, textarea or contenteditable, and it is
 * mounted OUTSIDE the editor — never inside the TipTap document. That, plus the
 * fact that nothing is stored (the entries are computed from live facts at
 * render), is the whole "the user cannot edit it" story. The `.md` export renders
 * the same entries through the same core module, so the two textual forms cannot
 * drift.
 *
 * It does hold VIEW controls now — the Clocked section's day bar and "All logs"
 * popup (`ClockedSection`) — which change only what is in view; and a Scheduled
 * task's name, or a Clocked task row, opens that task's details card.
 *
 * The project / vision filter is NOT in here: its controls live in `DayLogSection`,
 * next to this component, and hand it already-narrowed entries.
 */
import {
  bucketDate,
  DEFAULT_DAY_RESET_HOUR,
  formatDayLogDuration,
  formatDayLogTime,
  isDayLogEmpty,
  type DayLogEntries,
} from '@prisms/core';
import { Ic } from '@prisms/ui';

import { usableZone } from '../clocked-day';
import { ClockedSection } from './ClockedTimeline';
import { DayLogContext as Context } from './DayLogContext';
import { TaskOpenLink } from './TaskDetail';

export function DayLogFooter({
  entries,
  timezone,
  date,
  dayResetHour = DEFAULT_DAY_RESET_HOUR,
}: {
  entries: DayLogEntries | null;
  timezone: string;
  /** The journal day shown — the Clocked bar spans it. Falls back to the first session's day. */
  date?: string;
  dayResetHour?: number;
}) {  if (!entries || isDayLogEmpty(entries)) return null;
  const { scheduled, clocked, completed, truncated } = entries;
  const breaks = entries.breaks ?? [];
  const at = (ts: string) => formatDayLogTime(ts, timezone);
  const resetHour = Number.isInteger(dayResetHour) && dayResetHour >= 0 && dayResetHour <= 23 ? dayResetHour : DEFAULT_DAY_RESET_HOUR;
  const day = date ?? (clocked[0] ? bucketDate(clocked[0].started_at, resetHour, usableZone(timezone)) : '');

  return (
    <section className="px-daylog" data-testid="daylog" aria-label="Day log">
      <div className="px-daylog-h">
        <span className="px-daylog-t">Day log</span>
      </div>

      {scheduled.length > 0 && (
        <div className="px-daylog-sec" data-testid="daylog-scheduled">
          <div className="px-daylog-lbl">Scheduled</div>
          <ul className="px-daylog-list">
            {scheduled.map((s) => (
              <li key={s.block_id} className="px-daylog-row" data-testid={`daylog-sched-${s.block_id}`}>
                <span
                  className={`px-daylog-box${s.done ? ' px-daylog-box--on' : ''}`}
                  role="img"
                  aria-label={s.done ? 'done' : 'not done'}
                />
                <span className="px-daylog-time px-num">{at(s.starts_at)}–{at(s.ends_at)}</span>
                <TaskOpenLink
                  taskId={s.task_id}
                  className={`px-daylog-title${s.done ? ' px-daylog-title--done' : ''}`}
                  testId={`daylog-sched-open-${s.block_id}`}
                >
                  {s.title}
                </TaskOpenLink>
                <Context project={s.project} vision={s.vision} />
              </li>
            ))}
            {truncated && truncated.scheduled > 0 && (
              <li className="px-daylog-row px-daylog-more" data-testid="daylog-sched-more">+{truncated.scheduled} more</li>
            )}
          </ul>
        </div>
      )}

      {clocked.length > 0 && (
        <ClockedSection
          entries={clocked}
          totalMinutes={entries.clocked_minutes}
          truncated={truncated?.clocked ?? 0}
          date={day}
          dayResetHour={resetHour}
          timezone={timezone}
        />
      )}
      {breaks.length > 0 && (
        <div className="px-daylog-sec" data-testid="daylog-breaks">
          <div className="px-daylog-lbl">
            Breaks{' '}
            <span className="px-daylog-total px-num" data-testid="daylog-breaks-total">
              {formatDayLogDuration(breaks.reduce((sum, b) => sum + b.minutes, 0))}
            </span>
          </div>
          <ul className="px-daylog-list">
            {breaks.map((b) => {
              const over = b.minutes - b.planned_minutes;
              return (
                <li key={b.break_id} className="px-daylog-row" data-testid={`daylog-break-${b.break_id}`}>
                  <Ic name="coffee" className="px-ic px-daylog-break-ic" />
                  <span className="px-daylog-time px-num">{at(b.started_at)}–{at(b.ended_at)}</span>
                  <span className="px-daylog-title">Break</span>
                  <span className="px-daylog-dur px-num">{formatDayLogDuration(b.minutes)}</span>
                  {over >= 1 && (
                    <span className="px-daylog-mark px-daylog-mark--over" data-testid="daylog-break-over">
                      {formatDayLogDuration(over)} over the {formatDayLogDuration(b.planned_minutes)} planned
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {completed.length > 0 && (
        <div className="px-daylog-sec" data-testid="daylog-completed">
          <div className="px-daylog-lbl">Completed</div>
          <ul className="px-daylog-list">
            {completed.map((c) => (
              <li key={c.task_id} className="px-daylog-row" data-testid={`daylog-done-${c.task_id}`}>
                <span className="px-daylog-time px-num">{at(c.completed_at)}</span>
                <span className="px-daylog-title">{c.title}</span>
                {!c.planned && <span className="px-daylog-mark" data-testid="daylog-unplanned">unplanned</span>}
                {c.disposition === 'obsolete' && (
                  <span className="px-daylog-mark px-daylog-mark--descoped" data-testid="daylog-descoped">descoped</span>
                )}
                <Context project={c.project} vision={c.vision} />
              </li>
            ))}
            {truncated && truncated.completed > 0 && (
              <li className="px-daylog-row px-daylog-more" data-testid="daylog-done-more">+{truncated.completed} more</li>
            )}
          </ul>
        </div>
      )}
    </section>
  );
}
