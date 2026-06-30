/**
 * Local-first data layer (§12.3 mobile): a PowerSync RN database on the shared
 * two-layer `clientSchema` (replica + local-only overlay), connected through the
 * shared `createConnector` (JWT + the loud upload guard) with `startCommandUpload`
 * driving the named-envelope upload (M8). Identical sync/command path to web —
 * only the SQLite driver differs (react-native-quick-sqlite under
 * @powersync/react-native). Full mobile two-layer parity is M14.
 */
import { PowerSyncDatabase } from '@powersync/react-native';
import { clientSchema, createConnector, startCommandUpload, type CommandRejection, type WatchableDb } from '@prisms/ui';

import { config } from './config';
import { getDeviceId } from './device';

let db: PowerSyncDatabase | null = null;

export function getDb(): PowerSyncDatabase {
  if (db === null) {
    db = new PowerSyncDatabase({ schema: clientSchema, database: { dbFilename: 'prisms.sqlite' } });
  }
  return db;
}

export async function connectDb(database: PowerSyncDatabase, onReject: (rejections: CommandRejection[]) => void): Promise<() => void> {
  const deviceId = getDeviceId();
  await database.connect(createConnector({ apiBaseUrl: config.apiBaseUrl, powersyncUrl: config.powersyncUrl, deviceId }));
  // local-only overlay writes never fire uploadData, so drive uploads from the queue.
  return startCommandUpload(database as unknown as WatchableDb, { apiBaseUrl: config.apiBaseUrl, deviceId, onReject });
}
