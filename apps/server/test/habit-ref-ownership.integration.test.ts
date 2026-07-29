/**
 * SEC-7/F13 — a task's `habit_id` must name a habit the caller owns.
 *
 * `nodes.habit_id` carries no FK, and the I3 justification invariant only tests
 * `habit_id !== null` — so before this, ANY uuid (a random one, or another
 * account's habit id) satisfied "this task traces to a real habit", and the node
 * stored a dangling/foreign reference. Impact is tenant-internal (the row is
 * still owned by the caller), but it defeats an invariant and is inconsistent
 * with tag.create, which has always ownership-checked its habit_id.
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

const uuid = () => randomUUID();
const USER_A = '01900000-0000-7000-8000-0000000000b1';
const USER_B = '01900000-0000-7000-8000-0000000000b2';

let seq = 0;
const cmd = (name: string, payload: unknown) => ({
  id: uuid(),
  name,
  hlc: `${(++seq).toString(16).padStart(12, '0')}-0000-test-device`,
  payload,
  schema_version: 1,
});

describe.skipIf(!adminUrl)('SEC-7/F13 — habit_id references are ownership-checked', () => {
  const dbName = `prisms_sec7_${Date.now().toString(36)}`;
  let sql: postgres.Sql;
  let dispatcher: Dispatcher;

  const send = async (userId: string, ...commands: ReturnType<typeof cmd>[]) => {
    const out = await dispatcher.handleUpload(userId, { device_id: 'dev-1', commands });
    if (out.kind !== 'ok') throw new Error(`upload not ok: ${out.kind}`);
    return out.results;
  };

  /** vision → habit, both owned by `userId`. Returns the habit id. */
  const seedHabit = async (userId: string): Promise<string> => {
    const visionId = uuid();
    const habitId = uuid();
    const res = await send(
      userId,
      cmd('node.create', { id: visionId, node_type: 'vision', title: 'Vision', sort_order: 'a0' }),
      cmd('habit.create', { id: habitId, vision_id: visionId, title: 'Run', rrule: 'FREQ=DAILY', streak_mode: 'daily' }),
    );
    expect(res.map((r) => r.result)).toEqual(['applied', 'applied']);
    return habitId;
  };

  beforeAll(async () => {
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const url = new URL(`/${dbName}`, adminUrl!).toString();
    await runMigrations(url);
    sql = postgres(url, { max: 4, onnotice: () => undefined });
    dispatcher = createDispatcher(drizzle(sql), createRateLimiter({ limit: 10_000, windowMs: 60_000 }));
  }, 60_000);

  afterAll(async () => {
    await sql?.end();
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  describe('node.create', () => {
  it('accepts a habit the caller owns', async () => {
    const habitId = await seedHabit(USER_A);
    const [result] = await send(
      USER_A,
      cmd('node.create', { id: uuid(), node_type: 'task', title: 'Morning run', sort_order: 'b0', habit_id: habitId }),
    );
    expect(result!.result).toBe('applied');
  });

  it('accepts a task with no habit at all (justified by its ancestry instead)', async () => {
    // I3 needs a full vision → roadmap → project → milestone chain when the task
    // is not justified by a habit; this proves the new check leaves that path be.
    const [vision, roadmap, project, milestone] = [uuid(), uuid(), uuid(), uuid()];
    await send(
      USER_A,
      cmd('node.create', { id: vision, node_type: 'vision', title: 'V2', sort_order: 'c0' }),
      cmd('node.create', { id: roadmap, node_type: 'roadmap', title: 'R', sort_order: 'c1', parent_id: vision }),
      cmd('node.create', { id: project, node_type: 'project', title: 'P', sort_order: 'c2', parent_id: roadmap }),
      cmd('node.create', { id: milestone, node_type: 'milestone', title: 'M', sort_order: 'c3', parent_id: project }),
    );
    const [result] = await send(
      USER_A,
      cmd('node.create', { id: uuid(), node_type: 'task', title: 'Justified task', sort_order: 'c4', parent_id: milestone }),
    );
    expect(result!.result).toBe('applied');
  });

  it('REGRESSION: refuses ANOTHER account\'s habit id', async () => {
    const foreignHabit = await seedHabit(USER_B);
    const [result] = await send(
      USER_A,
      cmd('node.create', { id: uuid(), node_type: 'task', title: 'Borrowed justification', sort_order: 'd0', habit_id: foreignHabit }),
    );
    expect(result!.result).toBe('rejected');
    expect(result!.reject_code).toBe('E_OWNERSHIP');
  });

  it('REGRESSION: refuses a habit id that does not exist', async () => {
    const [result] = await send(
      USER_A,
      cmd('node.create', { id: uuid(), node_type: 'task', title: 'Fictional habit', sort_order: 'e0', habit_id: uuid() }),
    );
    expect(result!.result).toBe('rejected');
    expect(result!.reject_code).toBe('E_NOT_FOUND');
  });

  it('does not persist a rejected node', async () => {
    const nodeId = uuid();
    await send(
      USER_A,
      cmd('node.create', { id: nodeId, node_type: 'task', title: 'Should not exist', sort_order: 'f0', habit_id: uuid() }),
    );
    const rows = await sql`SELECT id FROM nodes WHERE id = ${nodeId}`;
    expect(rows).toHaveLength(0);
  });
  });

  describe('activity.promote', () => {
    it("refuses promoting an activity via another account's habit", async () => {
      const foreignHabit = await seedHabit(USER_B);
      const activityId = uuid();
      await send(USER_A, cmd('node.create', { id: activityId, node_type: 'activity', title: 'Jog', sort_order: 'g0' }));

      const [result] = await send(USER_A, cmd('activity.promote', { id: activityId, habit_id: foreignHabit }));
      expect(result!.result).toBe('rejected');
      expect(result!.reject_code).toBe('E_OWNERSHIP');
    });

    it('accepts promoting via an owned habit', async () => {
      const habitId = await seedHabit(USER_A);
      const activityId = uuid();
      await send(USER_A, cmd('node.create', { id: activityId, node_type: 'activity', title: 'Jog 2', sort_order: 'h0' }));

      const [result] = await send(USER_A, cmd('activity.promote', { id: activityId, habit_id: habitId }));
      expect(result!.result).toBe('applied');
    });
  });
});
