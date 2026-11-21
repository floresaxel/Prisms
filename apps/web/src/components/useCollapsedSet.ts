/**
 * A set of collapsed ids (the project groups on Tasks › By project), remembered
 * per device in localStorage under `key`. Everything starts EXPANDED — a task
 * list hides nothing until you fold it — and only the folded ids are stored, so
 * a new project is open by default. Storage can be missing or throw (private
 * windows, blocked site data): reads fall back to "nothing collapsed" and writes
 * to in-memory only, so the screen works either way.
 */
import { useCallback, useState } from 'react';

function read(key: string): ReadonlySet<string> {
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

function write(key: string, set: ReadonlySet<string>): void {
  try {
    if (set.size === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify([...set]));
  } catch {
    /* private mode — in-memory only */
  }
}

export interface CollapsedSet {
  isCollapsed: (id: string) => boolean;
  toggle: (id: string) => void;
  /** Open `id` (no-op when it already is) — e.g. a task was just added to it. */
  expand: (id: string) => void;
}

export function useCollapsedSet(key: string): CollapsedSet {
  const [set, setSet] = useState<ReadonlySet<string>>(() => read(key));
  const update = useCallback(
    (change: (s: Set<string>) => void) =>
      setSet((prev) => {
        const next = new Set(prev);
        change(next);
        if (next.size === prev.size && [...next].every((id) => prev.has(id))) return prev;
        write(key, next);
        return next;
      }),
    [key],
  );
  const toggle = useCallback((id: string) => update((s) => void (s.delete(id) || s.add(id))), [update]);
  const expand = useCallback((id: string) => update((s) => void s.delete(id)), [update]);
  const isCollapsed = useCallback((id: string) => set.has(id), [set]);
  return { isCollapsed, toggle, expand };
}
