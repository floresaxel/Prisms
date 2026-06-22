/**
 * S11 DoD integration: the §8 dispatcher against a real Postgres (throwaway
 * DB, migrated). Proves the 5-step pipeline end to end — one rejecting test
 * per §6.7 invariant through the real upload, node.move re-parent revalidation,
 * replay → noop with the original result, idempotency, ownership, and the
 * automation.backstop enqueue.
 *
 * Gated on PRISMS_DB_TEST_URL (skips without the compose stack).
 */
import { randomUUID } from 'node:crypto';

import { loadRootEnv, runMigrations } from '@prisms/db';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDispatcher, type BackstopJob, type Dispatcher } from '../src/dispatcher';
import { createRateLimiter } from '../src/rate-limit';

loadRootEnv();
const adminUrl = process.env.PRISMS_DB_TEST_URL;

const USER = '01900000-0000-7000-8000-0000000000a1';
const OTHER = '01900000-0000-7000-8000-0000000000a2';

let hlc = 0;
const cmd = (name: string, payload: unknown, id = randomUUID()) => ({
  id,
  name,
  hlc: `${(++hlc).toString(16).padStart(12, '0')}-0000-test-device`,
  payload,
});

describe.skipIf(!adminUrl)('S11 command dispatcher (§8 pipeline, full catalog)', () => {
  const dbName = `prisms_s11_${Date.now().toString(36)}`;
  let url: string;
  let sql: postgres.Sql;
  let dispatcher: Dispatcher;
  let backstops: BackstopJob[];

  const upload = (commands: ReturnType<typeof cmd>[], userId = USER, deviceId = 'dev-1') =>
    dispatcher.handleUpload(userId, { device_id: deviceId, commands });
  const results = async (commands: ReturnType<typeof cmd>[], userId = USER) => {
    const res = await upload(commands, userId);
    if (res.kind !== 'ok') throw new Error(`upload not ok: ${res.kind}`);
    return res.results;
  };

  beforeAll(async () => {
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    await admin.end();
    url = new URL(`/${dbName}`, adminUrl!).toString();
    await runMigrations(url);
    sql = postgres(url, { max: 4, onnotice: () => undefined });
    const db = drizzle(sql);
    backstops = [];
    dispatcher = createDispatcher(db, createRateLimiter({ limit: 10_000, windowMs: 60_000 }), {
      enqueueBackstop: (job) => {
        backstops.push(job);
      },
    });
  });

  afterAll(async () => {
    await sql?.end();
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  beforeEach(() => {
    backstops.length = 0;
  });

  /**
   * Builds the canonical vision→roadmap→project→milestone→task tree under a
   * FRESH user (each test gets its own, so per-user state like the I2 vision
   * cap doesn't bleed across tests).
   */
  async function seedTree() {
    const user = randomUUID();
    const ids = {
      user,
      vision: randomUUID(),
      roadmap: randomUUID(),
      project: randomUUID(),
      milestone: randomUUID(),
      task: randomUUID(),
    };
    const res = await results(
      [
        cmd('node.create', { id: ids.vision, node_type: 'vision', title: 'V', sort_order: 'a0' }),
        cmd('node.create', { id: ids.roadmap, node_type: 'roadmap', title: 'R', sort_order: 'a0', parent_id: ids.vision }),
        cmd('node.create', { id: ids.project, node_type: 'project', title: 'P', sort_order: 'a0', parent_id: ids.roadmap }),
        cmd('node.create', { id: ids.milestone, node_type: 'milestone', title: 'M', sort_order: 'a0', parent_id: ids.project }),
        cmd('node.create', { id: ids.task, node_type: 'task', title: 'T', sort_order: 'a0', parent_id: ids.milestone, estimate_minutes: 60 }),
      ],
      user,
    );
    expect(res.every((r) => r.result === 'applied')).toBe(true);
    return ids;
  }

  it('applies a full node.create chain and persists the rows', async () => {
    const ids = await seedTree();
    const rows = await sql`SELECT node_type FROM nodes WHERE user_id = ${ids.user} AND id = ${ids.task}`;
    expect(rows[0]!['node_type']).toBe('task');
    // node.create of a task enqueues a task_created backstop
    expect(backstops).toContainEqual({ userId: ids.user, trigger: 'task_created', nodeId: ids.task });
  });

  it('I1 hierarchy: a task created under a vision is rejected E_HIERARCHY', async () => {
    const ids = await seedTree();
    const [r] = await results(
      [cmd('node.create', { id: randomUUID(), node_type: 'task', title: 'bad', sort_order: 'a0', parent_id: ids.vision })],
      ids.user,
    );
    expect(r).toMatchObject({ result: 'rejected', reject_code: 'E_HIERARCHY' });
  });

  it('I2 max visions: the 5th vision is rejected E_MAX_VISIONS', async () => {
    const u = randomUUID();
    const four = [0, 1, 2, 3].map(() => cmd('node.create', { id: randomUUID(), node_type: 'vision', title: 'v', sort_order: 'a0' }));
    expect((await results(four, u)).every((r) => r.result === 'applied')).toBe(true);
    const [fifth] = await results([cmd('node.create', { id: randomUUID(), node_type: 'vision', title: 'v5', sort_order: 'a0' })], u);
    expect(fifth).toMatchObject({ result: 'rejected', reject_code: 'E_MAX_VISIONS' });
  });

  it('I4 DAG: type mismatch and cycle edges are rejected', async () => {
    const ids = await seedTree();
    const t2 = randomUUID();
    await results([cmd('node.create', { id: t2, node_type: 'task', title: 'T2', sort_order: 'a1', parent_id: ids.project })], ids.user);

    const [mismatch] = await results(
      [cmd('edge.create', { id: randomUUID(), predecessor_id: ids.task, successor_id: ids.project })],
      ids.user,
    );
    expect(mismatch).toMatchObject({ result: 'rejected', reject_code: 'E_EDGE_TYPE_MISMATCH' });

    await results([cmd('edge.create', { id: randomUUID(), predecessor_id: ids.task, successor_id: t2 })], ids.user);
    const [cycle] = await results([cmd('edge.create', { id: randomUUID(), predecessor_id: t2, successor_id: ids.task })], ids.user);
    expect(cycle).toMatchObject({ result: 'rejected', reject_code: 'E_CYCLE' });
  });

  it('I5 one timer: a second clock-in while one runs is rejected; clock-out then allows it', async () => {
    const ids = await seedTree();
    const e1 = randomUUID();
    const [in1] = await results([cmd('timer.clock_in', { entry_id: e1, task_id: ids.task, started_at: '2026-06-13T10:00:00.000Z' })], ids.user);
    expect(in1!.result).toBe('applied');
    const [in2] = await results([cmd('timer.clock_in', { entry_id: randomUUID(), task_id: ids.task, started_at: '2026-06-13T10:05:00.000Z' })], ids.user);
    expect(in2).toMatchObject({ result: 'rejected', reject_code: 'E_TIMER_ALREADY_RUNNING' });
    await results([cmd('timer.clock_out', { entry_id: e1, ended_at: '2026-06-13T11:00:00.000Z' })], ids.user);
    const [in3] = await results([cmd('timer.clock_in', { entry_id: randomUUID(), task_id: ids.task, started_at: '2026-06-13T12:00:00.000Z' })], ids.user);
    expect(in3!.result).toBe('applied');
  });

  it('I6 interval: a block ending before it starts is rejected', async () => {
    const ids = await seedTree();
    const [r] = await results(
      [cmd('block.create', { id: randomUUID(), task_id: ids.task, starts_at: '2026-06-13T11:00:00.000Z', ends_at: '2026-06-13T10:00:00.000Z' })],
      ids.user,
    );
    expect(r).toMatchObject({ result: 'rejected', reject_code: 'E_INVALID_INTERVAL' });
  });

  it('I7 anchored immutable: moving an anchored block is rejected', async () => {
    const ids = await seedTree();
    const block = randomUUID();
    await results([cmd('block.create', { id: block, task_id: ids.task, starts_at: '2026-06-13T10:00:00.000Z', ends_at: '2026-06-13T11:00:00.000Z', anchor_type: 'both' })], ids.user);
    const [r] = await results([cmd('block.move', { id: block, starts_at: '2026-06-13T12:00:00.000Z', ends_at: '2026-06-13T13:00:00.000Z' })], ids.user);
    expect(r).toMatchObject({ result: 'rejected', reject_code: 'E_ANCHORED_IMMUTABLE' });
  });

  it('I8 done immutable: scheduling a done task is rejected', async () => {
    const ids = await seedTree();
    await results([cmd('node.check_off', { id: ids.task, completed_at: '2026-06-13T09:00:00.000Z' })], ids.user);
    const [r] = await results(
      [cmd('block.create', { id: randomUUID(), task_id: ids.task, starts_at: '2026-06-13T10:00:00.000Z', ends_at: '2026-06-13T11:00:00.000Z' })],
      ids.user,
    );
    expect(r).toMatchObject({ result: 'rejected', reject_code: 'E_DONE_IMMUTABLE' });
  });

  it('node.move re-parent revalidates I1/I3 (DoD)', async () => {
    const ids = await seedTree();
    // I1: moving the task under the vision is rejected
    const [bad] = await results([cmd('node.move', { id: ids.task, new_parent_id: ids.vision, sort_order: 'a0' })], ids.user);
    expect(bad).toMatchObject({ result: 'rejected', reject_code: 'E_HIERARCHY' });
    // a valid re-parent (milestone → project) applies
    const [ok] = await results([cmd('node.move', { id: ids.task, new_parent_id: ids.project, sort_order: 'a5' })], ids.user);
    expect(ok!.result).toBe('applied');
    const [row] = await sql`SELECT parent_id FROM nodes WHERE id = ${ids.task}`;
    expect(row!['parent_id']).toBe(ids.project);
  });

  it('node.check_off enqueues a task_completed backstop', async () => {
    const ids = await seedTree();
    await results([cmd('node.check_off', { id: ids.task, completed_at: '2026-06-13T09:00:00.000Z' })], ids.user);
    expect(backstops).toContainEqual({ userId: ids.user, trigger: 'task_completed', nodeId: ids.task });
  });

  it('node.check_off records the disposition: default completed, explicit obsolete; uncheck clears (Phase 2)', async () => {
    const ids = await seedTree();
    // default: a check-off with no disposition records 'completed'
    await results([cmd('node.check_off', { id: ids.task, completed_at: '2026-06-13T09:00:00.000Z' })], ids.user);
    expect((await sql`SELECT completion_disposition FROM nodes WHERE id = ${ids.task}`)[0]!['completion_disposition']).toBe('completed');
    // uncheck clears completed_at AND the disposition
    await results([cmd('node.uncheck', { id: ids.task })], ids.user);
    const cleared = (await sql`SELECT completed_at, completion_disposition FROM nodes WHERE id = ${ids.task}`)[0]!;
    expect(cleared['completed_at']).toBeNull();
    expect(cleared['completion_disposition']).toBeNull();
    // explicit obsolete persists
    await results([cmd('node.check_off', { id: ids.task, completed_at: '2026-06-13T10:00:00.000Z', disposition: 'obsolete' })], ids.user);
    expect((await sql`SELECT completion_disposition FROM nodes WHERE id = ${ids.task}`)[0]!['completion_disposition']).toBe('obsolete');
  });

  it('node.check_off records the completing block; explicit persists, no-block ⇒ unscheduled, uncheck clears (Phase 3)', async () => {
    const ids = await seedTree();
    const block = await seedBlock(ids);
    // explicit block persists
    await results([cmd('node.check_off', { id: ids.task, completed_at: '2026-06-13T11:00:00.000Z', completed_in_block_id: block })], ids.user);
    expect((await sql`SELECT completed_in_block_id FROM nodes WHERE id = ${ids.task}`)[0]!['completed_in_block_id']).toBe(block);
    // uncheck clears it
    await results([cmd('node.uncheck', { id: ids.task })], ids.user);
    expect((await sql`SELECT completed_in_block_id FROM nodes WHERE id = ${ids.task}`)[0]!['completed_in_block_id']).toBeNull();
    // a check-off with no block ⇒ completed unscheduled (null)
    await results([cmd('node.check_off', { id: ids.task, completed_at: '2026-06-13T12:00:00.000Z' })], ids.user);
    expect((await sql`SELECT completed_in_block_id FROM nodes WHERE id = ${ids.task}`)[0]!['completed_in_block_id']).toBeNull();
  });

  it('node.check_off rejects a completing block owned by another user (Phase 3)', async () => {
    const ids = await seedTree();
    const other = await seedTree();
    const otherBlock = await seedBlock(other); // a block owned by a different user
    const [r] = await results([cmd('node.check_off', { id: ids.task, completed_at: '2026-06-13T11:00:00.000Z', completed_in_block_id: otherBlock })], ids.user);
    expect(r).toMatchObject({ result: 'rejected', reject_code: 'E_OWNERSHIP' });
  });

  it('replay returns noop with the original result (DoD)', async () => {
    const ids = await seedTree();
    const checkOff = cmd('node.check_off', { id: ids.task, completed_at: '2026-06-13T09:00:00.000Z' });
    const [first] = await results([checkOff], ids.user);
    expect(first!.result).toBe('applied');
    const [replay] = await results([checkOff], ids.user);
    expect(replay).toEqual({ id: checkOff.id, result: 'noop', original_result: 'applied' });
    // a rejected command also replays as noop(rejected)
    const bad = cmd('node.create', { id: randomUUID(), node_type: 'task', title: 'x', sort_order: 'a0', parent_id: ids.vision });
    const [r1] = await results([bad], ids.user);
    expect(r1!.result).toBe('rejected');
    const [r2] = await results([bad], ids.user);
    expect(r2).toEqual({ id: bad.id, result: 'noop', original_result: 'rejected' });
    // command_log holds exactly one row for the id
    const logs = await sql`SELECT count(*)::int AS n FROM command_log WHERE id = ${checkOff.id}`;
    expect(logs[0]!['n']).toBe(1);
  });

  it('rejects unknown verbs, malformed payloads, and full-row-write attempts', async () => {
    const [unknown] = await results([cmd('node.update', { id: randomUUID() })]);
    expect(unknown).toMatchObject({ result: 'rejected', reject_code: 'E_UNKNOWN_COMMAND' });
    const [parse] = await results([cmd('node.rename', { id: randomUUID(), title: 'x', user_id: OTHER })]);
    expect(parse).toMatchObject({ result: 'rejected', reject_code: 'E_PARSE' });
  });

  it('enforces ownership: another user cannot touch these rows or command ids', async () => {
    const ids = await seedTree();
    const attacker = randomUUID();
    // attacker renames the owner's node ⇒ E_OWNERSHIP
    const [foreign] = await results([cmd('node.rename', { id: ids.task, title: 'hijack' })], attacker);
    expect(foreign).toMatchObject({ result: 'rejected', reject_code: 'E_OWNERSHIP' });
    // reusing a command id under a different user ⇒ E_OWNERSHIP
    const shared = cmd('settings.update', { day_reset_hour: 5 });
    await results([shared], ids.user);
    const [reused] = await results([shared], attacker);
    expect(reused).toMatchObject({ result: 'rejected', reject_code: 'E_OWNERSHIP' });
  });

  it('timer.review can complete the task and enqueue a backstop', async () => {
    const ids = await seedTree();
    const entry = randomUUID();
    await results(
      [
        cmd('timer.clock_in', { entry_id: entry, task_id: ids.task, started_at: '2026-06-13T14:00:00.000Z' }),
        cmd('timer.clock_out', { entry_id: entry, ended_at: '2026-06-13T15:00:00.000Z' }),
      ],
      ids.user,
    );
    backstops.length = 0;
    const [review] = await results([cmd('timer.review', { entry_id: entry, focus_factor: 0.9, completed_session: true })], ids.user);
    expect(review!.result).toBe('applied');
    const [task] = await sql`SELECT completed_at FROM nodes WHERE id = ${ids.task}`;
    expect(task!['completed_at']).not.toBeNull();
    expect(backstops).toContainEqual({ userId: ids.user, trigger: 'task_completed', nodeId: ids.task });
  });

  it('soft_delete cascades the subtree (I10)', async () => {
    const ids = await seedTree();
    await results([cmd('node.soft_delete', { id: ids.project })], ids.user);
    const live = await sql`
      SELECT count(*)::int AS n FROM nodes
      WHERE user_id = ${ids.user} AND id IN (${ids.project}, ${ids.milestone}, ${ids.task}) AND deleted_at IS NULL`;
    expect(live[0]!['n']).toBe(0); // project + milestone + task all marked
    const visionStill = await sql`SELECT deleted_at FROM nodes WHERE id = ${ids.vision}`;
    expect(visionStill[0]!['deleted_at']).toBeNull(); // ancestor untouched
  });

  async function seedBlock(ids: Awaited<ReturnType<typeof seedTree>>) {
    const block = randomUUID();
    await results(
      [cmd('block.create', { id: block, task_id: ids.task, starts_at: '2026-06-13T10:00:00.000Z', ends_at: '2026-06-13T11:00:00.000Z' })],
      ids.user,
    );
    return block;
  }

  it('tags: place on a block, answer yes then no (LWW), then clear → pending', async () => {
    const ids = await seedTree();
    const block = await seedBlock(ids);
    const tag = randomUUID();
    const placement = randomUUID();
    const answer = randomUUID();
    const res = await results(
      [
        cmd('tag.create', { id: tag, label: 'on time?' }),
        cmd('tag.place', { id: placement, block_id: block, tag_id: tag }),
        cmd('tag.answer', { id: answer, placement_id: placement, value: 'yes', answered_at: '2026-06-13T11:05:00.000Z' }),
      ],
      ids.user,
    );
    expect(res.every((r) => r.result === 'applied')).toBe(true);
    const live = () => sql`SELECT value FROM tag_answers WHERE placement_id = ${placement} AND deleted_at IS NULL`;
    let rows = await live();
    expect(rows).toEqual([{ value: 'yes' }]);
    // re-answer with the same row id; the higher-HLC value wins (§7.3 LWW)
    await results([cmd('tag.answer', { id: answer, placement_id: placement, value: 'no', answered_at: '2026-06-13T12:00:00.000Z' })], ids.user);
    rows = await live();
    expect(rows).toEqual([{ value: 'no' }]);
    // clear back to pending (no live row remains)
    await results([cmd('tag.clear_answer', { id: answer })], ids.user);
    expect(await live()).toHaveLength(0);
  });

  it('tags: placing/answering on a DONE task succeeds (event completed, tag still confirmable)', async () => {
    const ids = await seedTree();
    const block = await seedBlock(ids);
    await results([cmd('node.check_off', { id: ids.task, completed_at: '2026-06-13T11:00:00.000Z' })], ids.user);
    const placement = randomUUID();
    const tag = randomUUID();
    const out = await results(
      [
        cmd('tag.create', { id: tag, label: 'on time?' }),
        cmd('tag.place', { id: placement, block_id: block, tag_id: tag }),
        cmd('tag.answer', { id: randomUUID(), placement_id: placement, value: 'yes', answered_at: '2026-06-13T12:00:00.000Z' }),
      ],
      ids.user,
    );
    expect(out.every((r) => r.result === 'applied')).toBe(true);
  });

  it('tags: a duplicate (block, tag) placement converges to one live row', async () => {
    const ids = await seedTree();
    const block = await seedBlock(ids);
    const tag = randomUUID();
    await results([cmd('tag.create', { id: tag, label: 'on time?' })], ids.user);
    await results([cmd('tag.place', { id: randomUUID(), block_id: block, tag_id: tag })], ids.user);
    const [dup] = await results([cmd('tag.place', { id: randomUUID(), block_id: block, tag_id: tag })], ids.user);
    expect(dup!.result).toBe('applied'); // converged no-op
    const rows = await sql`SELECT count(*)::int AS n FROM tag_placements WHERE block_id = ${block} AND tag_id = ${tag} AND deleted_at IS NULL`;
    expect(rows[0]!['n']).toBe(1);
  });

  it('tags: another user cannot place a tag on these rows (E_OWNERSHIP)', async () => {
    const ids = await seedTree();
    const block = await seedBlock(ids);
    const attacker = randomUUID();
    const tag = randomUUID();
    await results([cmd('tag.create', { id: tag, label: 'sneaky' })], attacker); // attacker's own tag
    const [r] = await results([cmd('tag.place', { id: randomUUID(), block_id: block, tag_id: tag })], attacker);
    expect(r).toMatchObject({ result: 'rejected', reject_code: 'E_OWNERSHIP' }); // the block isn't theirs
  });

  it('a re-created row id converges idempotently (§9.4), keeping one row', async () => {
    const ids = await seedTree();
    // a fresh command id re-creating the same row id is a converged no-op
    // (different content is ignored — the existing row wins), so two devices
    // running the same UUIDv5 automation agree.
    const dupe = cmd('node.create', { id: ids.vision, node_type: 'vision', title: 'again', sort_order: 'a9' });
    const [r] = await results([dupe], ids.user);
    expect(r!.result).toBe('applied');
    const rows = await sql`SELECT title FROM nodes WHERE id = ${ids.vision}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!['title']).toBe('V'); // original content preserved
  });
});
