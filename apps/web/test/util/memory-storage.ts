/**
 * An in-memory `Storage` for jsdom tests.
 *
 * Node 26 ships a `localStorage` global that is `undefined` unless the process
 * was started with `--localstorage-file`, and it shadows the one jsdom would
 * otherwise install — so under vitest neither `localStorage` nor
 * `window.localStorage` exists. Anything testing a persisted UI preference has
 * to bring its own.
 */
export function installMemoryStorage(): Storage {
  const map = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true, writable: true });
  return storage;
}
