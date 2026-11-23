/**
 * The clock-in log on the Review tab: every session clocked out in the last
 * two weeks, newest first, each with its FOCUS MULTIPLE — the share of the
 * logged time that really counted (0.5–1.0, §1.2). It is where a session closed
 * with "Later" in the clock-out review gets its multiple, and where any earlier
 * one can be changed. The field steps like the task card's Duration: ▲/▼ (and
 * ↑/↓ in the field) move it by a tenth; a typed value is kept on blur; Escape
 * puts the stored one back. Each change is saved at once through `timer.review`.
 *
 * Testids: clock-log, clock-log-count, log-row-<entryId>, log-focus-<entryId>,
 * log-up-<entryId>, log-down-<entryId>, log-counted-<entryId>,
 * log-pending-<entryId>, log-error-<entryId>, clock-log-empty.
 */
import { useEffect, useState } from 'react';

import { asEpochMillis, isoToEpochMillis } from '@prisms/core';
import { CLOCK_LOG_DAYS, Ic, useCommands, useRecentSessions, useUserSettings, type CommandContext, type LoggedSession } from '@prisms/ui';

import { FOCUS_MAX, FOCUS_MIN, focusText, parseFocus, stepFocus } from '../focus-factor';
import { formatMinutes } from '../format';

function stamp(iso: string, tz: string): string {
  return new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(isoToEpochMillis(iso));
}

function SessionRow({ s, timezone, ctx }: { s: LoggedSession; timezone: string; ctx: CommandContext }) {
  const commands = useCommands(ctx);
  const stored = s.entry.focus_factor ?? 1.0;
  const [draft, setDraft] = useState(focusText(stored));
  const [error, setError] = useState<string | null>(null);
  // follow the stored value when it changes underneath (a sync, another device)
  useEffect(() => setDraft(focusText(stored)), [stored]);

  const shown = parseFocus(draft) ?? stored;

  async function save(next: number) {
    // a never-reviewed session counts as 1.0, but saving 1.0 still marks it reviewed
    if (next === s.entry.focus_factor) return;
    setError(null);
    try {
      // keep the "this session finished the task" flag, unless the task has since been reopened
      await commands.review({ entryId: s.entry.id, focusFactor: next, completedSession: s.entry.completed_session === true && s.taskDone });
    } catch (e) {
      setDraft(focusText(stored));
      setError(e instanceof Error ? e.message : 'Could not save the focus multiple.');
    }
  }

  function commit() {
    const v = parseFocus(draft);
    if (v === undefined) {
      setDraft(focusText(stored));
      return;
    }
    setDraft(focusText(v));
    void save(v);
  }

  function step(dir: 1 | -1) {
    // from what is SHOWN, not what is stored: a quick second press lands before the store catches up
    const next = stepFocus(shown, dir);
    setDraft(focusText(next));
    void save(next);
  }

  const counted = s.minutes * shown;
  return (
    <li className="px-trow px-cl-row" data-testid={`log-row-${s.entry.id}`}>
      <div className="px-t-main">
        <div className="px-t-title">{s.taskTitle}</div>
        <div className="px-t-meta">
          <span>{stamp(s.entry.started_at, timezone)}</span>
          <span>{formatMinutes(s.minutes)} logged</span>
          {!s.reviewed && <span className="px-tag px-tag--amber" data-testid={`log-pending-${s.entry.id}`}>not reviewed</span>}
        </div>
        {error && <div className="px-error" role="alert" data-testid={`log-error-${s.entry.id}`}>{error}</div>}
      </div>
      <span className="px-cl-focus">
        <span className="px-cl-x" aria-hidden="true">×</span>
        <input
          className="px-td-in px-cl-in"
          data-testid={`log-focus-${s.entry.id}`}
          aria-label={`Focus multiple for ${s.taskTitle}`}
          inputMode="decimal"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.currentTarget.blur();
            } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              step(e.key === 'ArrowUp' ? 1 : -1);
            } else if (e.key === 'Escape' && draft !== focusText(stored)) {
              e.preventDefault();
              e.stopPropagation();
              setDraft(focusText(stored));
            }
          }}
        />
        <span className="px-td-spin">
          <button type="button" tabIndex={-1} aria-label="Raise the focus multiple by 0.1" data-testid={`log-up-${s.entry.id}`} disabled={shown >= FOCUS_MAX} onClick={() => step(1)}>
            <Ic name="chevd" />
          </button>
          <button type="button" tabIndex={-1} aria-label="Lower the focus multiple by 0.1" data-testid={`log-down-${s.entry.id}`} disabled={shown <= FOCUS_MIN} onClick={() => step(-1)}>
            <Ic name="chevd" />
          </button>
        </span>
      </span>
      <span className="px-cl-counted px-num" data-testid={`log-counted-${s.entry.id}`} title="Logged time × focus multiple">
        {formatMinutes(counted)} counted
      </span>
    </li>
  );
}

export function ClockLog({ ctx }: { ctx: CommandContext }) {
  // a minute's resolution is plenty: the log only needs "the last two weeks"
  const [now, setNow] = useState(() => asEpochMillis(Date.now()));
  useEffect(() => {
    const t = setInterval(() => setNow(asEpochMillis(Date.now())), 60_000);
    return () => clearInterval(t);
  }, []);
  const sessions = useRecentSessions(now);
  const { timezone } = useUserSettings();
  const pending = sessions.filter((s) => !s.reviewed).length;

  return (
    <section className="px-cl" data-testid="clock-log">
      <div className="px-page-head">
        <h2>
          Clock-in log <span className="px-muted" data-testid="clock-log-count">({sessions.length})</span>
        </h2>
        <span className="px-page-sub">
          the last {CLOCK_LOG_DAYS} days — set how much of each session&rsquo;s time was truly focused
          {pending > 0 && ` · ${pending} not reviewed yet`}
        </span>
      </div>
      {sessions.length === 0 ? (
        <div className="px-list-empty" data-testid="clock-log-empty">No clocked sessions in the last {CLOCK_LOG_DAYS} days.</div>
      ) : (
        <ul className="px-rows" style={{ maxWidth: 920 }}>
          {sessions.map((s) => (
            <SessionRow key={s.entry.id} s={s} timezone={timezone} ctx={ctx} />
          ))}
        </ul>
      )}
    </section>
  );
}
