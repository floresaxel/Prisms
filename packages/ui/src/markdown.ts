/**
 * Markdown toolbar + safe-truncation helpers (D2/D6) — PURE, shared web/RN so the
 * editor behaves identically on every platform. No DOM, no React. The web/mobile
 * editors call `applyMarkdownEdit` on the current textarea selection and write the
 * returned value + caret back.
 */

/** A text selection within the editor value (UTF-16 offsets, as the DOM reports). */
export interface Selection {
  start: number;
  end: number;
}

/** The toolbar actions the editor exposes (D2). */
export type MarkdownAction =
  | 'bold'
  | 'italic'
  | 'strikethrough'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'bulletList'
  | 'numberList'
  | 'taskList'
  | 'quote'
  | 'code'
  | 'codeBlock'
  | 'link';

export interface MarkdownEdit {
  /** The new full editor value. */
  value: string;
  /** Where to leave the caret/selection after the edit. */
  selection: Selection;
}

/** Inline actions that WRAP the selection with a marker on each side. */
const WRAP: Partial<Record<MarkdownAction, string>> = {
  bold: '**',
  italic: '_',
  strikethrough: '~~',
  code: '`',
};

/** Line actions that PREFIX each selected line. */
const LINE_PREFIX: Partial<Record<MarkdownAction, string>> = {
  h1: '# ',
  h2: '## ',
  h3: '### ',
  bulletList: '- ',
  numberList: '1. ',
  taskList: '- [ ] ',
  quote: '> ',
};

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(n, hi));

function edit(value: string, from: number, to: number, inserted: string, selStart: number, selEnd: number): MarkdownEdit {
  return { value: value.slice(0, from) + inserted + value.slice(to), selection: { start: selStart, end: selEnd } };
}

/**
 * Apply a toolbar action to `value` at `sel`, returning the new value + caret.
 * Inline actions wrap the selection (or insert an empty pair with the caret
 * between when nothing is selected); line actions prefix every selected line;
 * link inserts `[text](url)` with `url` selected for quick typing. Emoji and
 * grapheme clusters in the selection are preserved verbatim — this is pure string
 * surgery on the given UTF-16 offsets, it never re-encodes the text.
 */
export function applyMarkdownEdit(value: string, sel: Selection, action: MarkdownAction): MarkdownEdit {
  const start = clamp(sel.start, 0, value.length);
  const end = clamp(Math.max(sel.start, sel.end), start, value.length);
  const selected = value.slice(start, end);

  if (action === 'codeBlock') {
    const inserted = '```\n' + selected + '\n```';
    return edit(value, start, end, inserted, start + 4, start + 4 + selected.length);
  }
  if (action === 'link') {
    const text = selected || 'text';
    const inserted = `[${text}](url)`;
    const urlStart = start + 1 + text.length + 2; // after `[text](`
    return edit(value, start, end, inserted, urlStart, urlStart + 3);
  }

  const wrap = WRAP[action];
  if (wrap) {
    const inserted = `${wrap}${selected}${wrap}`;
    // caret between the markers when nothing was selected, else after the wrapped text
    const caret = selected ? start + inserted.length : start + wrap.length;
    return edit(value, start, end, inserted, caret, caret);
  }

  const prefix = LINE_PREFIX[action]!;
  const lineStart = value.lastIndexOf('\n', start - 1) + 1; // start of the first selected line
  const region = value.slice(lineStart, end);
  const prefixed = region
    .split('\n')
    .map((line) => prefix + line)
    .join('\n');
  return edit(value, lineStart, end, prefixed, lineStart, lineStart + prefixed.length);
}

/**
 * Truncate `text` to at most `maxCodePoints` code points, appending an ellipsis
 * when cut. Splits on CODE POINTS (`Array.from`) so a surrogate pair is never
 * severed (§D6) — `'a😀'.slice(0,2)` would split the emoji; this never does. ZWJ
 * grapheme clusters may split cosmetically at the cut (acceptable); do NOT use
 * `Intl.Segmenter` (unsupported on Hermes).
 */
export function truncatePlain(text: string, maxCodePoints: number): string {
  const cps = Array.from(text);
  if (cps.length <= maxCodePoints) return text;
  return cps.slice(0, Math.max(0, maxCodePoints)).join('') + '…';
}
