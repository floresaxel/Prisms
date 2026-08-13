/**
 * JournalDay (§12.1 mobile, D2/D3/D7): a calendar day's markdown note. Multiline
 * `TextInput` + the SAME shared `applyMarkdownEdit` toolbar as web + a preview via
 * `react-native-markdown-display`. Native iOS/Android emoji keyboards type straight
 * into the TextInput (plain Unicode → journal.write). Rendering executes NO HTML
 * (markdown-it, html:false) and link taps are allowlisted to http/https/mailto.
 * Save debounces (SAVE_DEBOUNCE_MS) + flushes on blur; Delete soft-deletes; Share exports the
 * single day's `.md` via the RN Share sheet (the exportAndShare precedent).
 */
import { useEffect, useRef, useState } from 'react';
import { Share, TextInput, View } from 'react-native';

import Markdown from 'react-native-markdown-display';

import { composeDayMarkdown } from '@prisms/core';
import { applyMarkdownEdit, isJournalContentEmpty, journalDayFilename, journalTitleOf, useCommands, useDayLog, useJournalDay, useUserSettings, type CommandContext, type MarkdownAction, type Selection } from '@prisms/ui';

import { DayLogFooter } from '../components/DayLogFooter';
import { Btn, Card, H2, Row, theme } from '../ui';

/** Kept in step with the web panel and the day-note sheet (see DayJournal.tsx). */
const SAVE_DEBOUNCE_MS = 100;
/** Allow only these link schemes to open; everything else is blocked. */
const SAFE_URL = /^(https?:|mailto:)/i;

const TOOLBAR: { action: MarkdownAction; label: string }[] = [
  { action: 'bold', label: 'B' },
  { action: 'italic', label: 'I' },
  { action: 'strikethrough', label: 'S' },
  { action: 'h1', label: 'H1' },
  { action: 'h2', label: 'H2' },
  { action: 'bulletList', label: '•' },
  { action: 'numberList', label: '1.' },
  { action: 'taskList', label: '☑' },
  { action: 'quote', label: '❝' },
  { action: 'code', label: '‹›' },
  { action: 'codeBlock', label: '{ }' },
  { action: 'link', label: '🔗' },
];

// react-native-markdown-display styles keyed by element (dark theme).
const mdStyles = {
  body: { color: theme.text, fontSize: 15 },
  heading1: { color: theme.text },
  heading2: { color: theme.text },
  link: { color: theme.accent },
  blockquote: { backgroundColor: theme.surface2, borderColor: theme.border },
  code_inline: { backgroundColor: theme.surface2, color: theme.text },
  code_block: { backgroundColor: theme.bg, color: theme.text },
  fence: { backgroundColor: theme.bg, color: theme.text },
};

export function JournalDay({ date, ctx, onClose }: { date: string; ctx: CommandContext; onClose?: () => void }) {
  const { entry, isSettled } = useJournalDay(date);
  const commands = useCommands(ctx);
  // Annex L: derived at render from the shared provider. Mobile has no toggle —
  // it obeys the synced flag (the switch is web/desktop-only, D4).
  const dayLog = useDayLog(date);
  const { timezone } = useUserSettings();
  const [draft, setDraft] = useState(entry?.content ?? '');
  /**
   * Read-only state for THIS day. A SYNCED field on the day's row (migration
   * 0013), not local UI state — a day locked on the web or desktop opens locked
   * here, and vice versa.
   */
  const preview = entry?.locked ?? false;
  const [sel, setSel] = useState<Selection>({ start: 0, end: 0 });
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const existingId = entry?.id;

  useEffect(() => {
    if (!dirty.current) setDraft(entry?.content ?? '');
  }, [entry?.content]);
  // An empty note is not a note: blank content deletes the row (and with it the
  // title and lock) rather than storing a day that holds nothing. Same rule as
  // the web panel — see DayJournal.tsx.
  const write = (content: string) => {
    if (isJournalContentEmpty(content)) {
      if (existingId) void commands.deleteJournal(existingId);
      return;
    }
    void commands.writeJournal({ existingId, entryDate: date, content });
  };
  const hasNote = existingId !== undefined && !isJournalContentEmpty(draft);
  /**
   * The heading, under the same rule as the web panel (DayJournal.tsx): a stored
   * title is the row's own value and shows the moment it arrives, while
   * "Note · <date>" asserts that this note has NO title and so waits until the row
   * has actually been read. Deriving it straight from `entry?.title` assumed that
   * absence — an unloaded day reads as untitled — so every open of a NAMED note
   * painted the default for a frame before the real title replaced it.
   *
   * Unlike the web panel this keeps the default for a day with no note at all:
   * here the heading is the screen's only day identifier, so blanking it would
   * leave a new day with no header.
   */
  const heading = (entry?.title ?? '').trim() || (isSettled ? journalTitleOf('', date) : '');

  // A pending debounced save must survive unmount (switching day). RN's
  // keyboardShouldPersistTaps can let a day-switch tap through WITHOUT blurring
  // the TextInput, so onBlur may never fire — flush the latest draft here or the
  // last SAVE_DEBOUNCE_MS of typing is lost. Guarded on `timer` so an already-flushed day
  // (blur fired) doesn't re-write. The ref holds the newest draft/write closure.
  const flushPending = useRef<() => void>(() => undefined);
  flushPending.current = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
      void write(draft);
    }
  };
  useEffect(() => () => flushPending.current(), []);
  function change(next: string) {
    dirty.current = true;
    setDraft(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void write(next), SAVE_DEBOUNCE_MS);
  }
  function toolbar(action: MarkdownAction) {
    const r = applyMarkdownEdit(draft, sel, action);
    change(r.value);
    setSel(r.selection);
  }
  function flush() {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    void write(draft);
  }
  async function share() {
    // The note VERBATIM plus the day-log section — the same core compose the web
    // download and the archive zip use (D7).
    await Share.share({ title: journalDayFilename(date), message: composeDayMarkdown(draft, dayLog, { timezone }) });
  }
  function remove() {
    if (!existingId) return;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    void commands.deleteJournal(existingId);
    dirty.current = false;
    setDraft('');
  }

  return (
    <Card testID={`journal-${date}`}>
      <Row>
        <H2>{heading}</H2>
        <Btn
          title={preview ? 'Edit' : 'Lock edit'}
          testID="journal-preview-toggle"
          disabled={!hasNote}
          onPress={() => existingId && void commands.setJournalLocked(existingId, !preview)}
        />
        {onClose && <Btn title="Close" testID="journal-close" onPress={onClose} />}
      </Row>

      {preview ? (
        <View testID="journal-preview">
          <Markdown style={mdStyles} onLinkPress={(url: string) => SAFE_URL.test(url)}>
            {draft}
          </Markdown>
        </View>
      ) : (
        <>
          <Row>
            {TOOLBAR.map((t) => (
              <Btn key={t.action} title={t.label} testID={`md-${t.action}`} onPress={() => toolbar(t.action)} />
            ))}
          </Row>
          <TextInput
            testID="journal-editor"
            multiline
            value={draft}
            onChangeText={change}
            onSelectionChange={(e) => setSel(e.nativeEvent.selection)}
            onBlur={flush}
            placeholder="Write a note for this day… (markdown)"
            placeholderTextColor={theme.dim}
            style={{
              color: theme.text,
              backgroundColor: theme.bg,
              borderColor: theme.border,
              borderWidth: 1,
              borderRadius: 10,
              padding: 12,
              minHeight: 160,
              textAlignVertical: 'top',
              fontSize: 15,
            }}
          />
        </>
      )}

      {/* BELOW the editor and the preview, never inside the TextInput. */}
      <DayLogFooter entries={dayLog} timezone={timezone} />

      <Row>
        <Btn title="Share .md" testID="journal-share" onPress={() => void share()} />
        {existingId && <Btn title="Delete" variant="danger" testID="journal-delete" onPress={remove} />}
      </Row>
    </Card>
  );
}
