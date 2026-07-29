/**
 * The generated "Day log" footer (Annex L) under a journal day.
 *
 * PURELY PRESENTATIONAL and deliberately INERT: it renders no input, textarea,
 * contenteditable, or button, and it is mounted OUTSIDE the editor — never inside
 * the TipTap document. That, plus the fact that nothing is stored (the entries are
 * computed from live facts at render), is the whole "the user cannot edit it"
 * story. The `.md` export renders the same entries through the same core module,
 * so the two textual forms cannot drift.
 */
import { formatDayLogTime, type DayLogEntries } from '@prisms/core';

export function DayLogFooter({ entries, timezone }: { entries: DayLogEntries | null; timezone: string }) {
  if (!entries) return null;
  const { scheduled, completed, truncated } = entries;
  if (scheduled.length === 0 && completed.length === 0) return null;
  const at = (ts: string) => formatDayLogTime(ts, timezone);

  return (
    <section className="px-daylog" data-testid="daylog" aria-label="Day log">
      <div className="px-daylog-h">
        <span className="px-daylog-t">Day log</span>
        <span className="px-daylog-cap" data-testid="daylog-caption">Generated · updates automatically</span>
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
                <span className={`px-daylog-title${s.done ? ' px-daylog-title--done' : ''}`}>{s.title}</span>
              </li>
            ))}
            {truncated && truncated.scheduled > 0 && (
              <li className="px-daylog-row px-daylog-more" data-testid="daylog-sched-more">+{truncated.scheduled} more</li>
            )}
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
