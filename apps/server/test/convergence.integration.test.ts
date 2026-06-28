/**
 * S12 — the convergence harness (§7.3–§7.4, §14). The permanent regression
 * gate: two simulated devices, each with a REAL local SQLite upload queue and
 * its own HLC clock, make offline edits and sync to the real dispatcher
 * (Postgres compose stack). Asserts the five convergence scenarios.
 *
 * The server (Postgres) is the convergence point: both devices, syncing the
 * same rows back down, would see identical state — so asserting the converged
 * server state proves device convergence.
 *
 * Gated on PRISMS_DB_TEST_URL (skips without the compose stack).
 */
import { randomUUID } from 'node:crypto';

import {
  asEpochMillis,
  hlcEncode,
  hlcTick,
  type Hlc,
} from '@prisms/core';
import { loadRootEnv, runMigrations } from '@prisms/db';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDispatcher, type BackstopJob, type Dispatcher } from '../src/dispatcher';
import { runAutomationBackstop } from '../src/jobs/automation-backstop';
import { createRateLimiter } from '../src/rate-limit';

loadRootEnv();
const adminUrl = process.env.PRISMS_DB_TEST_URL;

interface Command {
  id: string;
  name: string;
  hlc: string;
  payload: unknown;
}

/** A simulated device: a real local SQLite upload queue + an HLC clock. */
class Device {
  private clock: Hlc | null = null;
  private readonly local: Database.Database;

  constructor(readonly id: string) {
    this.local = new Database(':memory:');
    this.local.exec(
      'CREATE TABLE queue (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, name TEXT, hlc TEXT, payload TEXT)',
    );
  }

  /** Queue a command stamped with this device's next HLC at logical time `atMs`. */
  edit(name: string, payload: unknown, atMs: number, id = randomUUID()): Command {
    this.clock = hlcTick(this.clock, asEpochMillis(atMs), this.id);
    const hlc = hlcEncode(this.clock);
    this.local
      .prepare('INSERT INTO queue (id, name, hlc, payload) VALUES (?,?,?,?)')
      .run(id, name, hlc, JSON.stringify(payload));
    return { id, name, hlc, payload };
  }

  private pending(): Command[] {
    return (
      this.local.prepare('SELECT id, name, hlc, payload FROM queue ORDER BY seq').all() as {
        id: string;
        name: string;
        hlc: string;
        payload: string;
      }[]
    ).map((r) => ({ id: r.id, name: r.name, hlc: r.hlc, payload: JSON.parse(r.payload) as unknown }));
  }

  /** Go online: upload the queued commands in order, then clear the queue. */
  async sync(dispatcher: Dispatcher, userId: string): Promise<void> {
    const commands = this.pending();
    if (commands.length === 0) return;
    const res = await dispatcher.handleUpload(userId, { device_id: this.id, commands });
    this.local.prepare('DELETE FROM queue').run();
    if (res.kind !== 'ok') throw new Error(`upload not ok: ${res.kind}`);
  }

  close(): void {
    this.local.close();
  }
}

describe.skipIf(!adminUrl)('S12 convergence harness (two devices, offline edits)', () => {
  const dbName = `prisms_s12_${Date.now().toString(36)}`;
  let url: string;
  let sql: postgres.Sql;
  let dispatcher: Dispatcher;
  let backstops: BackstopJob[];

  /** Upload commands immediately as a synchronous "online" setup device. */
  const seed = async (userId: string, commands: Command[]) => {
    const res = await dispatcher.handleUpload(userId, { device_id: 'seed', commands });
    if (res.kind !== 'ok') throw new Error(res.kind);
    expect(res.results.every((r) => r.result === 'applied')).toBe(true);
  };
  let seedSeq = 0;
  const seedCmd = (name: string, payload: unknown, id = randomUUID()): Command => ({
    id,
    name,
    hlc: `${(++seedSeq).toString(16).padStart(12, '0')}-0000-seed`,
    payload,
  });

  /** A project with one task under it, for a fresh user. */
  async function project() {
    const user = randomUUID();
    const ids = { user, vision: randomUUID(), roadmap: randomUUID(), project: randomUUID(), task: randomUUID() };
    await seed(user, [
      seedCmd('node.create', { id: ids.vision, node_type: 'vision', title: 'V', sort_order: 'a0' }),
      seedCmd('node.create', { id: ids.roadmap, node_type: 'roadmap', title: 'R', sort_order: 'a0', parent_id: ids.vision }),
      seedCmd('node.create', { id: ids.project, node_type: 'project', title: 'P', sort_order: 'a0', parent_id: ids.roadmap }),
      seedCmd('node.create', { id: ids.task, node_type: 'task', title: 'T', sort_order: 'a0', parent_id: ids.project }),
    ]);
    return ids;
  }

  beforeAll(async () => {
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    await admin.end();
    url = new URL(`/${dbName}`, adminUrl!).toString();
    await runMigrations(url);
    sql = postgres(url, { max: 6, onnotice: () => undefined });
    backstops = [];
    dispatcher = createDispatcher(drizzle(sql), createRateLimiter({ limit: 100_000, windowMs: 60_000 }), {
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

  it('scenario 1 — different rows: both edits apply (no conflict)', async () => {
    const p = await project();
    const n2 = randomUUID();
    await seed(p.user, [seedCmd('node.create', { id: n2, node_type: 'task', title: 'T2', sort_order: 'a1', parent_id: p.project })]);
    const a = new Device('device-a');
    const b = new Device('device-b');
    a.edit('node.rename', { id: p.task, title: 'A renamed' }, 1000);
    b.edit('node.rename', { id: n2, title: 'B renamed' }, 1000);
    await a.sync(dispatcher, p.user);
    await b.sync(dispatcher, p.user);

    const rows = await sql`SELECT id, title FROM nodes WHERE id IN (${p.task}, ${n2})`;
    const titles = Object.fromEntries(rows.map((r) => [r['id'], r['title']]));
    expect(titles[p.task]).toBe('A renamed');
    expect(titles[n2]).toBe('B renamed');
    a.close();
    b.close();
  });

  it('scenario 2 — same row, different fields: both apply (minimal-field patches)', async () => {
    const p = await project();
    const a = new Device('device-a');
    const b = new Device('device-b');
    a.edit('node.rename', { id: p.task, title: 'New title' }, 1000);
    b.edit('node.set_description', { id: p.task, description: 'New description' }, 2000);
    // upload in the "wrong" order to show field independence is order-free
    await b.sync(dispatcher, p.user);
    await a.sync(dispatcher, p.user);

    const [row] = await sql`SELECT title, description FROM nodes WHERE id = ${p.task}`;
    expect(row).toMatchObject({ title: 'New title', description: 'New description' });
    a.close();
    b.close();
  });

  it('scenario 3 — same row, same field: the later HLC wins, regardless of arrival order', async () => {
    // run the SAME conflict twice with opposite upload orders; both converge
    // to the later-HLC value ("Beta", physical time 2000), proving HLC LWW
    // rather than last-arrival.
    for (const order of ['a-then-b', 'b-then-a'] as const) {
      const p = await project();
      const a = new Device('device-a');
      const b = new Device('device-b');
      a.edit('node.rename', { id: p.task, title: 'Alpha' }, 1000); // earlier
      b.edit('node.rename', { id: p.task, title: 'Beta' }, 2000); // later ⇒ should win
      if (order === 'a-then-b') {
        await a.sync(dispatcher, p.user);
        await b.sync(dispatcher, p.user);
      } else {
        await b.sync(dispatcher, p.user);
        await a.sync(dispatcher, p.user);
      }
      const [row] = await sql`SELECT title FROM nodes WHERE id = ${p.task}`;
      expect(row!['title'], `order ${order}`).toBe('Beta');
      a.close();
      b.close();
    }
  });

  it('scenario 4 — double clock-in resolves by §7.4 (latest started_at stays open)', async () => {
    for (const order of ['a-then-b', 'b-then-a'] as const) {
      const p = await project();
      const a = new Device('device-a');
      const b = new Device('device-b');
      const entryA = randomUUID();
      const entryB = randomUUID();
      // both clock into the same task while offline; B started later
      a.edit('timer.clock_in', { entry_id: entryA, task_id: p.task, started_at: '2026-06-13T10:00:00.000Z' }, 1000);
      b.edit('timer.clock_in', { entry_id: entryB, task_id: p.task, started_at: '2026-06-13T10:05:00.000Z' }, 1000);
      if (order === 'a-then-b') {
        await a.sync(dispatcher, p.user);
        await b.sync(dispatcher, p.user);
      } else {
        await b.sync(dispatcher, p.user);
        await a.sync(dispatcher, p.user);
      }

      const open = await sql`SELECT id FROM time_entries WHERE user_id = ${p.user} AND ended_at IS NULL AND deleted_at IS NULL`;
      expect(open.map((r) => r['id']), `order ${order}`).toEqual([entryB]); // exactly one, the later start
      const [closed] = await sql`SELECT ended_at, completed_session FROM time_entries WHERE id = ${entryA}`;
      expect(closed!['ended_at']).not.toBeNull();
      expect(new Date(closed!['ended_at'] as string).toISOString()).toBe('2026-06-13T10:05:00.000Z');
      expect(closed!['completed_session']).toBeNull();
      a.close();
      b.close();
    }
  });

  it('scenario 6 — two devices answer the same tag placement: later HLC wins', async () => {
    // Mirrors scenario 3 for the new tag_answers fact: the answer is upserted by
    // placement_id, so both devices' offline answers collapse to one live row
    // whose value is the later-HLC one ("no", physical time 2000).
    for (const order of ['a-then-b', 'b-then-a'] as const) {
      const p = await project();
      const block = randomUUID();
      const tag = randomUUID();
      const placement = randomUUID();
      await seed(p.user, [
        seedCmd('block.create', { id: block, task_id: p.task, starts_at: '2026-06-13T10:00:00.000Z', ends_at: '2026-06-13T11:00:00.000Z' }),
        seedCmd('tag.create', { id: tag, label: 'on time?' }),
        seedCmd('tag.place', { id: placement, block_id: block, tag_id: tag }),
      ]);
      const a = new Device('device-a');
      const b = new Device('device-b');
      a.edit('tag.answer', { id: randomUUID(), placement_id: placement, value: 'yes', answered_at: '2026-06-13T11:00:00.000Z' }, 1000); // earlier
      b.edit('tag.answer', { id: randomUUID(), placement_id: placement, value: 'no', answered_at: '2026-06-13T11:30:00.000Z' }, 2000); // later ⇒ wins
      if (order === 'a-then-b') {
        await a.sync(dispatcher, p.user);
        await b.sync(dispatcher, p.user);
      } else {
        await b.sync(dispatcher, p.user);
        await a.sync(dispatcher, p.user);
      }
      const live = await sql`SELECT value FROM tag_answers WHERE placement_id = ${placement} AND deleted_at IS NULL`;
      expect(live, `order ${order}`).toEqual([{ value: 'no' }]);
      a.close();
      b.close();
    }
  });

  it('scenario 5 — in-txn automation converges via UUIDv5 (backstop is a no-op)', async () => {
    const p = await project();
    const ruleId = randomUUID();
    await seed(p.user, [
      seedCmd('rule.create', {
        id: ruleId,
        trigger: 'task_completed',
        conditions: { all: [] },
        actions: [{ action: 'spawn_task', slot: 0, template: { title: 'Follow-up', parent: 'same_as_trigger' } }],
      }),
    ]);
    backstops.length = 0;

    const completedAt = '2026-06-13T14:00:00.000Z';
    const a = new Device('device-a');
    const b = new Device('device-b');
    a.edit('node.check_off', { id: p.task, completed_at: completedAt }, 1000);
    b.edit('node.check_off', { id: p.task, completed_at: completedAt }, 1000);
    await a.sync(dispatcher, p.user);
    await b.sync(dispatcher, p.user);

    // §10.1: each device's check_off ran automation IN ITS txn; the deterministic
    // UUIDv5 id makes the two devices converge to exactly ONE follow-up.
    const afterSync = await sql`SELECT id FROM nodes WHERE user_id = ${p.user} AND title = 'Follow-up' AND deleted_at IS NULL`;
    expect(afterSync).toHaveLength(1);

    // the backstop still fires per trigger but is now only a drift safety-net:
    // the rows are already present, so it is a structural no-op.
    expect(backstops).toEqual([
      { userId: p.user, trigger: 'task_completed', nodeId: p.task },
      { userId: p.user, trigger: 'task_completed', nodeId: p.task },
    ]);

    const first = await runAutomationBackstop(drizzle(sql), backstops[0]!);
    const second = await runAutomationBackstop(drizzle(sql), backstops[1]!);
    expect(first.nodesInserted).toBe(0);
    expect(first.noop).toBe(true);
    expect(second.nodesInserted).toBe(0);
    expect(second.noop).toBe(true);

    const rows = await sql`SELECT id, title FROM nodes WHERE user_id = ${p.user} AND title = 'Follow-up' AND deleted_at IS NULL`;
    expect(rows).toHaveLength(1); // structurally impossible to duplicate (§9.4)
    a.close();
    b.close();
  });
});
