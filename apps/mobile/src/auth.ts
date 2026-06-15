/** Better Auth client calls (§13) — plain fetch against the API (absolute URL). */
import { config } from './config';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

const api = config.apiBaseUrl;

export async function getSession(): Promise<SessionUser | null> {
  const res = await fetch(`${api}/api/auth/get-session`, { credentials: 'include' });
  if (!res.ok) return null;
  const body = (await res.json()) as { user?: SessionUser } | null;
  return body?.user ?? null;
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
