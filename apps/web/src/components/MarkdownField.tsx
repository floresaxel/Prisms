/**
 * A live markdown field: what is typed renders as it is typed. Closing `**bold**`
 * or `_italic_` turns it bold or italic at once, and `# `, `- `, `1. `, `- [ ] `,
 * `> ` start a heading, list, task list or quote. The value in and out is markdown
 * text, so storage and every other client are unchanged.
 *
 * The task card's Details. It is the journal's editor (TipTap + tiptap-markdown,
 * the same schema and sanitizing via `richMarkdownExtensions`) without the
 * toolbar. Loaded on demand (`markdown-field-loader`): TipTap stays out of the
 * startup chunk. Browser only; the jsdom tests never load it.
 */
import { useEffect, useRef, type KeyboardEvent } from 'react';

import { EditorContent, useEditor } from '@tiptap/react';

import { followCaret, growDown, track, useGrow } from './editor-grow';
import { editorMarkdown, richMarkdownExtensions } from './RichJournalEditor';

export interface MarkdownFieldProps {
  /** The markdown shown. Adopted while the field is not focused (or on `revision`). */
  value: string;
  onChange: (markdown: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  /** Bump to put `value` into the field even while it is focused (Escape reverting an edit). */
  revision?: number;
  id: string;
  testId: string;
  label: string;
  placeholder?: string;
}

export function MarkdownField({ value, onChange, onFocus, onBlur, onKeyDown, revision = 0, id, testId, label, placeholder }: MarkdownFieldProps) {
  // TipTap keeps the callbacks it was created with: route them through refs.
  const handlers = useRef({ onChange, onFocus, onBlur });
  handlers.current = { onChange, onFocus, onBlur };

  /**
   * The box grows down as lines are added, like the day's note (editor-grow.ts).
   * What slides is the bordered BOX, not the editable inside it: the border is
   * the box's. Once the task card is as tall as the window the box is held at
   * that size and scrolls inside instead (theme.css), so its height stops
   * changing and nothing animates.
   */
  const grow = useGrow();
  const box = useRef<HTMLDivElement>(null);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: richMarkdownExtensions(),
    content: value,
    editorProps: {
      attributes: {
        id,
        class: 'px-md px-td-md',
        'data-testid': testId,
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': label,
        writingsuggestions: 'false',
      },
      // glide the capped box (or the card) to the caret rather than snapping
      handleScrollToSelection: followCaret,
    },
    onUpdate: ({ editor: e }) => {
      growDown(grow);
      handlers.current.onChange(editorMarkdown(e));
    },
    onFocus: () => {
      track(grow, box.current);
      handlers.current.onFocus?.();
    },
    onBlur: () => handlers.current.onBlur?.(),
  });

  // A change from elsewhere (another device, this card's own save) shows while the
  // field is not being typed in; it never moves the caret mid-sentence.
  useEffect(() => {
    if (!editor || editor.isFocused) return;
    if (editorMarkdown(editor) !== value) editor.commands.setContent(value, { emitUpdate: false });
  }, [editor, value]);
  // …except a revert, which is asked for while focused.
  const seen = useRef(revision);
  useEffect(() => {
    if (!editor || seen.current === revision) return;
    seen.current = revision;
    editor.commands.setContent(value, { emitUpdate: false });
  }, [editor, revision, value]);

  return (
    <div ref={box} className="px-td-in px-td-desc px-td-mdbox" data-testid={`${testId}-box`} onKeyDown={onKeyDown}>
      <EditorContent editor={editor} />
      {value.trim() === '' && placeholder && (
        <span className="px-td-mdbox-ph" aria-hidden="true">
          {placeholder}
        </span>
      )}
    </div>
  );
}
