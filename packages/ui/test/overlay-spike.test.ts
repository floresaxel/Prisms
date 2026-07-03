/**
 * M0 spike — two-layer client store, end-to-end on `node.rename` (1.3 §7.2).
 *
 * Proves, without a browser/PowerSync runtime, the load-bearing contracts:
 *  - the overlay tables are local-only and absent from `appSchema` (never
 *    uploaded as row patches);
 *  - an optimistic rename shows from the merged read instantly;
 *  - exactly one named command envelope is uploaded, carrying the
 *    client-minted id + HLC (no upload-time minting, no row patch) — V2;
 *  - `applied` reconciles by dropping the overlay;
 *  - `rejected` rolls back (drops the overlay) and records a review item bound
 *    to the command id;
 *  - a network/429 failure throws and keeps the queue.
 *
 * The full client→server round-trip (proving `command_log.id == client id`
 * against the real dispatcher) lives in apps/server/test/m0-spike.integration.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  appSchema,
  clientSchema,
  client_commands,
  overlay_effects,
  createExecuteCommand,
  readMergedRows,
  uploadClientCommands,
  UploadClientError,
  type CommandRejection,
  type OverlayStore,
  type PendingCommand,
  type ReviewItem,
} from '../src/index';
import {
  defaultCommandMeta,
  mergeTable,
  type OverlayEffect,
  type OverlayRow,
} from '@prisms/core';

// --- an in-memory OverlayStore, mirroring the SQL store's invariants ---------
function memoryStore(seedReplica: Record<string, OverlayRow[]> = {}) {
  const replica = new Map<string, OverlayRow[]>(Object.entries(seedReplica));
  let commands: PendingCommand[] = [];
  let effects: OverlayEffect[] = [];
  const reviews: ReviewItem[] = [];

  const store: OverlayStore = {
    async enqueue(command, cmdEffects, dependsOn = []) {
      const meta = defaultCommandMeta([...dependsOn]);
      commands.push({ ...command, command_version: meta.command_version, schema_version: meta.schema_version, client_version: null, depends_on: [...dependsOn] });
      effects.push(...cmdEffects);
    },
    async pendingCommands() {
      return commands.filter((c) => c.status === 'pending').sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0));
    },
    async effectsFor(table) {
      return effects.filter((e) => e.table === table);
    },
    async replicaRows(table) {
      return replica.get(table) ?? [];
    },
    async markApplied(commandId) {
      commands = commands.map((c) => (c.id === commandId ? { ...c, status: 'applied' } : c));
    },
    async reconcileConfirmed(nowMs = Date.now()) {
      const cleared: string[] = [];
      for (const cmd of commands.filter((c) => c.status === 'applied')) {
        const arrived = effects
          .filter((e) => e.command_id === cmd.id)
          .every((e) => {
            const canonical = (replica.get(e.table) ?? []).find((r) => String(r['id']) === e.row_id);
            if (e.op === 'delete') return !canonical || canonical['deleted_at'] != null;
            if (!canonical || canonical['deleted_at'] != null) return false;
            const stamp = canonical['last_modified_by_command_id'];
            return stamp == null || String(stamp) === cmd.id;
          });
        if (arrived) {
          effects = effects.filter((e) => e.command_id !== cmd.id);
          commands = commands.filter((c) => c.id !== cmd.id);
          cleared.push(cmd.id);
        }
      }
      const cutoff = new Date(nowMs - 30 * 86_400_000).toISOString();
      commands = commands.filter((c) => !(c.status === 'rejected' && c.created_at < cutoff));
      return { cleared };
    },
    async rollbackRejected({ commandId, rejectCode, rejectReason }) {
      effects = effects.filter((e) => e.command_id !== commandId);
      commands = commands.map((c) =>
        c.id === commandId ? { ...c, status: 'rejected', reject_code: rejectCode, reject_reason: rejectReason } : c,
      );
    },
    async reviewItems() {
      return reviews.filter((r) => r.status === 'open');
    },
  };
  return {
    store,
    setReplica: (table: string, rows: OverlayRow[]) => replica.set(table, rows),
    allCommands: () => commands,
    allEffects: () => effects,
  };
}

const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
const NODE = '11111111-1111-7111-8111-111111111111';

// deterministic mint/hlc/now for the spike
const stubDeps = () => {
  let n = 0;
  return {
    mintId: vi.fn(() => `00000000-0000-7000-8000-00000000000${++n}`),
    nextHlc: vi.fn(() => `${(1000 + n).toString(16).padStart(12, '0')}-0000-web-1`),
    now: () => '2026-06-27T00:00:00.000Z',
  };
};

describe('schema: overlay tables are local-only and out of appSchema (R15)', () => {
  const names = (s: { tables: { name: string }[] }) => s.tables.map((t) => t.name);

  it('appSchema excludes the local-only overlay tables but INCLUDES synced sync_review_items', () => {
    for (const t of ['client_commands', 'overlay_effects']) {
      expect(names(appSchema)).not.toContain(t);
    }
    // §7.13: the review inbox is server-owned and streams down, so it IS synced.
    expect(names(appSchema)).toContain('sync_review_items');
    expect(appSchema.tables).toHaveLength(22);
  });

  it('clientSchema includes the overlay tables and marks ONLY those local-only', () => {
    expect(names(clientSchema)).toEqual(expect.arrayContaining(['client_commands', 'overlay_effects', 'sync_review_items']));
    expect(client_commands.localOnly).toBe(true);
    expect(overlay_effects.localOnly).toBe(true);
  });
});

describe('executeCommand: optimistic rename → overlay + merged read', () => {
  it('queues one command + effect and the merged read shows the pending rename', async () => {
    const { store } = memoryStore({ nodes: [{ id: NODE, title: 'Old', user_id: 'u1' }] });
    const deps = stubDeps();
    const exec = createExecuteCommand(store, { userId: 'u1', deviceId: 'web-1' }, deps);

    const commandId = await exec.renameNode(NODE, 'New title');

    expect(commandId).toBe('00000000-0000-7000-8000-000000000001');
    const pending = await store.pendingCommands();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id: commandId, name: 'node.rename', payload: { id: NODE, title: 'New title' } });
    // trust fields never leak into the queued payload (strictObject would also reject them)
    expect(Object.keys(pending[0]!.payload as object)).toEqual(['id', 'title']);

    const merged = await readMergedRows(store, 'nodes');
    expect(merged).toEqual([{ id: NODE, title: 'New title', user_id: 'u1' }]);
  });

  it('rejects an invalid target id before queuing (catalog validation)', async () => {
    const { store } = memoryStore();
    const exec = createExecuteCommand(store, { userId: 'u1', deviceId: 'web-1' }, stubDeps());
    await expect(exec.renameNode('not-a-uuid', 'x')).rejects.toThrow(/node\.rename invalid/);
    expect(await store.pendingCommands()).toHaveLength(0);
  });
});

describe('uploadClientCommands: envelope upload + reconciliation (V2, §7.2)', () => {
  it('uploads exactly one named envelope with the client-minted id + hlc (no row patch)', async () => {
    const { store } = memoryStore({ nodes: [{ id: NODE, title: 'Old', user_id: 'u1' }] });
    const deps = stubDeps();
    const exec = createExecuteCommand(store, { userId: 'u1', deviceId: 'web-1' }, deps);
    const commandId = await exec.renameNode(NODE, 'New title');
    const expectedHlc = deps.nextHlc.mock.results[0]!.value as string;

    const fetch = vi.fn(async (_url, init) => {
      const sent = JSON.parse((init as RequestInit).body as string);
      return okResponse({ results: sent.commands.map((c: { id: string }) => ({ id: c.id, result: 'applied' })) });
    });

    const summary = await uploadClientCommands({
      store,
      apiBaseUrl: 'http://api.test',
      deviceId: 'web-1',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('http://api.test/sync/upload');
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.device_id).toBe('web-1');
    expect(sent.commands).toHaveLength(1);
    // V2: the uploaded id is the SAME id minted at write time — not re-minted.
    // R6: the envelope now carries the version axes (§8/§7.11).
    expect(sent.commands[0]).toEqual({ id: commandId, name: 'node.rename', hlc: expectedHlc, payload: { id: NODE, title: 'New title' }, command_version: 1, schema_version: 1 });
    expect(summary).toEqual({ uploaded: 1, applied: 1, rejected: 0, noop: 0 });
  });

  it('applied: KEEPS the overlay until the canonical row arrives (no revert-flicker, S7-F6)', async () => {
    const seed = memoryStore({ nodes: [{ id: NODE, title: 'Old', user_id: 'u1' }] });
    const exec = createExecuteCommand(seed.store, { userId: 'u1', deviceId: 'web-1' }, stubDeps());
    const commandId = await exec.renameNode(NODE, 'New title');

    const fetch = vi.fn(async (_url, init) => {
      const sent = JSON.parse((init as RequestInit).body as string);
      return okResponse({ results: sent.commands.map((c: { id: string }) => ({ id: c.id, result: 'applied' })) });
    });
    await uploadClientCommands({ store: seed.store, apiBaseUrl: 'http://api.test', deviceId: 'web-1', fetch: fetch as never });

    // marked applied (not re-uploadable) but the overlay is KEPT, so the merged
    // read still shows the NEW value between the ack and the down-sync — no flicker.
    expect(await seed.store.pendingCommands()).toHaveLength(0);
    expect(await seed.store.effectsFor('nodes')).toHaveLength(1);
    expect(await readMergedRows(seed.store, 'nodes')).toEqual([{ id: NODE, title: 'New title', user_id: 'u1' }]);

    // a delayed down-sync delivers the identical canonical row carrying our command
    // id (V2) → reconcileConfirmed drops the now-redundant overlay.
    seed.setReplica('nodes', [{ id: NODE, title: 'New title', user_id: 'u1', last_modified_by_command_id: commandId }]);
    expect(await seed.store.reconcileConfirmed()).toEqual({ cleared: [commandId] });
    expect(await seed.store.effectsFor('nodes')).toHaveLength(0);
    expect(await readMergedRows(seed.store, 'nodes')).toEqual([{ id: NODE, title: 'New title', user_id: 'u1', last_modified_by_command_id: commandId }]);
  });

  it('chunks a >100-command queue into sequential ≤100 batches — all applied (S7-F2)', async () => {
    const seed = memoryStore();
    const exec = createExecuteCommand(seed.store, { userId: 'u1', deviceId: 'web-1' });
    // 150 real optimistic creates (unique valid uuids) → 2 batches (100 + 50).
    // (execute does not run invariants — S7-F4 — so 150 visions queue fine; the
    // mocked server acks them all.)
    for (let i = 0; i < 150; i += 1) {
      const id = `11111111-1111-7111-8111-${i.toString(16).padStart(12, '0')}`;
      await exec.execute('node.create', { id, node_type: 'vision', title: `V${i}`, sort_order: 'a0' });
    }
    expect(await seed.store.pendingCommands()).toHaveLength(150);

    const batchSizes: number[] = [];
    const fetch = vi.fn(async (_url, init) => {
      const sent = JSON.parse((init as RequestInit).body as string);
      batchSizes.push(sent.commands.length);
      return okResponse({ results: sent.commands.map((c: { id: string }) => ({ id: c.id, result: 'applied' })) });
    });
    const summary = await uploadClientCommands({ store: seed.store, apiBaseUrl: 'http://api.test', deviceId: 'web-1', fetch: fetch as never });

    expect(fetch).toHaveBeenCalledTimes(2); // 150 / 100 → two requests
    expect(batchSizes).toEqual([100, 50]);
    expect(summary).toEqual({ uploaded: 150, applied: 150, rejected: 0, noop: 0 });
    expect(await seed.store.pendingCommands()).toHaveLength(0); // none left pending
  });

  it('a 4xx surfaces as UploadClientError (won\'t self-heal by retrying), not a transient error', async () => {
    const seed = memoryStore({ nodes: [{ id: NODE, title: 'Old', user_id: 'u1' }] });
    const exec = createExecuteCommand(seed.store, { userId: 'u1', deviceId: 'web-1' }, stubDeps());
    await exec.renameNode(NODE, 'New title');
    const fetch = vi.fn(async () => ({ ok: false, status: 400, text: async () => 'bad envelope' }) as Response);
    await expect(
      uploadClientCommands({ store: seed.store, apiBaseUrl: 'http://api.test', deviceId: 'web-1', fetch: fetch as never }),
    ).rejects.toBeInstanceOf(UploadClientError);
    expect(await seed.store.pendingCommands()).toHaveLength(1); // still queued
  });

  it('rejected: rolls back the overlay (drops it) and surfaces onReject — the durable item is server-synced', async () => {
    const seed = memoryStore({ nodes: [{ id: NODE, title: 'Old', user_id: 'u1' }] });
    const exec = createExecuteCommand(seed.store, { userId: 'u1', deviceId: 'web-1' }, stubDeps());
    const commandId = await exec.renameNode(NODE, 'New title');
    expect(await readMergedRows(seed.store, 'nodes')).toEqual([{ id: NODE, title: 'New title', user_id: 'u1' }]);

    const rejections: CommandRejection[] = [];
    const fetch = vi.fn(async (_url, init) => {
      const sent = JSON.parse((init as RequestInit).body as string);
      return okResponse({ results: sent.commands.map((c: { id: string }) => ({ id: c.id, result: 'rejected', reject_code: 'E_OWNERSHIP', reject_reason: 'nope' })) });
    });
    const summary = await uploadClientCommands({
      store: seed.store,
      apiBaseUrl: 'http://api.test',
      deviceId: 'web-1',
      fetch: fetch as never,
      onReject: (r) => rejections.push(...r),
    });

    // overlay rolled back → merged read reverts to the canonical row
    expect(await readMergedRows(seed.store, 'nodes')).toEqual([{ id: NODE, title: 'Old', user_id: 'u1' }]);
    expect(await seed.store.effectsFor('nodes')).toHaveLength(0);
    // the client writes NO local review item — the server creates it (M5) and it
    // streams down to the synced inbox (§7.13).
    expect(await seed.store.reviewItems()).toHaveLength(0);
    expect(rejections).toEqual([{ id: commandId, name: 'node.rename', reject_code: 'E_OWNERSHIP', reject_reason: 'nope' }]);
    expect(summary).toEqual({ uploaded: 1, applied: 0, rejected: 1, noop: 0 });
  });

  it('throws on a network/429 so the queue survives', async () => {
    const seed = memoryStore({ nodes: [{ id: NODE, title: 'Old', user_id: 'u1' }] });
    const exec = createExecuteCommand(seed.store, { userId: 'u1', deviceId: 'web-1' }, stubDeps());
    await exec.renameNode(NODE, 'New title');
    const fetch = vi.fn(async () => ({ ok: false, status: 429 }) as Response);
    await expect(
      uploadClientCommands({ store: seed.store, apiBaseUrl: 'http://api.test', deviceId: 'web-1', fetch: fetch as never }),
    ).rejects.toThrow(/429/);
    expect(await seed.store.pendingCommands()).toHaveLength(1); // intact for retry
  });
});

describe('mergeTable re-export wiring', () => {
  it('@prisms/core mergeTable is reachable for the read path', () => {
    expect(mergeTable([{ id: 'a', v: 1 }], [])).toEqual([{ id: 'a', v: 1 }]);
  });
});
