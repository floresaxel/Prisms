/**
 * Local-first data layer (§12.3 mobile): a PowerSync RN database on the shared
 * `appSchema`, connected through the shared `createConnector` (JWT + command
 * upload). Identical sync/command path to web — only the SQLite driver differs
 * (react-native-quick-sqlite under @powersync/react-native).
 */
import { PowerSyncDatabase } from '@powersync/react-native';
import { appSchema, createConnector, type CommandRejection } from '@prisms/ui';

import { config } from './config';
import { getDeviceId } from './device';

let db: PowerSyncDatabase | null = null;

export function getDb(): PowerSyncDatabase {
  if (db === null) {
    db = new PowerSyncDatabase({ schema: appSchema, database: { dbFilename: 'prisms.sqlite' } });
  }
  return db;
}

export async function connectDb(database: PowerSyncDatabase, onReject: (rejections: CommandRejection[]) => void): Promise<void> {
  await database.connect(
    createConnector({ apiBaseUrl: config.apiBaseUrl, powersyncUrl: config.powersyncUrl, deviceId: getDeviceId(), onReject }),
  );
}
