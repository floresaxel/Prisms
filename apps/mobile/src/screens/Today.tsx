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
import { Alert, BackHandler, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { asEpochMillis, type Instant } from '@prisms/core';
import {
  explainProvenance,
  formatWallTime,
  useBlockTags,
  useCommands,
  useIsHydrated,
  useMyDayAvailable,
  useRunningTimer,
  useTimeBlocksForDay,
  useTodayItinerary,
  useUserSettings,
  type CommandContext,
  type ItineraryRow,
  type MyDayItem,
  type TimeBlockOption,
} from '@prisms/ui';

import { ActionList, type ActionItem, type ActionRequest } from '../components/ActionList';
import { ChipPill } from '../components/ChipPill';
import { DayMapBar } from '../components/DayMapBar';
import { DayPanel } from '../components/DayPanel';
import { Dot } from '../components/Dot';
import { FadeEdge } from '../components/FadeEdge';
import { SectionFold } from '../components/SectionFold';
import { useDayPanel } from '../components/useDayPanel';
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
  const dayPanel = useDayPanel();
  // This screen hides the navigator header (it draws its own), so it owns the
  // status-bar inset that the header would otherwise have provided.
  const insets = useSafeAreaInsets();

  // Android back closes the day calendar rather than leaving the screen.
  useEffect(() => {
    if (!dayPanel.open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      dayPanel.close();
      return true;
    });
    return () => sub.remove();
  }, [dayPanel]);

  const [review, setReview] = useState<{ entryId: string; taskId: string; taskTitle: string } | null>(null);
  // Local state is enough for the fold to survive a tab switch: the tab
  // navigator keeps a visited screen mounted.
  const [allTasksOpen, setAllTasksOpen] = useState(true);
  const [actionRequest, setActionRequest] = useState<ActionRequest | null>(null);

  // #18: actionable but not yet on the clock, in decision-board priority — the
  // same ordering the web My Day uses, so the two agree for one account.
  const available = useMyDayAvailable(coarseNow);
  const unscheduled = useMemo(() => available.filter((item) => !item.scheduled), [available]);
  const blocksToday = useTimeBlocksForDay(coarseNow);

  const checkOffUnscheduled = useCallback(
    (item: MyDayItem) => {
      // #19: an unscheduled task has no block to attribute to, so ask which one
      // it belonged to — the same choice the web My Day offers.
      if (blocksToday.length === 0) {
        void commands.checkOff(item.task.id, { disposition: 'completed', completedInBlockId: null });
        return;
      }
      setActionRequest(
        buildBlockPicker({
          title: item.task.title,
          blocks: blocksToday,
          timezone: settings.timezone,
          onPick: (blockId) => void commands.checkOff(item.task.id, { disposition: 'completed', completedInBlockId: blockId }),
        }),
      );
    },
    [blocksToday, commands, settings.timezone],
  );

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
      setActionRequest(
        buildRowMenu({
          row,
          // I5: only one timer runs at a time.
          canClockIn: running === null,
          onClockIn: () => void commands.clockIn(row.taskId),
          onClockOut: () => void stopTimer(row),
          onShiftLater: () => shift(30),
          onShiftEarlier: () => shift(-30),
          onToggleAnchor: () => void commands.setBlockAnchor(row.blockId, row.anchored ? 'none' : 'start'),
          onUnschedule: () => void commands.deleteBlock(row.blockId),
          onExplain: (title, body) => Alert.alert(title, body.length > 0 ? body : undefined),
        }),
      );
    },
    [commands, running, stopTimer],
  );

  const header = useMemo(() => formatDayHeading(itinerary.today), [itinerary.today]);

  return (
    <View style={s.screen} testID="today">
      <View style={[s.header, { paddingTop: insets.top + 6 }]}>
        <Text style={s.h1}>Today</Text>
        <Text style={s.headerDate} testID="today-date">{header}</Text>
      </View>

      {/* The bar overlays the content column; `s.list` keeps its right padding
          clear of the lane so nothing ever sits underneath it. */}
      <DayMapBar map={itinerary.dayMap} onPress={dayPanel.toggle} panHandlers={dayPanel.barPanHandlers} testID="day-map" />

      <View style={[s.itineraryWrap, allTasksOpen && s.itineraryShared]}>
        <FlatList
          data={itinerary.rows}
          keyExtractor={(row) => row.blockId}
          contentContainerStyle={s.list}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            hydrated ? (
              <Text style={s.empty} testID="today-empty">
                Nothing scheduled — pull something up from All Tasks.
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
        <FadeEdge placement="bottom" height={18} />
      </View>

      {/* #18–#19: what is NOT on the clock yet, in decision-board priority. */}
      <View style={[s.allTasks, allTasksOpen && s.allTasksOpen]}>
        <SectionFold
          title="All Tasks"
          open={allTasksOpen}
          count={unscheduled.length}
          onToggle={() => setAllTasksOpen((v) => !v)}
          testID="all-tasks-fold"
        />
        {allTasksOpen && (
          <View style={s.allTasksListWrap}>
            <FlatList
              data={unscheduled}
              keyExtractor={(item) => item.task.id}
              contentContainerStyle={s.allTasksList}
              showsVerticalScrollIndicator={false}
              ListEmptyComponent={
                hydrated ? (
                  <Text style={s.empty} testID="all-tasks-empty">
                    Nothing waiting — everything is scheduled, done or blocked.
                  </Text>
                ) : null
              }
              renderItem={({ item }) => <AllTaskRow item={item} onCheckOff={checkOffUnscheduled} />}
            />
            <FadeEdge placement="bottom" height={26} />
          </View>
        )}
      </View>

      <DayPanel
        map={itinerary.dayMap}
        heading={weekdayOf(itinerary.today)}
        controller={dayPanel}
        onAccept={(blockId) => void commands.acceptSuggestion(blockId)}
        onReject={(blockId) => void commands.rejectSuggestion(blockId)}
      />

      <ActionList request={actionRequest} onDismiss={() => setActionRequest(null)} />

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
 * One All-Tasks row (#19): a check circle and a title. Deliberately quieter
 * than an itinerary row — these are candidates, not commitments.
 */
const AllTaskRow = memo(function AllTaskRow({
  item,
  onCheckOff,
}: {
  item: MyDayItem;
  onCheckOff: (item: MyDayItem) => void;
}) {
  return (
    <View style={s.atRow} testID={`all-task-${item.task.id}`}>
      <Pressable
        onPress={() => onCheckOff(item)}
        hitSlop={10}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: false }}
        accessibilityLabel={`Complete ${item.task.title}`}
        testID={`all-task-check-${item.task.id}`}
        style={({ pressed }) => [s.atCheck, pressed && s.atCheckPressed]}
      />
      <Text style={s.atTitle} numberOfLines={1}>
        {item.task.title}
      </Text>
      {item.projectTitle !== null && (
        <Text style={s.atProject} numberOfLines={1}>
          {item.projectTitle}
        </Text>
      )}
    </View>
  );
});

/** "Which block did this belong to?" — the unscheduled check-off flow (#19). */
function buildBlockPicker(opts: {
  title: string;
  blocks: readonly TimeBlockOption[];
  timezone: string;
  onPick: (blockId: string | null) => void;
}): ActionRequest {
  return {
    title: opts.title,
    message: 'Which block did this happen in?',
    actions: [
      ...opts.blocks.map((b) => ({
        label: `${formatWallTime(b.startsAt, opts.timezone)} · ${b.title}`,
        onPress: () => opts.onPick(b.id),
      })),
      { label: 'No block', onPress: () => opts.onPick(null) },
    ],
  };
}

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
function buildRowMenu(opts: {
  row: ItineraryRow;
  canClockIn: boolean;
  onClockIn: () => void;
  onClockOut: () => void;
  onShiftLater: () => void;
  onShiftEarlier: () => void;
  onToggleAnchor: () => void;
  onUnschedule: () => void;
  onExplain: (title: string, body: string) => void;
}): ActionRequest {
  const { row } = opts;
  const actions: ActionItem[] = [];

  if (row.state === 'live') actions.push({ label: 'Clock out', onPress: opts.onClockOut });
  else if (opts.canClockIn) actions.push({ label: 'Clock in', onPress: opts.onClockIn });

  actions.push(
    { label: 'Move 30 min later', onPress: opts.onShiftLater },
    { label: 'Move 30 min earlier', onPress: opts.onShiftEarlier },
    { label: row.anchored ? 'Unlock (allow rescheduling)' : 'Lock to this time', onPress: opts.onToggleAnchor },
    {
      label: 'Why is this here?',
      onPress: () => {
        const why = explainProvenance(row.provenance);
        opts.onExplain(why.summary, why.detail.join('\n\n'));
      },
    },
    { label: 'Unschedule', onPress: opts.onUnschedule, destructive: true },
  );

  return { title: row.title, actions };
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

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The day string is ALREADY the account's local day, so it is read and
 * formatted as UTC — running it through the device's zone would shift it.
 */
function dayPartsOf(isoDate: string): Date | null {
  const [y, m, d] = isoDate.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined) return null;
  return new Date(Date.UTC(y, m - 1, d));
}

/** `2026-07-26` → `Sunday, Jul 26` (the mock's header line). */
function formatDayHeading(isoDate: string): string {
  const at = dayPartsOf(isoDate);
  if (at === null) return isoDate;
  return `${WEEKDAYS[at.getUTCDay()]}, ${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}`;
}

/** `2026-07-26` → `Sunday` — the day panel's header. */
function weekdayOf(isoDate: string): string {
  const at = dayPartsOf(isoDate);
  return at === null ? isoDate : (WEEKDAYS[at.getUTCDay()] as string);
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  header: { paddingHorizontal: 20, paddingTop: 6, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: theme.border },
  h1: { color: theme.text, fontSize: 22, fontWeight: '800', letterSpacing: -0.5 },
  headerDate: { color: theme.dim, fontSize: 12.5, fontWeight: '600', marginTop: 2 },
  // 34 px on the right: the 14 px lane at right:9, plus breathing room.
  list: { paddingLeft: 16, paddingRight: 34, paddingTop: 8, paddingBottom: 20 },
  empty: { color: theme.faint, fontSize: 13, fontWeight: '600', paddingVertical: 24 },

  // The itinerary takes what it needs until All Tasks is open, then the two
  // share the screen the way the mock splits them.
  itineraryWrap: { flexShrink: 1 },
  itineraryShared: { flex: 1.4 },
  allTasks: { paddingLeft: 20, paddingRight: 34 },
  allTasksOpen: { flex: 1, minHeight: 0 },
  allTasksListWrap: { flex: 1, minHeight: 0 },
  allTasksList: { paddingTop: 2, paddingBottom: 28 },
  atRow: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 8 },
  atCheck: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: theme.border2, backgroundColor: theme.surface },
  atCheckPressed: { backgroundColor: theme.accentBg, borderColor: theme.accent },
  atTitle: { color: theme.text, fontSize: 14.5, fontWeight: '500', flexShrink: 1 },
  atProject: { color: theme.faint, fontSize: 11, fontWeight: '600', marginLeft: 'auto' },

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
