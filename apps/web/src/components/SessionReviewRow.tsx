/**
 * A session closed with "Review later" as a regular review item on the Review
 * tab: the task, when it ran and for how long, the focus multiple to set
 * (counting at 1.0 until then) — and Clear, which saves that multiple through
 * `timer.review` and so takes the item off the list. Changing the multiple does
 * NOT clear the item: it is kept in the row until Clear, so the review can be
 * taken a step at a time.
 *
 * Testids: session-review-<entryId>, sr-focus-<entryId>, sr-up-<entryId>,
 * sr-down-<entryId>, sr-counted-<entryId>, sr-clear-<entryId>, sr-error-<entryId>,
 * sr-open-<entryId> (the task's name: opens its details card).
 */
import { useState } from 'react';

import { isoToEpochMillis } from '@prisms/core';
import { Ic, useCommands, type CommandContext, type LoggedSession } from '@prisms/ui';

import { focusText, parseFocus, stepFocus } from '../focus-factor';
import { formatMinutes } from '../format';
import { FocusStepper } from './FocusStepper';
import { TaskOpenLink } from './TaskDetail';

/** "Mon, Nov 23, 2:05 PM" — when a session started, in the user's timezone. */
function sessionStamp(iso: string, tz: string): string {
  return new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(isoToEpochMillis(iso));
}

export function SessionReviewRow({ s, timezone, ctx }: { s: LoggedSession; timezone: string; ctx: CommandContext }) {
  const commands = useCommands(ctx);
  // a never-reviewed session counts as 1.0 until a multiple is set
  const [value, setValue] = useState(1.0);
  const [draft, setDraft] = useState(focusText(1.0));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = parseFocus(draft) ?? value;

  function commit() {
    const v = parseFocus(draft);
    if (v === undefined) {
      setDraft(focusText(value)); // junk puts the last good value back
      return;
    }
    setValue(v);
    setDraft(focusText(v));
  }

  function step(dir: 1 | -1) {
    // from what is SHOWN, not the last committed value: a quick second press lands first
    const next = stepFocus(shown, dir);
    setValue(next);
    setDraft(focusText(next));
  }

  async function clear() {
    setBusy(true);
    setError(null);
    try {
      // saving ANY multiple (1.0 included) marks the session reviewed; the task's own
      // "finished" state is left as it is (a review here does not complete anything)
      await commands.review({ entryId: s.entry.id, focusFactor: shown, completedSession: s.entry.completed_session === true && s.taskDone });
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : 'Could not clear this review.');
    }
  }

  return (
    <li className="px-trow px-cl-row" data-testid={`session-review-${s.entry.id}`}>
      <span className="px-sev px-sev--info" title="info">
        <Ic name="clock" />
      </span>
      <div className="px-t-main">
        <div className="px-t-title">
          <TaskOpenLink taskId={s.entry.task_id} testId={`sr-open-${s.entry.id}`}>
            {s.taskTitle}
          </TaskOpenLink>
          <span className="px-muted" style={{ fontWeight: 400 }}>Session review</span>
        </div>
        <div className="px-t-meta">
          <span>{sessionStamp(s.entry.started_at, timezone)}</span>
          <span>{formatMinutes(s.minutes)} logged</span>
        </div>
        {error && <div className="px-error" role="alert" data-testid={`sr-error-${s.entry.id}`}>{error}</div>}
      </div>
      <FocusStepper
        prefix="sr"
        id={s.entry.id}
        label={`Focus multiple for ${s.taskTitle}`}
        draft={draft}
        setDraft={setDraft}
        shown={shown}
        stored={value}
        onStep={step}
        onCommit={commit}
      />
      <span className="px-cl-counted px-num" data-testid={`sr-counted-${s.entry.id}`} title="Logged time × focus multiple">
        {formatMinutes(s.minutes * shown)} counted
      </span>
      <button className="px-btn px-btn--sm px-btn--primary" data-testid={`sr-clear-${s.entry.id}`} disabled={busy} onClick={() => void clear()}>
        Clear
      </button>
    </li>
  );
}
