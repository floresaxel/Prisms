/** PowerSync web SDK setup (wa-sqlite/OPFS, §12.3). */
import { PowerSyncDatabase } from '@powersync/web';
import { appSchema, createConnector, getDeviceId, type CommandRejection } from '@prisms/ui';

import { config } from './config';

export function createDb(): PowerSyncDatabase {
  return new PowerSyncDatabase({ schema: appSchema, database: { dbFilename: 'prisms.db' } });
}

export async function connectDb(db: PowerSyncDatabase, onReject: (r: CommandRejection[]) => void): Promise<void> {
  const connector = createConnector({
    apiBaseUrl: config.apiBaseUrl,
    powersyncUrl: config.powersyncUrl,
    deviceId: getDeviceId(),
    onReject,
  });
  await db.connect(connector);
}
