/** PowerSync web SDK setup (wa-sqlite/OPFS, §12.3) — two-layer store (M8). */
import { PowerSyncDatabase } from '@powersync/web';
import { clientSchema, createConnector, getDeviceId, startCommandUpload, type CommandRejection, type WatchableDb } from '@prisms/ui';

import { config } from './config';

export function createDb(): PowerSyncDatabase {
  // clientSchema = the synced replica PLUS the local-only overlay tables
  // (client_commands / overlay_effects / sync_review_items) the two-layer store needs.
  return new PowerSyncDatabase({ schema: clientSchema, database: { dbFilename: 'prisms.db' } });
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
