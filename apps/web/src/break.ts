/**
 * Breaks: clock out of everything for 5–30 minutes, then be offered to clock
 * back in to the same tasks.
 *
 * Timeline of a break of `minutes`:
 *   - `on`      — counting down; clock-in is off everywhere.
 *   - `ending`  — the last minute: the "clock back in?" prompt opens (once).
 *   - `over`    — past the end, by up to OVERTIME_MS: the countdown goes negative
 *                 and the prompt stays up.
 *   - `expired` — OVERTIME_MS past the end: the break closes by itself and the
 *                 tasks stay clocked out.
 * However it closes, it is recorded (`break.log`, capped at the end + OVERTIME_MS)
 * and the journal's day log shows it on the day it started — as an event of the
 * day, never as text in the note.
 *
 * The running break lives on THIS device (localStorage, per account), shared by
 * its open tabs; the recorded break is what syncs.
 */
import { useSyncExternalStore } from 'react';

export const BREAK_MIN_MINUTES = 5;
export const BREAK_MAX_MINUTES = 30;
export const BREAK_STEP_MINUTES = 5;
export const BREAK_DEFAULT_MINUTES = 15;
/** The "clock back in?" prompt opens with this much of the break left. */
export const BREAK_PROMPT_MS = 60_000;
/** How long past its end a break may run before it closes by itself. */
export const BREAK_OVERTIME_MS = 10 * 60_000;
/** Why every Clock in button is off during a break. */
export const ON_BREAK_TITLE = "You're on a break — clock back in or end it first";

export interface BreakTask {
  taskId: string;
  title: string;
}

export interface ActiveBreak {
  id: string;
  /** epoch ms */
  startedAt: number;
  minutes: number;
  /** The tasks the break clocked out of — offered back when it ends. */
  tasks: BreakTask[];
  /** The "clock back in?" prompt has been shown (it shows once per break). */
  prompted: boolean;
}

export type BreakPhase = 'on' | 'ending' | 'over' | 'expired';

export function breakEndsAt(b: ActiveBreak): number {
  return b.startedAt + b.minutes * 60_000;
}

/**
 * Time left on the break; negative once it has run over. Never more than the
 * break's length: the shared second clock can lag the start by up to a second,
 * which would otherwise read "5:01" on a 5-minute break.
 */
export function breakRemainingMs(b: ActiveBreak, now: number): number {
  return Math.min(breakEndsAt(b) - now, b.minutes * 60_000);
}

export function breakPhase(b: ActiveBreak, now: number): BreakPhase {
  const left = breakRemainingMs(b, now);
  if (left <= -BREAK_OVERTIME_MS) return 'expired';
  if (left <= 0) return 'over';
  if (left <= BREAK_PROMPT_MS) return 'ending';
  return 'on';
}

/** How long the break lasted if it closes at `endAt` — never more than its end + the overtime. */
export function breakTakenMs(b: ActiveBreak, endAt: number): number {
  return Math.max(0, Math.min(endAt, breakEndsAt(b) + BREAK_OVERTIME_MS) - b.startedAt);
}

/** "14:59", "0:05", and past the end "-1:20" (whole seconds; the minus only once it is a second over). */
export function formatCountdown(ms: number): string {
  const negative = ms <= -1000;
  // counting down, a part-second still left shows as that second; past the end, whole seconds over
  const shown = negative ? Math.floor(-ms / 1000) : Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(shown / 60);
  const s = shown % 60;
  return `${negative ? '-' : ''}${m}:${String(s).padStart(2, '0')}`;
}

/**
 * When the break is recorded as ending if it closes at `endAt`: the real end, but
 * never more than its planned end + the overtime (a break left running while the
 * app was closed for hours is logged as 10 min over, not hours).
 */
export function breakLogEnd(b: ActiveBreak, endAt: number): number {
  return b.startedAt + breakTakenMs(b, endAt);
}

// --- persistence (this device, per account) ---------------------------------

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;

const keyFor = (userId: string) => `prisms.break.${userId}`;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function parse(raw: string | null): ActiveBreak | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<ActiveBreak>;
    if (typeof v.id !== 'string' || typeof v.startedAt !== 'number' || typeof v.minutes !== 'number' || !Array.isArray(v.tasks)) return null;
    return { id: v.id, startedAt: v.startedAt, minutes: v.minutes, tasks: v.tasks, prompted: v.prompted === true };
  } catch {
    return null;
  }
}

const listeners = new Set<() => void>();
/** Snapshot cache so useSyncExternalStore sees a stable object between changes. */
const cache = new Map<string, { raw: string | null; value: ActiveBreak | null }>();

export function loadBreak(userId: string, s: Storage | null = storage()): ActiveBreak | null {
  const raw = s?.getItem(keyFor(userId)) ?? null;
  const hit = cache.get(userId);
  if (hit && hit.raw === raw) return hit.value;
  const value = parse(raw);
  cache.set(userId, { raw, value });
  return value;
}

function notify(): void {
  for (const l of listeners) l();
}

export function saveBreak(userId: string, b: ActiveBreak, s: Storage | null = storage()): void {
  s?.setItem(keyFor(userId), JSON.stringify(b));
  notify();
}

/**
 * Close the break `id` — only if it is still the running one. Returns it when THIS
 * call closed it, null when it was already gone (another tab, or a second click),
 * so a break is logged and resumed exactly once.
 */
export function takeBreak(userId: string, id: string, s: Storage | null = storage()): ActiveBreak | null {
  const current = loadBreak(userId, s);
  if (!current || current.id !== id) return null;
  s?.removeItem(keyFor(userId));
  notify();
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // other tabs of this account
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key.startsWith('prisms.break.')) listener();
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

/** The running break of this account on this device (null when none), live across tabs. */
export function useActiveBreak(userId: string): ActiveBreak | null {
  return useSyncExternalStore(
    subscribe,
    () => loadBreak(userId),
    () => null,
  );
}
