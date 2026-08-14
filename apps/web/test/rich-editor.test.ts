// @vitest-environment jsdom
/**
 * The REAL RichJournalEditor, with TipTap stubbed at the LIBRARY boundary rather
 * than the component one.
 *
 * Every other suite mocks this whole module away (ProseMirror cannot run in
 * jsdom), which left its own wiring untested — and that is exactly where locking
 * once cost every note its contents: `setEditable` announces an `update` unless
 * told not to, and this editor's update handler is the note's save path. The
 * stub below is faithful about that one detail on purpose, so the regression
 * cannot come back silently.
 */
import { createElement } from 'react';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** What the component handed to `useEditor` on the last render. */
const captured: { onUpdate?: (p: { editor: unknown }) => void } = {};
const state = { content: '', editable: true };
const setContent = vi.fn((v: string) => { state.content = v; });

const setEditable = vi.fn((editable: boolean, emitUpdate = true) => {
  state.editable = editable;
  // TipTap's real default: flipping editability EMITS an update. Modelled here
  // so a call that forgets to opt out fails this suite instead of production.
  if (emitUpdate) captured.onUpdate?.({ editor: fakeEditor });
});

const fakeEditor = {
  get isEditable() { return state.editable; },
  isFocused: false,
  setEditable,
  storage: { markdown: { getMarkdown: () => state.content } },
  commands: { setContent },
  chain: () => ({ focus: () => ({ toggleBold: () => ({ run: () => true }) }) }),
};

vi.mock('@tiptap/react', async () => {
  const { createElement: h } = await import('react');
  return {
    useEditor: (options: { content?: string; onUpdate?: (p: { editor: unknown }) => void }) => {
      captured.onUpdate = options.onUpdate;
      return fakeEditor;
    },
    EditorContent: () => h('div', { 'data-testid': 'journal-rich' }),
  };
});
vi.mock('@tiptap/starter-kit', () => ({ default: { configure: () => ({}) } }));
vi.mock('@tiptap/extension-list', () => ({ TaskList: {}, TaskItem: { configure: () => ({}) } }));
vi.mock('tiptap-markdown', () => ({ Markdown: { configure: () => ({}) } }));

// Imported AFTER the mocks (vitest hoists vi.mock).
import { RichJournalEditor } from '../src/components/RichJournalEditor';

afterEach(() => {
  cleanup();
  setEditable.mockClear();
  setContent.mockClear();
  state.content = '';
  state.editable = true;
});

const view = (props: Record<string, unknown>) =>
  render(
    createElement(RichJournalEditor, {
      value: 'hello',
      onChange: () => undefined,
      renderLocked: (md: string) => createElement('div', { 'data-testid': 'journal-preview' }, md),
      ...props,
    } as never),
  );

describe('RichJournalEditor — locking must not touch the note', () => {
  it('never announces editability as a content change', () => {
    // The regression: the one-argument `setEditable(!locked)` fired the update
    // handler, which IS the save path — so locking wrote the editor's current
    // (still empty, on mount) text over the note and marked it dirty.
    const onChange = vi.fn();
    const { rerender } = view({ onChange, locked: false });
    onChange.mockClear();

    rerender(
      createElement(RichJournalEditor, {
        value: 'hello',
        onChange,
        locked: true,
        renderLocked: (md: string) => createElement('div', { 'data-testid': 'journal-preview' }, md),
      } as never),
    );

    expect(setEditable).toHaveBeenCalled();
    // every call must opt out of the update
    for (const call of setEditable.mock.calls) expect(call[1]).toBe(false);
    expect(onChange).not.toHaveBeenCalled(); // the note was never told it changed
  });

  it('makes the editor read-only when locked, and writable again when not', () => {
    view({ locked: true });
    expect(state.editable).toBe(false);
    cleanup();
    state.editable = true;
    view({ locked: false });
    expect(state.editable).toBe(true);
  });

  it('does not re-assert editability it already has', () => {
    // Cheap, but it is what keeps a re-render from becoming an editor event.
    view({ locked: false }); // already editable
    expect(setEditable).not.toHaveBeenCalled();
  });
});

describe('RichJournalEditor — the toolbar survives locking, inert', () => {
  it('keeps the buttons mounted but disabled and hidden from assistive tech', () => {
    view({ locked: true });
    const bold = screen.getByTestId('rt-bold') as HTMLButtonElement;
    expect(bold).toBeTruthy(); // still there — it has to be, to animate out
    expect(bold.disabled).toBe(true);
    expect(screen.getByRole('toolbar', { hidden: true }).closest('[aria-hidden="true"]')).toBeTruthy();
  });

  it('leaves them usable while unlocked', () => {
    view({ locked: false });
    expect((screen.getByTestId('rt-bold') as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the injected read-only body when locked, the editor when not', () => {
    view({ locked: true });
    expect(screen.getByTestId('journal-preview').textContent).toBe('hello');
    expect(screen.queryByTestId('journal-rich')).toBeNull();
    cleanup();
    view({ locked: false });
    expect(screen.getByTestId('journal-rich')).toBeTruthy();
    expect(screen.queryByTestId('journal-preview')).toBeNull();
  });
});
