/**
 * S10 DoD integration suite, against real infrastructure:
 * - register/login via Better Auth (drizzle adapter on a fresh database)
 * - short-lived JWT verified by the PowerSync dev instance in compose
 * - settings.update round-trips through the §8 pipeline
 * - replay → noop; rejections logged; rate limit → 429
 *
 * Gated on PRISMS_DB_TEST_URL (admin connection used to create a throwaway
 * database). PowerSync is reached at PRISMS_POWERSYNC_URL, defaulting to
 * localhost:${PRISMS_POWERSYNC_PORT ?? 8080} (the compose service).
 */
import { randomUUID } from 'node:crypto';

import { loadRootEnv, runMigrations } from '@prisms/db';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp, type PrismsServer } from '../src/app';
import { DEV_AUTH_SECRET, DEV_POWERSYNC_SECRET } from '../src/env';

loadRootEnv();
const adminUrl = process.env.PRISMS_DB_TEST_URL;
const powersyncUrl =
  process.env.PRISMS_POWERSYNC_URL ??
  `http://localhost:${process.env.PRISMS_POWERSYNC_PORT ?? '8080'}`;

const PASSWORD = 'demo-password-123';

function cookiesFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0]!)
    .join('; ');
}

let hlcCounter = 0;
const nextHlc = () =>
  `${(++hlcCounter).toString(16).padStart(12, '0')}-0000-test-device`;

const command = (payload: unknown, name = 'settings.update') => ({
  id: randomUUID(),
  name,
  hlc: nextHlc(),
  payload,
});

describe.skipIf(!adminUrl)('S10 API integration (auth, PowerSync JWT, settings.update)', () => {
  const dbName = `prisms_s10_test_${Date.now().toString(36)}`;
  let url: string;
  let sql: postgres.Sql;
  let server: PrismsServer;
  let cookie: string;
  let userId: string;
  let powersyncToken: string;

  const upload = (commands: unknown[], cookieHeader = cookie, deviceId = 'test-device') =>
    server.app.request('/sync/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieHeader },
      body: JSON.stringify({ device_id: deviceId, commands }),
    });

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
      powersync: {
        secret: DEV_POWERSYNC_SECRET,
        kid: 'powersync-dev',
        audience: 'powersync-dev',
        ttlSeconds: 300,
      },
      rateLimit: { limit: 10, windowMs: 60_000 },
      quiet: true,
    });
  });

  afterAll(async () => {
    await server?.close();
    await sql?.end();
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  it('GET /health answers without auth', async () => {
    const res = await server.app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', service: 'prisms-api' });
  });

  it('registers and logs in (Better Auth email+password)', async () => {
    const signUp = await server.app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Demo', email: 'demo@prisms.test', password: PASSWORD }),
    });
    expect(signUp.status).toBe(200);
    const created = (await signUp.json()) as { user: { id: string } };
    userId = created.user.id;
    // user ids are uuids so they fit every domain user_id column (§6)
    expect(userId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    const signIn = await server.app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'demo@prisms.test', password: PASSWORD }),
    });
    expect(signIn.status).toBe(200);
    cookie = cookiesFrom(signIn);
    expect(cookie).toContain('better-auth');
  });

  it('issues a short-lived PowerSync JWT for the session user', async () => {
    const unauthenticated = await server.app.request('/api/powersync/token');
    expect(unauthenticated.status).toBe(401);

    const res = await server.app.request('/api/powersync/token', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expires_at: string };
    expect(body.token.split('.')).toHaveLength(3);
    const msLeft = new Date(body.expires_at).getTime() - Date.now();
    expect(msLeft).toBeGreaterThan(0);
    expect(msLeft).toBeLessThanOrEqual(300_000);
    powersyncToken = body.token;

    const claims = JSON.parse(
      Buffer.from(body.token.split('.')[1]!, 'base64url').toString(),
    ) as { sub: string; aud: string };
    expect(claims.sub).toBe(userId);
    expect(claims.aud).toBe('powersync-dev');
  });

  it('PowerSync dev instance verifies the JWT (DoD)', async () => {
    const stream = await fetch(`${powersyncUrl}/sync/stream`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${powersyncToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(15_000),
    });
    expect(stream.status).toBe(200);
    await stream.body?.cancel();

    const rejected = await fetch(`${powersyncUrl}/sync/stream`, {
      method: 'POST',
      headers: { authorization: 'Bearer not-a-token', 'content-type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(15_000),
    });
    expect(rejected.status).toBe(401);
    await rejected.body?.cancel();
  });

  const firstUpdate = command({ day_reset_hour: 6, timezone: 'Europe/Paris' });

  it('settings.update round-trips (first wired command)', async () => {
    const res = await upload([firstUpdate]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { result: string }[] };
    expect(body.results).toEqual([{ id: firstUpdate.id, result: 'applied' }]);

    const [row] = await sql`
      SELECT day_reset_hour, timezone, weather_location FROM user_settings
      WHERE user_id = ${userId}`;
    expect(row).toMatchObject({
      day_reset_hour: 6,
      timezone: 'Europe/Paris',
      weather_location: null,
    });
  });

  it('patches are minimal-field (§2.8): untouched fields survive', async () => {
    const setWeather = command({
      weather_location: { lat: 28.36, lon: -80.69, label: 'Merritt Island, FL' },
    });
    expect((await upload([setWeather])).status).toBe(200);
    let [row] = await sql`
      SELECT day_reset_hour, timezone, weather_location FROM user_settings
      WHERE user_id = ${userId}`;
    expect(row!['day_reset_hour']).toBe(6);
    expect(row!['weather_location']).toMatchObject({ label: 'Merritt Island, FL' });

    const clearWeather = command({ weather_location: null });
    expect((await upload([clearWeather])).status).toBe(200);
    [row] = await sql`
      SELECT timezone, weather_location FROM user_settings WHERE user_id = ${userId}`;
    expect(row).toMatchObject({ timezone: 'Europe/Paris', weather_location: null });
  });

  it('replaying a command id is a noop with the original result (§8)', async () => {
    const res = await upload([firstUpdate]);
    const body = (await res.json()) as { results: unknown[] };
    expect(body.results).toEqual([
      { id: firstUpdate.id, result: 'noop', original_result: 'applied' },
    ]);
    const logs = await sql`SELECT result FROM command_log WHERE id = ${firstUpdate.id}`;
    expect(logs).toHaveLength(1);
  });

  it('rejects machine-readably and logs the rejection', async () => {
    const badRange = command({ day_reset_hour: 25 });
    const unknownVerb = command({ id: 'x' }, 'node.create');
    const res = await upload([badRange, unknownVerb]);
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as {
      results: { result: string; reject_code?: string }[];
    };
    expect(results[0]).toMatchObject({ result: 'rejected', reject_code: 'E_PARSE' });
    expect(results[1]).toMatchObject({ result: 'rejected', reject_code: 'E_UNKNOWN_COMMAND' });

    // logged → replay of a rejection is a noop too
    const replay = await upload([badRange]);
    const replayBody = (await replay.json()) as { results: unknown[] };
    expect(replayBody.results).toEqual([
      { id: badRange.id, result: 'noop', original_result: 'rejected' },
    ]);
  });

  it('a foreign command id is rejected with E_OWNERSHIP', async () => {
    const signUp = await server.app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Two', email: 'two@prisms.test', password: PASSWORD }),
    });
    expect(signUp.status).toBe(200);
    const otherCookie = cookiesFrom(signUp);

    const res = await upload([{ ...firstUpdate, hlc: nextHlc() }], otherCookie);
    const { results } = (await res.json()) as { results: { reject_code?: string }[] };
    expect(results[0]).toMatchObject({ result: 'rejected', reject_code: 'E_OWNERSHIP' });
  });

  it('rate limit returns 429 with Retry-After and applies nothing (DoD)', async () => {
    const signUp = await server.app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Three', email: 'three@prisms.test', password: PASSWORD }),
    });
    const limitedCookie = cookiesFrom(signUp);
    const burst = Array.from({ length: 11 }, () => command({ day_reset_hour: 5 }));

    const res = await upload(burst, limitedCookie);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    const body = (await res.json()) as { error: string; verb: string };
    expect(body).toMatchObject({ error: 'E_RATE_LIMITED', verb: 'settings.update' });

    const created = (await signUp.clone().json().catch(() => null)) as {
      user: { id: string };
    } | null;
    if (created) {
      const rows = await sql`SELECT 1 FROM user_settings WHERE user_id = ${created.user.id}`;
      expect(rows).toHaveLength(0);
    }
  });

  it('rejects unauthenticated and malformed uploads', async () => {
    const noAuth = await upload([command({ day_reset_hour: 5 })], '');
    expect(noAuth.status).toBe(401);

    const badJson = await server.app.request('/sync/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: '{not json',
    });
    expect(badJson.status).toBe(400);

    const badShape = await upload([{ nope: true }]);
    expect(badShape.status).toBe(400);
  });
});
