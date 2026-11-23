/**
 * Unsaved text that survives leaving the screen it was typed on.
 *
 * A screen is unmounted when you switch to another page (and a card when it
 * closes), and the text in its inputs goes with it. A field that wants to keep
 * what was typed keeps it here instead, under a stable key: coming back puts the
 * text back, and saving / clearing the field drops it.
 *
 * Held in memory only, for this page load — a reload or a sign-out starts clean
 * (`clearDrafts`), so nothing typed lingers on a shared machine or follows the
 * next account. Never use it for passwords.
 */
import { useCallback, useState } from 'react';

const drafts = new Map<string, string>();

/** The text kept under `key`, if any. */
export function peekDraft(key: string): string | undefined {
  return drafts.get(key);
}

/** Keep `text` under `key`; an empty (or `fallback`) text drops the entry instead. */
export function keepDraft(key: string, text: string, fallback = ''): void {
  if (text === fallback) drafts.delete(key);
  else drafts.set(key, text);
}

/** Forget everything — sign-out. */
export function clearDrafts(): void {
  drafts.clear();
}

/**
 * A text input's value that outlives the component. `fallback` is what it shows
 * when nothing was kept (and what it counts as "empty": setting it again drops
 * the kept text). Use `set(fallback)` after a successful save to clear it.
 */
export function usePersistedText(key: string, fallback = ''): [string, (text: string) => void] {
  const [state, setState] = useState(() => ({ key, text: peekDraft(key) ?? fallback }));
  // the same component showing another thing (a different key): read that one's text
  let current = state;
  if (state.key !== key) {
    current = { key, text: peekDraft(key) ?? fallback };
    setState(current);
  }
  const set = useCallback(
    (text: string) => {
      setState({ key, text });
      keepDraft(key, text, fallback);
    },
    [key, fallback],
  );
  return [current.text, set];
}
