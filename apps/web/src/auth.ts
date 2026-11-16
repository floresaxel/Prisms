/** Better Auth client calls (§13) — plain fetch against the proxied API. */
import { config } from './config';
import type { SessionAnswer } from './session-boot';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

const api = config.apiBaseUrl;

/**
 * Who is signed in, as the server sees it.
 *
 * Only a real answer is one: a signed-out session comes back as `200 null`
 * (or a 401/403), and that is "signed out". Anything else — no network, a 5xx
 * while the API restarts — is "unknown", not "signed out": the app already on
 * screen from local data stays there rather than being thrown back to the
 * sign-in form by a server hiccup.
 */
export async function checkSession(doFetch: typeof fetch = fetch): Promise<SessionAnswer> {
  let res: Response;
  try {
    res = await doFetch(`${api}/api/auth/get-session`, { credentials: 'include' });
  } catch {
    return { kind: 'unknown' };
  }
  if (res.status === 401 || res.status === 403) return { kind: 'signed-out' };
  if (!res.ok) return { kind: 'unknown' };
  try {
    const body = (await res.json()) as { user?: SessionUser } | null;
    return body?.user ? { kind: 'user', user: body.user } : { kind: 'signed-out' };
  } catch {
    return { kind: 'unknown' };
  }
}

async function post(path: string, payload: unknown): Promise<Response> {
  return fetch(`${api}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function fail(res: Response): Promise<never> {
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  throw new Error(body?.message ?? `request failed (${res.status})`);
}

export async function signIn(email: string, password: string): Promise<SessionUser> {
  const res = await post('/api/auth/sign-in/email', { email, password });
  if (!res.ok) return fail(res);
  return ((await res.json()) as { user: SessionUser }).user;
}

export async function signUp(name: string, email: string, password: string): Promise<SessionUser> {
  const res = await post('/api/auth/sign-up/email', { name, email, password });
  if (!res.ok) return fail(res);
  return ((await res.json()) as { user: SessionUser }).user;
}

export async function signOut(): Promise<void> {
  await post('/api/auth/sign-out', {});
}
