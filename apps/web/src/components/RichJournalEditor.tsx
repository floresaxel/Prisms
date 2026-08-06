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
import { useEffect } from 'react';

import { TaskItem, TaskList } from '@tiptap/extension-list';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Markdown, type MarkdownStorage } from 'tiptap-markdown';

/** Link schemes allowed in a note; everything else is refused (matches MarkdownView, D2). */
const SAFE_PROTOCOLS = ['http', 'https', 'mailto'];

// tiptap-markdown augments the editor's storage at runtime but doesn't type it.
const getMd = (editor: Editor): string =>
  (editor.storage as unknown as { markdown: MarkdownStorage }).markdown.getMarkdown();

interface ToolItem {
  key: string;
  label: string;
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
  { key: 'task', label: '☑', title: 'Task list', run: (e) => e.chain().focus().toggleTaskList().run() },
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
}: {
  value: string;
  onChange: (markdown: string) => void;
  onBlur?: (markdown: string) => void;
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

  return (
    <div className="px-journal-rich-wrap">
      <div className="px-md-toolbar" role="toolbar" aria-label="formatting">
        {TOOLBAR.map((t) => (
          <button
            key={t.key}
            type="button"
            className="px-btn"
            data-testid={`rt-${t.key}`}
            title={t.title}
            aria-label={t.title}
            disabled={!editor}
            onMouseDown={(e) => e.preventDefault()} // keep the editor selection on click
            onClick={() => editor && t.run(editor)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
