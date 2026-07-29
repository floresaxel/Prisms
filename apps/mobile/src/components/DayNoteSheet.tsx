/**
 * The Day-note sheet (MOBILE_TODAY_PLAN §2 #28–#29, D6).
 *
 * This is NOT a new store: it is `useJournalDay` + `writeJournal`, the same row
 * the Agenda's `JournalDay` screen and the web journal edit — just a faster
 * door to it, opened from the day you are actually living. Content stays
 * CommonMark text; the sheet deliberately offers no toolbar and no preview,
 * because the point is to catch a thought before it evaporates.
 *
 * Saving is debounced, so the sheet owes the writer an honest answer about
 * whether the words are safe yet: the header dot is amber while a keystroke is
 * still only in memory and green once the command has been written. Every exit
 * flushes — closing, blurring, the day rolling over, and the app going to the
 * background (Android can kill a backgrounded process without another event).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { useJournalDay, type PrismsCommands } from '@prisms/ui';

import { FadeEdge } from './FadeEdge';
import { SheetBase } from './SheetBase';
import { theme } from '../ui';

/** J-feature precedent: the same debounce the JournalDay screen uses. */
const SAVE_DEBOUNCE_MS = 800;
/** Rule spacing = the input's line height, so the text sits ON the lines. */
const RULE_STEP = 28;
/**
 * Where the first rule goes, relative to the end of the first line box. Zero:
 * the text's `lineHeight` box bottom IS the rule, exactly as the mock's
 * `repeating-linear-gradient(transparent 0 27px, hair 27px 28px)` draws it.
 */
const RULE_OFFSET = 0;

type SaveState = 'saved' | 'dirty';

export function DayNoteSheet({
  open,
  onClose,
  top,
  date,
  heading,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  top: number;
  /** The account's local day (already day-reset bucketed), `YYYY-MM-DD`. */
  date: string;
  /** "SUNDAY, JUL 26" — the mock's header line. */
  heading: string;
  commands: PrismsCommands;
}) {
  const { entry } = useJournalDay(date);
  const [draft, setDraft] = useState(entry?.content ?? '');
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [viewport, setViewport] = useState(0);
  const [paperHeight, setPaperHeight] = useState(0);

  // A keystroke that has not been written yet. Holding the *date* with it means
  // a flush can never file today's words under tomorrow after a roll-over, and
  // means `flush` needs no dependency on the current draft.
  const pending = useRef<{ date: string; content: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read at flush time so a debounce started before the row existed still
  // patches that row instead of minting a second one.
  const entryId = useRef<string | undefined>(undefined);
  entryId.current = entry?.id;

  const flush = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const due = pending.current;
    if (due === null) return;
    pending.current = null;
    setSaveState('saved');
    void commands.writeJournal({ existingId: entryId.current, entryDate: due.date, content: due.content });
  }, [commands]);

  // Someone else edited this day (web, the JournalDay screen, another device).
  // Only adopt it when there is nothing of ours in flight — otherwise the round
  // trip of our own write would yank the caret back mid-sentence.
  useEffect(() => {
    if (pending.current === null) setDraft(entry?.content ?? '');
  }, [entry?.content]);

  // The day rolled over (4 a.m. reset) while the sheet was mounted: file what
  // was typed against the day it was typed for, then start the new day clean.
  const previousDate = useRef(date);
  useEffect(() => {
    if (previousDate.current === date) return;
    previousDate.current = date;
    flush();
    setDraft('');
  }, [date, flush]);

  // A pending save must survive unmount and backgrounding. Android in
  // particular can kill a backgrounded process without another callback, so
  // 'background' is the last honest chance to write.
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') flushRef.current();
    });
    return () => {
      sub.remove();
      flushRef.current();
    };
  }, []);

  // Closing the sheet is an exit like any other — the words are not "less
  // saved" because the sheet slid down. Opening puts the caret in the note:
  // `autoFocus` cannot do it, because the sheet stays mounted while closed, so
  // the prop is only ever read once, when `open` was still false. The wait lets
  // the slide finish before the keyboard animation starts on top of it.
  const input = useRef<TextInput>(null);
  useEffect(() => {
    if (!open) {
      flushRef.current();
      return;
    }
    const t = setTimeout(() => input.current?.focus(), 280);
    return () => clearTimeout(t);
  }, [open]);

  const change = useCallback(
    (next: string) => {
      setDraft(next);
      pending.current = { date, content: next };
      setSaveState('dirty');
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => flushRef.current(), SAVE_DEBOUNCE_MS);
    },
    [date],
  );

  const close = useCallback(() => {
    flush();
    onClose();
  }, [flush, onClose]);

  const rules = Math.max(0, Math.ceil((Math.max(paperHeight, viewport) - RULE_OFFSET) / RULE_STEP));

  return (
    <SheetBase open={open} onClose={close} top={top} accessibilityLabel="Day note" testID="day-note-sheet">
      <View style={s.head}>
        <Text style={s.headText} numberOfLines={1}>
          DAY NOTE — {heading.toUpperCase()}
        </Text>
        <View
          style={[s.saveDot, saveState === 'dirty' && s.saveDotDirty]}
          accessibilityRole="image"
          accessibilityLabel={saveState === 'dirty' ? 'Unsaved changes' : 'Saved'}
          testID={`day-note-${saveState}`}
        />
      </View>

      <View style={s.wrap} onLayout={(e) => setViewport(e.nativeEvent.layout.height)}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={s.scroll}
        >
          {/* The rules live behind the text and grow with it, so they scroll
              together — a static backdrop would drift out of register the
              moment the note is longer than the sheet. */}
          <View style={[s.paper, { minHeight: viewport }]} onLayout={(e) => setPaperHeight(e.nativeEvent.layout.height)}>
            <View style={s.rules} pointerEvents="none">
              {Array.from({ length: rules }, (_, i) => (
                <View key={i} style={[s.rule, { top: RULE_OFFSET + (i + 1) * RULE_STEP }]} />
              ))}
            </View>
            <TextInput
              ref={input}
              multiline
              // The ScrollView above is the scroller; letting the input scroll
              // too would slide the text off its own rules.
              scrollEnabled={false}
              value={draft}
              onChangeText={change}
              onBlur={flush}
              placeholder="Write about today…"
              placeholderTextColor={theme.faint}
              selectionColor={theme.accent}
              textAlignVertical="top"
              style={s.input}
              testID="day-note-input"
            />
          </View>
        </ScrollView>
        <FadeEdge placement="top" color={theme.surface} height={16} />
      </View>
    </SheetBase>
  );
}

const s = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 16, paddingBottom: 8 },
  headText: { color: theme.faint, fontSize: 10, fontWeight: '800', letterSpacing: 1.2, flexShrink: 1 },
  saveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: theme.ok, marginLeft: 'auto' },
  saveDotDirty: { backgroundColor: theme.live },

  wrap: { flex: 1, minHeight: 0 },
  scroll: { flexGrow: 1 },
  paper: { position: 'relative', paddingHorizontal: 16, paddingBottom: 24 },
  rules: { ...StyleSheet.absoluteFillObject },
  rule: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: theme.border },
  input: {
    color: theme.text,
    fontSize: 14,
    lineHeight: RULE_STEP,
    padding: 0,
    // Android measures a multiline input at one line until it has content;
    // the paper still needs to fill the sheet so the rules read as paper.
    minHeight: RULE_STEP * 4,
  },
});
