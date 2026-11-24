/**
 * RichJournalEditor (J7): the web/desktop WYSIWYG surface for a day's note.
 *
 * TipTap (ProseMirror) bound to the SAME markdown `content` field via
 * `tiptap-markdown` — markdown in (parsed on mount), markdown out (serialized on
 * every edit). The storage format is UNCHANGED (still CommonMark in one LWW
 * field), so this is a pure editing-surface swap: no schema, sync, or server
 * change, and it interops byte-for-byte with the mobile toolbar editor and the
 * `.md` export.
 *
 * Sanitization (D2) is preserved: `Markdown({ html: false })` never renders raw
 * HTML (it's dropped on parse), and links are scheme-allowlisted through the
 * StarterKit `link` config (anything but http/https/mailto is refused). Task-list
 * checkboxes are INTERACTIVE — clicking one toggles `- [ ]`⇄`- [x]` in the stored
 * markdown, the headline J7 affordance.
 *
 * Rendered in a browser only; the jsdom component tests mock this module (TipTap
 * needs a real DOM), and Playwright e2e exercises the live editor.
 */
import { useEffect, useRef, type ReactNode } from 'react';

import { TaskItem, TaskList } from '@tiptap/extension-list';
import { EditorContent, Extension, InputRule, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Markdown, type MarkdownStorage } from 'tiptap-markdown';

import { Ic } from '@prisms/ui';

/** Link schemes allowed in a note; everything else is refused (matches MarkdownView, D2). */
const SAFE_PROTOCOLS = ['http', 'https', 'mailto'];

// tiptap-markdown augments the editor's storage at runtime but doesn't type it.
const getMd = (editor: Editor): string =>
  (editor.storage as unknown as { markdown: MarkdownStorage }).markdown.getMarkdown();

/* ── growing down ──
   A new line lands at the bottom of the note, and the note's box follows it
   DOWN: its height eases from where it was to where the text now needs it,
   clipping the new line until the edge has slid past it. Nothing above moves. */

/** How long the box takes to reach a new line. Short: it runs on every Enter. */
const GROW_MS = 160;
const GROW_EASE = 'cubic-bezier(0.2, 0, 0, 1)';

const reducedMotion = (): boolean =>
  typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The box's settled height, and the animation easing it there if one is running. */
interface Grow {
  el: HTMLElement | null;
  last: number;
  anim: Animation | null;
  ro: ResizeObserver | null;
}

/**
 * Start following `el`. A ResizeObserver keeps `last` current through every
 * change that is NOT typing — a synced edit landing, the window resizing — so the
 * next keystroke animates from the height actually on screen. It stands down
 * while an animation runs: those are the animation's own frames.
 */
function track(s: Grow, el: HTMLElement): void {
  if (s.el === el || typeof ResizeObserver !== 'function') return;
  s.ro?.disconnect();
  s.el = el;
  s.last = el.getBoundingClientRect().height;
  s.ro = new ResizeObserver(() => {
    if (!s.anim && s.el) s.last = s.el.getBoundingClientRect().height;
  });
  s.ro.observe(el);
}

/**
 * Called right after an edit reached the DOM — the box is already at its NEW
 * height, and `last` still holds the old one. Animate between the two. An edit
 * landing mid-animation starts from wherever the edge has got to, so fast typing
 * is one continuous slide rather than a stutter.
 */
function growDown(s: Grow): void {
  const el = s.el;
  if (!el || typeof el.animate !== 'function') return;
  const from = s.anim ? el.getBoundingClientRect().height : s.last;
  s.anim?.cancel();
  s.anim = null;
  const to = el.getBoundingClientRect().height;
  s.last = to;
  if (Math.abs(to - from) < 0.5 || reducedMotion()) {
    el.classList.remove('px-journal-rich--growing');
    return;
  }
  // overflow: clip + min-height: 0 for the length of the slide — see theme.css
  el.classList.add('px-journal-rich--growing');
  const a = el.animate({ height: [`${from}px`, `${to}px`] }, { duration: GROW_MS, easing: GROW_EASE });
  s.anim = a;
  a.onfinish = () => {
    if (s.anim !== a) return;
    s.anim = null;
    el.classList.remove('px-journal-rich--growing');
  };
}

/** The element that scrolls the page around this editor (`.px-content`). */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === 'auto' || oy === 'scroll') return p;
  }
  return null;
}

/** Room kept between the caret and the scroller's edge. */
const CARET_MARGIN = 24;

/**
 * Keep the caret in view by GLIDING the page, not snapping it. ProseMirror's own
 * scroll jumps the page a line at a time, and it runs before the box has grown —
 * so at the bottom of the window every Enter yanked the whole page up a line
 * while the note's edge was still sliding down. Returns false (ProseMirror's
 * default) when there is no scroller to drive.
 */
function followCaret(view: Editor['view']): boolean {
  const scroller = scrollParent(view.dom);
  if (!scroller) return false;
  let caret: { top: number; bottom: number };
  try {
    caret = view.coordsAtPos(view.state.selection.head);
  } catch {
    return false;
  }
  const box = scroller.getBoundingClientRect();
  let delta = 0;
  if (caret.bottom > box.bottom - CARET_MARGIN) delta = caret.bottom - (box.bottom - CARET_MARGIN);
  else if (caret.top < box.top + CARET_MARGIN) delta = caret.top - (box.top + CARET_MARGIN);
  if (delta !== 0) scroller.scrollBy({ top: delta, behavior: reducedMotion() ? 'auto' : 'smooth' });
  return true;
}

interface ToolItem {
  key: string;
  /**
   * What the button shows. Plain text where a normal character carries the
   * meaning (B, H2, •, 1.) — those render in the button's own `color`. Anything
   * needing a pictogram uses the shared SVG sprite rather than a symbol
   * character: a glyph Inter lacks falls through the font stack to Segoe UI
   * Emoji, which paints a COLOUR emoji that `color` cannot touch.
   */
  label: ReactNode;
  title: string;
  run: (editor: Editor) => void;
}

/** WYSIWYG actions, run as TipTap chained commands (not text transforms). */
const TOOLBAR: ToolItem[] = [
  { key: 'bold', label: 'B', title: 'Bold', run: (e) => e.chain().focus().toggleBold().run() },
  { key: 'italic', label: 'I', title: 'Italic', run: (e) => e.chain().focus().toggleItalic().run() },
  { key: 'strike', label: 'S', title: 'Strikethrough', run: (e) => e.chain().focus().toggleStrike().run() },
  { key: 'h2', label: 'H2', title: 'Heading', run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run() },
  { key: 'bullet', label: '•', title: 'Bullet list', run: (e) => e.chain().focus().toggleBulletList().run() },
  { key: 'ordered', label: '1.', title: 'Numbered list', run: (e) => e.chain().focus().toggleOrderedList().run() },
  { key: 'task', label: <Ic name="tasklist" />, title: 'Task list', run: (e) => e.chain().focus().toggleTaskList().run() },
  { key: 'quote', label: '❝', title: 'Quote', run: (e) => e.chain().focus().toggleBlockquote().run() },
  // StarterKit's horizontalRule; tiptap-markdown serializes it to `---`, so the
  // divider survives the round trip to storage, the .md export and every client.
  { key: 'divider', label: '—', title: 'Section divider', run: (e) => e.chain().focus().setHorizontalRule().run() },
  { key: 'code', label: '‹›', title: 'Inline code', run: (e) => e.chain().focus().toggleCode().run() },
  { key: 'codeBlock', label: '{ }', title: 'Code block', run: (e) => e.chain().focus().toggleCodeBlock().run() },
];

/**
 * `- [ ] ` as it is typed. The `- ` makes a bullet before the brackets arrive,
 * and TaskItem's own rule only fires at the start of a plain line, so the item
 * stayed a bullet with a literal "[ ]". Typing `[ ] ` or `[x] ` at the start of a
 * top-level bullet item takes THAT item out of its list and makes it a task item:
 * the bullets around it stay bullets (a new "- " joins the list above it, so
 * converting the whole list would tick-box items that were never meant as tasks).
 */
const BulletToTask = Extension.create({
  name: 'bulletToTask',
  addInputRules() {
    return [
      new InputRule({
        find: /^\s*\[([ xX])?\]\s$/,
        handler: ({ state, range, match, chain }) => {
          const $from = state.doc.resolve(range.from);
          // doc › bulletList › listItem › paragraph: a top-level bullet, nothing nested
          if ($from.depth !== 3) return null;
          if ($from.node(-1).type.name !== 'listItem' || $from.node(-2).type.name !== 'bulletList') return null;
          const checked = (match[1] ?? ' ').toLowerCase() === 'x';
          chain().deleteRange(range).liftListItem('listItem').toggleTaskList().updateAttributes('taskItem', { checked }).run();
        },
      }),
    ];
  },
});

/**
 * Task lists are written with `*` bullets (`* [ ] item`), bullet lists with `-`.
 * In CommonMark a run of `-` items is ONE list even across a blank line, so a
 * checklist written right after a bullet list with the same `-` came back from a
 * reload merged into it (with a stray empty checkbox). A change of bullet
 * character starts a new list, so each list survives the round trip. Still GFM;
 * `- [ ]` already stored parses as before.
 */
interface ListSerializer {
  renderList: (node: unknown, delim: string, firstDelim: (index: number) => string) => void;
}
const StarTaskList = TaskList.extend({
  addStorage() {
    return {
      ...this.parent?.(),
      markdown: {
        serialize(state: ListSerializer, node: unknown) {
          state.renderList(node, '  ', () => '* ');
        },
      },
    };
  },
});

/**
 * The editor's schema and markdown bridge, shared with the task card's Details
 * (`MarkdownField`): StarterKit (whose input rules render `**bold**`, `_italic_`,
 * `# heading`, `- list`, `> quote`, `` `code` `` as they are typed), task lists,
 * and tiptap-markdown with raw HTML off and a link-scheme allowlist (D2).
 */
export function richMarkdownExtensions() {
  return [
    StarterKit.configure({
      link: {
        openOnClick: false, // clicking a link while editing shouldn't navigate
        autolink: true,
        protocols: SAFE_PROTOCOLS,
        HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
      },
    }),
    StarTaskList,
    TaskItem.configure({ nested: true }),
    BulletToTask,
    Markdown.configure({ html: false, linkify: false, breaks: false, transformPastedText: true, transformCopiedText: true }),
  ];
}

/** The editor's content as markdown (tiptap-markdown's serializer). */
export const editorMarkdown = (editor: Editor): string => getMd(editor);

/**
 * Controlled by markdown: `value` seeds the editor and `onChange` emits the
 * serialized markdown on every edit. External (synced) changes are adopted only
 * while the editor is UNFOCUSED, so a same-day update from another device can't
 * yank the caret mid-typing (parity with the textarea's `dirty` guard).
 */
export function RichJournalEditor({
  value,
  onChange,
  onBlur,
  locked = false,
  animate = false,
  renderLocked,
}: {
  value: string;
  onChange: (markdown: string) => void;
  onBlur?: (markdown: string) => void;
  /**
   * Read-only. The toolbar STAYS MOUNTED and merely goes inert — it used to
   * unmount with the editor, which made it vanish the instant a note locked.
   * Keeping it lets it animate out, and lets it animate back.
   */
  locked?: boolean;
  /**
   * Whether a change of `locked` should animate. False on arrival, so a note that
   * loads already locked is simply drawn locked rather than folding itself shut
   * in front of the reader — the same reasoning as the padlock's own gate.
   */
  animate?: boolean;
  /**
   * The read-only body. Injected rather than imported so the SANITIZED renderer
   * (D2 — no raw HTML, href allowlist) stays in DayJournal and this module keeps
   * no opinion about how locked markdown is drawn.
   */
  renderLocked?: (markdown: string) => ReactNode;
}) {
  const grow = useRef<Grow>({ el: null, last: 0, anim: null, ro: null });
  useEffect(() => {
    const s = grow.current;
    return () => {
      s.ro?.disconnect();
      s.anim?.cancel();
    };
  }, []);

  const editor = useEditor({
    immediatelyRender: false, // client-only SPA; avoids any SSR-detection warning
    extensions: richMarkdownExtensions(),
    content: value, // tiptap-markdown parses a string as markdown
    editorProps: {
      attributes: {
        class: 'px-md px-journal-rich',
        'data-testid': 'journal-rich',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': 'journal editor',
      },
      handleScrollToSelection: followCaret,
    },
    // Tracking starts as soon as the view exists, and again on focus in case the
    // view was rebuilt; `track` is a no-op for the element it already follows.
    onCreate: ({ editor }) => track(grow.current, editor.view.dom),
    onFocus: ({ editor }) => track(grow.current, editor.view.dom),
    onUpdate: ({ editor }) => {
      growDown(grow.current);
      onChange(getMd(editor));
    },
    onBlur: onBlur ? ({ editor }) => onBlur(getMd(editor)) : undefined,
  });

  useEffect(() => {
    if (!editor || editor.isFocused) return;
    if (getMd(editor) !== value) editor.commands.setContent(value, { emitUpdate: false });
  }, [editor, value]);

  /**
   * Locking is a SYNCED fact, so the editor has to honour it even while mounted:
   * the toolbar going inert is not enough to stop typing into the note.
   *
   * The `false` is load-bearing. `setEditable(editable, emitUpdate = true)` emits
   * an `update` by DEFAULT, and this editor's update handler is the note's save
   * path — so the plain one-argument call cost every note its contents:
   *   - it fired on mount, while the editor still held the empty string it was
   *     created with (the synced text arrives a beat later),
   *   - which ran `onChange('')` → the panel marked the note dirty and scheduled
   *     a save of nothing,
   *   - the empty save soft-DELETED the row, and the dirty flag then blocked the
   *     panel from ever adopting the synced text, so the note did not come back.
   * Editability is not a content change and must never be announced as one.
   */
  useEffect(() => {
    if (!editor || editor.isEditable === !locked) return;
    editor.setEditable(!locked, false);
  }, [editor, locked]);

  const wrap =
    'px-journal-rich-wrap' +
    (locked ? ' px-journal-rich-wrap--locked' : '') +
    (animate ? ' px-journal-rich-wrap--anim' : '');

  return (
    <div className={wrap}>
      {/* The toolbar rides up under the title block and is clipped off there
          rather than unmounting. The clip is the grid; the row collapses to 0fr,
          which is the one way to animate to a CONTENT height — the toolbar wraps
          to two rows at narrow widths, so its height is not a number we know. */}
      <div className="px-md-toolbar-clip" aria-hidden={locked || undefined}>
        <div className="px-md-toolbar" role="toolbar" aria-label="formatting">
          {TOOLBAR.map((t) => (
            <button
              key={t.key}
              type="button"
              className="px-btn"
              data-testid={`rt-${t.key}`}
              title={t.title}
              aria-label={t.title}
              // Inert while locked, in every sense: not clickable, not hoverable
              // (the clip drops pointer-events), and out of the tab order.
              disabled={!editor || locked}
              onMouseDown={(e) => e.preventDefault()} // keep the editor selection on click
              onClick={() => editor && t.run(editor)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      {/* The field's own min-height lives HERE, on the one element that survives
          the editor⇄read-only swap, so its bottom edge can animate up to the last
          line of text instead of jumping there. */}
      <div className="px-jn-field" data-testid="journal-field">
        {locked ? renderLocked?.(value) : <EditorContent editor={editor} className="px-jn-field-fill" />}
      </div>
    </div>
  );
}
