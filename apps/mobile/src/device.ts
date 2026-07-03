/**
 * Stable per-install device id for the §7.4 double-clock-in merge and command
 * HLCs. Persisted across launches in the OS keystore (expo-secure-store) so the
 * same physical device keeps one id after a restart — otherwise a post-restart
 * clock-in with an open entry would be misread as a *different* device and
 * routed through the §7.4 cross-device merge instead of the I5 same-device
 * rejection.
 *
 * `loadDeviceId()` runs once at startup (App.tsx); `getDeviceId()` is the
 * synchronous accessor the connector + command context use afterwards.
 */
import { newId } from '@prisms/ui';

import { mobileSecureStorage } from './secure-storage';

const STORAGE_KEY = 'prisms.device_id';
let cached: string | null = null;

/** Load (or first-time generate + persist) the stable device id. Idempotent. */
export async function loadDeviceId(): Promise<string> {
  if (cached !== null) return cached;
  const existing = await mobileSecureStorage.get(STORAGE_KEY);
  if (existing) {
    cached = existing;
    return existing;
  }
  const id = `mobile-${newId().slice(0, 18)}`;
  await mobileSecureStorage.set(STORAGE_KEY, id);
  cached = id;
  return id;
}

/** The already-loaded id. `loadDeviceId()` must have resolved first (startup). */
export function getDeviceId(): string {
  if (cached === null) {
    throw new Error('device id not loaded — call loadDeviceId() at startup');
  }
  return cached;
}
