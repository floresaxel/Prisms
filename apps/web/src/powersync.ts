/** PowerSync web SDK setup (wa-sqlite/OPFS, §12.3) — two-layer store (M8). */
import { PowerSyncDatabase } from '@powersync/web';
import { clearReadCaches, clientSchema, createConnector, getDeviceId, startCommandUpload, type CommandRejection, type WatchableDb } from '@prisms/ui';

import { config } from './config';

export function createDb(userId: string): PowerSyncDatabase {
  // clientSchema = the synced replica PLUS the local-only overlay tables
  // (client_commands / overlay_effects / sync_review_items) the two-layer store needs.
  // §13.2/S9-F1: the OPFS filename is PER ACCOUNT, so signing in as a different
  // user on a shared device never opens the previous account's replica/queue.
  return new PowerSyncDatabase({ schema: clientSchema, database: { dbFilename: `prisms-${userId}.db` } });
}

export async function connectDb(db: PowerSyncDatabase, onReject: (r: CommandRejection[]) => void): Promise<() => void> {
  const deviceId = getDeviceId();
  const connector = createConnector({ apiBaseUrl: config.apiBaseUrl, powersyncUrl: config.powersyncUrl, deviceId });
  await db.connect(connector);
  // Uploads are the named command envelopes read from client_commands (not the
  // CRUD queue, which local-only writes never fill). Drive them from the pending
  // queue; on rejection the overlay has already rolled back, so just surface it.
  return startCommandUpload(db as unknown as WatchableDb, { apiBaseUrl: config.apiBaseUrl, deviceId, onReject });
}

/**
 * §13.2/S9-F1 sign-out: end this account's LOCAL presence on this device. If
 * unsynced commands would be lost, `confirm(pending)` gates the wipe — return
 * false to keep them and abort the sign-out. On proceed, `disconnectAndClear()`
 * drops the synced replica AND the local command queue, and `clearReadCaches()`
 * empties the in-memory SWR read cache, so nothing of this account survives for
 * the next login on a shared device (the cross-account replica/queue exposure
 * S9-F1 describes). Returns true if it cleared, false if the user cancelled.
 */
export async function clearLocalAccount(
  db: { getAll<T>(sql: string): Promise<T[]>; disconnectAndClear(): Promise<void> },
  confirm: (pending: number) => boolean,
): Promise<boolean> {
  const pending =
    (await db.getAll<{ n: number }>("SELECT count(*) AS n FROM client_commands WHERE status = 'pending'"))[0]?.n ?? 0;
  if (pending > 0 && !confirm(pending)) return false;
  await db.disconnectAndClear();
  clearReadCaches();
  return true;
}
