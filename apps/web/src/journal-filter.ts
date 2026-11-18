/**
 * The journal's filter — which tag, project and vision the journal is narrowed to.
 *
 * One store shared by every place that shows journal days (the Journal screen's
 * list and the day-log footer under any open note, in the Agenda's side panel as
 * much as on the Journal screen), so choosing "Marathon" in one place narrows the
 * others too. It is a VIEW preference: nothing here is synced or exported, and it
 * persists in localStorage only so a reload does not silently drop it.
 *
 * Projects and visions are kept as `{id, title}`, not bare ids: the filter can
 * outlive the day it was chosen on, and a select has to be able to label a choice
 * the open day does not itself mention.
 */
import { useSyncExternalStore } from 'react';

import type { DayLogFilter, DayLogRef } from '@prisms/core';

export interface JournalFilter {
  /** A canonical tag (see `normalizeJournalTag`), or null for any. */
  tag: string | null;
  project: DayLogRef | null;
  vision: DayLogRef | null;
}

export const NO_JOURNAL_FILTER: JournalFilter = { tag: null, project: null, vision: null };

const KEY = 'prisms.journal.filter';

function parseRef(value: unknown): DayLogRef | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, title } = value as { id?: unknown; title?: unknown };
  return typeof id === 'string' && id.length > 0 ? { id, title: typeof title === 'string' ? title : '' } : null;
}

function read(): JournalFilter {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return NO_JOURNAL_FILTER;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      tag: typeof parsed['tag'] === 'string' && parsed['tag'].length > 0 ? parsed['tag'] : null,
      project: parseRef(parsed['project']),
      vision: parseRef(parsed['vision']),
    };
  } catch {
    // storage blocked, or a hand-edited value: start unfiltered rather than fail
    return NO_JOURNAL_FILTER;
  }
}

let current: JournalFilter = read();
const listeners = new Set<() => void>();

function set(next: JournalFilter): void {
  if (next.tag === current.tag && next.project?.id === current.project?.id && next.vision?.id === current.vision?.id) {
    return;
  }
  current = next;
  try {
    if (next === NO_JOURNAL_FILTER || (next.tag === null && next.project === null && next.vision === null)) {
      window.localStorage.removeItem(KEY);
    } else {
      window.localStorage.setItem(KEY, JSON.stringify(next));
    }
  } catch {
    /* in-memory only */
  }
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The filter plus a patcher; `clear()` resets all three axes. */
export function useJournalFilter(): {
  filter: JournalFilter;
  patch: (change: Partial<JournalFilter>) => void;
  clear: () => void;
} {
  const filter = useSyncExternalStore(subscribe, () => current, () => NO_JOURNAL_FILTER);
  return {
    filter,
    patch: (change) => set({ ...current, ...change }),
    clear: () => set(NO_JOURNAL_FILTER),
  };
}

export function isJournalFilterActive(filter: JournalFilter): boolean {
  return filter.tag !== null || filter.project !== null || filter.vision !== null;
}

/** The project/vision half, in the shape `filterDayLog` takes. */
export function toDayLogFilter(filter: JournalFilter): DayLogFilter {
  return { project_id: filter.project?.id ?? null, vision_id: filter.vision?.id ?? null };
}

/** Test seam: put the module-level store back to unfiltered between tests. */
export function resetJournalFilterForTests(): void {
  set(NO_JOURNAL_FILTER);
}
