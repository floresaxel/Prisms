/**
 * Client-side runtime helpers (browser tier — wall clock + crypto allowed,
 * unlike core). UUIDv7 ids for new rows + command envelopes, and a per-device
 * HLC that stamps every uploaded command for §7.3 LWW.
 */
import { asEpochMillis, hlcCompare, hlcEncode, hlcParse, hlcTick, uuidV7, type Clock, type Hlc, type Rng } from '@prisms/core';

export const browserClock: Clock = { now: () => asEpochMillis(Date.now()) };

// Import HLC floor (1.3 §13.1, R20): after an import the device clock must be
// advanced past the maximum imported HLC so every subsequent local write orders
// AFTER the imported state (monotonicity). A shared module floor lets an import
// that happens mid-session dominate even an already-constructed `createHlc` — the
// next tick observes it — and it is persisted so a reload re-observes it.
const HLC_FLOOR_KEY = 'prisms.hlc_floor';
let hlcFloor: Hlc | null = null;

/** Raise the in-memory import floor to `encoded` if it dominates the current one. */
export function observeImportedHlc(encoded: string): void {
  const parsed = hlcParse(encoded);
  if (parsed.ok && (hlcFloor === null || hlcCompare(parsed.value, hlcFloor) > 0)) hlcFloor = parsed.value;
}

/** Persist + observe the imported high-water (call after a successful import). */
export function persistImportedHlc(
  encoded: string,
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
): void {
  observeImportedHlc(encoded);
  const prev = storage.getItem(HLC_FLOOR_KEY);
  if (prev === null || encoded > prev) storage.setItem(HLC_FLOOR_KEY, encoded);
}

/** Re-observe the persisted floor at startup (call once when the app boots). */
export function loadImportedHlcFloor(storage: Pick<Storage, 'getItem'> = localStorage): void {
  const stored = storage.getItem(HLC_FLOOR_KEY);
  if (stored !== null) observeImportedHlc(stored);
}

/** Test-only: clear the module floor between cases. */
export function __resetHlcFloorForTests(): void {
  hlcFloor = null;
}

export const browserRng: Rng = {
  randomBytes: (length: number) => {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return bytes;
  },
};

/**
 * Ids never go backwards, even when the computer's clock does. The overlay store
 * reads a command's order from its UUIDv7 (`supersedes`): if the clock is set back,
 * a later command would mint a SMALLER id, and an earlier command's overlay would
 * wait forever for a row stamped by "an older" one. So each id is at least 1 ms
 * past the last; the high-water is persisted so a reload keeps it too.
 */
const ID_LAST_MS_KEY = 'prisms.id_last_ms';
let lastIdMs: number | null = null;

function defaultIdStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** The ms to mint the next id at: the wall clock, or just past the last id. */
export function nextIdMs(nowMs: number, storage: Pick<Storage, 'getItem' | 'setItem'> | null = defaultIdStorage()): number {
  if (lastIdMs === null) {
    const stored = Number(storage?.getItem(ID_LAST_MS_KEY) ?? NaN);
    lastIdMs = Number.isFinite(stored) ? stored : 0;
  }
  const ms = nowMs > lastIdMs ? nowMs : lastIdMs + 1;
  lastIdMs = ms;
  storage?.setItem(ID_LAST_MS_KEY, String(ms));
  return ms;
}

/** Test-only: forget the in-memory high-water. */
export function __resetIdClockForTests(): void {
  lastIdMs = null;
}

/** Time-ordered id for new rows and command envelopes (monotonic per device). */
export function newId(): string {
  const ms = nextIdMs(Date.now());
  return uuidV7({ now: () => asEpochMillis(ms) }, browserRng);
}

/** The persisted last-tick high-water — seeds a fresh clock so a restart can't regress (S7-F8). */
const HLC_LAST_KEY = 'prisms.hlc_last';

/** localStorage when present (browser/desktop), else null (React Native has none). */
function defaultHlcStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  return typeof localStorage !== 'undefined' ? localStorage : null;
}

/**
 * A monotonic per-device HLC; call `next()` once per uploaded command. Each tick
 * also dominates any observed import floor (§13.1), so a command minted after an
 * import always orders after the imported rows.
 *
 * The clock is seeded from the persisted last tick (and any caller-supplied
 * high-water, e.g. `max(client_commands.hlc)`) and persists every tick, so a
 * wall-clock regression across a restart cannot mint an HLC below an
 * already-queued/applied one (§7.9a monotonicity, S7-F8). On React Native
 * (no localStorage) persistence is a no-op unless a storage is passed.
 */
export function createHlc(
  deviceId: string,
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = defaultHlcStorage(),
  seedHlc?: string | null,
): () => string {
  let prev: Hlc | null = null;
  for (const enc of [storage?.getItem(HLC_LAST_KEY) ?? null, seedHlc ?? null]) {
    if (enc === null) continue;
    const parsed = hlcParse(enc);
    if (parsed.ok && (prev === null || hlcCompare(parsed.value, prev) > 0)) prev = parsed.value;
  }
  return () => {
    // base = the most-recent of the previous tick, the seed, and the import floor.
    const base = hlcFloor !== null && (prev === null || hlcCompare(hlcFloor, prev) > 0) ? hlcFloor : prev;
    prev = hlcTick(base, asEpochMillis(Date.now()), deviceId);
    const enc = hlcEncode(prev);
    storage?.setItem(HLC_LAST_KEY, enc);
    return enc;
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
