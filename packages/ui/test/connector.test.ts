/**
 * S15: the PowerSync connector's upload path (§7.3). Translates the local CRUD
 * batch into named commands, POSTs them, surfaces rejections, and always
 * completes the batch (rejected rows roll back via the next sync — the DoD).
 */
import { describe, expect, it, vi } from 'vitest';

import { createConnector, type CommandRejection } from '../src/powersync/connector';

interface FakeBatch {
  crud: { op: string; table: string; id: string; opData: Record<string, unknown> | null }[];
  complete: ReturnType<typeof vi.fn>;
}

function fakeDb(batch: FakeBatch | null) {
  return { getCrudBatch: async () => batch } as never;
}

const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

describe('connector.uploadData', () => {
  const baseOpts = { apiBaseUrl: 'http://api.test', powersyncUrl: 'http://ps.test', deviceId: 'web-1' };

  it('translates the CRUD batch into a single /sync/upload of commands', async () => {
    const fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      return okResponse({ results: body.commands.map((c: { id: string }) => ({ id: c.id, result: 'applied' })) });
    });
    const complete = vi.fn();
    const connector = createConnector({ ...baseOpts, fetch: fetch as unknown as typeof globalThis.fetch });
    await connector.uploadData(
      fakeDb({
        complete,
        crud: [
          { op: 'PATCH', table: 'nodes', id: 'n1', opData: { completed_at: '2026-06-13T12:00:00.000Z', updated_at: 'x' } },
          { op: 'PATCH', table: 'nodes', id: 'n2', opData: { updated_at: 'x' } }, // untranslatable ⇒ dropped
        ],
      }),
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('http://api.test/sync/upload');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.device_id).toBe('web-1');
    expect(body.commands).toHaveLength(1);
    expect(body.commands[0]).toMatchObject({ name: 'node.check_off', payload: { id: 'n1', completed_at: '2026-06-13T12:00:00.000Z' } });
    expect(body.commands[0].hlc).toMatch(/^[0-9a-f]{12}-[0-9a-f]{4}-web-1$/);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('surfaces rejections but still completes the batch (rollback comes from sync)', async () => {
    const rejected: CommandRejection[] = [];
    const fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      return okResponse({ results: body.commands.map((c: { id: string }) => ({ id: c.id, result: 'rejected', reject_code: 'E_HIERARCHY' })) });
    });
    const complete = vi.fn();
    const connector = createConnector({
      ...baseOpts,
      fetch: fetch as unknown as typeof globalThis.fetch,
      onReject: (r) => rejected.push(...r),
    });
    await connector.uploadData(fakeDb({ complete, crud: [{ op: 'PATCH', table: 'nodes', id: 'n1', opData: { title: 'x', updated_at: 'x' } }] }));

    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reject_code).toBe('E_HIERARCHY');
    expect(complete).toHaveBeenCalledTimes(1); // NOT retried — sync restores the row
  });

  it('throws on a network/429 failure so PowerSync keeps the queue', async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 429 }) as Response);
    const complete = vi.fn();
    const connector = createConnector({ ...baseOpts, fetch: fetch as unknown as typeof globalThis.fetch });
    await expect(
      connector.uploadData(fakeDb({ complete, crud: [{ op: 'PATCH', table: 'nodes', id: 'n1', opData: { title: 'x' } }] })),
    ).rejects.toThrow(/429/);
    expect(complete).not.toHaveBeenCalled();
  });

  it('fetchCredentials returns the PowerSync endpoint + JWT', async () => {
    const fetch = vi.fn(async () => okResponse({ token: 'jwt-123' }));
    const connector = createConnector({ ...baseOpts, fetch: fetch as unknown as typeof globalThis.fetch });
    const creds = await connector.fetchCredentials!();
    expect(creds).toEqual({ endpoint: 'http://ps.test', token: 'jwt-123' });
    expect(fetch).toHaveBeenCalledWith('http://api.test/api/powersync/token', { credentials: 'include' });
  });
});
