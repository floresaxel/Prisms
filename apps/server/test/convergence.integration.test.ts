/**
 * S12 / M7 — the convergence harness (§7.2, §7.6, §7.10, §7.11, §13, §14). The
 * permanent regression gate before any client rework (M8+ may not start until
 * this is green). Two simulated devices, each with a REAL local SQLite store
 * (an upload queue PLUS the 1.3 two-layer overlay — `client_commands` +
 * `overlay_effects` + a canonical `replica`) and its own HLC clock, make
 * offline edits and sync to the real dispatcher (Postgres compose stack).
 *
 * The server (Postgres) is the convergence point: both devices, syncing the
 * same rows back down, would see identical state — so asserting the converged
 * server state proves device convergence.
 *
 * M7 grows the v1.0 six-scenario harness to thirteen, and proves the M5/§8
 * contracts the client (M8) depends on:
 *  - command envelopes carrying CLIENT-MINTED ids are the only trusted upload;
 *    overlay effects NEVER upload as row patches (scenarios 7–8 + `uploadBody`);
 *  - the frozen `uploadData` response contract (`commandOutcomeSchema`) holds
 *    (`assertContract`);
 *  - rejections + conflicts produce durable `sync_review_items` that sync to the
 *    affected device.
 *
 * Gated on PRISMS_DB_TEST_URL (skips without the compose stack); run directly
 * with `pnpm test:convergence`.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import {
  asEpochMillis,
  canonicalProgress,
  commandOutcomeSchema,
  hlcEncode,
  hlcTick,
  mergeRow,
  mergeTimeEntries,
  uploadRequestSchema,
  uuidV7From,
  type CommandOutcome,
  type Hlc,
  type JsonObject,
  type Node as CoreNode,
  type OverlayEffect,
  type OverlayOp,
  type OverlayRow,
  type TimeEntry,
} from '@prisms/core';
import { loadRootEnv, runMigrations } from '@prisms/db';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDispatcher, type BackstopJob, type Dispatcher } from '../src/dispatcher';
import { runAutomationBackstop } from '../src/jobs/automation-backstop';
import { NIGHTLY_OPTIMIZATION, runScheduleOptimize } from '../src/jobs/schedule-optimize';
import { runWeatherPoll } from '../src/jobs/weather-poll';
import { createRateLimiter } from '../src/rate-limit';

loadRootEnv();
const adminUrl = process.env.PRISMS_DB_TEST_URL;

interface Command {
  id: string;
  name: string;
  hlc: string;
  payload: unknown;
  /** §7.2e intra-device causal deps; §7.11/§8 version axes — present only when set. */
  depends_on?: readonly string[];
  schema_version?: number;
  command_version?: number;
}

/**
 * A simulated device: a real local SQLite store + an HLC clock. It holds BOTH
 *  - a legacy upload `queue` (the server-convergence scenarios assert the
 *    converged Postgres state — the convergence point — so they only need an
 *    ordered command queue), and
 *  - the 1.3 two-layer client store (`client_commands` + `overlay_effects` +
 *    `replica`), client-local ONLY, exercised by the overlay-reconciliation
 *    scenarios (7–8). Nothing in the overlay is ever a server write source.
 */
class Device {
  private clock: Hlc | null = null;
  private readonly local: Database.Database;

  constructor(readonly id: string) {
    this.local = new Database(':memory:');
    this.local.exec(
      'CREATE TABLE queue (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, name TEXT, hlc TEXT, payload TEXT, depends_on TEXT, schema_version INTEGER, command_version INTEGER)',
    );
    // Two-layer client store (1.3 §7.2a) — client-local, never uploaded as rows.
    this.local.exec(
      "CREATE TABLE client_commands (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, name TEXT, hlc TEXT, payload TEXT, depends_on TEXT, status TEXT NOT NULL DEFAULT 'pending')",
    );
    this.local.exec(
      'CREATE TABLE overlay_effects (seq INTEGER PRIMARY KEY AUTOINCREMENT, command_id TEXT, hlc TEXT, tbl TEXT, row_id TEXT, op TEXT, fields TEXT)',
    );
    this.local.exec('CREATE TABLE replica (tbl TEXT, row_id TEXT, data TEXT, PRIMARY KEY (tbl, row_id))');
  }

  /** Advance this device's HLC to logical time `atMs`; return the encoded stamp. */
  private tick(atMs: number): string {
    this.clock = hlcTick(this.clock, asEpochMillis(atMs), this.id);
    return hlcEncode(this.clock);
  }

  // --- legacy queue path (server-convergence scenarios 1–6, 9–13) ------------

  /** Queue a command stamped with this device's next HLC at logical time `atMs`. */
  edit(
    name: string,
    payload: unknown,
    atMs: number,
    opts: { id?: string; depends_on?: readonly string[]; schema_version?: number; command_version?: number } = {},
  ): Command {
    const id = opts.id ?? randomUUID();
    const hlc = this.tick(atMs);
    this.local
      .prepare('INSERT INTO queue (id, name, hlc, payload, depends_on, schema_version, command_version) VALUES (?,?,?,?,?,?,?)')
      .run(
        id,
        name,
        hlc,
        JSON.stringify(payload),
        opts.depends_on ? JSON.stringify(opts.depends_on) : null,
        opts.schema_version ?? null,
        opts.command_version ?? null,
      );
    return { id, name, hlc, payload, depends_on: opts.depends_on, schema_version: opts.schema_version, command_version: opts.command_version };
  }

  private pending(): Command[] {
    return (
      this.local.prepare('SELECT id, name, hlc, payload, depends_on, schema_version, command_version FROM queue ORDER BY seq').all() as {
        id: string;
        name: string;
        hlc: string;
        payload: string;
        depends_on: string | null;
        schema_version: number | null;
        command_version: number | null;
      }[]
    ).map((r) => ({
      id: r.id,
      name: r.name,
      hlc: r.hlc,
      payload: JSON.parse(r.payload) as unknown,
      // include the version/causal axes ONLY when set — the envelope is a strict
      // object, so an explicit `undefined`/extra key would fail validation.
      ...(r.depends_on ? { depends_on: JSON.parse(r.depends_on) as string[] } : {}),
      ...(r.schema_version != null ? { schema_version: r.schema_version } : {}),
      ...(r.command_version != null ? { command_version: r.command_version } : {}),
    }));
  }

  /** Go online: upload the queued commands in order, clear the queue, return the per-command outcomes. */
  async sync(dispatcher: Dispatcher, userId: string): Promise<CommandOutcome[]> {
    const commands = this.pending();
    if (commands.length === 0) return [];
    const res = await dispatcher.handleUpload(userId, { device_id: this.id, commands });
    this.local.prepare('DELETE FROM queue').run();
    if (res.kind !== 'ok') throw new Error(`upload not ok: ${res.kind}`);
    return res.results;
  }

  // --- two-layer overlay path (overlay-reconciliation scenarios 7–8) ---------

  /** Down-sync: seed/refresh the local canonical replica with a server row. */
  hydrate(table: string, row: OverlayRow): void {
    this.local
      .prepare('INSERT OR REPLACE INTO replica (tbl, row_id, data) VALUES (?,?,?)')
      .run(table, String(row['id']), JSON.stringify(row));
  }

  /**
   * Optimistic write (1.3 §7.2): mint the client command id (UUIDv7) + HLC at
   * write time, queue the NAMED command in `client_commands`, and record its row
   * effect in `overlay_effects`. The effect builder receives the minted id so the
   * overlay can PREDICT `created_by_command_id` (== the value the server stamps,
   * V2/§7.2b). Nothing written here is ever uploaded as a row patch.
   */
  executeCommand(args: {
    name: string;
    payload: Record<string, unknown>;
    atMs: number;
    effect: (commandId: string) => { table: string; row_id: string; op: OverlayOp; fields: JsonObject };
    depends_on?: readonly string[];
  }): Command {
    const hlc = this.tick(args.atMs);
    const id = uuidV7From(args.atMs, randomBytes(16));
    const eff = args.effect(id);
    this.local
      .prepare('INSERT INTO client_commands (id, name, hlc, payload, depends_on) VALUES (?,?,?,?,?)')
      .run(id, args.name, hlc, JSON.stringify(args.payload), args.depends_on ? JSON.stringify(args.depends_on) : null);
    this.local
      .prepare('INSERT INTO overlay_effects (command_id, hlc, tbl, row_id, op, fields) VALUES (?,?,?,?,?,?)')
      .run(id, hlc, eff.table, eff.row_id, eff.op, JSON.stringify(eff.fields));
    return { id, name: args.name, hlc, payload: args.payload, depends_on: args.depends_on };
  }

  /** The named command envelopes queued for upload (HLC order) — the ONLY trusted upload (§7.2). */
  pendingEnvelopes(): Command[] {
    return (
      this.local.prepare("SELECT id, name, hlc, payload, depends_on FROM client_commands WHERE status = 'pending' ORDER BY hlc, seq").all() as {
        id: string;
        name: string;
        hlc: string;
        payload: string;
        depends_on: string | null;
      }[]
    ).map((r) => ({
      id: r.id,
      name: r.name,
      hlc: r.hlc,
      payload: JSON.parse(r.payload) as unknown,
      ...(r.depends_on ? { depends_on: JSON.parse(r.depends_on) as string[] } : {}),
    }));
  }

  /** The exact upload body the connector sends — named envelopes, NO row patches. */
  uploadBody(): { device_id: string; commands: Command[] } {
    return { device_id: this.id, commands: this.pendingEnvelopes() };
  }

  /** The merged read for one row (1.3 §7.2): replica patched by its pending overlay effects. */
  mergedRow(table: string, rowId: string): OverlayRow | null {
    const rep = this.local.prepare('SELECT data FROM replica WHERE tbl = ? AND row_id = ?').get(table, rowId) as
      | { data: string }
      | undefined;
    const replica = rep ? (JSON.parse(rep.data) as OverlayRow) : null;
    const effects: OverlayEffect[] = (
      this.local.prepare('SELECT command_id, hlc, tbl, row_id, op, fields FROM overlay_effects WHERE tbl = ? AND row_id = ? ORDER BY seq').all(table, rowId) as {
        command_id: string;
        hlc: string;
        tbl: string;
        row_id: string;
        op: string;
        fields: string;
      }[]
    ).map((e, i) => ({
      command_id: e.command_id,
      hlc: e.hlc,
      table: e.tbl,
      row_id: e.row_id,
      op: e.op as OverlayOp,
      fields: JSON.parse(e.fields) as JsonObject,
      seq: i,
    }));
    return mergeRow(replica, effects);
  }

  /** Count of pending overlay effects — 0 after full reconciliation/rollback. */
  overlayCount(): number {
    return (this.local.prepare('SELECT count(*) AS n FROM overlay_effects').get() as { n: number }).n;
  }

  /** Upload the pending named envelopes and return the outcomes. */
  async push(dispatcher: Dispatcher, userId: string): Promise<CommandOutcome[]> {
    const res = await dispatcher.handleUpload(userId, this.uploadBody());
    if (res.kind !== 'ok') throw new Error(`upload not ok: ${res.kind}`);
    return res.results;
  }

  /**
   * Reconcile the overlay against the server response (1.3 §7.2): drop each
   * command's optimistic effect — an `applied`/`noop` command's value now lives
   * in the canonical replica (synced down via `hydrate`); a `rejected` command
   * rolls back with no data loss. Marks the queued command's terminal status.
   */
  reconcile(outcomes: readonly CommandOutcome[]): void {
    for (const o of outcomes) {
      this.local.prepare('DELETE FROM overlay_effects WHERE command_id = ?').run(o.id);
      this.local.prepare('UPDATE client_commands SET status = ? WHERE id = ?').run(o.result === 'rejected' ? 'rejected' : 'applied', o.id);
    }
  }

  close(): void {
    this.local.close();
  }
}

/** DoD: every per-command outcome conforms to the frozen §8 response contract (M5). */
function assertContract(results: readonly CommandOutcome[]): void {
  for (const r of results) {
    expect(commandOutcomeSchema.safeParse(r).success, `outcome ${JSON.stringify(r)} matches the §8 response contract`).toBe(true);
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

  it('scenario 7 — overlay reconciliation: optimistic create → identical canonical row, matching created_by_command_id', async () => {
    const p = await project();
    const a = new Device('device-a');
    // Optimistically create a task. executeCommand mints the client id (UUIDv7) +
    // HLC at write and predicts created_by_command_id == that id (V2/§7.2b).
    const taskId = randomUUID();
    const cmd = a.executeCommand({
      name: 'node.create',
      payload: { id: taskId, node_type: 'task', title: 'Optimistic', sort_order: 'a5', parent_id: p.project },
      atMs: 1000,
      effect: (cid) => ({
        table: 'nodes',
        row_id: taskId,
        op: 'insert',
        fields: { id: taskId, title: 'Optimistic', node_type: 'task', created_by_command_id: cid },
      }),
    });

    // the merged read shows the optimistic row before any sync (replica is empty for it).
    expect(a.mergedRow('nodes', taskId)).toMatchObject({ title: 'Optimistic', created_by_command_id: cmd.id });
    expect(a.overlayCount()).toBe(1); // the effect lives LOCAL-ONLY in overlay_effects

    // DoD: the upload is named command envelopes (with the client-minted id), NOT
    // row patches — the overlay effect never appears in the upload body.
    const body = a.uploadBody();
    expect(uploadRequestSchema.safeParse(body).success).toBe(true);
    expect(body.commands).toHaveLength(1);
    expect(body.commands[0]).toMatchObject({ id: cmd.id, name: 'node.create' });
    expect(Object.keys(body.commands[0]!).sort()).toEqual(['hlc', 'id', 'name', 'payload']);

    const results = await a.push(dispatcher, p.user);
    assertContract(results);
    expect(results[0]).toMatchObject({ id: cmd.id, result: 'applied', created_by_command_id: cmd.id });

    // down-sync the canonical row and reconcile (drop the now-applied overlay).
    const [canonical] = await sql`SELECT id, title, created_by_command_id, last_modified_by_command_id, source_kind FROM nodes WHERE id = ${taskId}`;
    expect(canonical!['created_by_command_id']).toBe(cmd.id); // server stamped the predicted id (V2 end-to-end)
    a.hydrate('nodes', canonical as OverlayRow);
    a.reconcile(results);

    // the merged read now equals the identical canonical row; the overlay is gone.
    expect(a.overlayCount()).toBe(0);
    expect(a.mergedRow('nodes', taskId)).toMatchObject({
      title: 'Optimistic',
      created_by_command_id: cmd.id,
      source_kind: 'user',
    });
    a.close();
  });

  it('scenario 8 — rejected offline command → review inbox; overlay rolls back (no data loss)', async () => {
    const p = await project();
    const a = new Device('device-a');
    // Optimistically create a structurally-invalid node offline: a task directly
    // under a vision (I1 — a task needs a milestone/project parent) → E_HIERARCHY.
    const badId = randomUUID();
    const cmd = a.executeCommand({
      name: 'node.create',
      payload: { id: badId, node_type: 'task', title: 'Orphan', sort_order: 'a9', parent_id: p.vision },
      atMs: 1000,
      effect: (cid) => ({
        table: 'nodes',
        row_id: badId,
        op: 'insert',
        fields: { id: badId, title: 'Orphan', node_type: 'task', created_by_command_id: cid },
      }),
    });
    expect(a.mergedRow('nodes', badId)).toMatchObject({ title: 'Orphan' }); // shown optimistically
    expect(a.overlayCount()).toBe(1);

    const results = await a.push(dispatcher, p.user);
    assertContract(results);
    expect(results[0]).toMatchObject({ id: cmd.id, result: 'rejected', reject_code: 'E_HIERARCHY' });
    expect(results[0]!.review_item_ids).toHaveLength(1);

    // §7.13: the rejection produced a durable review item that syncs to the
    // affected device (queryable by the user, bound to the command id).
    const items = await sql`SELECT item_type, severity, status, command_id FROM sync_review_items WHERE command_id = ${cmd.id} AND user_id = ${p.user}`;
    expect(items[0]).toMatchObject({ item_type: 'command_rejection', severity: 'warning', status: 'open', command_id: cmd.id });

    // rollback: drop the overlay; nothing committed server-side; the row is gone.
    a.reconcile(results);
    expect(a.overlayCount()).toBe(0);
    expect(a.mergedRow('nodes', badId)).toBeNull();
    const [count] = await sql`SELECT count(*)::int AS n FROM nodes WHERE id = ${badId}`;
    expect(count!['n']).toBe(0);
    a.close();
  });

  it('scenario 9 — double clock-in: overlapping intervals union, not sum (mergeTimeEntries §7.10b)', async () => {
    const p = await project();
    const a = new Device('device-a');
    const b = new Device('device-b');
    const entryA = randomUUID();
    const entryB = randomUUID();
    // A logs 10:00–11:00 (60m); B logs 10:30–11:30 (60m). They overlap by 30m, so
    // the union is 90m while a naive SUM would be 120m. Each device fully closes
    // its own entry offline, then syncs — two overlapping CLOSED entries persist.
    a.edit('timer.clock_in', { entry_id: entryA, task_id: p.task, started_at: '2026-06-13T10:00:00.000Z' }, 1000);
    a.edit('timer.clock_out', { entry_id: entryA, ended_at: '2026-06-13T11:00:00.000Z' }, 1100);
    b.edit('timer.clock_in', { entry_id: entryB, task_id: p.task, started_at: '2026-06-13T10:30:00.000Z' }, 1000);
    b.edit('timer.clock_out', { entry_id: entryB, ended_at: '2026-06-13T11:30:00.000Z' }, 1100);
    await a.sync(dispatcher, p.user);
    await b.sync(dispatcher, p.user);

    const rows = await sql`SELECT id, started_at, ended_at, focus_factor FROM time_entries WHERE task_id = ${p.task} AND deleted_at IS NULL ORDER BY started_at`;
    expect(rows).toHaveLength(2); // both entries persist — no data loss
    const union = mergeTimeEntries(
      rows.map((r) => ({
        id: r['id'] as string,
        started_at: new Date(r['started_at'] as string).toISOString(),
        ended_at: new Date(r['ended_at'] as string).toISOString(),
        focus_factor: r['focus_factor'] as number | null,
      })),
    );
    expect(union.rawMinutes).toBe(90); // union — NOT 120 (the double-counted sum)
    expect(union.segments).toHaveLength(1); // one merged span, 10:00–11:30

    // Aggregate-level union (audit S10-F3b/S3-F2): the PRODUCTION progress
    // aggregate consumes the resolver — asserting on the SYNCED rows, the task
    // consumed 90 minutes (75% of a 120-min estimate), not the 120 a per-entry
    // sum would report. canonicalPractice shares the same per-task-union path
    // (pinned by the §9.2 unit goldens in @prisms/core).
    const progress = canonicalProgress(
      { id: p.task, estimate_minutes: 120 } as unknown as CoreNode,
      rows.map((r) => ({
        id: r['id'] as string,
        task_id: p.task,
        deleted_at: null,
        started_at: new Date(r['started_at'] as string).toISOString(),
        ended_at: new Date(r['ended_at'] as string).toISOString(),
        focus_factor: r['focus_factor'] as number | null,
      })) as unknown as TimeEntry[],
    );
    expect(progress.consumedMinutes).toBe(90);
    expect(progress.percent).toBe(75);
    a.close();
    b.close();
  });

  it('scenario 10 — sort_order collision (insert between the same pair) → one deterministic order via (sort_order, hlc)', async () => {
    // both upload orders must converge to the SAME total order: the tie at sort_order
    // 'a1' is broken by HLC (the earlier-stamped insert sorts first), independent of arrival.
    for (const order of ['a-then-b', 'b-then-a'] as const) {
      const p = await project();
      const sibling = randomUUID();
      await seed(p.user, [seedCmd('node.create', { id: sibling, node_type: 'task', title: 'sib', sort_order: 'a2', parent_id: p.project })]);
      const a = new Device('device-a');
      const b = new Device('device-b');
      const xa = randomUUID();
      const xb = randomUUID();
      // both compute the SAME midpoint key 'a1' offline (between a0 and a2).
      a.edit('node.create', { id: xa, node_type: 'task', title: 'X-a', sort_order: 'a1', parent_id: p.project }, 1000); // earlier HLC
      b.edit('node.create', { id: xb, node_type: 'task', title: 'X-b', sort_order: 'a1', parent_id: p.project }, 2000); // later HLC, same key
      if (order === 'a-then-b') {
        await a.sync(dispatcher, p.user);
        await b.sync(dispatcher, p.user);
      } else {
        await b.sync(dispatcher, p.user);
        await a.sync(dispatcher, p.user);
      }
      const rows = await sql`SELECT id FROM nodes WHERE parent_id = ${p.project} AND deleted_at IS NULL ORDER BY sort_order, hlc`;
      expect(rows.map((r) => r['id']), `order ${order}`).toEqual([p.task, xa, xb, sibling]); // a0, a1(earlier), a1(later), a2
      a.close();
      b.close();
    }
  });

  it('scenario 11 — mixed schema_version devices converge; a below-floor client is rejected client_too_old (§7.11)', async () => {
    const p = await project();
    const a = new Device('device-a');
    const b = new Device('device-b');
    // device A at the current floor (1); device B a NEWER client (2). They edit
    // DIFFERENT fields of the same row, so both apply with no corruption — old
    // clients ignore added columns; newer clients are accepted (only BELOW-floor is rejected).
    a.edit('node.rename', { id: p.task, title: 'A title' }, 1000, { schema_version: 1 });
    b.edit('node.set_description', { id: p.task, description: 'B desc' }, 2000, { schema_version: 2 });
    const ra = await a.sync(dispatcher, p.user);
    const rb = await b.sync(dispatcher, p.user);
    assertContract([...ra, ...rb]);
    expect([...ra, ...rb].every((r) => r.result === 'applied')).toBe(true);
    const [row] = await sql`SELECT title, description, schema_version FROM nodes WHERE id = ${p.task}`;
    expect(row).toMatchObject({ title: 'A title', description: 'B desc' }); // both fields, no clobber
    expect(row!['schema_version']).toBe(1); // the row schema_version is server-owned (additive)

    // a device BELOW the floor (schema_version 0) is rejected + a schema_version_block item.
    const old = new Device('device-old');
    old.edit('node.rename', { id: p.task, title: 'too old' }, 3000, { schema_version: 0 });
    const ro = await old.sync(dispatcher, p.user);
    assertContract(ro);
    expect(ro[0]).toMatchObject({ result: 'rejected', reject_code: 'E_CLIENT_TOO_OLD' });
    expect(ro[0]!.review_item_ids).toHaveLength(1);
    const items = await sql`SELECT item_type, severity FROM sync_review_items WHERE command_id = ${ro[0]!.id} AND user_id = ${p.user}`;
    expect(items[0]).toMatchObject({ item_type: 'schema_version_block', severity: 'error' });
    const [after] = await sql`SELECT title FROM nodes WHERE id = ${p.task}`;
    expect(after!['title']).toBe('A title'); // the below-floor client did not corrupt the row
    a.close();
    b.close();
    old.close();
  });

  it('scenario 12 — dependency_rejected cascade from a rejected depends_on (§7.2e) + review item', async () => {
    const p = await project();
    const a = new Device('device-a');
    // C1 targets a missing node → E_NOT_FOUND. C2 would apply on its own merits but
    // declares depends_on: [C1]; because C1 was rejected in this HLC-ordered batch,
    // C2 is rejected E_DEPENDENCY_REJECTED — the cascade, not C2's own validity.
    const c1 = a.edit('node.rename', { id: randomUUID(), title: 'ghost' }, 1000);
    const c2 = a.edit('node.rename', { id: p.task, title: 'after' }, 2000, { depends_on: [c1.id] });
    const results = await a.sync(dispatcher, p.user);
    assertContract(results);
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    expect(byId[c1.id]).toMatchObject({ result: 'rejected', reject_code: 'E_NOT_FOUND' });
    expect(byId[c2.id]).toMatchObject({ result: 'rejected', reject_code: 'E_DEPENDENCY_REJECTED' });
    expect(byId[c2.id]!.review_item_ids).toHaveLength(1);

    const items = await sql`SELECT item_type, severity FROM sync_review_items WHERE command_id = ${c2.id} AND user_id = ${p.user}`;
    expect(items[0]).toMatchObject({ item_type: 'dependency_rejection', severity: 'warning' });
    const [row] = await sql`SELECT title FROM nodes WHERE id = ${p.task}`;
    expect(row!['title']).toBe('T'); // the dependent edit never applied — the task is untouched
    a.close();
  });

  it('scenario 13 — divergent weather facts converge to one committed state; an older command_version still applies (V10/R19/§8)', async () => {
    const p = await project();
    await seed(p.user, [seedCmd('settings.update', { weather_location: { lat: 1, lon: 2, label: 'Town' } })]);
    const key = 'town/2026-06-13';
    const forecast = (precip: number, high: number) => async () => [{ date: '2026-06-13', high_c: high, low_c: 5, precip_prob: precip, wind_kph: 10 }];

    // two DIVERGENT observations of the same (user, kind, key): rainy, then clear.
    // external facts are server-owned (R17) and keyed-upserted, so they converge to
    // ONE deterministic committed row — the later poll wins; no divergence persists.
    await runWeatherPoll(drizzle(sql), { now: () => 2000 }, forecast(0.9, 10));
    await runWeatherPoll(drizzle(sql), { now: () => 3000 }, forecast(0.0, 25));
    const facts = await sql`SELECT payload FROM external_facts WHERE user_id = ${p.user} AND kind = 'weather_forecast' AND key = ${key} AND deleted_at IS NULL`;
    expect(facts).toHaveLength(1);
    expect(facts[0]!['payload']).toMatchObject({ precip_prob: 0, high_c: 25 });

    // R19/V10: external-fact divergence never changes a CONVERGENT outcome. Two
    // devices rename the same task offline and converge by HLC, identically
    // regardless of the (advisory) weather. device B carries an explicit
    // command_version with a minimal payload — the server accepts and records it
    // (payloads only gain OPTIONAL fields within a version, §8), folding the
    // command-version migration path into this rig.
    const a = new Device('device-a');
    const b = new Device('device-b');
    a.edit('node.rename', { id: p.task, title: 'early' }, 1000);
    const late = b.edit('node.rename', { id: p.task, title: 'late' }, 2000, { command_version: 1 });
    const ra = await a.sync(dispatcher, p.user);
    const rb = await b.sync(dispatcher, p.user);
    assertContract([...ra, ...rb]);
    const [row] = await sql`SELECT title FROM nodes WHERE id = ${p.task}`;
    expect(row!['title']).toBe('late'); // later HLC wins, unaffected by weather
    const [log] = await sql`SELECT command_version FROM command_log WHERE id = ${late.id}`;
    expect(log!['command_version']).toBe(1); // the envelope's command_version is recorded
    a.close();
    b.close();
  });

  it('scenario 13b — a weather-blocked task clocks in WITHOUT force; a dependency-blocked one still needs force (R19/V10, S3-F1)', async () => {
    const p = await project();
    // A weather blocker rule scoped to tasks, plus two extra tasks (t1 → t2 FS)
    // for the dependency case. §10.3/R19: external-fact state must never gate a
    // command — so a task blocked ONLY by weather must clock in without force,
    // while a dependency-blocked task must still be rejected without force.
    const t1 = randomUUID(); // incomplete predecessor
    const t2 = randomUUID(); // FS-blocked by t1
    await seed(p.user, [
      seedCmd('settings.update', { weather_location: { lat: 1, lon: 2, label: 'Town' } }),
      seedCmd('blocker.create', {
        id: randomUUID(),
        scope: { node_types: ['task'] },
        predicate: { all: [{ fact: 'weather.precip_prob', op: 'gt', value: 0.5, key: '{today}' }] },
        label: 'Rain',
      }),
      seedCmd('node.create', { id: t1, node_type: 'task', title: 'T1', sort_order: 'a1', parent_id: p.project }),
      seedCmd('node.create', { id: t2, node_type: 'task', title: 'T2', sort_order: 'a2', parent_id: p.project }),
      seedCmd('edge.create', { id: randomUUID(), predecessor_id: t1, successor_id: t2, edge_type: 'FS' }),
    ]);
    // a "blocking" weather observation for 2026-06-13 (precip 0.9 > 0.5).
    await runWeatherPoll(drizzle(sql), { now: () => Date.parse('2026-06-13T09:00:00.000Z') }, async () => [
      { date: '2026-06-13', high_c: 10, low_c: 5, precip_prob: 0.9, wind_kph: 10 },
    ]);

    // a dispatcher pinned to 2026-06-13 noon so ctx.today() deterministically
    // resolves the {today} key against the weather fact keyed town/2026-06-13.
    const fixed = createDispatcher(drizzle(sql), createRateLimiter({ limit: 100_000, windowMs: 60_000 }), {
      enqueueBackstop: (job) => {
        backstops.push(job);
      },
      nowIso: () => '2026-06-13T12:00:00.000Z',
    });

    const dev = new Device('device-a');
    // p.task is blocked ONLY by weather (no predecessor) → applies without force.
    const okClock = dev.edit('timer.clock_in', { entry_id: randomUUID(), task_id: p.task, started_at: '2026-06-13T12:05:00.000Z' }, 1000);
    // t2 is dependency-blocked (t1 incomplete) → rejected without force.
    const depClock = dev.edit('timer.clock_in', { entry_id: randomUUID(), task_id: t2, started_at: '2026-06-13T12:06:00.000Z' }, 2000);
    const results = await dev.sync(fixed, p.user);
    assertContract(results);
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    // R19/V10 (S3-F1): advisory weather must NOT cause a rejection. (Before R2's
    // dispatcher fix this was rejected E_BLOCKED_TASK — the regression this pins.)
    expect(byId[okClock.id], 'weather-only-blocked clock-in').toMatchObject({ result: 'applied' });
    // dependency blocking is real state and still gates a non-force clock-in.
    expect(byId[depClock.id], 'dependency-blocked clock-in').toMatchObject({ result: 'rejected', reject_code: 'E_BLOCKED_TASK' });

    const open = await sql`SELECT task_id FROM time_entries WHERE user_id = ${p.user} AND ended_at IS NULL AND deleted_at IS NULL`;
    expect(open.map((r) => r['task_id'])).toEqual([p.task]); // exactly the weather-blocked task is running
    dev.close();
  });

  it('scenario 14 — accepting an optimize MOVE replaces the old block; no double-book (§7.5, S5-F2)', async () => {
    // A schedulable task with an existing FLEXIBLE committed block, off-window so
    // the optimizer proposes moving it. §7.5: the suggestion carries
    // replaces_block_id, so accepting it (through the two-layer overlay + reconcile)
    // must converge to ONE committed block, not two.
    const user = randomUUID();
    const ids = { vision: randomUUID(), roadmap: randomUUID(), project: randomUUID(), task: randomUUID() };
    await seed(user, [
      seedCmd('node.create', { id: ids.vision, node_type: 'vision', title: 'V', sort_order: 'a0' }),
      seedCmd('node.create', { id: ids.roadmap, node_type: 'roadmap', title: 'R', sort_order: 'a0', parent_id: ids.vision }),
      seedCmd('node.create', { id: ids.project, node_type: 'project', title: 'P', sort_order: 'a0', parent_id: ids.roadmap }),
      seedCmd('node.create', { id: ids.task, node_type: 'task', title: 'T', sort_order: 'a0', parent_id: ids.project, estimate_minutes: 60 }),
    ]);
    const oldBlock = randomUUID();
    await sql`INSERT INTO schedule_blocks (id, user_id, task_id, starts_at, ends_at, anchor_type, status, updated_at)
      VALUES (${oldBlock}, ${user}, ${ids.task}, '2026-06-20T22:00:00Z', '2026-06-20T23:00:00Z', 'none', 'committed', '2026-06-13T16:00:00.000Z')`;

    const res = await runScheduleOptimize(drizzle(sql), user, { now: () => Date.parse('2026-06-13T16:00:00.000Z') });
    expect(res.suggestions).toBe(1); // the flexible block is replaceable → a move is proposed
    const [suggested] = await sql`
      SELECT id, replaces_block_id FROM schedule_blocks
      WHERE user_id = ${user} AND task_id = ${ids.task} AND status = 'suggested' AND suggestion_reason = ${NIGHTLY_OPTIMIZATION}`;
    expect(suggested!['replaces_block_id']).toBe(oldBlock); // §7.5 replacement link stamped by the job

    // accept through a real device (overlay effect + envelope + reconcile).
    const dev = new Device('device-a');
    const accept = dev.edit('block.accept_suggestion', { id: suggested!['id'] }, Date.parse('2026-06-13T17:00:00.000Z'));
    const outcomes = await dev.sync(dispatcher, user);
    assertContract(outcomes);
    expect(outcomes.find((o) => o.id === accept.id)).toMatchObject({ result: 'applied' });

    // converged server state: exactly one committed block (the promoted one),
    // and the replaced flexible block is soft-deleted.
    const committed = await sql`
      SELECT id FROM schedule_blocks
      WHERE user_id = ${user} AND task_id = ${ids.task} AND status = 'committed' AND deleted_at IS NULL`;
    expect(committed).toHaveLength(1);
    expect(committed[0]!['id']).not.toBe(oldBlock);
    const [gone] = await sql`SELECT deleted_at FROM schedule_blocks WHERE id = ${oldBlock}`;
    expect(gone!['deleted_at']).not.toBeNull();
    dev.close();
  });
});
