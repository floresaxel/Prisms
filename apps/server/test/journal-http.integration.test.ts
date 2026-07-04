/**
 * J2 — the GET /sync/journal/export HTTP wrapper (D7): an authed round-trip
 * returns the user's live notes date-ordered with emoji byte-exact through JSON;
 * no session → 401; the shared endpoint rate gate → 429 + Retry-After.
 *
 * Gated on PRISMS_DB_TEST_URL.
 */
import { randomUUID } from 'node:crypto';

import { loadRootEnv, runMigrations } from '@prisms/db';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp, type PrismsServer } from '../src/app';
import { DEV_AUTH_SECRET, DEV_POWERSYNC_SECRET } from '../src/env';

loadRootEnv();
const adminUrl = process.env.PRISMS_DB_TEST_URL;
const PASSWORD = 'demo-password-123';
const ZWJ = '👨‍👩‍👧‍👦';

const cookiesFrom = (res: Response): string =>
  res.headers.getSetCookie().map((c) => c.split(';')[0]!).join('; ');

describe.skipIf(!adminUrl)('J2 /sync/journal/export (D7 HTTP)', () => {
  const dbName = `prisms_jx_${Date.now().toString(36)}`;
  let url: string;
  let sql: postgres.Sql;
  let server: PrismsServer;
  let cookie: string;
  let hc = 0;
  const hlc = () => `${(++hc).toString(16).padStart(12, '0')}-0000-devx`;

  const uploadJournal = (entry_date: string, content: string) =>
    server.app.request('/sync/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        device_id: 'devx',
        commands: [{ id: randomUUID(), name: 'journal.write', hlc: hlc(), payload: { id: randomUUID(), entry_date, content }, schema_version: 1 }],
      }),
    });
  const exportReq = (headers: Record<string, string> = {}) => server.app.request('/sync/journal/export', { headers });

  beforeAll(async () => {
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    await admin.end();
    url = new URL(`/${dbName}`, adminUrl!).toString();
    await runMigrations(url);
    sql = postgres(url, { max: 1, onnotice: () => undefined });
    server = createApp({
      databaseUrl: url,
      baseUrl: 'http://localhost',
      betterAuthSecret: DEV_AUTH_SECRET,
      trustedOrigins: ['http://app.prisms.test'],
      powersync: { secret: DEV_POWERSYNC_SECRET, kid: 'powersync-dev', audience: 'powersync-dev', ttlSeconds: 300 },
      rateLimit: { limit: 1000, windowMs: 60_000 }, // dispatcher limiter; the endpoint gate is a fixed 30
      quiet: true,
    });
    await server.app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Jx', email: 'jx@prisms.test', password: PASSWORD }),
    });
    const signIn = await server.app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'jx@prisms.test', password: PASSWORD }),
    });
    cookie = cookiesFrom(signIn);
  });

  afterAll(async () => {
    await server?.close();
    await sql?.end();
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  it('unauthenticated GET → 401', async () => {
    expect((await exportReq()).status).toBe(401);
  });

  it('authed export returns the notes date-ordered, emoji byte-exact through JSON', async () => {
    expect((await uploadJournal('2026-05-02', 'may note')).status).toBe(200);
    expect((await uploadJournal('2026-03-09', ZWJ)).status).toBe(200);
    const res = await exportReq({ cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: { entry_date: string; content: string; updated_at: string }[] };
    expect(body.entries.map((e) => e.entry_date)).toEqual(['2026-03-09', '2026-05-02']);
    expect(body.entries[0]!.content).toBe(ZWJ); // surrogate pairs intact through HTTP
  });

  it('the shared endpoint rate gate returns 429 + Retry-After', async () => {
    let last: Response | undefined;
    for (let i = 0; i < 31; i++) last = await exportReq({ cookie }); // fixed limit 30 → the last is denied
    expect(last!.status).toBe(429);
    expect(last!.headers.get('Retry-After')).toBeTruthy();
  });
});
