/**
 * A `long_session` review item (> 6 h clocked in, or auto clocked out at 24 h).
 * The user either confirms the time was real, or fixes it — by how long they
 * actually worked, or by the exact time they stopped. Both edit the SAME end
 * instant: a still-running timer is clocked out at it (`timer.clock_out`), a
 * closed one has its end corrected (`timer.adjust`). Either way the item is
 * then resolved.
 *
 * Load-bearing testids: long-session-<id>, ls-confirm-<id>, ls-edit-<id>,
 * ls-hours-<id>, ls-minutes-<id>, ls-end-<id>, ls-save-<id>, ls-error-<id>.
 */
import { useState } from 'react';

import { isoToEpochMillis } from '@prisms/core';
import { Ic, type LongSessionView, type ReviewItemView } from '@prisms/ui';

import { endError, endFromDuration, formatDuration, fromLocalInput, splitDuration, toLocalInput } from '../long-session-edit';

interface Props {
  item: ReviewItemView;
  session: LongSessionView;
  timezone: string;
  /** Close the item once the time is confirmed or fixed. */
  onResolve: () => void;
  onDismiss: () => void;
  /** Clock a running timer out at `endedAt`. */
  onClockOut: (entryId: string, endedAt: string) => Promise<void>;
  /** Correct a closed session's end to `endedAt`. */
  onAdjust: (entryId: string, endedAt: string) => Promise<void>;
}

function stamp(ms: number, tz: string): string {
  return new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(ms);
}

export function LongSessionRow({ item, session, timezone, onResolve, onDismiss, onClockOut, onAdjust }: Props) {
  const { detail, entry, taskTitle } = session;
  const startMs = isoToEpochMillis(entry?.started_at ?? detail.started_at);
  const endedIso = entry ? entry.ended_at : detail.ended_at;
  const running = entry !== null && entry.ended_at === null;
  const nowMs = Date.now();
  const currentEndMs = endedIso ? isoToEpochMillis(endedIso) : nowMs;
  const auto = detail.kind === 'auto_clock_out';

  const [editing, setEditing] = useState(false);
  const [hours, setHours] = useState('');
  const [minutes, setMinutes] = useState('');
  const [at, setAt] = useState('');
  const [endMs, setEndMs] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  function openEditor() {
    const d = splitDuration(currentEndMs - startMs);
    setHours(String(d.hours));
    setMinutes(String(d.minutes));
    setAt(toLocalInput(currentEndMs, timezone));
    setEndMs(currentEndMs);
    setEditing(true);
  }

  function onDuration(h: string, m: string) {
    setHours(h);
    setMinutes(m);
    const end = endFromDuration(startMs, h, m);
    setEndMs(end);
    if (end !== null) setAt(toLocalInput(end, timezone));
  }

  function onEndAt(v: string) {
    setAt(v);
    const end = fromLocalInput(v, timezone);
    setEndMs(end);
    if (end !== null) {
      const d = splitDuration(end - startMs);
      setHours(String(d.hours));
      setMinutes(String(d.minutes));
    }
  }

  const error = editing ? endError(endMs, startMs, Date.now()) : null;

  async function save() {
    if (!entry || endMs === null || error) return;
    setBusy(true);
    try {
      const endedAt = new Date(endMs).toISOString();
      if (running) await onClockOut(entry.id, endedAt);
      else await onAdjust(entry.id, endedAt);
      onResolve();
    } finally {
      setBusy(false);
    }
  }

  const status = running
    ? `still running · ${formatDuration(nowMs - startMs)} so far`
    : `ran ${formatDuration(currentEndMs - startMs)} · ended ${stamp(currentEndMs, timezone)}${auto ? ' (automatic clock-out)' : ''}`;

  return (
    <li className="px-trow" style={{ flexWrap: 'wrap' }} data-testid={`long-session-${item.id}`}>
      <span className={`px-sev px-sev--${item.severity}`} title={item.severity}>
        <Ic name="alert" />
      </span>
      <div className="px-t-main">
        <div className="px-t-title">
          {item.title || `Long session on ${taskTitle}`}
          <span className="px-muted" style={{ fontWeight: 400 }} data-testid={`review-type-${item.id}`}>Long session</span>
        </div>
        <div className="px-t-meta" data-testid={`ls-status-${item.id}`}>
          Started {stamp(startMs, timezone)} · {status}
        </div>
      </div>
      {!editing && (
        <>
          <button className="px-btn px-btn--sm px-btn--primary" data-testid={`ls-confirm-${item.id}`} onClick={onResolve}>
            {running ? 'Yes, still working' : 'Time is right'}
          </button>
          <button className="px-btn px-btn--sm" data-testid={`ls-edit-${item.id}`} disabled={!entry} onClick={openEditor}>
            {running ? 'Clock out at…' : 'Adjust time'}
          </button>
          <button className="px-btn px-btn--sm" data-testid={`dismiss-${item.id}`} onClick={onDismiss}>Dismiss</button>
        </>
      )}
      {editing && (
        <div style={{ flexBasis: '100%', display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 16, padding: '8px 0 4px 38px' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }} className="px-muted">
            Time actually spent
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--px-text)' }}>
              <input
                className="px-input"
                style={{ width: 64 }}
                type="number"
                min={0}
                aria-label="Hours"
                data-testid={`ls-hours-${item.id}`}
                value={hours}
                onChange={(e) => onDuration(e.target.value, minutes)}
              />
              h
              <input
                className="px-input"
                style={{ width: 64 }}
                type="number"
                min={0}
                max={59}
                aria-label="Minutes"
                data-testid={`ls-minutes-${item.id}`}
                value={minutes}
                onChange={(e) => onDuration(hours, e.target.value)}
              />
              m
            </span>
          </label>
          <span className="px-muted" style={{ paddingBottom: 9, fontSize: 12 }}>or</span>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }} className="px-muted">
            Exact clock-out time
            <input
              className="px-input"
              type="datetime-local"
              aria-label="Clock-out time"
              data-testid={`ls-end-${item.id}`}
              value={at}
              min={toLocalInput(startMs + 60_000, timezone)}
              max={toLocalInput(nowMs, timezone)}
              onChange={(e) => onEndAt(e.target.value)}
            />
          </label>
          <span style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
            <button className="px-btn px-btn--sm" onClick={() => setEditing(false)}>Cancel</button>
            <button className="px-btn px-btn--sm px-btn--primary" data-testid={`ls-save-${item.id}`} disabled={busy || error !== null} onClick={() => void save()}>
              {running ? 'Clock out' : 'Save time'}
            </button>
          </span>
          {error && (
            <div className="px-error" style={{ flexBasis: '100%', margin: 0 }} data-testid={`ls-error-${item.id}`}>
              {error}
            </div>
          )}
        </div>
      )}
    </li>
  );
}
