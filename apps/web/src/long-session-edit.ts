/**
 * Pure helpers behind the long-session review card: the two ways to fix a
 * session (how long you really worked, or exactly when you stopped) both
 * resolve to one end instant, read and written in the user's own timezone.
 */
import { asEpochMillis, localInstant, localParts } from '@prisms/core';

const pad = (n: number): string => String(n).padStart(2, '0');

/** An instant as a `<input type="datetime-local">` value in `tz`. */
export function toLocalInput(ms: number, tz: string): string {
  const p = localParts(asEpochMillis(Math.floor(ms)), tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** A `datetime-local` value read as wall time in `tz`; null when unparseable. */
export function fromLocalInput(value: string, tz: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  return localInstant(m[1]!, Number(m[2]), tz, Number(m[3]));
}

/** Whole hours + leftover minutes of a duration (rounded to the minute). */
export function splitDuration(ms: number): { hours: number; minutes: number } {
  const total = Math.max(0, Math.round(ms / 60_000));
  return { hours: Math.floor(total / 60), minutes: total % 60 };
}

export function formatDuration(ms: number): string {
  const { hours, minutes } = splitDuration(ms);
  return `${hours}h ${pad(minutes)}m`;
}

/** "How long did you work" fields → the session's end instant; null if not a number. */
export function endFromDuration(startMs: number, hours: string, minutes: string): number | null {
  const h = hours.trim() === '' ? 0 : Number(hours);
  const m = minutes.trim() === '' ? 0 : Number(minutes);
  if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || m < 0) return null;
  return startMs + Math.round((h * 60 + m) * 60_000);
}

/** Why an end can't be saved, or null when it can (mirrors core checkAdjustEntry). */
export function endError(endMs: number | null, startMs: number, nowMs: number): string | null {
  if (endMs === null) return 'Enter a valid time.';
  if (endMs <= startMs) return 'The session has to end after it started.';
  if (endMs > nowMs + 60_000) return "A session can't end in the future.";
  return null;
}
