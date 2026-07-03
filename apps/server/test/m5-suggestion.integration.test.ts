/**
 * M5 — the §7.5 suggestion accept/reject transaction in the dispatcher.
 * One case per branch: promote, supersede conflicts, replace a flexible block,
 * stale rejection, done-task rejection, anchored-overlap rejection, reject =
 * soft-delete, cross-user ownership. Gated on PRISMS_DB_TEST_URL.
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

describe.skipIf(!adminUrl)('M5 — §7.5 suggestion accept/reject', () => {
  const dbName = `prisms_m5sg_${Date.now().toString(36)}`;
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

  /** A user with a project + one task; returns ids. */
  async function project(userId: string) {
    const ids = { vision: randomUUID(), roadmap: randomUUID(), project: randomUUID(), task: randomUUID() };
    const res = await upload(userId, [
      cmd('node.create', { id: ids.vision, node_type: 'vision', title: 'V', sort_order: 'a0' }),
      cmd('node.create', { id: ids.roadmap, node_type: 'roadmap', title: 'R', sort_order: 'a0', parent_id: ids.vision }),
      cmd('node.create', { id: ids.project, node_type: 'project', title: 'P', sort_order: 'a0', parent_id: ids.roadmap }),
      cmd('node.create', { id: ids.task, node_type: 'task', title: 'T', sort_order: 'a0', parent_id: ids.project }),
    ]);
    if (res.kind !== 'ok') throw new Error(res.kind);
    return ids;
  }

  const D = (h: number) => `2026-06-13T${String(h).padStart(2, '0')}:00:00.000Z`;
  const Dm = (h: number, m: number) => `2026-06-13T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;

  /** Insert a block row directly (suggestions come from jobs, not a command). */
  async function insertBlock(
    userId: string,
    taskId: string,
    starts: string,
    ends: string,
    opts: { status?: 'suggested' | 'committed'; anchor?: string; replaces?: string; superseded?: boolean } = {},
  ): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO schedule_blocks
      (id, user_id, task_id, starts_at, ends_at, anchor_type, status, suggestion_reason, replaces_block_id, superseded_at, updated_at)
      VALUES (${id}, ${userId}, ${taskId}, ${starts}, ${ends}, ${opts.anchor ?? 'none'},
              ${opts.status ?? 'suggested'}, 'nightly_optimization', ${opts.replaces ?? null},
              ${opts.superseded ? new Date().toISOString() : null}, now())`;
    return id;
  }
  const blockRow = async (id: string) =>
    (await sql`SELECT status, deleted_at, superseded_at, suggestion_reason FROM schedule_blocks WHERE id = ${id}`)[0]!;

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

  it('accept promotes a suggestion to committed and clears its suggestion metadata', async () => {
    const user = randomUUID();
    const p = await project(user);
    const s = await insertBlock(user, p.task, D(10), D(11));
    expect((await result(user, cmd('block.accept_suggestion', { id: s }))).result).toBe('applied');
    const row = await blockRow(s);
    expect(row['status']).toBe('committed');
    expect(row['suggestion_reason']).toBeNull();
    expect(row['superseded_at']).toBeNull();
  });

  it('accept supersedes a conflicting overlapping suggestion for the same task', async () => {
    const user = randomUUID();
    const p = await project(user);
    const s1 = await insertBlock(user, p.task, D(10), D(11));
    const s2 = await insertBlock(user, p.task, Dm(10, 30), Dm(11, 30)); // overlaps s1
    await result(user, cmd('block.accept_suggestion', { id: s1 }));
    expect((await blockRow(s1))['status']).toBe('committed');
    expect((await blockRow(s2))['superseded_at']).not.toBeNull(); // conflict superseded
  });

  it('accept soft-deletes the flexible block it replaces', async () => {
    const user = randomUUID();
    const p = await project(user);
    const replaced = await insertBlock(user, p.task, D(9), D(10), { status: 'committed' });
    const s = await insertBlock(user, p.task, D(14), D(15), { replaces: replaced });
    await result(user, cmd('block.accept_suggestion', { id: s }));
    expect((await blockRow(replaced))['deleted_at']).not.toBeNull();
    expect((await blockRow(s))['status']).toBe('committed');
  });

  it('rejects accepting a superseded (stale) suggestion', async () => {
    const user = randomUUID();
    const p = await project(user);
    const s = await insertBlock(user, p.task, D(10), D(11), { superseded: true });
    expect(await result(user, cmd('block.accept_suggestion', { id: s }))).toMatchObject({ result: 'rejected', reject_code: 'E_STALE_SUGGESTION' });
  });

  it('rejects accepting a suggestion for a done task', async () => {
    const user = randomUUID();
    const p = await project(user);
    await result(user, cmd('node.check_off', { id: p.task, completed_at: D(9) }));
    const s = await insertBlock(user, p.task, D(10), D(11));
    expect(await result(user, cmd('block.accept_suggestion', { id: s }))).toMatchObject({ result: 'rejected', reject_code: 'E_DONE_IMMUTABLE' });
  });

  it('rejects accepting a suggestion that overlaps an anchored committed block', async () => {
    const user = randomUUID();
    const p = await project(user);
    await insertBlock(user, p.task, D(10), D(11), { status: 'committed', anchor: 'both' });
    const s = await insertBlock(user, p.task, Dm(10, 30), Dm(11, 30)); // overlaps the anchor
    expect(await result(user, cmd('block.accept_suggestion', { id: s }))).toMatchObject({ result: 'rejected', reject_code: 'E_SUGGESTION_OVERLAPS_ANCHOR' });
    expect((await blockRow(s))['status']).toBe('suggested'); // unchanged
  });

  it('reject soft-deletes the suggestion only', async () => {
    const user = randomUUID();
    const p = await project(user);
    const s = await insertBlock(user, p.task, D(10), D(11));
    expect((await result(user, cmd('block.reject_suggestion', { id: s }))).result).toBe('applied');
    expect((await blockRow(s))['deleted_at']).not.toBeNull();
  });

  it('rejects a cross-user accept (ownership)', async () => {
    const owner = randomUUID();
    const attacker = randomUUID();
    const p = await project(owner);
    const s = await insertBlock(owner, p.task, D(10), D(11));
    expect(await result(attacker, cmd('block.accept_suggestion', { id: s }))).toMatchObject({ result: 'rejected', reject_code: 'E_OWNERSHIP' });
  });
});
