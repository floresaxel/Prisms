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
import { useEffect, type ReactNode } from 'react';


import { TaskItem, TaskList } from '@tiptap/extension-list';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Markdown, type MarkdownStorage } from 'tiptap-markdown';

import { Ic } from '@prisms/ui';

/** Link schemes allowed in a note; everything else is refused (matches MarkdownView, D2). */
const SAFE_PROTOCOLS = ['http', 'https', 'mailto'];

// tiptap-markdown augments the editor's storage at runtime but doesn't type it.
const getMd = (editor: Editor): string =>
  (editor.storage as unknown as { markdown: MarkdownStorage }).markdown.getMarkdown();

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
  const editor = useEditor({
    immediatelyRender: false, // client-only SPA; avoids any SSR-detection warning
    extensions: [
      StarterKit.configure({
        link: {
          openOnClick: false, // clicking a link while editing shouldn't navigate
          autolink: true,
          protocols: SAFE_PROTOCOLS,
          HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
        },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Markdown.configure({ html: false, linkify: false, breaks: false, transformPastedText: true, transformCopiedText: true }),
    ],
    content: value, // tiptap-markdown parses a string as markdown
    editorProps: {
      attributes: {
        class: 'px-md px-journal-rich',
        'data-testid': 'journal-rich',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': 'journal editor',
      },
    },
    onUpdate: ({ editor }) => onChange(getMd(editor)),
    onBlur: onBlur ? ({ editor }) => onBlur(getMd(editor)) : undefined,
  });

  useEffect(() => {
    if (!editor || editor.isFocused) return;
    if (getMd(editor) !== value) editor.commands.setContent(value, { emitUpdate: false });
  }, [editor, value]);

  // Locking is a SYNCED fact, so the editor has to honour it even while mounted:
  // the toolbar going inert is not enough to stop typing into the note.
  useEffect(() => {
    editor?.setEditable(!locked);
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
