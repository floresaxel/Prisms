/**
 * M1 — `layout.renormalize_order` server applier (1.3 §7.10a). Deterministic,
 * idempotent sort_order cleanup over a sibling group, ownership-checked. The
 * pure effect builder + idempotency are unit-tested in core; this pins the
 * dispatcher wiring against real Postgres.
 *
 * Gated on PRISMS_DB_TEST_URL.
 */
import { randomUUID } from 'node:crypto';

import { renormalizedOrders } from '@prisms/core';
import { loadRootEnv, runMigrations } from '@prisms/db';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDispatcher, type Dispatcher } from '../src/dispatcher';
import { createRateLimiter } from '../src/rate-limit';

loadRootEnv();
const adminUrl = process.env.PRISMS_DB_TEST_URL;

interface Cmd { id: string; name: string; hlc: string; payload: unknown; schema_version?: number }

describe.skipIf(!adminUrl)('M1 layout.renormalize_order (server applier)', () => {
  const dbName = `prisms_m1_${Date.now().toString(36)}`;
  let url: string;
  let sql: postgres.Sql;
  let dispatcher: Dispatcher;

  let seq = 0;
  const cmd = (name: string, payload: unknown, id = randomUUID()): Cmd => ({
    id,
    name,
    hlc: `${(++seq).toString(16).padStart(12, '0')}-0000-seed`,
    payload,
    schema_version: 1, // R6: clients emit the §7.11 version (absent = below-floor)
  });
  const upload = (userId: string, commands: Cmd[]) => dispatcher.handleUpload(userId, { device_id: 'seed', commands });

  /** A project with three sibling tasks all colliding on sort_order 'a0'. */
  async function collidingSiblings(userId: string) {
    const ids = { vision: randomUUID(), roadmap: randomUUID(), project: randomUUID(), t1: randomUUID(), t2: randomUUID(), t3: randomUUID() };
    const res = await upload(userId, [
      cmd('node.create', { id: ids.vision, node_type: 'vision', title: 'V', sort_order: 'a0' }),
      cmd('node.create', { id: ids.roadmap, node_type: 'roadmap', title: 'R', sort_order: 'a0', parent_id: ids.vision }),
      cmd('node.create', { id: ids.project, node_type: 'project', title: 'P', sort_order: 'a0', parent_id: ids.roadmap }),
      cmd('node.create', { id: ids.t1, node_type: 'task', title: 'T1', sort_order: 'a0', parent_id: ids.project }),
      cmd('node.create', { id: ids.t2, node_type: 'task', title: 'T2', sort_order: 'a0', parent_id: ids.project }),
      cmd('node.create', { id: ids.t3, node_type: 'task', title: 'T3', sort_order: 'a0', parent_id: ids.project }),
    ]);
    if (res.kind !== 'ok') throw new Error(res.kind);
    return ids;
  }

  const ordersOf = async (taskIds: string[]) => {
    const rows = await sql`SELECT id, sort_order FROM nodes WHERE id IN ${sql(taskIds)}`;
    const byId = new Map(rows.map((r) => [r['id'] as string, r['sort_order'] as string]));
    return taskIds.map((id) => byId.get(id)!);
  };

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

  it('renormalizes a colliding sibling group to clean, strictly-increasing orders', async () => {
    const user = randomUUID();
    const ids = await collidingSiblings(user);
    const order = [ids.t1, ids.t2, ids.t3];

    const res = await upload(user, [cmd('layout.renormalize_order', { parent_id: ids.project, node_ids: order })]);
    expect(res.kind === 'ok' && res.results[0]!.result).toBe('applied');

    const after = await ordersOf(order);
    expect(after).toEqual(renormalizedOrders(3)); // deterministic clean spacing
    expect(after[0]! < after[1]! && after[1]! < after[2]!).toBe(true); // strictly increasing
  });

  it('is idempotent: a second renormalize (new id/hlc) leaves the orders unchanged', async () => {
    const user = randomUUID();
    const ids = await collidingSiblings(user);
    const order = [ids.t1, ids.t2, ids.t3];
    await upload(user, [cmd('layout.renormalize_order', { parent_id: ids.project, node_ids: order })]);
    const first = await ordersOf(order);
    await upload(user, [cmd('layout.renormalize_order', { parent_id: ids.project, node_ids: order })]);
    const second = await ordersOf(order);
    expect(second).toEqual(first);
  });

  it('rejects a cross-user renormalize (ownership)', async () => {
    const owner = randomUUID();
    const attacker = randomUUID();
    const ids = await collidingSiblings(owner);
    const res = await upload(attacker, [cmd('layout.renormalize_order', { parent_id: ids.project, node_ids: [ids.t1, ids.t2, ids.t3] })]);
    expect(res.kind === 'ok' && res.results[0]).toMatchObject({ result: 'rejected', reject_code: 'E_OWNERSHIP' });
  });
});
