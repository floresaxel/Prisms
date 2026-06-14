/**
 * Client-side runtime helpers (browser tier — wall clock + crypto allowed,
 * unlike core). UUIDv7 ids for new rows + command envelopes, and a per-device
 * HLC that stamps every uploaded command for §7.3 LWW.
 */
import { asEpochMillis, hlcEncode, hlcTick, uuidV7, type Clock, type Hlc, type Rng } from '@prisms/core';

export const browserClock: Clock = { now: () => asEpochMillis(Date.now()) };

export const browserRng: Rng = {
  randomBytes: (length: number) => {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return bytes;
  },
};

/** Time-ordered id for new rows and command envelopes. */
export function newId(): string {
  return uuidV7(browserClock, browserRng);
}

/** A monotonic per-device HLC; call `next()` once per uploaded command. */
export function createHlc(deviceId: string): () => string {
  let prev: Hlc | null = null;
  return () => {
    prev = hlcTick(prev, asEpochMillis(Date.now()), deviceId);
    return hlcEncode(prev);
  };
}

/** Stable per-install device id (persisted in localStorage). */
export function getDeviceId(storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): string {
  const existing = storage.getItem('prisms.device_id');
  if (existing) return existing;
  const id = `web-${newId().slice(0, 18)}`;
  storage.setItem('prisms.device_id', id);
  return id;
}
