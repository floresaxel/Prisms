/**
 * Today (MOBILE_TODAY_PLAN T1) — the itinerary half of the new home screen.
 *
 * One row per committed block for today, in clock order: time, a marker whose
 * colour is the parent project, the title, its category chips, and how long it
 * took or is expected to take. The clocked-in row pulses and ticks.
 *
 * Two clocks on purpose (plan §6): `coarseNow` moves once a minute and drives
 * the reads, while only `LiveElapsed` re-renders every second. Threading a 1 s
 * clock into `useTodayItinerary` would rebuild the agenda, the ancestry walk
 * and the entry sums sixty times a minute to animate one label.
 *
 * T2–T4 add the day-map bar, the swipe-out day calendar and the All Tasks
 * section below this; T7 retires Worklist once its flows all live here.
 */
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { ActionSheetIOS, Alert, FlatList, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { asEpochMillis, type Instant } from '@prisms/core';
import {
  explainProvenance,
  formatWallTime,
  useBlockTags,
  useCommands,
  useIsHydrated,
  useRunningTimer,
  useTodayItinerary,
  useUserSettings,
  type CommandContext,
  type ItineraryRow,
} from '@prisms/ui';

import { ChipPill } from '../components/ChipPill';
import { DayMapBar } from '../components/DayMapBar';
import { Dot } from '../components/Dot';
import { formatDurationLong, formatElapsed } from '../format';
import { theme } from '../ui';

const MINUTE = 60_000;

export function Today({ ctx }: { ctx: CommandContext }) {
  // Coarse clock: the reads only need to notice a new minute (and the day-reset).
  const [coarseNow, setCoarseNow] = useState<Instant>(asEpochMillis(Date.now()));
  useEffect(() => {
    const t = setInterval(() => setCoarseNow(asEpochMillis(Date.now())), MINUTE);
    return () => clearInterval(t);
  }, []);

  const itinerary = useTodayItinerary(coarseNow);
  const running = useRunningTimer(coarseNow);
  const commands = useCommands(ctx);
  const settings = useUserSettings();
  const hydrated = useIsHydrated();

  const [review, setReview] = useState<{ entryId: string; taskId: string; taskTitle: string } | null>(null);

  const toggleDone = useCallback(
    async (row: ItineraryRow) => {
      if (row.state === 'done') {
        await commands.uncheck(row.taskId);
        return;
      }
      // A scheduled task attributes its completion to the block it sat in —
      // the same rule the web My Day uses.
      await commands.checkOff(row.taskId, { disposition: 'completed', completedInBlockId: row.blockId });
    },
    [commands],
  );

  const stopTimer = useCallback(
    async (row: ItineraryRow) => {
      const entry = running?.entry;
      if (entry === undefined) return;
      await commands.clockOut(entry.id);
      // D9: clocking out always asks for the focus factor (I5 parity with web).
      setReview({ entryId: entry.id, taskId: row.taskId, taskTitle: row.title });
    },
    [commands, running],
  );

  const openMenu = useCallback(
    (row: ItineraryRow) => {
      const shift = (minutes: number) =>
        void commands.moveBlock(
          row.blockId,
          new Date(row.startsAt + minutes * MINUTE).toISOString(),
          new Date(row.endsAt + minutes * MINUTE).toISOString(),
        );
      presentRowMenu({
        row,
        // I5: only one timer runs at a time.
        canClockIn: running === null,
        onClockIn: () => void commands.clockIn(row.taskId),
        onClockOut: () => void stopTimer(row),
        onShiftLater: () => shift(30),
        onShiftEarlier: () => shift(-30),
        onToggleAnchor: () => void commands.setBlockAnchor(row.blockId, row.anchored ? 'none' : 'start'),
        onUnschedule: () => void commands.deleteBlock(row.blockId),
      });
    },
    [commands, running, stopTimer],
  );

  const header = useMemo(() => formatDayHeading(itinerary.today), [itinerary.today]);

  return (
    <View style={s.screen} testID="today">
      <View style={s.header}>
        <Text style={s.h1}>Today</Text>
        <Text style={s.headerDate} testID="today-date">{header}</Text>
      </View>

      {/* The bar overlays the content column; `s.list` keeps its right padding
          clear of the lane so nothing ever sits underneath it. */}
      <DayMapBar map={itinerary.dayMap} testID="day-map" />

      <FlatList
        data={itinerary.rows}
        keyExtractor={(row) => row.blockId}
        contentContainerStyle={s.list}
        ListEmptyComponent={
          hydrated ? (
            <Text style={s.empty} testID="today-empty">
              Nothing scheduled today.
            </Text>
          ) : null
        }
        renderItem={({ item }) => (
          <ItineraryItem
            row={item}
            timezone={settings.timezone}
            runningSince={item.state === 'live' ? running?.entry.started_at : undefined}
            onToggleDone={toggleDone}
            onOpenMenu={openMenu}
          />
        )}
      />

      <FocusReview
        target={review}
        onCancel={() => setReview(null)}
        onSubmit={async (focusFactor, completedSession) => {
          if (review === null) return;
          await commands.review({ entryId: review.entryId, focusFactor, completedSession, taskId: review.taskId });
          setReview(null);
        }}
      />
    </View>
  );
}

/**
 * One itinerary row. Memoised so the per-second tick inside `LiveElapsed`
 * cannot drag the whole list into a re-render.
 */
const ItineraryItem = memo(function ItineraryItem({
  row,
  timezone,
  runningSince,
  onToggleDone,
  onOpenMenu,
}: {
  row: ItineraryRow;
  timezone: string;
  runningSince: string | undefined;
  onToggleDone: (row: ItineraryRow) => void;
  onOpenMenu: (row: ItineraryRow) => void;
}) {
  const tags = useBlockTags(row.blockId);
  const done = row.state === 'done';

  return (
    <View style={s.row} testID={`today-row-${row.blockId}`}>
      <Text style={s.time}>{formatWallTime(row.startsAt, timezone)}</Text>

      <Dot
        tone={row.tone}
        checked={done}
        pulse={row.state === 'live'}
        onPress={() => onToggleDone(row)}
        accessibilityLabel={done ? `${row.title}, done` : `Mark ${row.title} done`}
        testID={`today-dot-${row.blockId}`}
      />

      <View style={s.body}>
        <Text style={[s.title, done && s.titleDone]} numberOfLines={2}>
          {row.anchored ? '🔒 ' : ''}
          {row.title}
        </Text>
        <View style={s.meta}>
          {tags.map((t) => (
            <ChipPill key={t.placementId} label={t.tag.label.toUpperCase()} />
          ))}
          {row.isHabit && <ChipPill label="HABIT" />}
          {runningSince !== undefined ? (
            <LiveElapsed startedAt={runningSince} testID={`today-elapsed-${row.blockId}`} />
          ) : (
            <Text style={s.metaText} testID={`today-duration-${row.blockId}`}>
              {done ? formatDurationLong(row.loggedMinutes) : `${formatDurationLong(row.plannedMinutes)} est.`}
            </Text>
          )}
        </View>
      </View>

      <Pressable
        onPress={() => onOpenMenu(row)}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel={`Options for ${row.title}`}
        testID={`today-menu-${row.blockId}`}
        style={({ pressed }) => [s.more, pressed && s.pressed]}
      >
        <Text style={s.moreGlyph}>•••</Text>
      </Pressable>
    </View>
  );
});

/**
 * The ONLY thing on this screen that ticks every second. It owns its own interval
 * and derives elapsed from the entry's start, so no parent state changes.
 */
function LiveElapsed({ startedAt, testID }: { startedAt: string; testID?: string }) {
  const started = useMemo(() => Date.parse(startedAt), [startedAt]);
  const [elapsedMs, setElapsedMs] = useState(() => Math.max(0, Date.now() - started));

  useEffect(() => {
    const t = setInterval(() => setElapsedMs(Math.max(0, Date.now() - started)), 1000);
    return () => clearInterval(t);
  }, [started]);

  return (
    <Text style={[s.metaText, s.metaLive]} testID={testID}>
      ⏱ {formatElapsed(elapsedMs)}
    </Text>
  );
}

/**
 * The ••• menu (#11). iOS gets the native action sheet; Android gets an Alert
 * with the same choices — neither needs a dependency, and T3's `SheetBase`
 * is for content, not for a short list of verbs.
 */
function presentRowMenu(opts: {
  row: ItineraryRow;
  canClockIn: boolean;
  onClockIn: () => void;
  onClockOut: () => void;
  onShiftLater: () => void;
  onShiftEarlier: () => void;
  onToggleAnchor: () => void;
  onUnschedule: () => void;
}): void {
  const { row } = opts;
  const actions: { label: string; run: () => void; destructive?: boolean }[] = [];

  if (row.state === 'live') actions.push({ label: 'Clock out', run: opts.onClockOut });
  else if (opts.canClockIn) actions.push({ label: 'Clock in', run: opts.onClockIn });

  actions.push(
    { label: 'Move 30 min later', run: opts.onShiftLater },
    { label: 'Move 30 min earlier', run: opts.onShiftEarlier },
    { label: row.anchored ? 'Unlock (allow rescheduling)' : 'Lock to this time', run: opts.onToggleAnchor },
    {
      label: 'Why is this here?',
      run: () => {
        const why = explainProvenance(row.provenance);
        Alert.alert(why.summary, why.detail.join('\n\n') || undefined);
      },
    },
    { label: 'Unschedule', run: opts.onUnschedule, destructive: true },
  );

  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: row.title,
        options: [...actions.map((a) => a.label), 'Cancel'],
        cancelButtonIndex: actions.length,
        destructiveButtonIndex: actions.findIndex((a) => a.destructive === true),
      },
      (index) => actions[index]?.run(),
    );
    return;
  }

  Alert.alert(row.title, undefined, [
    ...actions.map((a) => ({
      text: a.label,
      style: a.destructive === true ? ('destructive' as const) : ('default' as const),
      onPress: a.run,
    })),
    { text: 'Cancel', style: 'cancel' as const },
  ]);
}

const FACTORS = [0.5, 0.75, 1.0];

/** D9: the focus-factor sheet clock-out always opens, ported from Worklist. */
function FocusReview({
  target,
  onCancel,
  onSubmit,
}: {
  target: { entryId: string; taskId: string; taskTitle: string } | null;
  onCancel: () => void;
  onSubmit: (focusFactor: number, completedSession: boolean) => Promise<void>;
}) {
  const [focus, setFocus] = useState(1.0);
  const [completed, setCompleted] = useState(false);

  useEffect(() => {
    if (target !== null) {
      setFocus(1.0);
      setCompleted(false);
    }
  }, [target]);

  if (target === null) return null;

  return (
    <View style={s.reviewScrim} testID="today-review">
      <View style={s.reviewCard}>
        <Text style={s.reviewTitle}>Session review</Text>
        <Text style={s.reviewTask}>{target.taskTitle}</Text>

        <Text style={s.reviewLabel}>How focused was it?</Text>
        <View style={s.reviewRow}>
          {FACTORS.map((f) => (
            <Pressable
              key={f}
              onPress={() => setFocus(f)}
              accessibilityRole="radio"
              accessibilityState={{ selected: focus === f }}
              testID={`today-review-focus-${f}`}
              style={[s.reviewChip, focus === f && s.reviewChipOn]}
            >
              <Text style={[s.reviewChipText, focus === f && s.reviewChipTextOn]}>×{f.toFixed(2)}</Text>
            </Pressable>
          ))}
        </View>

        <Pressable
          onPress={() => setCompleted((c) => !c)}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: completed }}
          testID="today-review-completed"
          style={[s.reviewChip, completed && s.reviewChipOn]}
        >
          <Text style={[s.reviewChipText, completed && s.reviewChipTextOn]}>
            {completed ? 'Finished the task ✓' : 'Finished the task?'}
          </Text>
        </Pressable>

        <View style={s.reviewRow}>
          <Pressable onPress={onCancel} testID="today-review-skip" style={s.reviewChip}>
            <Text style={s.reviewChipText}>Skip</Text>
          </Pressable>
          <Pressable
            onPress={() => void onSubmit(focus, completed)}
            testID="today-review-save"
            style={[s.reviewChip, s.reviewSave]}
          >
            <Text style={[s.reviewChipText, s.reviewSaveText]}>Save</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

/** `2026-07-26` → `Sunday, Jul 26` (the mock's header line). */
function formatDayHeading(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined) return isoDate;
  // Read as UTC and format as UTC: the string is already the account's local day.
  const at = new Date(Date.UTC(y, m - 1, d));
  const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][at.getUTCDay()];
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][at.getUTCMonth()];
  return `${day}, ${month} ${at.getUTCDate()}`;
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  header: { paddingHorizontal: 20, paddingTop: 6, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: theme.border },
  h1: { color: theme.text, fontSize: 22, fontWeight: '800', letterSpacing: -0.5 },
  headerDate: { color: theme.dim, fontSize: 12.5, fontWeight: '600', marginTop: 2 },
  // 34 px on the right: the 14 px lane at right:9, plus breathing room.
  list: { paddingLeft: 16, paddingRight: 34, paddingTop: 8, paddingBottom: 28 },
  empty: { color: theme.faint, fontSize: 13, fontWeight: '600', paddingVertical: 24 },

  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: theme.border },
  time: { color: theme.dim, fontSize: 12, fontWeight: '700', width: 42, textAlign: 'right', paddingTop: 3 },
  body: { flex: 1, minWidth: 0 },
  title: { color: theme.text, fontSize: 15, fontWeight: '600', letterSpacing: -0.2, lineHeight: 19 },
  titleDone: { textDecorationLine: 'line-through', color: theme.faint },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 6, flexWrap: 'wrap' },
  metaText: { color: theme.faint, fontSize: 11, fontWeight: '600' },
  metaLive: { color: theme.live },
  more: { paddingHorizontal: 2, paddingTop: 3 },
  moreGlyph: { color: theme.faint, fontSize: 13, fontWeight: '800', letterSpacing: 1 },
  pressed: { opacity: 0.6 },

  reviewScrim: { ...StyleSheet.absoluteFillObject, backgroundColor: theme.scrim, justifyContent: 'center', padding: 24 },
  reviewCard: { backgroundColor: theme.surface, borderColor: theme.border, borderWidth: 1, borderRadius: 16, padding: 16, gap: 10 },
  reviewTitle: { color: theme.text, fontSize: 17, fontWeight: '700' },
  reviewTask: { color: theme.dim, fontSize: 13 },
  reviewLabel: { color: theme.dim, fontSize: 12, fontWeight: '600', marginTop: 4 },
  reviewRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  reviewChip: { borderWidth: 1.5, borderColor: theme.border2, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: theme.surface },
  reviewChipOn: { borderColor: theme.accent, backgroundColor: theme.accentBg },
  reviewChipText: { color: theme.dim, fontSize: 13, fontWeight: '600' },
  reviewChipTextOn: { color: theme.accentDeep },
  reviewSave: { backgroundColor: theme.accent, borderColor: theme.accent, marginLeft: 'auto' },
  reviewSaveText: { color: '#ffffff' },
});
