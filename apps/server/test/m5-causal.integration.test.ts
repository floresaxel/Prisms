/**
 * M5 — causal ordering, schema floor, and the review inbox (§7.2e, §7.11, §7.13).
 *
 * A command whose `depends_on` references a rejected command is itself rejected
 * `E_DEPENDENCY_REJECTED`; one referencing an unknown command is `E_UNKNOWN_TARGET`;
 * a command below the schema floor is `E_CLIENT_TOO_OLD`. Every rejection creates
 * a durable `sync_review_items` row and the response carries its id.
 *
 * Gated on PRISMS_DB_TEST_URL.
 */
import { randomUUID } from 'node:crypto';

import { asEpochMillis, hlcEncode, hlcTick, type Hlc } from '@prisms/core';
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
  depends_on?: string[];
  schema_version?: number;
}

let clockMs = 1_720_000_000_000;
let hlcState: Hlc | null = null;
function mk(name: string, payload: unknown, extra: { depends_on?: string[]; schema_version?: number } = {}): Envelope {
  clockMs += 1;
  hlcState = hlcTick(hlcState, asEpochMillis(clockMs), 'web-1');
  return { id: randomUUID(), name, hlc: hlcEncode(hlcState), payload, ...extra };
}

describe.skipIf(!adminUrl)('M5 — causal ordering + schema floor + review inbox', () => {
  const dbName = `prisms_m5c_${Date.now().toString(36)}`;
  let sql: postgres.Sql;
  let dispatcher: Dispatcher;
  const upload = (userId: string, commands: Envelope[]) => dispatcher.handleUpload(userId, { device_id: 'web-1', commands });

  let seedSeq = 0;
  const seedCmd = (name: string, payload: unknown): Envelope => ({ id: randomUUID(), name, hlc: `${(++seedSeq).toString(16).padStart(12, '0')}-0000-seed`, payload });

  async function project(userId: string) {
    const ids = { vision: randomUUID(), roadmap: randomUUID(), project: randomUUID(), task: randomUUID() };
    const res = await upload(userId, [
      seedCmd('node.create', { id: ids.vision, node_type: 'vision', title: 'V', sort_order: 'a0' }),
      seedCmd('node.create', { id: ids.roadmap, node_type: 'roadmap', title: 'R', sort_order: 'a0', parent_id: ids.vision }),
      seedCmd('node.create', { id: ids.project, node_type: 'project', title: 'P', sort_order: 'a0', parent_id: ids.roadmap }),
      seedCmd('node.create', { id: ids.task, node_type: 'task', title: 'T', sort_order: 'a0', parent_id: ids.project }),
    ]);
    if (res.kind !== 'ok') throw new Error(res.kind);
    return ids;
  }

  const reviewItems = (userId: string, commandId: string) =>
    sql`SELECT item_type, severity, status, user_id FROM sync_review_items WHERE command_id = ${commandId} AND user_id = ${userId}`;

  beforeAll(async () => {
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const url = new URL(`/${dbName}`, adminUrl!).toString();
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

  it('rejects a command whose depends_on was rejected (E_DEPENDENCY_REJECTED) + dependency_rejection item', async () => {
    const user = randomUUID();
    const p = await project(user);
    const bad = mk('node.rename', { id: randomUUID(), title: 'ghost' }); // targets a missing node → E_NOT_FOUND
    const dependent = mk('node.rename', { id: p.task, title: 'after' }, { depends_on: [bad.id] });

    const res = await upload(user, [bad, dependent]);
    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') return;
    const byId = Object.fromEntries(res.results.map((r) => [r.id, r]));
    expect(byId[bad.id]).toMatchObject({ result: 'rejected', reject_code: 'E_NOT_FOUND' });
    expect(byId[dependent.id]).toMatchObject({ result: 'rejected', reject_code: 'E_DEPENDENCY_REJECTED' });
    expect(byId[dependent.id]!.review_item_ids).toHaveLength(1);

    const items = await reviewItems(user, dependent.id);
    expect(items[0]).toMatchObject({ item_type: 'dependency_rejection', severity: 'warning', status: 'open', user_id: user });
    // the canonical task is untouched by the rejected dependent
    const [row] = await sql`SELECT title FROM nodes WHERE id = ${p.task}`;
    expect(row!['title']).toBe('T');
  });

  it('rejects a command depending on an unknown command (E_UNKNOWN_TARGET)', async () => {
    const user = randomUUID();
    const p = await project(user);
    const cmd = mk('node.rename', { id: p.task, title: 'x' }, { depends_on: [randomUUID()] });
    const res = await upload(user, [cmd]);
    if (res.kind !== 'ok') throw new Error(res.kind);
    expect(res.results[0]).toMatchObject({ result: 'rejected', reject_code: 'E_UNKNOWN_TARGET' });
    expect(res.results[0]!.review_item_ids).toHaveLength(1);
  });

  it('applies a command whose depends_on was applied (dependency satisfied)', async () => {
    const user = randomUUID();
    const p = await project(user);
    const first = mk('node.rename', { id: p.task, title: 'first' });
    const second = mk('node.set_description', { id: p.task, description: 'desc' }, { depends_on: [first.id] });
    const res = await upload(user, [first, second]);
    if (res.kind !== 'ok') throw new Error(res.kind);
    expect(res.results.every((r) => r.result === 'applied')).toBe(true);
    // no review items for applied commands
    expect(await reviewItems(user, second.id)).toHaveLength(0);
  });

  it('rejects a command below the schema floor (E_CLIENT_TOO_OLD) + schema_version_block item', async () => {
    const user = randomUUID();
    const p = await project(user);
    const cmd = mk('node.rename', { id: p.task, title: 'old client' }, { schema_version: 0 });
    const res = await upload(user, [cmd]);
    if (res.kind !== 'ok') throw new Error(res.kind);
    expect(res.results[0]).toMatchObject({ result: 'rejected', reject_code: 'E_CLIENT_TOO_OLD' });
    const items = await reviewItems(user, cmd.id);
    expect(items[0]).toMatchObject({ item_type: 'schema_version_block', severity: 'error', status: 'open' });
  });

  it('a plain handler rejection also creates a command_rejection review item', async () => {
    const owner = randomUUID();
    const attacker = randomUUID();
    const p = await project(owner);
    const cmd = mk('node.rename', { id: p.task, title: 'hijack' });
    const res = await upload(attacker, [cmd]);
    if (res.kind !== 'ok') throw new Error(res.kind);
    expect(res.results[0]).toMatchObject({ result: 'rejected', reject_code: 'E_OWNERSHIP' });
    const items = await reviewItems(attacker, cmd.id);
    expect(items[0]).toMatchObject({ item_type: 'command_rejection', severity: 'warning' });
  });
});
