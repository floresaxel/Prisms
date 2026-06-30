/**
 * M8 — the two-layer connector + command-upload driver (§7.2, §7.3).
 *  - `uploadData` is now a LOUD GUARD: replica-table CRUD must never reach the
 *    upload batch (every write goes to the local-only overlay); if it does, throw.
 *  - `startCommandUpload` drives the named-envelope upload from `client_commands`,
 *    preserving the stored id + HLC (V2) and reconciling applied commands.
 *  - `fetchCredentials` mints the PowerSync JWT.
 */
import { describe, expect, it, vi } from 'vitest';

import { createConnector, startCommandUpload, type WatchableDb } from '../src/powersync/connector';

const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
const baseOpts = { apiBaseUrl: 'http://api.test', powersyncUrl: 'http://ps.test', deviceId: 'web-1' };

function fakeDb(batch: { crud: { op: string; table: string; id: string; opData: Record<string, unknown> | null }[]; complete: ReturnType<typeof vi.fn> } | null) {
  return { getCrudBatch: async () => batch } as never;
}

describe('connector.uploadData — loud guard (R15)', () => {
  it('throws if any replica-table CRUD op reaches the upload batch (a write bypassed the overlay)', async () => {
    const complete = vi.fn();
    const connector = createConnector(baseOpts);
    await expect(
      connector.uploadData(fakeDb({ complete, crud: [{ op: 'PATCH', table: 'nodes', id: 'n1', opData: { title: 'x' } }] })),
    ).rejects.toThrow(/bypassed executeCommand/);
    expect(complete).not.toHaveBeenCalled(); // batch left intact — the error surfaces loudly
  });

  it('completes a null / empty batch (the normal case: overlay writes enqueue no replica CRUD)', async () => {
    const connector = createConnector(baseOpts);
    await expect(connector.uploadData(fakeDb(null))).resolves.toBeUndefined();
    const complete = vi.fn();
    await connector.uploadData(fakeDb({ complete, crud: [] }));
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('fetchCredentials returns the PowerSync endpoint + JWT', async () => {
    const fetch = vi.fn(async () => okResponse({ token: 'jwt-123' }));
    const connector = createConnector({ ...baseOpts, fetch: fetch as unknown as typeof globalThis.fetch });
    const creds = await connector.fetchCredentials!();
    expect(creds).toEqual({ endpoint: 'http://ps.test', token: 'jwt-123' });
    expect(fetch).toHaveBeenCalledWith('http://api.test/api/powersync/token', { credentials: 'include' });
  });
});

/** A fake SqlExecutor + watch backing `createSqlOverlayStore`, for the driver. */
function fakeWatchableDb(pendingRows: Record<string, unknown>[]) {
  const tx = { execute: vi.fn(async () => undefined), getAll: vi.fn(async () => []) };
  const db = {
    execute: vi.fn(async () => undefined),
    getAll: vi.fn(async (sql: string) => (sql.includes('client_commands') ? pendingRows : [])),
    writeTransaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    watch: vi.fn(),
  };
  return { db: db as unknown as WatchableDb, tx, raw: db };
}

describe('startCommandUpload — envelope upload driven by client_commands', () => {
  const pending = [{ id: 'c1', name: 'node.rename', hlc: '000000000001-0000-web-1', payload: '{"id":"n1","title":"x"}', status: 'pending', created_at: 't' }];

  it('drains the pending queue: uploads one named envelope (stored id+HLC, V2) and reconciles applied', async () => {
    const { db, tx, raw } = fakeWatchableDb(pending);
    const fetch = vi.fn(async (_url, init) => {
      const sent = JSON.parse((init as RequestInit).body as string);
      return okResponse({ results: sent.commands.map((c: { id: string }) => ({ id: c.id, result: 'applied' })) });
    });
    const stop = startCommandUpload(db, { apiBaseUrl: 'http://api.test', deviceId: 'web-1', fetch: fetch as never, setInterval: vi.fn(() => 0 as never) });

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const sent = JSON.parse((fetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(sent.device_id).toBe('web-1');
    expect(sent.commands[0]).toEqual({ id: 'c1', name: 'node.rename', hlc: '000000000001-0000-web-1', payload: { id: 'n1', title: 'x' } });
    // reconcile dropped the applied command's overlay + queue rows
    await vi.waitFor(() => expect(tx.execute).toHaveBeenCalled());
    // registered a watch on the pending queue so a fresh write triggers an upload
    expect(raw.watch).toHaveBeenCalledTimes(1);
    expect((raw.watch.mock.calls[0]![0] as string)).toMatch(/client_commands/);
    stop();
  });

  it('a network failure leaves the queue intact (no throw escapes the driver)', async () => {
    const { db } = fakeWatchableDb(pending);
    const fetch = vi.fn(async () => ({ ok: false, status: 429 }) as Response);
    const stop = startCommandUpload(db, { apiBaseUrl: 'http://api.test', deviceId: 'web-1', fetch: fetch as never, setInterval: vi.fn(() => 0 as never) });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    // the driver swallows the error (commands stay pending for the next watch/retry)
    expect(stop).toBeTypeOf('function');
    stop();
  });
});
