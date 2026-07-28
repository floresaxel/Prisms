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
 * Around it: the day-map bar and its swipe-out calendar (T2/T3), the All Tasks
 * section (T4) and the two bottom sheets — New Task (T5) and the day note
 * (T6) — which share one slot, so opening either closes the other.
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
  useHabits,
  useIsHydrated,
  useMyDayAvailable,
  useNodeTree,
  usePromoteTargets,
  useRunningTimer,
  useTimeBlocksForDay,
  useTodayItinerary,
  useUserSettings,
  useWorklist,
  type CommandContext,
  type ItineraryRow,
  type MyDayItem,
  type TimeBlockOption,
} from '@prisms/ui';

import { ActionList, type ActionItem, type ActionRequest } from '../components/ActionList';
import { ChipPill } from '../components/ChipPill';
import { DayMapBar } from '../components/DayMapBar';
import { DayNoteSheet } from '../components/DayNoteSheet';
import { DayPanel } from '../components/DayPanel';
import { Dot } from '../components/Dot';
import { FadeEdge } from '../components/FadeEdge';
import { NewTaskSheet } from '../components/NewTaskSheet';
import { SectionFold } from '../components/SectionFold';
import { useDayPanel } from '../components/useDayPanel';
import { formatDurationLong, formatElapsed } from '../format';
import { theme } from '../ui';

const MINUTE = 60_000;
/** Keep in step with `s.list`'s paddingTop. */
const LIST_PADDING_TOP = 8;

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
  // Only one sheet is ever up: they occupy the same slot, and the mock's two
  // buttons read as a toggle between them rather than two stacking panels.
  const [sheet, setSheet] = useState<'note' | 'task' | null>(null);
  // Measured from the rendered itinerary, like the mock measures rects: the
  // task sheet lands under the 4th row, the note under the 1st.
  const [sheetTop, setSheetTop] = useState({ note: 200, task: 320 });
  const [headerHeight, setHeaderHeight] = useState(0);
  const [rowHeight, setRowHeight] = useState(0);

  // #30: the sheets stop under a row (the 4th for New Task, the 1st for the day
  // note), so the day being written about stays visible behind them. Derived
  // from ONE measured row rather than the anchor row's own layout: rows that
  // arrive after their first layout never re-fire onLayout, so waiting for a
  // particular index leaves the sheet stuck wherever the list was mid-hydration.
  useEffect(() => {
    if (rowHeight === 0 || headerHeight === 0) return;
    const under = (n: number) =>
      Math.round(headerHeight + LIST_PADDING_TOP + rowHeight * Math.min(n, Math.max(1, itinerary.rows.length)) + 4);
    setSheetTop({ note: under(1), task: under(4) });
  }, [rowHeight, headerHeight, itinerary.rows.length]);

  const tree = useNodeTree();
  const promoteTargets = usePromoteTargets();
  const habits = useHabits(coarseNow);
  const worklist = useWorklist(coarseNow);

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
    async (taskId: string, taskTitle: string) => {
      const entry = running?.entry;
      if (entry === undefined) return;
      await commands.clockOut(entry.id);
      // D9: clocking out always asks for the focus factor (I5 parity with web).
      setReview({ entryId: entry.id, taskId, taskTitle });
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
          onClockOut: () => void stopTimer(row.taskId, row.title),
          onShiftLater: () => shift(30),
          onShiftEarlier: () => shift(-30),
          onToggleAnchor: () => void commands.setBlockAnchor(row.blockId, row.anchored ? 'none' : 'start'),
          onUnschedule: () => void commands.deleteBlock(row.blockId),
          onDelete: () => void commands.softDelete(row.taskId),
          onExplain: (title, body) => Alert.alert(title, body.length > 0 ? body : undefined),
        }),
      );
    },
    [commands, running, stopTimer],
  );

  // T7/D2: the two things Worklist could do to a task that is NOT on the
  // itinerary — put it on the clock, and throw it away. Without these, retiring
  // that tab would strand an unscheduled running timer with no way to stop it.
  const openTaskMenu = useCallback(
    (item: MyDayItem) => {
      setActionRequest(
        buildTaskMenu({
          item,
          canClockIn: running === null,
          onClockIn: () => void commands.clockIn(item.task.id),
          onClockOut: () => void stopTimer(item.task.id, item.task.title),
          onDelete: () => void commands.softDelete(item.task.id),
        }),
      );
    },
    [commands, running, stopTimer],
  );

  const header = useMemo(() => formatDayHeading(itinerary.today), [itinerary.today]);

  return (
    <View style={s.screen} testID="today">
      <View
        style={[s.header, { paddingTop: insets.top + 6 }]}
        onLayout={(e) => setHeaderHeight(e.nativeEvent.layout.height)}
      >
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
          // #32: an empty list before the replica has hydrated is not an empty
          // day — it is a day nobody has read yet, and saying otherwise is a lie
          // the user acts on.
          ListEmptyComponent={
            hydrated ? (
              <Text style={s.empty} testID="today-empty">
                Nothing scheduled — pull something up from All Tasks.
              </Text>
            ) : (
              <LoadingRows count={4} testID="today-skeleton" />
            )
          }
          renderItem={({ item, index }) => (
            <View
              onLayout={(e) => {
                if (index === 0) setRowHeight(e.nativeEvent.layout.height);
              }}
            >
              <ItineraryItem
                row={item}
                timezone={settings.timezone}
                runningSince={item.state === 'live' ? running?.entry.started_at : undefined}
                onToggleDone={toggleDone}
                onOpenMenu={openMenu}
              />
            </View>
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
                ) : (
                  <LoadingRows count={3} testID="all-tasks-skeleton" />
                )
              }
              renderItem={({ item }) => (
                <AllTaskRow
                  item={item}
                  runningSince={item.openEntryId === undefined ? undefined : running?.entry.started_at}
                  onCheckOff={checkOffUnscheduled}
                  onOpenMenu={openTaskMenu}
                />
              )}
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

      {/* #31: the action bar floats over the content on its own gradient. */}
      <View style={s.actionBar} pointerEvents="box-none">
        <FadeEdge placement="bottom" height={90} />
        <Pressable
          onPress={() => setSheet((v) => (v === 'note' ? null : 'note'))}
          accessibilityRole="button"
          accessibilityLabel="Day note"
          accessibilityState={{ expanded: sheet === 'note' }}
          testID="day-note-button"
          style={({ pressed }) => [s.actionBtn, sheet === 'note' && s.actionBtnOn, pressed && s.actionBtnPressed]}
        >
          <Text style={s.actionNote}>▤</Text>
        </Pressable>
        <Pressable
          onPress={() => setSheet((v) => (v === 'task' ? null : 'task'))}
          accessibilityRole="button"
          accessibilityLabel="New task"
          accessibilityState={{ expanded: sheet === 'task' }}
          testID="new-task-button"
          style={({ pressed }) => [s.actionBtn, sheet === 'task' && s.actionBtnOn, pressed && s.actionBtnPressed]}
        >
          <Text style={s.actionPlus}>＋</Text>
        </Pressable>
      </View>

      {/* #28: the journal, reached from the day it is about. */}
      <DayNoteSheet
        open={sheet === 'note'}
        onClose={() => setSheet(null)}
        top={sheetTop.note}
        date={itinerary.today}
        heading={header}
        commands={commands}
      />

      <NewTaskSheet
        open={sheet === 'task'}
        onClose={() => setSheet(null)}
        // #30: the sheet stops just under the rows, so the day it is being
        // added to stays visible behind it.
        top={sheetTop.task}
        today={itinerary.today}
        tree={tree}
        commands={commands}
        projects={promoteTargets}
        habits={habits}
        candidates={worklist}
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

  // One node for the whole row body, so a screen reader reads a sentence
  // instead of five fragments. The ticking elapsed is deliberately NOT in it:
  // a label that changes every second announces every second.
  const label = [
    formatWallTime(row.startsAt, timezone),
    row.title,
    row.anchored ? 'locked to this time' : null,
    ...tags.map((t) => t.tag.label),
    row.isHabit ? 'habit' : null,
    row.state === 'live'
      ? 'running now'
      : done
        ? `done, ${formatDurationLong(row.loggedMinutes)} logged`
        : `${formatDurationLong(row.plannedMinutes)} estimated`,
  ]
    .filter((part): part is string => part !== null)
    .join(', ');

  return (
    <View style={s.row} testID={`today-row-${row.blockId}`}>
      {/* The time is spoken as part of the body label below. */}
      <Text style={s.time} importantForAccessibility="no" accessibilityElementsHidden>
        {formatWallTime(row.startsAt, timezone)}
      </Text>

      <Dot
        tone={row.tone}
        checked={done}
        pulse={row.state === 'live'}
        onPress={() => onToggleDone(row)}
        accessibilityLabel={done ? `${row.title}, done` : `Mark ${row.title} done`}
        testID={`today-dot-${row.blockId}`}
      />

      <View style={s.body} accessible accessibilityLabel={label}>
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
  runningSince,
  onCheckOff,
  onOpenMenu,
}: {
  item: MyDayItem;
  runningSince: string | undefined;
  onCheckOff: (item: MyDayItem) => void;
  onOpenMenu: (item: MyDayItem) => void;
}) {
  const label = [item.task.title, item.projectTitle, runningSince === undefined ? null : 'running now']
    .filter((part): part is string => part !== null && part !== undefined)
    .join(', ');

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
      <View style={s.atBody} accessible accessibilityLabel={label}>
        <Text style={[s.atTitle, runningSince !== undefined && s.atTitleLive]} numberOfLines={1}>
          {item.task.title}
        </Text>
        {runningSince !== undefined ? (
          <LiveElapsed startedAt={runningSince} testID={`all-task-elapsed-${item.task.id}`} />
        ) : (
          item.projectTitle !== null && (
            <Text style={s.atProject} numberOfLines={1}>
              {item.projectTitle}
            </Text>
          )
        )}
      </View>
      {/* T7: an unscheduled task still needs the clock and the bin — the two
          verbs the retired Worklist tab owned. */}
      <Pressable
        onPress={() => onOpenMenu(item)}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel={`Options for ${item.task.title}`}
        testID={`all-task-menu-${item.task.id}`}
        style={({ pressed }) => [s.more, pressed && s.pressed]}
      >
        <Text style={s.moreGlyph}>•••</Text>
      </Pressable>
    </View>
  );
});

/**
 * #32: what a list shows before the replica has hydrated. Grey bars rather than
 * an empty state, because "nothing here" and "not read yet" are different
 * facts and the user plans their day on the difference.
 */
function LoadingRows({ count, testID }: { count: number; testID: string }) {
  return (
    <View testID={testID} accessible accessibilityLabel="Loading">
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={s.skeletonRow}>
          <View style={[s.skeletonBar, { width: `${70 - i * 8}%` }]} />
          <View style={[s.skeletonBar, s.skeletonBarSmall]} />
        </View>
      ))}
    </View>
  );
}

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
  onDelete: () => void;
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
    { label: 'Delete task', onPress: opts.onDelete, destructive: true },
  );

  return { title: row.title, actions };
}

/**
 * The All-Tasks row menu (T7). Short on purpose: an unscheduled task has no
 * block to move, lock or explain — only the two verbs Worklist owned.
 */
function buildTaskMenu(opts: {
  item: MyDayItem;
  canClockIn: boolean;
  onClockIn: () => void;
  onClockOut: () => void;
  onDelete: () => void;
}): ActionRequest {
  const actions: ActionItem[] = [];
  if (opts.item.openEntryId !== undefined) actions.push({ label: 'Clock out', onPress: opts.onClockOut });
  else if (opts.canClockIn) actions.push({ label: 'Clock in', onPress: opts.onClockIn });
  actions.push({ label: 'Delete task', onPress: opts.onDelete, destructive: true });
  return { title: opts.item.task.title, actions };
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
    // Not a Modal, but it behaves as one: without this a screen reader walks
    // straight past it into the itinerary underneath.
    <View style={s.reviewScrim} testID="today-review" accessibilityViewIsModal>
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
  atBody: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 },
  atTitle: { color: theme.text, fontSize: 14.5, fontWeight: '500', flexShrink: 1 },
  atTitleLive: { color: theme.live, fontWeight: '600' },
  atProject: { color: theme.faint, fontSize: 11, fontWeight: '600', marginLeft: 'auto' },

  skeletonRow: { paddingVertical: 13, gap: 7 },
  skeletonBar: { height: 10, borderRadius: 5, backgroundColor: theme.greyBg },
  skeletonBarSmall: { width: '32%', height: 8 },

  actionBar: { position: 'absolute', left: 0, right: 34, bottom: 0, paddingHorizontal: 24, paddingBottom: 22, paddingTop: 12, flexDirection: 'row', justifyContent: 'flex-end', gap: 10, zIndex: 6 },
  actionBtn: {
    width: 58,
    height: 54,
    borderRadius: 17,
    backgroundColor: theme.surface,
    borderWidth: 1.5,
    borderColor: theme.border2,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#101828',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 14,
    elevation: 4,
  },
  actionBtnOn: { borderColor: theme.accent, backgroundColor: theme.accentBg },
  actionBtnPressed: { backgroundColor: theme.bg },
  actionPlus: { color: theme.accent, fontSize: 26, fontWeight: '500', lineHeight: 30 },
  actionNote: { color: theme.dim, fontSize: 21, lineHeight: 26 },

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
