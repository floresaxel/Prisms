/**
 * PowerSync backend connector + command-upload driver (§7.3, §7.2, §13; M8).
 *
 * Down: `fetchCredentials` mints a short-lived PowerSync JWT from the API.
 *
 * Up (the two-layer cutover): optimistic writes go to the LOCAL-ONLY overlay
 * (`client_commands` + `overlay_effects`), so PowerSync's CRUD queue stays empty
 * and `uploadData` is now only a LOUD GUARD — if any replica-table op reaches it,
 * a writer bypassed `executeCommand` (R15) and we throw. The real upload is the
 * named command envelope read from `client_commands`, driven by
 * `startCommandUpload` (a watch on the pending queue, NOT PowerSync's CRUD
 * trigger, since local-only writes never fire `uploadData`). This kills the v1.0
 * `getCrudBatch → crudToCommand → newId()`-at-upload path (V2: the stored id+HLC
 * upload verbatim).
 */
import type { AbstractPowerSyncDatabase, PowerSyncBackendConnector, PowerSyncCredentials } from '@powersync/common';

import { assertNoReplicaCrud, type CrudOp } from './crud-to-command';
import { createSqlOverlayStore, type SqlExecutor } from './overlay-store';
import { uploadClientCommands } from './upload-commands';

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
}

export function createConnector(options: ConnectorOptions): PowerSyncBackendConnector {
  const doFetch = options.fetch ?? fetch;

  return {
    async fetchCredentials(): Promise<PowerSyncCredentials> {
      const res = await doFetch(`${options.apiBaseUrl}/api/powersync/token`, { credentials: 'include' });
      if (!res.ok) throw new Error(`powersync token request failed: ${res.status}`);
      const body = (await res.json()) as { token: string };
      return { endpoint: options.powersyncUrl, token: body.token };
    },

    async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
      // The overlay tables are local-only, so a well-behaved write enqueues NO
      // replica CRUD and this body is a no-op. Any entry here means a replica
      // write bypassed the overlay — fail loudly (the guard throws).
      const batch = await database.getCrudBatch();
      if (!batch) return;
      assertNoReplicaCrud(
        batch.crud.map((e) => ({ op: String(e.op) as CrudOp, table: e.table, id: e.id, opData: e.opData as Record<string, unknown> | null })),
      );
      await batch.complete();
    },
  };
}

/** A PowerSync db that can watch a local query — the minimal surface the driver needs. */
export interface WatchableDb extends SqlExecutor {
  watch(sql: string, parameters: unknown[] | undefined, handler: { onResult: () => void; onError?: (e: Error) => void }): void;
}

export interface CommandUploadOptions {
  apiBaseUrl: string;
  deviceId: string;
  /** Surface rejected commands to the UI (the overlay has already rolled back). */
  onReject?: (rejections: CommandRejection[]) => void;
  fetch?: typeof fetch;
  /** Periodic retry for commands left pending by a network failure (default 15s). */
  retryMs?: number;
  /** Injected for tests (defaults to the global timer). */
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
}

/**
 * Drive the named-envelope upload from `client_commands`: an initial drain, a
 * watch that fires whenever the pending queue changes (a fresh optimistic write),
 * and a periodic retry so commands stranded by a network failure eventually go.
 * A single in-flight guard avoids overlapping uploads (the server is idempotent
 * by command id regardless). Returns a stop function.
 */
export function startCommandUpload(db: WatchableDb, options: CommandUploadOptions): () => void {
  const store = createSqlOverlayStore(db);
  let inFlight = false;
  const drain = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      await uploadClientCommands({ store, apiBaseUrl: options.apiBaseUrl, deviceId: options.deviceId, onReject: options.onReject, fetch: options.fetch });
    } catch {
      // network / 429: commands stay pending; the watch or the retry timer re-tries.
    } finally {
      inFlight = false;
    }
  };
  void drain();
  db.watch('SELECT count(*) AS n FROM client_commands WHERE status = ?', ['pending'], { onResult: () => void drain() });
  const timer = (options.setInterval ?? setInterval)(() => void drain(), options.retryMs ?? 15_000);
  return () => clearInterval(timer);
}
