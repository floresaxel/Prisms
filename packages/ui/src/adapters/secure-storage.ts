/**
 * Secure-storage adapter port (1.3 §13.2/§13.3, R13). Provider-neutral, defined
 * OUTSIDE `packages/core` (core does no platform IO). Auth/session secrets and the
 * device HLC floor go through this port so a platform can back them with the OS
 * keystore without touching core or the call sites.
 *
 * Implementations:
 *   - web:     `webSecureStorage` — localStorage. **Documented limitation:** the
 *              browser has no OS keystore, so this is NOT hardware-backed; the web
 *              app's real auth secret is the HTTP-only session cookie (never in JS,
 *              so never here). Only non-token material (device id, HLC floor,
 *              non-sensitive session cache) is kept here.
 *   - mobile:  expo-secure-store (M14).
 *   - desktop: Tauri Stronghold / OS keychain (M14).
 */

/** The provider-neutral secure key/value store (async — a keystore may be). */
export interface SecureStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Web implementation over a `Storage` (localStorage by default). NOT
 * hardware-backed — see the file header. Kept behind the port so installed
 * targets (M14) swap in a real keystore with no call-site change.
 */
export function createWebSecureStorage(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = localStorage,
): SecureStorage {
  return {
    get: (key) => Promise.resolve(storage.getItem(key)),
    set: (key, value) => {
      storage.setItem(key, value);
      return Promise.resolve();
    },
    delete: (key) => {
      storage.removeItem(key);
      return Promise.resolve();
    },
  };
}

/** An in-memory store — tests and SSR fallbacks. */
export function createMemorySecureStorage(seed?: Record<string, string>): SecureStorage {
  const map = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    get: (key) => Promise.resolve(map.get(key) ?? null),
    set: (key, value) => {
      map.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => {
      map.delete(key);
      return Promise.resolve();
    },
  };
}
