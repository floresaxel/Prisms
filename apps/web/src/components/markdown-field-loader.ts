/**
 * Loads the live markdown field (TipTap, ~300 kB) on demand, once, and remembers
 * it, so the task card can ask for it when it opens without it ever reaching the
 * startup chunk (load-budget.spec.ts keeps ProseMirror out of that chunk).
 */
import type { MarkdownField } from './MarkdownField';

export type MarkdownFieldComponent = typeof MarkdownField;

let loaded: MarkdownFieldComponent | null = null;
let pending: Promise<MarkdownFieldComponent> | null = null;

/** The field if it has loaded already, else null. */
export function peekMarkdownField(): MarkdownFieldComponent | null {
  return loaded;
}

/** Start (or join) loading the field. A failed load can be retried by calling again. */
export function loadMarkdownField(): Promise<MarkdownFieldComponent> {
  pending ??= import('./MarkdownField').then(
    (m) => (loaded = m.MarkdownField),
    (err: unknown) => {
      pending = null;
      throw err;
    },
  );
  return pending;
}
