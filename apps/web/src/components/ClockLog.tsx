/**
 * The clock-in log on the Review tab: every REVIEWED session clocked out in the
 * last two weeks, newest first, each with its FOCUS MULTIPLE — the share of the
 * logged time that really counted (0.5–1.0, §1.2). Where any session's multiple
 * can be changed afterwards. A session closed with "Review later" is not here
 * yet: it waits above as a regular review item (`SessionReviewRow`) until it is
 * reviewed and cleared, and then joins this log. The field steps like the task
 * card's Duration: ▲/▼ (and ↑/↓ in the field) move it by a tenth; a typed value
 * is kept on blur; Escape puts the stored one back. Each change is saved at once
 * through `timer.review`.
 *
 * Testids: clock-log, clock-log-count, log-row-<entryId>, log-focus-<entryId>,
 * log-up-<entryId>, log-down-<entryId>, log-counted-<entryId>,
 * log-error-<entryId>, clock-log-empty.
 */
import { useEffect, useMemo, useState } from 'react';

import { asEpochMillis, isoToEpochMillis } from '@prisms/core';
import { CLOCK_LOG_DAYS, useCommands, useRecentSessions, useUserSettings, type CommandContext, type LoggedSession } from '@prisms/ui';

import { focusText, parseFocus, stepFocus } from '../focus-factor';
import { formatMinutes } from '../format';
import { FocusStepper } from './FocusStepper';

/** "Mon, Nov 23, 2:05 PM" — when a session started, in the user's timezone. */
export function sessionStamp(iso: string, tz: string): string {
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
          <span>{sessionStamp(s.entry.started_at, timezone)}</span>
          <span>{formatMinutes(s.minutes)} logged</span>
        </div>
        {error && <div className="px-error" role="alert" data-testid={`log-error-${s.entry.id}`}>{error}</div>}
      </div>
      <FocusStepper
        prefix="log"
        id={s.entry.id}
        label={`Focus multiple for ${s.taskTitle}`}
        draft={draft}
        setDraft={setDraft}
        shown={shown}
        stored={stored}
        onStep={step}
        onCommit={commit}
      />
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
  const all = useRecentSessions(now);
  // sessions still waiting for a review are review items above, not log rows
  const sessions = useMemo(() => all.filter((s) => s.reviewed), [all]);
  const { timezone } = useUserSettings();

  return (
    <section className="px-cl" data-testid="clock-log">
      <div className="px-page-head">
        <h2>
          Clock-in log <span className="px-muted" data-testid="clock-log-count">({sessions.length})</span>
        </h2>
        <span className="px-page-sub">the last {CLOCK_LOG_DAYS} days — change how much of each reviewed session&rsquo;s time was truly focused</span>
      </div>
      {sessions.length === 0 ? (
        <div className="px-list-empty" data-testid="clock-log-empty">No reviewed sessions in the last {CLOCK_LOG_DAYS} days.</div>
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
