/**
 * R8 (S4-F2): the SERVER write-path scale gate. The audit found every gated
 * command (non-force clock-in, gated completion, node create/move/…) loads the
 * user's FULL fact set inside its transaction — an O(all-rows) read per command,
 * a 100k-node cliff the client-side StatusIndex perf test never covered.
 *
 * The per-batch context cache (S4-F2) memoizes those loads across a batch and
 * reloads only what a prior command wrote. This measures a chain of `edge.create`
 * commands (each running `checkEdgeCreate` over the full 100k node tree) against a
 * 100k-node account, cache OFF (baseline) vs ON. `edge.create` writes only
 * `edges`, so the 100k `tree` load survives across the batch when cached — the
 * exact repeated O(all-rows) load the audit flagged. Wall times are logged; the
 * hard assert has headroom for CI contention (mirrors load.perf.test.ts style).
 *
 * Gated on PRISMS_DB_TEST_URL (skips without the compose stack).
 */
import { randomUUID } from 'node:crypto';

import { loadRootEnv, runMigrations } from '@prisms/db';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDispatcher } from '../src/dispatcher';
import { createRateLimiter } from '../src/rate-limit';

loadRootEnv();
const adminUrl = process.env.PRISMS_DB_TEST_URL;

const TOTAL = 100_000;
const CHAIN = 21; // 21 tasks → a 20-edge DAG chain per run

let hlc = 0;
const cmd = (name: string, payload: unknown) => ({
  id: randomUUID(),
  name,
  hlc: `${(++hlc).toString(16).padStart(12, '0')}-0000-perf-device`,
  payload,
  schema_version: 1,
});

describe.skipIf(!adminUrl)('R8 server write-path scale (§7.5, S4-F2)', () => {
  const dbName = `prisms_perf_${Date.now().toString(36)}`;
  let url: string;
  let sql: postgres.Sql;

  const user = randomUUID();
  const project = randomUUID();
  // two disjoint task chains so the baseline and cached runs don't interfere.
  const tasksA = Array.from({ length: CHAIN }, () => randomUUID());
  const tasksB = Array.from({ length: CHAIN }, () => randomUUID());

  beforeAll(async () => {
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    await admin.end();
    url = new URL(`/${dbName}`, adminUrl!).toString();
    await runMigrations(url);
    sql = postgres(url, { max: 4, onnotice: () => undefined });

    // spine: vision → roadmap → project
    const vision = randomUUID();
    const roadmap = randomUUID();
    await sql`INSERT INTO nodes (id, user_id, parent_id, node_type, title, description, sort_order, created_at, updated_at) VALUES
      (${vision}, ${user}, NULL, 'vision', 'V', '', 'a0', now(), now()),
      (${roadmap}, ${user}, ${vision}, 'roadmap', 'R', '', 'a0', now(), now()),
      (${project}, ${user}, ${roadmap}, 'project', 'P', '', 'a0', now(), now())`;

    // ~100k filler task nodes under the project (bulk; defaults fill provenance/hlc).
    const filler = TOTAL - 3 - tasksA.length - tasksB.length;
    await sql`
      INSERT INTO nodes (id, user_id, parent_id, node_type, title, description, sort_order, created_at, updated_at)
      SELECT gen_random_uuid(), ${user}, ${project}, 'task', 'n' || g, '', 'a' || lpad(g::text, 7, '0'), now(), now()
      FROM generate_series(1, ${filler}) g`;

    // the 42 known tasks the chains link (endpoints exist → checkEdgeCreate passes).
    const known = [...tasksA, ...tasksB];
    for (let i = 0; i < known.length; i += 1) {
      await sql`INSERT INTO nodes (id, user_id, parent_id, node_type, title, description, sort_order, created_at, updated_at)
        VALUES (${known[i]!}, ${user}, ${project}, 'task', ${`known${i}`}, '', ${`b${String(i).padStart(4, '0')}`}, now(), now())`;
    }

    const countRows = (await sql`SELECT count(*)::int AS n FROM nodes WHERE user_id = ${user}`) as unknown as { n: number }[];
    expect(countRows[0]!.n).toBe(TOTAL);
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  it('the per-batch context cache slashes repeated tree loads at 100k', async () => {
    // a 20-edge DAG chain t0→t1→…→t20 — each edge.create runs checkEdgeCreate
    // over the full node tree, but writes only `edges`, so the 100k `tree` load
    // survives across the batch when cached.
    const chainEdges = (tasks: string[]) =>
      tasks.slice(1).map((succ, i) => cmd('edge.create', { id: randomUUID(), predecessor_id: tasks[i]!, successor_id: succ, edge_type: 'FS' }));

    const run = async (disableBatchCache: boolean, tasks: string[]): Promise<number> => {
      const dispatcher = createDispatcher(drizzle(sql), createRateLimiter({ limit: 1_000_000, windowMs: 60_000 }), { disableBatchCache });
      const t0 = performance.now();
      const res = await dispatcher.handleUpload(user, { device_id: 'perf', commands: chainEdges(tasks) });
      const ms = performance.now() - t0;
      if (res.kind !== 'ok') throw new Error(`upload not ok: ${res.kind}`);
      expect(res.results.every((r) => r.result === 'applied')).toBe(true);
      return ms;
    };

    // warm the pg connection / plan / buffer caches so the comparison is
    // cache-vs-no-cache, not cold-vs-warm.
    await sql`SELECT count(*) FROM nodes WHERE user_id = ${user}`;
    await sql`SELECT count(*) FROM nodes WHERE user_id = ${user}`;

    const baselineMs = await run(true /* fresh ctx per command */, tasksA);
    const cachedMs = await run(false /* one ctx for the batch */, tasksB);
    const speedup = baselineMs / cachedMs;

    // eslint-disable-next-line no-console
    console.log(`[perf] ${CHAIN - 1} edge.creates over ${TOTAL} nodes · baseline ${baselineMs.toFixed(0)}ms · cached ${cachedMs.toFixed(0)}ms · ${speedup.toFixed(1)}×`);

    // The binding gate: the cache is a large win (each baseline edge.create
    // reloads the 100k tree; the cached run loads it once). ≥3× hard-asserted with
    // headroom for CI contention; measured ~18× locally (see the log). The ratio
    // is contention-robust (starvation slows both runs proportionally).
    expect(cachedMs).toBeLessThan(baselineMs / 3);
  }, 180_000);
});
