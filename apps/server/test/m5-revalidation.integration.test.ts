/**
 * M5 — command-rule revalidation in the dispatcher: §7.6 completion gate,
 * §8 blocked-task clock-in (force override), and the node.retype orphan rule.
 * Gated on PRISMS_DB_TEST_URL.
 */
import { randomUUID } from 'node:crypto';

import { loadRootEnv, runMigrations } from '@prisms/db';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDispatcher, type Dispatcher } from '../src/dispatcher';
import { createRateLimiter } from '../src/rate-limit';

loadRootEnv();
const adminUrl = process.env.PRISMS_DB_TEST_URL;

interface Cmd { id: string; name: string; hlc: string; payload: unknown; schema_version?: number }

describe.skipIf(!adminUrl)('M5 — completion gate, force clock-in, retype orphan', () => {
  const dbName = `prisms_m5rv_${Date.now().toString(36)}`;
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
  const result = async (userId: string, command: Cmd) => {
    const res = await upload(userId, [command]);
    if (res.kind !== 'ok') throw new Error(res.kind);
    return res.results[0]!;
  };

  /** vision→roadmap→project→{taskA, taskB}; returns ids. */
  async function project(userId: string) {
    const ids = { vision: randomUUID(), roadmap: randomUUID(), project: randomUUID(), a: randomUUID(), b: randomUUID() };
    const res = await upload(userId, [
      cmd('node.create', { id: ids.vision, node_type: 'vision', title: 'V', sort_order: 'a0' }),
      cmd('node.create', { id: ids.roadmap, node_type: 'roadmap', title: 'R', sort_order: 'a0', parent_id: ids.vision }),
      cmd('node.create', { id: ids.project, node_type: 'project', title: 'P', sort_order: 'a0', parent_id: ids.roadmap }),
      cmd('node.create', { id: ids.a, node_type: 'task', title: 'A', sort_order: 'a0', parent_id: ids.project }),
      cmd('node.create', { id: ids.b, node_type: 'task', title: 'B', sort_order: 'a1', parent_id: ids.project }),
    ]);
    if (res.kind !== 'ok') throw new Error(res.kind);
    return ids;
  }
  const fsEdge = (a: string, b: string) => cmd('edge.create', { id: randomUUID(), predecessor_id: a, successor_id: b, edge_type: 'FS' });

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

  it('§7.6: cannot complete a successor until its FS predecessor is done', async () => {
    const user = randomUUID();
    const p = await project(user);
    await result(user, fsEdge(p.a, p.b));
    const done = '2026-06-13T12:00:00.000Z';
    expect(await result(user, cmd('node.check_off', { id: p.b, completed_at: done }))).toMatchObject({
      result: 'rejected',
      reject_code: 'E_COMPLETION_BLOCKED',
    });
    // complete the predecessor, then the successor completes
    expect((await result(user, cmd('node.check_off', { id: p.a, completed_at: done }))).result).toBe('applied');
    expect((await result(user, cmd('node.check_off', { id: p.b, completed_at: done }))).result).toBe('applied');
  });

  it('a task with no predecessors completes freely', async () => {
    const user = randomUUID();
    const p = await project(user);
    expect((await result(user, cmd('node.check_off', { id: p.a, completed_at: '2026-06-13T12:00:00.000Z' }))).result).toBe('applied');
  });

  it('§8: clocking into a blocked task is rejected without force, accepted with it', async () => {
    const user = randomUUID();
    const p = await project(user);
    await result(user, fsEdge(p.a, p.b)); // B is blocked until A is done
    const start = '2026-06-13T10:00:00.000Z';
    expect(await result(user, cmd('timer.clock_in', { entry_id: randomUUID(), task_id: p.b, started_at: start }))).toMatchObject({
      result: 'rejected',
      reject_code: 'E_BLOCKED_TASK',
    });
    expect((await result(user, cmd('timer.clock_in', { entry_id: randomUUID(), task_id: p.b, started_at: start, force: true }))).result).toBe('applied');
  });

  it('clocking into an unblocked task needs no force', async () => {
    const user = randomUUID();
    const p = await project(user);
    expect((await result(user, cmd('timer.clock_in', { entry_id: randomUUID(), task_id: p.a, started_at: '2026-06-13T10:00:00.000Z' }))).result).toBe('applied');
  });

  it('§8: node.retype rejects orphaning a child type (E_INVALID_RETYPE_CHILDREN)', async () => {
    const user = randomUUID();
    const ids = { vision: randomUUID(), roadmap: randomUUID(), project: randomUUID(), milestone: randomUUID(), task: randomUUID() };
    const res = await upload(user, [
      cmd('node.create', { id: ids.vision, node_type: 'vision', title: 'V', sort_order: 'a0' }),
      cmd('node.create', { id: ids.roadmap, node_type: 'roadmap', title: 'R', sort_order: 'a0', parent_id: ids.vision }),
      cmd('node.create', { id: ids.project, node_type: 'project', title: 'P', sort_order: 'a0', parent_id: ids.roadmap }),
      cmd('node.create', { id: ids.milestone, node_type: 'milestone', title: 'M', sort_order: 'a0', parent_id: ids.project }),
      cmd('node.create', { id: ids.task, node_type: 'task', title: 'T', sort_order: 'a0', parent_id: ids.milestone }),
    ]);
    if (res.kind !== 'ok') throw new Error(res.kind);
    // milestone→task would orphan the task child (a task cannot parent a task)
    expect(await result(user, cmd('node.retype', { id: ids.milestone, node_type: 'task' }))).toMatchObject({
      result: 'rejected',
      reject_code: 'E_INVALID_RETYPE_CHILDREN',
    });
  });
});
