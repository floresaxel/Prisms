// @vitest-environment jsdom
/**
 * Phase 3 of the load plan: the app boots as the REMEMBERED account, from its
 * local data, and asks the server in the background. These are the pieces that
 * decide what that answer does — each case on its own, since a wrong one either
 * signs someone out for no reason or shows (and syncs) the wrong account.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { checkSession } from '../src/auth';
import {
  forgetCachedUser,
  readCachedUser,
  rememberUser,
  settleBootSession,
  USER_CACHE,
  type SessionAnswer,
} from '../src/session-boot';
import { installMemoryStorage } from './util/memory-storage';

const A = { id: 'user-a', email: 'a@prisms.test', name: 'A' };
const B = { id: 'user-b', email: 'b@prisms.test', name: 'B' };

let storage: Storage;
beforeEach(() => {
  storage = installMemoryStorage();
});

describe('the remembered account', () => {
  it('round-trips, and forgetting it leaves nothing', () => {
    expect(readCachedUser()).toBeNull();
    rememberUser(A);
    expect(readCachedUser()).toEqual(A);
    forgetCachedUser();
    expect(readCachedUser()).toBeNull();
  });

  it('keeps the format e2e specs read (`prisms.user`, JSON with the id)', () => {
    rememberUser(A);
    expect(JSON.parse(storage.getItem(USER_CACHE)!)).toEqual(A);
    expect(USER_CACHE).toBe('prisms.user');
  });

  it('stores only the three fields, whatever the server sent alongside', () => {
    rememberUser({ ...A, image: 'x', emailVerified: true } as typeof A);
    expect(JSON.parse(storage.getItem(USER_CACHE)!)).toEqual(A);
  });

  it.each([
    ['corrupt JSON', '{"id":'],
    ['JSON null', 'null'],
    ['no id', JSON.stringify({ email: 'a@x', name: 'A' })],
    ['an empty id', JSON.stringify({ id: '', email: 'a@x', name: 'A' })],
    ['a numeric id', JSON.stringify({ id: 7, email: 'a@x', name: 'A' })],
    ['no email', JSON.stringify({ id: 'a', name: 'A' })],
  ])('reads %s as nothing remembered — never a half-account to open a database for', (_what, raw) => {
    storage.setItem(USER_CACHE, raw);
    expect(readCachedUser()).toBeNull();
  });

  it('survives storage that throws (private mode, blocked site data)', () => {
    const blocked = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    Object.defineProperty(window, 'localStorage', { value: blocked, configurable: true, writable: true });
    expect(readCachedUser()).toBeNull();
    expect(() => rememberUser(A)).not.toThrow();
    expect(() => forgetCachedUser()).not.toThrow();
  });
});

describe('settleBootSession — what the server’s answer does to the account the app booted as', () => {
  const user = (u: typeof A): SessionAnswer => ({ kind: 'user', user: u });

  it('the same account: keep it, with the server’s fresh name and email', () => {
    const renamed = { ...A, name: 'A renamed' };
    expect(settleBootSession(A, user(renamed))).toEqual({ action: 'keep', user: renamed });
  });

  it('a DIFFERENT account is signed in: switch — never carry on (and sync) as the remembered one', () => {
    expect(settleBootSession(A, user(B))).toEqual({ action: 'switch', user: B });
  });

  it('nothing remembered but a session exists: adopt it', () => {
    expect(settleBootSession(null, user(B))).toEqual({ action: 'keep', user: B });
  });

  it('signed out: back to the sign-in form, remembered or not', () => {
    expect(settleBootSession(A, { kind: 'signed-out' })).toEqual({ action: 'sign-in' });
    expect(settleBootSession(null, { kind: 'signed-out' })).toEqual({ action: 'sign-in' });
  });

  it('no answer (offline, server error): stay as the remembered account — the offline path', () => {
    expect(settleBootSession(A, { kind: 'unknown' })).toEqual({ action: 'offline' });
    expect(settleBootSession(null, { kind: 'unknown' })).toEqual({ action: 'offline' });
  });
});

describe('checkSession — only a real answer counts as one', () => {
  const reply = (status: number, body: unknown) =>
    vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('200 with a user → that user', async () => {
    await expect(checkSession(reply(200, { user: A, session: {} }))).resolves.toEqual({ kind: 'user', user: A });
  });

  it('200 null (how Better Auth says "not signed in") → signed out', async () => {
    await expect(checkSession(reply(200, null))).resolves.toEqual({ kind: 'signed-out' });
  });

  it.each([401, 403])('%i → signed out', async (status) => {
    await expect(checkSession(reply(status, { error: 'nope' }))).resolves.toEqual({ kind: 'signed-out' });
  });

  it.each([500, 502, 503, 429])('%i → unknown, NOT signed out: a server hiccup must not throw anyone out', async (status) => {
    await expect(checkSession(reply(status, 'Bad Gateway'))).resolves.toEqual({ kind: 'unknown' });
  });

  it('no network → unknown', async () => {
    const offline = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(checkSession(offline)).resolves.toEqual({ kind: 'unknown' });
  });

  it('a 200 that is not JSON (a captive portal, a proxy page) → unknown', async () => {
    await expect(checkSession(reply(200, '<html>log in to the wifi</html>'))).resolves.toEqual({ kind: 'unknown' });
  });
});
