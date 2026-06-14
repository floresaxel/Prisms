/**
 * PowerSync backend connector (§7.3, §13). Down: fetches a short-lived JWT
 * from the API for the PowerSync service. Up: drains the local CRUD queue,
 * translates each entry into a named command, and POSTs the batch to
 * /sync/upload. Rejected commands are NOT retried — the next sync streams the
 * unchanged server row back down, so the optimistic local edit visibly rolls
 * back (DoD).
 */
import type { AbstractPowerSyncDatabase, CrudEntry, PowerSyncBackendConnector, PowerSyncCredentials } from '@powersync/web';

import { createHlc, newId } from './client-runtime';
import { crudToCommand, type CrudOp } from './crud-to-command';

export interface CommandRejection {
  id: string;
  name: string;
  reject_code?: string;
  reject_reason?: string;
}

export interface ConnectorOptions {
  /** API origin, e.g. http://localhost:3001 (Better Auth + /sync/upload). */
  apiBaseUrl: string;
  /** PowerSync service URL, e.g. http://localhost:8080. */
  powersyncUrl: string;
  deviceId: string;
  /** Injected for tests. */
  fetch?: typeof fetch;
  /** Surface rejected commands to the UI (it reverts on the next sync). */
  onReject?: (rejections: CommandRejection[]) => void;
}

interface UploadResult {
  results?: { id: string; result: 'applied' | 'rejected' | 'noop'; reject_code?: string; reject_reason?: string }[];
}

export function createConnector(options: ConnectorOptions): PowerSyncBackendConnector {
  const nextHlc = createHlc(options.deviceId);
  const doFetch = options.fetch ?? fetch;

  return {
    async fetchCredentials(): Promise<PowerSyncCredentials> {
      const res = await doFetch(`${options.apiBaseUrl}/api/powersync/token`, { credentials: 'include' });
      if (!res.ok) throw new Error(`powersync token request failed: ${res.status}`);
      const body = (await res.json()) as { token: string };
      return { endpoint: options.powersyncUrl, token: body.token };
    },

    async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
      const batch = await database.getCrudBatch();
      if (!batch) return;

      const commands = [];
      for (const entry of batch.crud as CrudEntry[]) {
        const translated = crudToCommand({
          op: String(entry.op) as CrudOp,
          table: entry.table,
          id: entry.id,
          opData: entry.opData as Record<string, unknown> | null,
        });
        if (translated) commands.push({ id: newId(), name: translated.name, hlc: nextHlc(), payload: translated.payload });
      }

      if (commands.length > 0) {
        const res = await doFetch(`${options.apiBaseUrl}/sync/upload`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json', origin: options.apiBaseUrl },
          body: JSON.stringify({ device_id: options.deviceId, commands }),
        });
        // network / 429: throw so PowerSync keeps the queue and retries.
        if (!res.ok) throw new Error(`upload failed: ${res.status}`);
        const body = (await res.json()) as UploadResult;
        const rejections = (body.results ?? []).filter((r) => r.result === 'rejected');
        if (rejections.length > 0) {
          options.onReject?.(rejections.map((r) => ({ id: r.id, name: '', reject_code: r.reject_code, reject_reason: r.reject_reason })));
        }
        // applied/noop/rejected are all terminal — complete the batch. Rejected
        // rows revert when the unchanged server value syncs back down.
      }
      await batch.complete();
    },
  };
}
