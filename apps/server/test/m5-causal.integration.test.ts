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
  // R6: default the §7.11 version (absent = below-floor); `extra` can override
  // it (e.g. a below-floor client_too_old test passes schema_version: 0).
  return { id: randomUUID(), name, hlc: hlcEncode(hlcState), payload, schema_version: 1, ...extra };
}

describe.skipIf(!adminUrl)('M5 — causal ordering + schema floor + review inbox', () => {
  const dbName = `prisms_m5c_${Date.now().toString(36)}`;
  let sql: postgres.Sql;
  let dispatcher: Dispatcher;
  const upload = (userId: string, commands: Envelope[]) => dispatcher.handleUpload(userId, { device_id: 'web-1', commands });

  let seedSeq = 0;
  const seedCmd = (name: string, payload: unknown): Envelope => ({ id: randomUUID(), name, hlc: `${(++seedSeq).toString(16).padStart(12, '0')}-0000-seed`, payload, schema_version: 1 });

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

  it('accepts a command at the schema floor and one that omits schema_version', async () => {
    const user = randomUUID();
    const p = await project(user);
    const atFloor = mk('node.rename', { id: p.task, title: 'at floor' }, { schema_version: 1 });
    const omitted = mk('node.set_description', { id: p.task, description: 'd' }); // no schema_version
    const res = await upload(user, [atFloor, omitted]);
    if (res.kind !== 'ok') throw new Error(res.kind);
    expect(res.results.every((r) => r.result === 'applied')).toBe(true);
  });

  it('persists depends_on to command_log for an applied dependent', async () => {
    const user = randomUUID();
    const p = await project(user);
    const first = mk('node.rename', { id: p.task, title: 'a' });
    const second = mk('node.set_description', { id: p.task, description: 'b' }, { depends_on: [first.id] });
    const res = await upload(user, [first, second]);
    if (res.kind !== 'ok') throw new Error(res.kind);
    expect(res.results.every((r) => r.result === 'applied')).toBe(true);
    expect(res.results.find((r) => r.id === second.id)!.review_item_ids).toBeUndefined();
    const [log] = await sql`SELECT depends_on FROM command_log WHERE id = ${second.id}`;
    expect(log!['depends_on']).toEqual([first.id]);
  });

  it('cascades dependency rejection transitively (A rejected → B → C)', async () => {
    const user = randomUUID();
    const p = await project(user);
    const a = mk('node.rename', { id: randomUUID(), title: 'ghost' }); // E_NOT_FOUND
    const b = mk('node.rename', { id: p.task, title: 'b' }, { depends_on: [a.id] });
    const c = mk('node.set_description', { id: p.task, description: 'c' }, { depends_on: [b.id] });
    const res = await upload(user, [a, b, c]);
    if (res.kind !== 'ok') throw new Error(res.kind);
    const byId = Object.fromEntries(res.results.map((r) => [r.id, r]));
    expect(byId[a.id]).toMatchObject({ result: 'rejected', reject_code: 'E_NOT_FOUND' });
    expect(byId[b.id]).toMatchObject({ result: 'rejected', reject_code: 'E_DEPENDENCY_REJECTED' });
    expect(byId[c.id]).toMatchObject({ result: 'rejected', reject_code: 'E_DEPENDENCY_REJECTED' });
    // the task is untouched and each rejection produced a review item
    const [row] = await sql`SELECT title FROM nodes WHERE id = ${p.task}`;
    expect(row!['title']).toBe('T');
    expect(byId[c.id]!.review_item_ids).toHaveLength(1);
  });

  it('rejects a depends_on referencing another user\'s command id as unknown (no cross-user oracle)', async () => {
    const owner = randomUUID();
    const other = randomUUID();
    const po = await project(owner);
    const applied = mk('node.rename', { id: po.task, title: 'owned' });
    await upload(owner, [applied]); // a real APPLIED command of `owner`
    // `other` references owner's applied command id — must be unknown, not satisfied.
    const pOther = await project(other);
    const cmd = mk('node.rename', { id: pOther.task, title: 'x' }, { depends_on: [applied.id] });
    const res = await upload(other, [cmd]);
    if (res.kind !== 'ok') throw new Error(res.kind);
    expect(res.results[0]).toMatchObject({ result: 'rejected', reject_code: 'E_UNKNOWN_TARGET' });
  });

  it('a losing concurrent field write creates an hlc_conflict item preserving the losing value (§7.13)', async () => {
    const user = randomUUID();
    const p = await project(user);
    // winner: a high-HLC rename applies first and records the field version.
    const high = { id: randomUUID(), name: 'node.rename', hlc: 'ffffffffffff-0000-web-9', payload: { id: p.task, title: 'New' }, schema_version: 1 };
    const r1 = await upload(user, [high]);
    expect(r1.kind === 'ok' && r1.results[0]!.result).toBe('applied');

    // loser: an older-HLC rename with a DIFFERENT value loses LWW (separate upload,
    // so it is not reordered ahead of the winner).
    const low = { id: randomUUID(), name: 'node.rename', hlc: '000000000001-0000-web-9', payload: { id: p.task, title: 'Old' }, schema_version: 1 };
    const r2 = await upload(user, [low]);
    if (r2.kind !== 'ok') throw new Error(r2.kind);
    expect(r2.results[0]!.result).toBe('applied'); // the command is logged; the field just loses

    const [row] = await sql`SELECT title FROM nodes WHERE id = ${p.task}`;
    expect(row!['title']).toBe('New'); // the winner stands

    const items = await sql`SELECT severity, detail FROM sync_review_items WHERE user_id = ${user} AND item_type = 'hlc_conflict'`;
    expect(items).toHaveLength(1);
    expect(items[0]!['severity']).toBe('warning');
    expect(items[0]!['detail']).toMatchObject({ field: 'title', winning_value: 'New', losing_value: 'Old' });
  });

  it('a losing write with the SAME value creates no hlc_conflict item (not material, §7.13)', async () => {
    const user = randomUUID();
    const p = await project(user);
    const high = { id: randomUUID(), name: 'node.rename', hlc: 'ffffffffffff-0000-web-8', payload: { id: p.task, title: 'Same' } };
    await upload(user, [high]);
    const low = { id: randomUUID(), name: 'node.rename', hlc: '000000000001-0000-web-8', payload: { id: p.task, title: 'Same' } };
    await upload(user, [low]); // older, but identical value → converges, not a conflict
    const items = await sql`SELECT count(*)::int AS n FROM sync_review_items WHERE user_id = ${user} AND item_type = 'hlc_conflict'`;
    expect(items[0]!['n']).toBe(0);
  });
});
