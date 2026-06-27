/**
 * M0 spike — client command identity end-to-end (V2, 1.3 §7.2b).
 *
 * The client mints a UUIDv7 command id + HLC at write time (the @prisms/ui
 * two-layer store); the connector uploads that envelope verbatim (no upload-time
 * id). This asserts the SERVER half of that contract against the real
 * dispatcher + Postgres: the persisted `command_log.id` equals the client id,
 * so the optimistic overlay reconciles to the identical canonical row. It also
 * pins the surrounding guarantees the overlay reconciliation relies on:
 * idempotent replay (noop), cross-user ownership scoping, and strict payloads
 * (the server rejects client-supplied trust fields).
 *
 * The boundary forbids apps/server from importing @prisms/ui, so the client
 * envelope is built here exactly as `uploadClientCommands` builds it — the same
 * shape the ui unit tests assert on the other side of the seam.
 *
 * Gated on PRISMS_DB_TEST_URL (skips without the compose stack), like the
 * convergence harness.
 */
import { randomUUID } from 'node:crypto';

import { asEpochMillis, hlcEncode, hlcTick, uuidV7From, type Hlc } from '@prisms/core';
import { loadRootEnv, runMigrations } from '@prisms/db';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDispatcher, type Dispatcher } from '../src/dispatcher';
import { createRateLimiter } from '../src/rate-limit';

loadRootEnv();
const adminUrl = process.env.PRISMS_DB_TEST_URL;

interface Envelope {
  id: string;
  name: string;
  hlc: string;
  payload: unknown;
}

/** Mint a client command envelope the way the two-layer store does (id + HLC at write). */
let clockMs = 1_718_000_000_000;
let hlcState: Hlc | null = null;
function clientCommand(name: string, payload: unknown): Envelope {
  clockMs += 1;
  const id = uuidV7From(clockMs, new Uint8Array(16).fill(0x7a));
  hlcState = hlcTick(hlcState, asEpochMillis(clockMs), 'web-1');
  return { id, name, hlc: hlcEncode(hlcState), payload };
}

describe.skipIf(!adminUrl)('M0 spike — client command identity (V2)', () => {
  const dbName = `prisms_m0_${Date.now().toString(36)}`;
  let url: string;
  let sql: postgres.Sql;
  let dispatcher: Dispatcher;

  let seedSeq = 0;
  const seedCmd = (name: string, payload: unknown): Envelope => ({
    id: randomUUID(),
    name,
    hlc: `${(++seedSeq).toString(16).padStart(12, '0')}-0000-seed`,
    payload,
  });

  const upload = (userId: string, deviceId: string, commands: Envelope[]) =>
    dispatcher.handleUpload(userId, { device_id: deviceId, commands });

  async function project(userId: string) {
    const ids = { vision: randomUUID(), roadmap: randomUUID(), project: randomUUID(), task: randomUUID() };
    const res = await upload(userId, 'seed', [
      seedCmd('node.create', { id: ids.vision, node_type: 'vision', title: 'V', sort_order: 'a0' }),
      seedCmd('node.create', { id: ids.roadmap, node_type: 'roadmap', title: 'R', sort_order: 'a0', parent_id: ids.vision }),
      seedCmd('node.create', { id: ids.project, node_type: 'project', title: 'P', sort_order: 'a0', parent_id: ids.roadmap }),
      seedCmd('node.create', { id: ids.task, node_type: 'task', title: 'T', sort_order: 'a0', parent_id: ids.project }),
    ]);
    if (res.kind !== 'ok') throw new Error(`seed not ok: ${res.kind}`);
    return ids;
  }

  beforeAll(async () => {
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    await admin.end();
    url = new URL(`/${dbName}`, adminUrl!).toString();
    await runMigrations(url);
    sql = postgres(url, { max: 4, onnotice: () => undefined });
    dispatcher = createDispatcher(drizzle(sql), createRateLimiter({ limit: 100_000, windowMs: 60_000 }));
  });

  afterAll(async () => {
    await sql?.end();
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  it('persists command_log.id == the client-minted command id (V2)', async () => {
    const user = randomUUID();
    const p = await project(user);
    const cmd = clientCommand('node.rename', { id: p.task, title: 'Renamed' });

    const res = await upload(user, 'web-1', [cmd]);
    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') return;
    expect(res.results[0]).toMatchObject({ id: cmd.id, result: 'applied' });

    // V2: the server stored the command under the SAME id the client minted.
    const log = await sql`SELECT id, name, hlc, result FROM command_log WHERE id = ${cmd.id}`;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ id: cmd.id, name: 'node.rename', hlc: cmd.hlc, result: 'applied' });

    // the canonical row the overlay reconciles to carries the optimistic title.
    const [row] = await sql`SELECT title FROM nodes WHERE id = ${p.task}`;
    expect(row!['title']).toBe('Renamed');
  });

  it('replaying the same command id is an idempotent noop (overlay still reconciles)', async () => {
    const user = randomUUID();
    const p = await project(user);
    const cmd = clientCommand('node.rename', { id: p.task, title: 'Once' });

    const first = await upload(user, 'web-1', [cmd]);
    const second = await upload(user, 'web-1', [cmd]);
    expect(first.kind === 'ok' && first.results[0]!.result).toBe('applied');
    expect(second.kind === 'ok' && second.results[0]).toMatchObject({ result: 'noop', original_result: 'applied' });

    const log = await sql`SELECT count(*)::int AS n FROM command_log WHERE id = ${cmd.id}`;
    expect(log[0]!['n']).toBe(1); // one row, idempotent by command id
  });

  it('rejects a cross-user command (JWT/ownership scoping blocks foreign rows)', async () => {
    const owner = randomUUID();
    const attacker = randomUUID();
    const p = await project(owner);
    const cmd = clientCommand('node.rename', { id: p.task, title: 'Hijacked' });

    const res = await upload(attacker, 'web-evil', [cmd]);
    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') return;
    expect(res.results[0]).toMatchObject({ id: cmd.id, result: 'rejected', reject_code: 'E_OWNERSHIP' });

    const [row] = await sql`SELECT title FROM nodes WHERE id = ${p.task}`;
    expect(row!['title']).toBe('T'); // untouched
  });

  it('rejects a payload carrying a client-supplied trust field (strict catalog)', async () => {
    const user = randomUUID();
    const p = await project(user);
    // the client strips these (stripTrustFields); the server is the backstop.
    const cmd = clientCommand('node.rename', { id: p.task, title: 'X', user_id: 'forged' });

    const res = await upload(user, 'web-1', [cmd]);
    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') return;
    expect(res.results[0]).toMatchObject({ id: cmd.id, result: 'rejected', reject_code: 'E_PARSE' });
  });
});
