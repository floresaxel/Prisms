/**
 * Boot without waiting on the server.
 *
 * Everything the first screen shows is in the local database, so the only
 * thing a cold load used to wait for that it did not need was the session
 * check: one round-trip to the API before the database could even start
 * opening. Instead, the last account this browser was signed in as is
 * remembered here; its database opens at once (`early-open.ts`) and its shell
 * renders from local data while the server is asked, in the background,
 * whether that is still who is signed in.
 *
 * What the answer can do is decided by `settleBootSession`, kept pure so every
 * case is tested on its own.
 */
import type { SessionUser } from './auth';

/** The localStorage key. e2e specs read it too (the session user's id, without a DB round-trip). */
export const USER_CACHE = 'prisms.user';

/** The remembered account, or null — never a half-parsed one, and never a throw (private mode, blocked storage). */
export function readCachedUser(): SessionUser | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(USER_CACHE);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const u = JSON.parse(raw) as Partial<SessionUser> | null;
    if (u && typeof u.id === 'string' && u.id.length > 0 && typeof u.email === 'string' && typeof u.name === 'string') {
      return { id: u.id, email: u.email, name: u.name };
    }
  } catch {
    /* corrupt: treat as nothing remembered */
  }
  return null;
}

export function rememberUser(user: SessionUser): void {
  try {
    localStorage.setItem(USER_CACHE, JSON.stringify({ id: user.id, email: user.email, name: user.name }));
  } catch {
    /* storage blocked: the next load simply waits for the server, as before */
  }
}

export function forgetCachedUser(): void {
  try {
    localStorage.removeItem(USER_CACHE);
  } catch {
    /* nothing to forget */
  }
}

/** What the server said about who is signed in. */
export type SessionAnswer =
  | { kind: 'user'; user: SessionUser }
  | { kind: 'signed-out' }
  /** It could not be asked: offline, or the API failed. Says nothing either way. */
  | { kind: 'unknown' };

export type BootOutcome =
  /** The remembered account is the one signed in (or nothing was remembered): carry on, and sync. */
  | { action: 'keep'; user: SessionUser }
  /** Someone ELSE is signed in on this browser now: drop the remembered account's screens and open theirs. */
  | { action: 'switch'; user: SessionUser }
  /** Nobody is signed in: back to the sign-in form. */
  | { action: 'sign-in' }
  /** No answer: keep the remembered account on screen and sync as soon as the network allows — the offline path, unchanged. */
  | { action: 'offline' };

/**
 * Turn the server's answer into what the app does with the account it booted
 * as. Syncing (and with it uploading this device's queued commands) waits for
 * this, because the queue belongs to the REMEMBERED account: uploading it under
 * a different account's session would post one person's changes into another's
 * data. Reading local data needs no session, which is why the screens did not
 * have to wait.
 */
export function settleBootSession(remembered: SessionUser | null, answer: SessionAnswer): BootOutcome {
  switch (answer.kind) {
    case 'user':
      return remembered && remembered.id !== answer.user.id ? { action: 'switch', user: answer.user } : { action: 'keep', user: answer.user };
    case 'signed-out':
      return { action: 'sign-in' };
    case 'unknown':
      return { action: 'offline' };
  }
}
