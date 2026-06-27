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
  sync_review_items,
  createExecuteCommand,
  readMergedRows,
  uploadClientCommands,
  type CommandRejection,
  type OverlayStore,
  type ReviewItem,
} from '../src/index';
import {
  mergeTable,
  type ClientCommand,
  type OverlayEffect,
  type OverlayRow,
} from '@prisms/core';

// --- an in-memory OverlayStore, mirroring the SQL store's invariants ---------
function memoryStore(seedReplica: Record<string, OverlayRow[]> = {}) {
  const replica = new Map<string, OverlayRow[]>(Object.entries(seedReplica));
  let commands: ClientCommand[] = [];
  let effects: OverlayEffect[] = [];
  const reviews: ReviewItem[] = [];

  const store: OverlayStore = {
    async enqueue(command, cmdEffects) {
      commands.push(command);
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
    async reconcileApplied(commandId) {
      effects = effects.filter((e) => e.command_id !== commandId);
      commands = commands.filter((c) => c.id !== commandId);
    },
    async rollbackRejected({ commandId, reviewItem, rejectCode, rejectReason }) {
      effects = effects.filter((e) => e.command_id !== commandId);
      commands = commands.map((c) =>
        c.id === commandId ? { ...c, status: 'rejected', reject_code: rejectCode, reject_reason: rejectReason } : c,
      );
      reviews.push(reviewItem);
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

  it('appSchema excludes the overlay tables', () => {
    for (const t of ['client_commands', 'overlay_effects', 'sync_review_items']) {
      expect(names(appSchema)).not.toContain(t);
    }
    expect(appSchema.tables).toHaveLength(21);
  });

  it('clientSchema includes them and marks them local-only', () => {
    expect(names(clientSchema)).toEqual(expect.arrayContaining(['client_commands', 'overlay_effects', 'sync_review_items']));
    expect(client_commands.localOnly).toBe(true);
    expect(overlay_effects.localOnly).toBe(true);
    expect(sync_review_items.localOnly).toBe(true);
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
    expect(sent.commands[0]).toEqual({ id: commandId, name: 'node.rename', hlc: expectedHlc, payload: { id: NODE, title: 'New title' } });
    expect(summary).toEqual({ uploaded: 1, applied: 1, rejected: 0, noop: 0 });
  });

  it('applied: drops the overlay so the canonical row (synced back) is the source of truth', async () => {
    const seed = memoryStore({ nodes: [{ id: NODE, title: 'Old', user_id: 'u1' }] });
    const exec = createExecuteCommand(seed.store, { userId: 'u1', deviceId: 'web-1' }, stubDeps());
    await exec.renameNode(NODE, 'New title');

    const fetch = vi.fn(async (_url, init) => {
      const sent = JSON.parse((init as RequestInit).body as string);
      return okResponse({ results: sent.commands.map((c: { id: string }) => ({ id: c.id, result: 'applied' })) });
    });
    await uploadClientCommands({ store: seed.store, apiBaseUrl: 'http://api.test', deviceId: 'web-1', fetch: fetch as never });

    // overlay gone; queue empty
    expect(await seed.store.pendingCommands()).toHaveLength(0);
    expect(await seed.store.effectsFor('nodes')).toHaveLength(0);
    // before the canonical row syncs down the merged read shows the replica…
    expect(await readMergedRows(seed.store, 'nodes')).toEqual([{ id: NODE, title: 'Old', user_id: 'u1' }]);
    // …then the down-sync delivers the identical canonical row.
    seed.setReplica('nodes', [{ id: NODE, title: 'New title', user_id: 'u1' }]);
    expect(await readMergedRows(seed.store, 'nodes')).toEqual([{ id: NODE, title: 'New title', user_id: 'u1' }]);
  });

  it('rejected: rolls back the overlay and records a review item bound to the command id', async () => {
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
      mintId: () => 'review-1',
      now: () => '2026-06-27T00:00:00.000Z',
    });

    // overlay rolled back → merged read reverts to the canonical row
    expect(await readMergedRows(seed.store, 'nodes')).toEqual([{ id: NODE, title: 'Old', user_id: 'u1' }]);
    expect(await seed.store.effectsFor('nodes')).toHaveLength(0);
    // a synced review item bound to the rejected command id
    const items = await seed.store.reviewItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ item_type: 'command_rejection', command_id: commandId, status: 'open', detail: 'nope' });
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
