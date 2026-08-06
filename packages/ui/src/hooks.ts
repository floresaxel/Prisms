/**
 * Reactive hooks (§12.2): PowerSync reactive queries → core selectors → React.
 * No view caches derived status; it recomputes on data change (microseconds).
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react';

import { usePowerSync, useQuery } from '@powersync/react';
import {
  addDays,
  ancestorsOf,
  asEpochMillis,
  bucketDate,
  buildEdgeIndex,
  canonicalBurndown,
  canonicalCompletion,
  canonicalPractice,
  canonicalProgress,
  canonicalStreak,
  childrenOf,
  computeDayLog,
  criticalPath,
  DEFAULT_JOURNAL_DAY_LOG,
  DEFAULT_WINDOWS,
  descendantsOf,
  evaluateBlockerRules,
  expandWindows,
  habitTaskIds,
  habitTodayMinutes,
  isJustified,
  isoToEpochMillis,
  localInstant,
  mergeTable,
  minutesLeftInDay,
  minutesLeftInTask,
  minutesUntilNextBlock,
  rankProjects,
  taskStatus,
  topologicalOrder,
  type AutomationRule,
  type BlockerRule,
  type BurndownValue,
  type CommittedBlock,
  type CompletionValue,
  type DayLogEntries,
  type DecisionBoard,
  type DecisionCriterion,
  type DiagramGroup,
  type EdgeIndex,
  type FactContext,
  type Habit,
  type Instant,
  type IsoDate,
  type JournalEntry,
  type Node,
  type PracticeValue,
  type ProgressValue,
  type ScheduleBlock,
  type SchedulableTask,
  type SchedulerDependency,
  type SchedulerInput,
  type StreakValue,
  type Tag,
  type TagAnswerValue,
  type TaskStatus,
  type TaskStep,
  type TimeEntry,
  type TreeIndex,
} from '@prisms/core';

import { createCommands, type CommandContext } from './powersync/commands';
import { usePrismsData, toOverlayEffect } from './powersync/data-provider';
import { createSqlOverlayStore, type SqlExecutor } from './powersync/overlay-store';
import { createJournalMonthSubscriptions, type JournalMonthSubscriptions, type StreamSubscriber } from './powersync/streams';
import { type ProvenanceFields } from './provenance';
import { buildDayMap, type DayMap } from './day-map';
import { blocksForDay, buildItinerary, loggedMinutesByTask, type ItineraryRow } from './today-itinerary';
import { groupWorklistBySchedule, type WorklistGroup } from './worklist-grouping';
import {
  toAutomationRule,
  toBlockerRule,
  toComputedAggregate,
  toDecisionBoard,
  toDecisionCriterion,
  toDecisionScore,
  toDiagramGroup,
  toDiagramLayout,
  toEdge,
  toHabit,
  toHabitCompletion,
  toJournalEntry,
  toMembership,
  toNode,
  toScheduleBlock,
  toSprint,
  toTag,
  toTagAnswer,
  toTagPlacement,
  toTaskStep,
  toTimeEntry,
  toUserSettings,
} from './powersync/rows';

type Row = Record<string, unknown>;

const EMPTY_ROWS: readonly Row[] = Object.freeze([]);

/** The table a simple `SELECT … FROM <table> …` reads (each hook queries one table). */
function tableFromSql(sql: string): string | null {
  const m = /\bfrom\s+([a-z_][a-z0-9_]*)/i.exec(sql);
  return m ? m[1]!.toLowerCase() : null;
}

// ── Loading-aware, stale-while-revalidate read layer (1.4 §7.15, Fix C; M12) ──
//
// v1.0's `useRows = useQuery(sql).data ?? []` discarded the loading signal, so a
// fresh login (empty replica, sync in flight) and every screen remount resolved
// empty-before-data and flashed the empty branch. M12 fixes both:
//
//   • ROWS_CACHE — the last-known MERGED rows per (sql+params), module-scoped so
//     it SURVIVES a screen unmount/remount. On a warm revisit the read returns the
//     prior rows synchronously (no cold empty frame); a full reload clears it and
//     the read re-hydrates from local SQLite.
//   • PRODUCED — the set of read-keys that have yielded ≥1 replica result this
//     session. A reactive external store (bump `producedVersion` + notify) so the
//     `isHydrated` companions re-render exactly when their table first produces —
//     without opening a second subscription per table.
//
// `isHydrated` (skeleton gating) is grounded at the SESSION level in the provider
// (hasSynced ∨ a base row already exists, §7.14) and combined here with per-read
// "produced" so a screen-local table shows a skeleton until its first result, the
// empty branch only once it is confirmed empty, and cached rows on remount.

const ROWS_CACHE = new Map<string, Row[]>();
const PRODUCED = new Set<string>();
const producedListeners = new Set<() => void>();
let producedVersion = 0;

/** Record that `key` has produced a result and wake the hydration subscribers. */
function markProduced(key: string): void {
  if (PRODUCED.has(key)) return;
  PRODUCED.add(key);
  producedVersion += 1;
  for (const l of producedListeners) l();
}
function subscribeProduced(cb: () => void): () => void {
  producedListeners.add(cb);
  return () => {
    producedListeners.delete(cb);
  };
}
const getProducedVersion = (): number => producedVersion;
/** Re-render when ANY read first produces (so `isHydrated` flips reactively). */
function useProducedVersion(): void {
  useSyncExternalStore(subscribeProduced, getProducedVersion, getProducedVersion);
}

const keyOf = (sql: string, params: readonly unknown[]): string =>
  params.length ? `${sql} :: ${JSON.stringify(params)}` : sql;

/**
 * Test-only: reset the module SWR cache + hydration registry between renders in a
 * fresh test. No-op contract for production (never called by app code).
 */
export function __resetReadCacheForTests(): void {
  ROWS_CACHE.clear();
  PRODUCED.clear();
  producedVersion += 1;
  for (const l of producedListeners) l();
}

/**
 * Clear the module-scoped SWR read cache + hydration registry on sign-out /
 * account switch (S9-F1/S8-F2). These caches are keyed only by sql+params, so
 * without this a warm read on a shared device could momentarily serve the
 * previous account's rows before the fresh replica loads. Call alongside the
 * PowerSync `disconnectAndClear()` in the app's sign-out path.
 */
export function clearReadCaches(): void {
  ROWS_CACHE.clear();
  PRODUCED.clear();
  producedVersion += 1;
  for (const l of producedListeners) l();
}

export interface RowsRead {
  /** The merged (replica + overlay) rows, or the last-known cached rows while (re)loading. */
  data: Row[];
  /** No result this mount AND nothing cached — the true cold-load window. */
  isLoading: boolean;
  /** A refetch is in flight (data may be stale-but-shown). */
  isFetching: boolean;
}

/**
 * The merged read (1.3 §7.2) for SCREEN-LOCAL tables, made loading-aware and
 * remount-surviving (§7.15). The replica query is patched by the pending overlay
 * for its table; optimistic writes (`overlay_effects`) show instantly and a
 * rollback (overlay dropped) reverts. While the replica is first loading, the
 * last-known merged rows from `ROWS_CACHE` are returned so a remount does not
 * flash empty.
 *
 * M11 (Fix A): the 9 provider-shared tables never come through here — they are
 * subscribed once in `PrismsDataProvider` and read warm. This primitive serves
 * only screen-local tables (decision_*, diagram_*, automation_rules,
 * habits/habit_completions, tags*, computed_aggregates, sync_review_items).
 */
function useRowsRead(sql: string, params: readonly unknown[] = EMPTY_ROWS as readonly unknown[]): RowsRead {
  const key = keyOf(sql, params);
  const table = tableFromSql(sql);
  const replicaQ = useQuery<Row>(sql, params as unknown[]);
  const overlayQ = useQuery<Row>(
    'SELECT command_id, hlc, table_name, row_id, op, fields, seq FROM overlay_effects WHERE table_name = ?',
    [table ?? ''],
  );
  const replica = replicaQ.data; // undefined while first-loading (distinct from an empty result)
  const effectRows = overlayQ.data ?? (EMPTY_ROWS as Row[]);
  const produced = replica !== undefined;

  const data = useMemo(() => {
    if (!produced || replica === undefined) return ROWS_CACHE.get(key) ?? (EMPTY_ROWS as Row[]);
    const merged =
      effectRows.length === 0 ? replica : (mergeTable(replica, effectRows.map(toOverlayEffect)) as Row[]);
    ROWS_CACHE.set(key, merged);
    return merged;
  }, [produced, replica, effectRows, key]);

  // Flip the reactive hydration signal AFTER commit (never setState-during-render).
  useEffect(() => {
    if (produced) markProduced(key);
  }, [produced, key]);

  return {
    data,
    isLoading: !produced && !ROWS_CACHE.has(key),
    isFetching: replicaQ.isFetching || overlayQ.isFetching,
  };
}

/** Data-only screen-local read (existing call sites), now remount-surviving. */
const useRows = (sql: string, params?: readonly unknown[]): Row[] => useRowsRead(sql, params).data;

/**
 * Session-level hydration (§7.14/§7.15): the provider has produced a first base
 * result AND either PowerSync's first sync completed OR a base row already exists
 * locally. Screens gate provider-backed empty branches on this — empty renders
 * only when `isHydrated && length === 0`, a skeleton otherwise.
 */
export function useIsHydrated(): boolean {
  return usePrismsData().isHydrated;
}

/**
 * Screen-local hydration: session-hydrated AND the given screen-local read has
 * produced ≥1 result this session. A table that has never loaded (first visit,
 * still loading) is NOT hydrated → skeleton; once it produces (even empty) the
 * screen may show its confirmed-empty branch. Survives remount (PRODUCED is
 * module-scoped), so a tab-away-and-back is instantly hydrated.
 */
function useScreenLocalHydrated(sql: string, params?: readonly unknown[]): boolean {
  const session = usePrismsData().isHydrated;
  useProducedVersion();
  return session && PRODUCED.has(keyOf(sql, params ?? (EMPTY_ROWS as readonly unknown[])));
}

// Primary screen-local reads whose hydration a screen gates its empty branch on.
// Extracted so the data hook and its `…Hydrated` companion key on the SAME sql
// string (a drift between the two would leave the screen stuck on a skeleton).
const Q_HABITS = 'SELECT * FROM habits WHERE deleted_at IS NULL';
const Q_DECISION_BOARDS = 'SELECT * FROM decision_boards WHERE deleted_at IS NULL';
const Q_RULES = 'SELECT * FROM automation_rules WHERE deleted_at IS NULL';
const Q_REVIEW = 'SELECT * FROM sync_review_items';

/** Habits list hydration (§7.15) — gate the "No habits yet" empty branch + vision `<select>`. */
export const useHabitsHydrated = (): boolean => useScreenLocalHydrated(Q_HABITS);
/** Decision-board list hydration — gate the "No boards yet" empty branch. */
export const useDecisionsHydrated = (): boolean => useScreenLocalHydrated(Q_DECISION_BOARDS);
/** Automation-rule list hydration — gate the "No automation rules yet" empty branch. */
export const useRulesHydrated = (): boolean => useScreenLocalHydrated(Q_RULES);
/** Review-inbox hydration — gate the "Nothing to review" empty branch. */
export const useReviewInboxHydrated = (): boolean => useScreenLocalHydrated(Q_REVIEW);

/** Live tree of non-deleted nodes — served warm from the session read layer (§7.14). */
export function useNodeTree(): TreeIndex {
  return usePrismsData().tree;
}

/**
 * The full FactContext used by status + blocker evaluation. Served warm from the
 * `PrismsDataProvider` (§7.14, Fix A): built once per session over the 9 shared
 * subscriptions, not re-derived on navigation or the 1s `now` tick.
 */
export function useFactContext(): FactContext {
  return usePrismsData().factContext;
}

export interface WorklistItem {
  task: Node;
  status: TaskStatus;
  /** Open time-entry id when running. */
  openEntryId?: string;
  /** Time consumed vs. estimate (§7.2 progress bar). */
  progress: ProgressValue;
  /** estimate − consumed minutes (null without an estimate); negative when over. */
  minutesLeftInTask: number | null;
  /** True when the task has ≥1 committed block (Phase 3 grouping/association). */
  scheduled: boolean;
  /** The committed block to auto-associate a completion with (null = none/unscheduled). */
  committedBlockId: string | null;
  /**
   * Labels of in-scope blocker rules that evaluated `unknown` (e.g. weather
   * unverified, §10.3) — advisory only: the task is still actionable, the UI
   * just surfaces a "weather unverified" badge. Never gates a command.
   */
  unverified: string[];
}

/** The committed block to default a completion to: covering now, else most recent, else earliest. */
function pickCommittedBlock(blocks: readonly ScheduleBlock[], now: Instant): string | null {
  if (blocks.length === 0) return null;
  const covering = blocks.find(
    (b) => isoToEpochMillis(b.starts_at) <= now && now <= isoToEpochMillis(b.ends_at),
  );
  if (covering) return covering.id;
  const sorted = [...blocks].sort((a, b) => isoToEpochMillis(a.starts_at) - isoToEpochMillis(b.starts_at));
  const lastPast = [...sorted].reverse().find((b) => isoToEpochMillis(b.starts_at) <= now);
  return (lastPast ?? sorted[0]!).id;
}

/**
 * The "available items" worklist (§1.2): tasks the user can act on now —
 * available, prioritized, scheduled, or ongoing (not done, not blocked),
 * ordered ongoing-first then by status precedence. Each item carries its
 * progress (§7.2) and time-left-in-task indicator.
 */
export function useWorklist(now: Instant): WorklistItem[] {
  const { factContext: ctx, rows } = usePrismsData();
  const entryRows = rows.time_entries;
  const blockRows = useMemo(() => rows.schedule_blocks.filter((r) => r['status'] === 'committed'), [rows.schedule_blocks]);
  return useMemo(() => {
    const entries = entryRows.map(toTimeEntry);
    const blocksByTask = new Map<string, ScheduleBlock[]>();
    for (const b of blockRows.map(toScheduleBlock)) {
      const list = blocksByTask.get(b.task_id);
      if (list) list.push(b);
      else blocksByTask.set(b.task_id, [b]);
    }
    const items: WorklistItem[] = [];
    for (const node of ctx.tree.byId.values()) {
      if (node.node_type !== 'task') continue;
      const status = taskStatus(node, ctx, now);
      if (status === 'done' || status === 'blocked') continue;
      const open = ctx.openEntryFor(node.id);
      const taskBlocks = blocksByTask.get(node.id) ?? [];
      // advisory: in-scope blocker rules that returned `unknown` (e.g. weather
      // unverified, §10.3). The task is not blocked — this only drives a badge.
      const unverified = evaluateBlockerRules(node, ctx, now).unverified.map((r) => r.label);
      items.push({
        task: node,
        status,
        openEntryId: open?.id,
        progress: canonicalProgress(node, entries),
        minutesLeftInTask: minutesLeftInTask(node, entries),
        scheduled: taskBlocks.length > 0,
        committedBlockId: pickCommittedBlock(taskBlocks, now),
        unverified,
      });
    }
    const rank: Record<TaskStatus, number> = { ongoing: 0, scheduled: 1, prioritized: 2, available: 3, blocked: 4, done: 5 };
    return items.sort((a, b) => rank[a.status] - rank[b.status] || (a.task.title < b.task.title ? -1 : 1));
  }, [ctx, entryRows, blockRows, now]);
}

export interface TimeBlockOption {
  id: string;
  title: string;
  startsAt: Instant;
  endsAt: Instant;
}

/** Committed blocks bucketed to the current day — options for the "which block?" picker (Phase 3). */
export function useTimeBlocksForDay(now: Instant): TimeBlockOption[] {
  const { factContext: ctx, rows } = usePrismsData();
  const blockRows = useMemo(() => rows.schedule_blocks.filter((r) => r['status'] === 'committed'), [rows.schedule_blocks]);
  return useMemo(() => {
    const today = bucketDate(now, ctx.dayResetHour, ctx.timezone);
    return blockRows
      .map(toScheduleBlock)
      .filter((b) => bucketDate(isoToEpochMillis(b.starts_at), ctx.dayResetHour, ctx.timezone) === today)
      .map((b) => ({
        id: b.id,
        title: ctx.tree.byId.get(b.task_id)?.title ?? 'Block',
        startsAt: isoToEpochMillis(b.starts_at),
        endsAt: isoToEpochMillis(b.ends_at),
      }))
      .sort((a, b) => a.startsAt - b.startsAt);
  }, [blockRows, ctx, now]);
}

/** The worklist grouped by scheduled vs unscheduled (Phase 4a). */
export function useGroupedWorklist(now: Instant): WorklistGroup[] {
  const items = useWorklist(now);
  return useMemo(() => groupWorklistBySchedule(items), [items]);
}

export interface BlockedTask {
  task: Node;
  /** Labels of blocker rules that evaluated `true` — why it is blocked. */
  blockedBy: string[];
  /** Labels of in-scope rules that evaluated `unknown` (weather unverified, §10.3). */
  unverified: string[];
}

/**
 * Blocked tasks (§8, §10.3) — kept OUT of `useWorklist` (which only lists
 * actionable items) so the UI can surface them separately with a `force`
 * clock-in affordance. Forcing a clock-in opens a time entry, which makes the
 * task `ongoing` (ongoing wins precedence over blocked), so it then leaves this
 * list and appears as the running timer.
 */
export function useBlockedTasks(now: Instant): BlockedTask[] {
  const ctx = useFactContext();
  return useMemo(() => {
    const out: BlockedTask[] = [];
    for (const node of ctx.tree.byId.values()) {
      if (node.node_type !== 'task' || node.completed_at !== null) continue;
      if (taskStatus(node, ctx, now) !== 'blocked') continue;
      const ev = evaluateBlockerRules(node, ctx, now);
      out.push({ task: node, blockedBy: ev.blockedBy.map((r) => r.label), unverified: ev.unverified.map((r) => r.label) });
    }
    return out.sort((a, b) => (a.task.title < b.task.title ? -1 : a.task.title > b.task.title ? 1 : a.task.id < b.task.id ? -1 : 1));
  }, [ctx, now]);
}

/**
 * A task's checklist steps (W3/D4), ordered by sort_order then id. Screen-local
 * overlay-merged read: `mergeTable` appends optimistic inserts regardless of the
 * SQL filter, so re-filter by task_id + live here (the journal precedent).
 */
export function useTaskSteps(taskId: string): TaskStep[] {
  const rows = useRows('SELECT * FROM task_steps WHERE task_id = ? AND deleted_at IS NULL', [taskId]);
  return useMemo(
    () =>
      rows
        .map(toTaskStep)
        .filter((s) => s.task_id === taskId && s.deleted_at === null)
        .sort((a, b) => (a.sort_order < b.sort_order ? -1 : a.sort_order > b.sort_order ? 1 : a.id < b.id ? -1 : 1)),
    [rows, taskId],
  );
}

export interface ProjectTasksGroup {
  project: Node;
  tasks: { task: Node; status: TaskStatus; blockedBy: string[] }[];
}

/**
 * All non-done tasks grouped by their ancestor PROJECT (W4/D6 "By project"): the
 * Tasks view mirrors the tree, so a task under a milestone rolls up to its
 * project. Habit-parentless tasks (no project) are omitted here — they surface in
 * the By-status view. Groups + tasks are in tree (sort_order) order.
 */
export function useTasksByProject(now: Instant): ProjectTasksGroup[] {
  const ctx = useFactContext();
  return useMemo(() => {
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const byProject = new Map<string, { task: Node; status: TaskStatus; blockedBy: string[] }[]>();
    for (const node of ctx.tree.byId.values()) {
      if (node.node_type !== 'task' || node.deleted_at !== null || node.completed_at !== null) continue;
      const project = ancestorsOf(ctx.tree, node.id).find((a) => a.node_type === 'project');
      if (!project) continue;
      const status = taskStatus(node, ctx, now);
      const blockedBy = status === 'blocked' ? evaluateBlockerRules(node, ctx, now).blockedBy.map((r) => r.label) : [];
      const list = byProject.get(project.id) ?? [];
      list.push({ task: node, status, blockedBy });
      byProject.set(project.id, list);
    }
    const projects = [...ctx.tree.byId.values()].filter((n) => n.node_type === 'project' && byProject.has(n.id));
    projects.sort((a, b) => cmp(a.sort_order, b.sort_order) || cmp(a.id, b.id));
    return projects.map((project) => ({
      project,
      tasks: byProject.get(project.id)!.sort((x, y) => cmp(x.task.sort_order, y.task.sort_order) || cmp(x.task.id, y.task.id)),
    }));
  }, [ctx, now]);
}

/**
 * All live task_steps grouped by task_id (W4) — ONE overlay-merged subscription
 * for the whole Tasks view, so each task row reads its steps (count + list) from
 * the map without a per-row watch. Steps within a task are in sort_order.
 */
export function useTaskStepsByTask(): Map<string, TaskStep[]> {
  const rows = useRows('SELECT * FROM task_steps WHERE deleted_at IS NULL');
  return useMemo(() => {
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const m = new Map<string, TaskStep[]>();
    for (const r of rows) {
      const s = toTaskStep(r);
      if (s.deleted_at !== null) continue; // an overlay delete drops the row
      const list = m.get(s.task_id) ?? [];
      list.push(s);
      m.set(s.task_id, list);
    }
    for (const list of m.values()) list.sort((a, b) => cmp(a.sort_order, b.sort_order) || cmp(a.id, b.id));
    return m;
  }, [rows]);
}

export interface HabitTasksView {
  habit: Habit;
  /** The habit's actionable (not done/blocked) recurring task instances. */
  tasks: WorklistItem[];
}

/** Each habit's recurring task instances (nodes.habit_id) as actionable items (Phase 4a). */
export function useHabitTasks(now: Instant): HabitTasksView[] {
  const items = useWorklist(now);
  const habitRows = useRows(Q_HABITS);
  return useMemo(() => {
    const byHabit = new Map<string, WorklistItem[]>();
    for (const item of items) {
      if (item.task.habit_id === null) continue;
      const list = byHabit.get(item.task.habit_id);
      if (list) list.push(item);
      else byHabit.set(item.task.habit_id, [item]);
    }
    return habitRows
      .map(toHabit)
      .map((habit) => ({ habit, tasks: byHabit.get(habit.id) ?? [] }))
      .filter((v) => v.tasks.length > 0)
      .sort((a, b) => (a.habit.title < b.habit.title ? -1 : a.habit.title > b.habit.title ? 1 : 0));
  }, [items, habitRows]);
}

export interface RunningTimer {
  entry: TimeEntry;
  /** The task being timed (undefined only on a transiently inconsistent set). */
  task: Node | undefined;
  /** Live elapsed milliseconds since clock-in. */
  elapsedMs: number;
}

/**
 * The single global running timer (I5). When two open entries exist transiently
 * (offline double clock-in, §7.4), the latest-started one is the live timer —
 * the same winner the server's merge keeps — so the UI never shows two.
 */
export function useRunningTimer(now: Instant): RunningTimer | null {
  const { rows, tree } = usePrismsData();
  const openRows = useMemo(() => rows.time_entries.filter((r) => r['ended_at'] == null), [rows.time_entries]);
  return useMemo(() => {
    const open = openRows.map(toTimeEntry);
    if (open.length === 0) return null;
    const winner = open.reduce((a, b) =>
      b.started_at > a.started_at || (b.started_at === a.started_at && b.id > a.id) ? b : a,
    );
    return {
      entry: winner,
      task: tree.byId.get(winner.task_id),
      elapsedMs: Math.max(0, now - isoToEpochMillis(winner.started_at)),
    };
  }, [openRows, tree, now]);
}

/** Activity inbox (§1.2): parentless `activity` items awaiting promotion. */
export function useActivityInbox(): Node[] {
  const { rows } = usePrismsData();
  return useMemo(
    () =>
      rows.nodes
        .map(toNode)
        // Filter the shared (unfiltered) node set down to live activities: an
        // optimistic activity.promote flips node_type 'activity'→'task' in the
        // overlay, so re-apply the predicate on the MERGED row here.
        .filter((n) => n.node_type === 'activity' && n.deleted_at === null)
        .sort((a, b) => (a.sort_order < b.sort_order ? -1 : a.sort_order > b.sort_order ? 1 : a.id < b.id ? -1 : 1)),
    [rows.nodes],
  );
}

export interface PromoteTarget {
  id: string;
  title: string;
  type: 'project' | 'milestone';
}

/** Valid parents for a promoted activity (I1: a task's parent is a project or milestone). */
export function usePromoteTargets(): PromoteTarget[] {
  const tree = useNodeTree();
  return useMemo(() => {
    const out: PromoteTarget[] = [];
    for (const n of tree.byId.values()) {
      if (n.node_type === 'project' || n.node_type === 'milestone') out.push({ id: n.id, title: n.title, type: n.node_type });
    }
    return out.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : a.id < b.id ? -1 : 1));
  }, [tree]);
}

/** Minutes left until the next day-reset (§7.2), using the user's settings. */
export function useDayTimeLeft(now: Instant): number {
  const ctx = useFactContext();
  return useMemo(() => minutesLeftInDay(now, { day_reset_hour: ctx.dayResetHour, timezone: ctx.timezone }), [ctx, now]);
}

/** Minutes until the next committed block starts (§7.2 time-left trio); null when none ahead. */
export function useNextBlockMinutes(now: Instant, taskId?: string): number | null {
  const { rows } = usePrismsData();
  return useMemo(() => minutesUntilNextBlock(rows.schedule_blocks.map(toScheduleBlock), now, taskId), [rows.schedule_blocks, now, taskId]);
}

export interface AgendaBlock {
  id: string;
  taskId: string;
  title: string;
  startsAt: Instant;
  endsAt: Instant;
  status: 'committed' | 'suggested';
  /** anchor_type != 'none' (I7): immovable, shows a lock glyph. */
  anchored: boolean;
  /** §12.2: ancestry reaches no vision/habit → render dark grey. */
  justified: boolean;
  suggestionReason: string | null;
  /** §7.5: a newer batch superseded this suggestion — stale, reflected in the UI. */
  superseded: boolean;
  /** §7.8 provenance for the "why is this here?" affordance (scheduler/user/…). */
  provenance: ProvenanceFields;
}

export interface AgendaEntry {
  id: string;
  taskId: string;
  title: string;
  startsAt: Instant;
  endsAt: Instant;
}

export interface TodoTask {
  task: Node;
  schedulable: SchedulableTask;
}

export interface AgendaTask extends TodoTask {
  /** False when the task carries no estimate of its own — `schedulable.estimateMinutes` is then `DEFAULT_DRAG_MINUTES`. */
  estimated: boolean;
  /** A committed block already exists for it. */
  scheduled: boolean;
  /**
   * `activity` = captured into the Inbox and not yet promoted (§1.2): no parent,
   * so no vision. It is still listed and still schedulable — a block on one is
   * accepted and simply renders unjustified (the agenda's grey "No vision"
   * state) until it is promoted under a project.
   */
  kind: 'task' | 'activity';
}

export interface Agenda {
  /** SchedulerInput (greedy) for `validWindowsFor` drag hints (§10). */
  input: SchedulerInput;
  tasksById: ReadonlyMap<string, SchedulableTask>;
  /** Committed + suggested blocks to render in the calendar. */
  blocks: AgendaBlock[];
  /** Past `time_entries` as the historical event layer (§12.2). */
  entries: AgendaEntry[];
  /**
   * Tasks not yet placed — the to-do side panel. Includes tasks with no estimate
   * of their own (they carry `DEFAULT_DRAG_MINUTES`); requiring an estimate hid
   * every task the web app itself creates.
   */
  todo: AgendaTask[];
  /**
   * EVERY live, not-done task AND Inbox activity — the Agenda's "All tasks"
   * list. Unlike `todo` this keeps already-scheduled ones. Anything with no
   * estimate carries `DEFAULT_DRAG_MINUTES` so it is still draggable onto the
   * week; the drop creates a block of that length.
   */
  allTasks: AgendaTask[];
}

/** Assumed block length when dragging a task that has no estimate of its own. */
export const DEFAULT_DRAG_MINUTES = 30;

/**
 * Agenda data (§12.2, §10 client mode): mirrors the server's scheduler-context
 * loader on the client so drag-to-agenda window hints, suggestions, the grey
 * (unjustified) rule, and the time-entry history layer all work offline.
 */
export function useAgenda(now: Instant, horizonDays = 7): Agenda {
  const { factContext: ctx, rows } = usePrismsData();
  const edgeRows = rows.edges;
  const blockRows = rows.schedule_blocks;
  const entryRows = rows.time_entries;
  const sprintRows = rows.sprints;
  const membershipRows = rows.sprint_memberships;

  return useMemo(() => {
    const tree = ctx.tree;
    const today = ctx.today(now);

    const activeSprintIds = new Set(
      sprintRows.map(toSprint).filter((s) => s.starts_on <= today && today <= s.ends_on).map((s) => s.id),
    );
    const sprintMemberNodeIds = new Set<string>();
    for (const m of membershipRows.map(toMembership)) if (activeSprintIds.has(m.sprint_id)) sprintMemberNodeIds.add(m.node_id);

    const depsBySuccessor = new Map<string, SchedulerDependency[]>();
    for (const e of edgeRows.map(toEdge)) {
      const list = depsBySuccessor.get(e.successor_id) ?? [];
      list.push({ predecessorId: e.predecessor_id, edgeType: e.edge_type, lagMinutes: e.lag_minutes });
      depsBySuccessor.set(e.successor_id, list);
    }

    const tasks: SchedulableTask[] = [];
    const tasksById = new Map<string, SchedulableTask>();
    for (const node of tree.byId.values()) {
      if (node.node_type !== 'task' || node.completed_at !== null) continue;
      if (node.estimate_minutes === null || node.estimate_minutes <= 0) continue;
      const t: SchedulableTask = {
        id: node.id,
        estimateMinutes: node.estimate_minutes,
        dueDate: node.due_date,
        dependencies: depsBySuccessor.get(node.id),
        sprintMember: sprintMemberNodeIds.has(node.id),
      };
      tasks.push(t);
      tasksById.set(node.id, t);
    }

    const blocksRaw = blockRows.map(toScheduleBlock);
    const committed: CommittedBlock[] = blocksRaw
      .filter((b) => b.status === 'committed')
      .map((b) => ({
        id: b.id,
        taskId: b.task_id,
        startsAt: isoToEpochMillis(b.starts_at),
        endsAt: isoToEpochMillis(b.ends_at),
        anchored: b.anchor_type !== 'none',
      }));

    const input: SchedulerInput = {
      tasks,
      committed,
      windows: DEFAULT_WINDOWS,
      timezone: ctx.timezone,
      horizon: { from: now, to: asEpochMillis(now + horizonDays * 86_400_000) },
      mode: 'greedy',
    };

    const blocks: AgendaBlock[] = blocksRaw.map((b) => ({
      id: b.id,
      taskId: b.task_id,
      title: tree.byId.get(b.task_id)?.title ?? 'Task',
      startsAt: isoToEpochMillis(b.starts_at),
      endsAt: isoToEpochMillis(b.ends_at),
      status: b.status,
      anchored: b.anchor_type !== 'none',
      justified: isJustified(tree, b.task_id),
      suggestionReason: b.suggestion_reason,
      superseded: b.superseded_at !== null,
      provenance: {
        source_kind: b.source_kind,
        source_id: b.source_id,
        source_detail: b.source_detail,
        created_by_command_id: b.created_by_command_id,
        last_modified_by_command_id: b.last_modified_by_command_id,
      },
    }));

    const entries: AgendaEntry[] = entryRows
      .map(toTimeEntry)
      .filter((e) => e.ended_at !== null)
      .map((e) => ({
        id: e.id,
        taskId: e.task_id,
        title: tree.byId.get(e.task_id)?.title ?? 'Task',
        startsAt: isoToEpochMillis(e.started_at),
        endsAt: isoToEpochMillis(e.ended_at as string),
      }));

    const scheduledTaskIds = new Set(committed.map((b) => b.taskId));

    // The full list. Two things `tasks` above deliberately excludes have to come
    // back here, because both are things the user thinks of as "my tasks":
    //  - anything without a positive estimate (it gets DEFAULT_DRAG_MINUTES), and
    //  - `activity` nodes — the Inbox. The web app's capture bar creates ONLY
    //    those, so a tree walk restricted to node_type='task' showed a user none
    //    of what they had just typed in.
    // `tasks`/`input` stay tasks-only: that is the SCHEDULER's view, and an
    // unpromoted activity has no justification to schedule against.
    const allTasks: AgendaTask[] = [];
    for (const node of tree.byId.values()) {
      const kind = node.node_type === 'task' ? 'task' : node.node_type === 'activity' ? 'activity' : null;
      if (kind === null || node.completed_at !== null) continue;
      const existing = tasksById.get(node.id);
      const own = node.estimate_minutes !== null && node.estimate_minutes > 0 ? node.estimate_minutes : null;
      allTasks.push({
        task: node,
        schedulable: existing ?? {
          id: node.id,
          estimateMinutes: own ?? DEFAULT_DRAG_MINUTES,
          dueDate: node.due_date,
          dependencies: depsBySuccessor.get(node.id),
          sprintMember: sprintMemberNodeIds.has(node.id),
        },
        estimated: existing !== undefined || own !== null,
        scheduled: scheduledTaskIds.has(node.id),
        kind,
      });
    }
    allTasks.sort((a, b) => (a.task.title < b.task.title ? -1 : a.task.title > b.task.title ? 1 : 0));

    // The to-schedule panel: every task not already placed. An estimate is NOT
    // required to appear here. It used to be, and that silently emptied the panel
    // the whole Agenda is built around: the app's own capture path
    // (`activity.create` → `activity.promote`) never sets one, so every task a
    // user made in the web UI was missing from it. Those get DEFAULT_DRAG_MINUTES.
    const todo: AgendaTask[] = allTasks.filter((t) => !t.scheduled);

    return { input, tasksById, blocks, entries, todo, allTasks };
  }, [ctx, edgeRows, blockRows, entryRows, sprintRows, membershipRows, now, horizonDays]);
}

export interface HabitView {
  habit: Habit;
  streak: StreakValue;
  /** Practice hours + level (skills); zero for plain habits. */
  practice: PracticeValue;
  /** Minutes toward today's daily target — INCLUDING the live running timer. */
  todayMinutes: number;
  dailyTargetMinutes: number | null;
  /** 0..1 (capped at 1) when a daily target is set; null otherwise. */
  ringFill: number | null;
  /** A completion exists for today's bucket. */
  doneToday: boolean;
  /** Live yes/no/pending tally across this habit's confirmable-tag placements (Phase 4b). */
  tagConfirmation: { yes: number; no: number; pending: number };
  /** computed_at of the latest server aggregate for this habit (freshness label). */
  serverComputedAt: string | null;
}

/**
 * Habits/skills (§1.2, §7.2): streaks, practice hours + levels, and the daily-
 * target ring — all computed live in core from local facts, with the running
 * timer folded into today's minutes so the ring fills during a clock-in. The
 * server aggregate's `computed_at` is surfaced for the freshness label.
 */
export function useHabits(now: Instant): HabitView[] {
  const { factContext: ctx, rows } = usePrismsData();
  const habitRows = useRows(Q_HABITS);
  const completionRows = useRows('SELECT * FROM habit_completions WHERE deleted_at IS NULL');
  const entryRows = rows.time_entries;
  const blockRows = rows.schedule_blocks;
  const tagRows = useRows('SELECT * FROM tags WHERE deleted_at IS NULL');
  const placementRows = useRows('SELECT * FROM tag_placements WHERE deleted_at IS NULL');
  const answerRows = useRows('SELECT * FROM tag_answers WHERE deleted_at IS NULL');
  const aggRows = useRows("SELECT * FROM computed_aggregates WHERE deleted_at IS NULL AND subject_kind = 'habit'");

  return useMemo(() => {
    const nodes = [...ctx.tree.byId.values()];
    const entries = entryRows.map(toTimeEntry);
    const completions = completionRows.map(toHabitCompletion);
    const blocks = blockRows.map(toScheduleBlock);
    const tags = tagRows.map(toTag);
    const placements = placementRows.map(toTagPlacement);
    const answers = answerRows.map(toTagAnswer);
    const liveAnswer = new Map(answers.filter((a) => a.deleted_at === null).map((a) => [a.placement_id, a.value] as const));
    const settings = { day_reset_hour: ctx.dayResetHour, timezone: ctx.timezone };
    const today = ctx.today(now);

    const serverAt = new Map<string, string>();
    for (const a of aggRows.map(toComputedAggregate)) {
      if (a.subject_id === null || a.computed_by !== 'server') continue;
      const prev = serverAt.get(a.subject_id);
      if (prev === undefined || a.computed_at > prev) serverAt.set(a.subject_id, a.computed_at);
    }

    const views: HabitView[] = [];
    for (const habit of habitRows.map(toHabit)) {
      const taskIds = habitTaskIds(habit, nodes);
      const streak = canonicalStreak(
        { habit, completions, nodes, schedule_blocks: blocks, time_entries: entries, tags, tag_placements: placements, tag_answers: answers, settings },
        now,
      );
      const practice = canonicalPractice(habit, nodes, entries);

      // Closed entries union PER TASK (§9.2 — two overlapping offline sessions
      // count once, audit S3-F2); the running entry adds live elapsed on top.
      const todayMinutes = habitTodayMinutes(entries, taskIds, today, settings.day_reset_hour, settings.timezone, now);

      // live tag-confirmation tally across this habit's habit-scoped placements
      const habitTagIds = new Set(tags.filter((t) => t.deleted_at === null && t.habit_id === habit.id).map((t) => t.id));
      const tc = { yes: 0, no: 0, pending: 0 };
      for (const pl of placements) {
        if (pl.deleted_at !== null || !habitTagIds.has(pl.tag_id)) continue;
        const a = liveAnswer.get(pl.id);
        if (a === 'yes') tc.yes += 1;
        else if (a === 'no') tc.no += 1;
        else tc.pending += 1;
      }

      const target = habit.daily_target_minutes;
      views.push({
        habit,
        streak,
        practice,
        todayMinutes,
        dailyTargetMinutes: target,
        ringFill: target && target > 0 ? Math.min(1, todayMinutes / target) : null,
        doneToday: completions.some((c) => c.habit_id === habit.id && c.occurrence_date === today),
        tagConfirmation: tc,
        serverComputedAt: serverAt.get(habit.id) ?? null,
      });
    }
    return views.sort((a, b) => (a.habit.title < b.habit.title ? -1 : a.habit.title > b.habit.title ? 1 : 0));
  }, [ctx, habitRows, completionRows, entryRows, blockRows, tagRows, placementRows, answerRows, aggRows, now]);
}

export interface KanbanColumn {
  key: string;
  label: string;
  /** The due date this column writes on drop; null = the no-date backlog. */
  date: IsoDate | null;
  cards: Node[];
}

/**
 * Kanban by date (§1.2): non-done tasks grouped into a backlog (no due date)
 * plus `dayCount` day columns from today. Tasks due before the window land in
 * the first day column, after it in the last — so every card stays draggable.
 * `projectId` (W5 scope picker) narrows to tasks under one project; null = all.
 */
export function useKanban(now: Instant, projectId?: string | null, dayCount = 5): KanbanColumn[] {
  const ctx = useFactContext();
  return useMemo(() => {
    const today = ctx.today(now);
    const dates = Array.from({ length: dayCount }, (_, i) => addDays(today, i));
    const columns: KanbanColumn[] = [
      { key: 'backlog', label: 'No date', date: null, cards: [] },
      ...dates.map((d, i) => ({ key: d, label: i === 0 ? `Today · ${d.slice(5)}` : d.slice(5), date: d, cards: [] as Node[] })),
    ];
    const dayCols = columns.slice(1);
    for (const node of ctx.tree.byId.values()) {
      if (node.node_type !== 'task' || node.completed_at !== null) continue;
      if (projectId && ancestorsOf(ctx.tree, node.id).find((a) => a.node_type === 'project')?.id !== projectId) continue;
      if (node.due_date === null) {
        columns[0]!.cards.push(node);
        continue;
      }
      let target = dayCols.find((c) => c.date === node.due_date);
      if (!target) target = node.due_date < dates[0]! ? dayCols[0]! : dayCols[dayCols.length - 1]!;
      target.cards.push(node);
    }
    for (const col of columns) {
      col.cards.sort((a, b) => (a.sort_order < b.sort_order ? -1 : a.sort_order > b.sort_order ? 1 : a.id < b.id ? -1 : 1));
    }
    return columns;
  }, [ctx, now, projectId, dayCount]);
}

export interface DecisionBoardView {
  board: DecisionBoard;
  criteria: DecisionCriterion[];
  /** All scoreable projects (rows of the grid). */
  projects: Node[];
  /** key `${criterionId}:${projectId}` → the score row's id + value. */
  scores: ReadonlyMap<string, { id: string; score: number }>;
  /** Live weighted ranking, highest priority first (§6.0). */
  ranking: { project: Node; priority: number }[];
}

/** Decision boards with their criteria, score grid, and live ranking (§6.0). */
export function useDecisionBoards(): DecisionBoardView[] {
  const tree = useNodeTree();
  const boardRows = useRows(Q_DECISION_BOARDS);
  const criterionRows = useRows('SELECT * FROM decision_criteria WHERE deleted_at IS NULL');
  const scoreRows = useRows('SELECT * FROM decision_scores WHERE deleted_at IS NULL');

  return useMemo(() => {
    const projects = [...tree.byId.values()]
      .filter((n) => n.node_type === 'project')
      .sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : a.id < b.id ? -1 : 1));
    const projectIds = projects.map((p) => p.id);
    const projectById = new Map(projects.map((p) => [p.id, p]));
    const allCriteria = criterionRows.map(toDecisionCriterion);
    const allScores = scoreRows.map(toDecisionScore);

    return boardRows
      .map(toDecisionBoard)
      .map((board) => {
        const criteria = allCriteria
          .filter((c) => c.board_id === board.id)
          .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1));
        const critIds = new Set(criteria.map((c) => c.id));
        const scores = allScores.filter((s) => critIds.has(s.criterion_id));
        const scoreMap = new Map<string, { id: string; score: number }>();
        for (const s of scores) scoreMap.set(`${s.criterion_id}:${s.project_id}`, { id: s.id, score: s.score });
        const ranking = rankProjects(criteria, scores, projectIds)
          .map((r) => ({ project: projectById.get(r.projectId) as Node, priority: r.priority }))
          .filter((r) => r.project !== undefined);
        return { board, criteria, projects, scores: scoreMap, ranking };
      })
      .sort((a, b) => (a.board.created_at < b.board.created_at ? -1 : a.board.created_at > b.board.created_at ? 1 : 0));
  }, [tree, boardRows, criterionRows, scoreRows]);
}

/**
 * Parent-project priority for My Day ordering (W2/D5). Uses the FIRST decision
 * board (earliest created — useDecisionBoards sorts boards by created_at) as the
 * canonical priority source; its live weighted ranking maps each project →
 * {priority, rank} (rank 1 = highest). Empty when there is no board. A weight or
 * score edit reorders it (and My Day) instantly and offline.
 */
export function useProjectPriorities(): Map<string, { priority: number; rank: number }> {
  const boards = useDecisionBoards();
  return useMemo(() => {
    const map = new Map<string, { priority: number; rank: number }>();
    const board = boards[0];
    if (!board) return map;
    board.ranking.forEach((r, i) => map.set(r.project.id, { priority: r.priority, rank: i + 1 }));
    return map;
  }, [boards]);
}

export interface MyDayItem extends WorklistItem {
  projectId: string | null;
  projectTitle: string | null;
  /** Parent-project priority from the decision board, or null when unscored. */
  priority: number | null;
}

/**
 * The My Day "Available now" list (W2/D5): the actionable worklist enriched with
 * each task's parent project + its decision-board priority, sorted by priority
 * DESC, tie-broken by due date (earliest first, undated last) then sort_order.
 */
export function useMyDayAvailable(now: Instant): MyDayItem[] {
  const items = useWorklist(now);
  const ctx = useFactContext();
  const priorities = useProjectPriorities();
  return useMemo(() => {
    const enriched: MyDayItem[] = items.map((it) => {
      const project = ancestorsOf(ctx.tree, it.task.id).find((a) => a.node_type === 'project') ?? null;
      const p = project ? priorities.get(project.id) : undefined;
      return { ...it, projectId: project?.id ?? null, projectTitle: project?.title ?? null, priority: p?.priority ?? null };
    });
    return enriched.sort((a, b) => {
      const pa = a.priority ?? -Infinity;
      const pb = b.priority ?? -Infinity;
      if (pb !== pa) return pb - pa;
      const da = a.task.due_date ?? '~'; // '~' > any ISO date → undated sorts last
      const db = b.task.due_date ?? '~';
      if (da !== db) return da < db ? -1 : 1;
      return a.task.sort_order < b.task.sort_order ? -1 : a.task.sort_order > b.task.sort_order ? 1 : 0;
    });
  }, [items, ctx, priorities]);
}

export interface DoneTodayItem {
  task: Node;
  /** Minutes logged against the task from time entries (merged, §7.10b). */
  consumedMinutes: number;
}

/**
 * Tasks completed since the day-reset (W2/D5 "Done today"), most-recent first,
 * each with the minutes logged against it. Done tasks are excluded from the
 * worklist, so this is a separate read; it also drives the "Done N" header chip.
 */
export function useDoneToday(now: Instant): DoneTodayItem[] {
  const { factContext: ctx, rows } = usePrismsData();
  const entryRows = rows.time_entries;
  return useMemo(() => {
    const entries = entryRows.map(toTimeEntry);
    const today = ctx.today(now);
    const out: DoneTodayItem[] = [];
    for (const node of ctx.tree.byId.values()) {
      if (node.node_type !== 'task' || node.completed_at === null) continue;
      if (bucketDate(isoToEpochMillis(node.completed_at), ctx.dayResetHour, ctx.timezone) !== today) continue;
      out.push({ task: node, consumedMinutes: canonicalProgress(node, entries).consumedMinutes });
    }
    return out.sort((a, b) => {
      const ca = a.task.completed_at ?? '';
      const cb = b.task.completed_at ?? '';
      return cb < ca ? -1 : cb > ca ? 1 : 0; // most-recent completion first
    });
  }, [ctx, entryRows, now]);
}

export interface TodayItinerary {
  /** The day bucket being shown (day-reset aware, not civil midnight). */
  today: IsoDate;
  rows: ItineraryRow[];
  /**
   * The same day as percentages, for the 24 h bar (T2) and the swipe-out
   * calendar (T3). Built here rather than in a second hook so both surfaces
   * share one agenda read and one pass over the tree — and so a block cannot
   * possibly be in one and missing from the other.
   */
  dayMap: DayMap;
  /** Minutes logged per task today. */
  loggedMinutes: ReadonlyMap<string, number>;
  /** The task the single global timer is on (I5), or null. */
  runningTaskId: string | null;
}

/**
 * The mobile Today itinerary (MOBILE_TODAY_PLAN T1): today's committed blocks
 * resolved into rows carrying state, project tone and durations.
 *
 * Pass a COARSE `now` (the Today screen ticks this once a minute). The elapsed
 * time on the live row ticks every second in a leaf component instead —
 * threading a 1 s clock through here would recompute the whole agenda, the
 * ancestry walk and the entry sums every second, for one label.
 */
export function useTodayItinerary(now: Instant): TodayItinerary {
  const { factContext: ctx } = usePrismsData();
  const agenda = useAgenda(now);
  const running = useRunningTimer(now);
  const runningTaskId = running?.entry.task_id ?? null;

  return useMemo(() => {
    const today = ctx.today(now);
    const logged = loggedMinutesByTask(agenda.entries, { today, timezone: ctx.timezone, dayResetHour: ctx.dayResetHour });

    const projectIdByTask = new Map<string, string | null>();
    const estimateMinutesByTask = new Map<string, number>();
    const doneTaskIds = new Set<string>();
    const habitTaskIds = new Set<string>();
    for (const b of agenda.blocks) {
      if (projectIdByTask.has(b.taskId)) continue;
      const node = ctx.tree.byId.get(b.taskId);
      const project = ancestorsOf(ctx.tree, b.taskId).find((a) => a.node_type === 'project');
      projectIdByTask.set(b.taskId, project?.id ?? null);
      if (node?.completed_at != null) doneTaskIds.add(b.taskId);
      // Read from the node, not from `useHabitTasks`: that hook keeps only
      // actionable items, so a checked-off habit row would lose its chip.
      if (node?.habit_id != null) habitTaskIds.add(b.taskId);
      // A completed task is absent from `tasksById` (useAgenda only keeps live,
      // estimated ones), so fall back to the node's own estimate.
      const estimate = agenda.tasksById.get(b.taskId)?.estimateMinutes ?? node?.estimate_minutes ?? null;
      if (estimate !== null && estimate > 0) estimateMinutesByTask.set(b.taskId, estimate);
    }

    const rows = buildItinerary({
      blocks: agenda.blocks,
      logged,
      estimateMinutesByTask,
      projectIdByTask,
      doneTaskIds,
      habitTaskIds,
      runningTaskId,
      today,
      timezone: ctx.timezone,
      dayResetHour: ctx.dayResetHour,
    });

    // D4: active hours ARE the scheduler windows, so the greyed zones come from
    // the account's own window config — no second setting to keep in sync.
    const dayStart = localInstant(today, 0, ctx.timezone);
    const dayMap = buildDayMap({
      blocks: blocksForDay(agenda.blocks, { today, timezone: ctx.timezone, dayResetHour: ctx.dayResetHour }),
      loggedMinutesByTask: logged,
      projectIdByTask,
      windows: expandWindows(agenda.input.windows, ctx.timezone, { from: dayStart, to: localInstant(today, 24, ctx.timezone) }),
      runningTaskId,
      doneTaskIds,
      now,
      today,
      timezone: ctx.timezone,
    });

    return { today, rows, dayMap, loggedMinutes: logged, runningTaskId };
  }, [ctx, agenda, runningTaskId, now]);
}

export interface ProjectCompletion {
  project: Node;
  value: CompletionValue;
}

export interface DashboardData {
  /** Trailing-window burndown (remaining vs scheduled) + projection (§7.2). */
  burndown: BurndownValue;
  /** computed_at of the server projection/burndown aggregate, or null (live). */
  projectionComputedAt: string | null;
  /** Per-project completion bars, most complete first. */
  completion: ProjectCompletion[];
}

/**
 * Dashboard data (§1.2): a user-wide burndown + projection (with the server
 * aggregate's freshness), and per-project completion — all from local facts so
 * the dashboard renders fully offline.
 */
export function useDashboard(now: Instant, days = 14): DashboardData {
  const { factContext: ctx, rows } = usePrismsData();
  // include soft-deleted tasks so the burndown scope-out (a deleted task
  // leaving the series) is reflected — the shared `nodes` set is unfiltered.
  const taskRows = useMemo(() => rows.nodes.filter((r) => r['node_type'] === 'task'), [rows.nodes]);
  const blockRows = rows.schedule_blocks;
  const aggRows = useRows("SELECT * FROM computed_aggregates WHERE deleted_at IS NULL AND subject_kind = 'user'");

  return useMemo(() => {
    const settings = { day_reset_hour: ctx.dayResetHour, timezone: ctx.timezone };
    const today = ctx.today(now);
    const burndown = canonicalBurndown({
      tasks: taskRows.map(toNode),
      schedule_blocks: blockRows.map(toScheduleBlock),
      settings,
      range: { from: addDays(today, -(days - 1)), to: today },
    });

    let projectionComputedAt: string | null = null;
    for (const a of aggRows.map(toComputedAggregate)) {
      if (a.computed_by !== 'server') continue;
      if (a.metric !== 'projection' && a.metric !== 'burndown_series') continue;
      if (projectionComputedAt === null || a.computed_at > projectionComputedAt) projectionComputedAt = a.computed_at;
    }

    const completion: ProjectCompletion[] = [...ctx.tree.byId.values()]
      .filter((n) => n.node_type === 'project')
      .map((project) => ({ project, value: canonicalCompletion(project.id, ctx.tree) }))
      .sort((a, b) => b.value.percent - a.value.percent || (a.project.title < b.project.title ? -1 : 1));

    return { burndown, projectionComputedAt, completion };
  }, [ctx, taskRows, blockRows, aggRows, now, days]);
}

export interface FlowNode {
  id: string;
  title: string;
  nodeType: Node['node_type'];
  x: number;
  y: number;
  /** The diagram_layouts row id, when a saved position exists (for upsert). */
  layoutId?: string;
  collapsed: boolean;
  groupId: string | null;
  dueDate: string | null;
}

export interface FlowEdge {
  id: string;
  predecessorId: string;
  successorId: string;
  edgeType: string;
}

export interface FlowchartView {
  /** Children of the diagram root, positioned (saved layout → fallback layered). */
  nodes: FlowNode[];
  /** Dependency edges whose both endpoints are in the node set. */
  edges: FlowEdge[];
  groups: DiagramGroup[];
  /** Full tree + edge index for local validateEdge (cycle/type checks). */
  tree: TreeIndex;
  edgeIndex: EdgeIndex;
}

const COL_W = 220;
const ROW_H = 110;

/**
 * Flowchart view-model (§12.1–12.2): the diagram root's children as cards plus
 * the dependency edges among them. Positions come from saved `diagram_layouts`
 * (a user drag) or a deterministic layered fallback (topological rank → x,
 * order-in-rank → y); "dates" mode overrides x by due-date. Pure selector over
 * local rows, so it renders + validates offline.
 */
export function useFlowchart(diagramId: string | null, mode: 'dates' | 'nodates' = 'nodates'): FlowchartView {
  const { tree, rows } = usePrismsData();
  const edgeRows = rows.edges;
  const layoutRows = useRows('SELECT * FROM diagram_layouts WHERE deleted_at IS NULL');
  const groupRows = useRows('SELECT * FROM diagram_groups WHERE deleted_at IS NULL');

  return useMemo(() => {
    const allEdges = edgeRows.map(toEdge);
    const edgeIndex = buildEdgeIndex(allEdges);
    if (diagramId === null) return { nodes: [], edges: [], groups: [], tree, edgeIndex };

    const children = childrenOf(tree, diagramId);
    const childIds = new Set(children.map((c) => c.id));

    const savedByNode = new Map<string, ReturnType<typeof toDiagramLayout>>();
    for (const l of layoutRows.map(toDiagramLayout)) {
      if (l.diagram_id === diagramId) savedByNode.set(l.node_id, l);
    }

    // fallback layered layout: rank = longest in-set predecessor chain.
    const inSetEdges = allEdges.filter((e) => childIds.has(e.predecessor_id) && childIds.has(e.successor_id));
    const order = topologicalOrder(buildEdgeIndex(inSetEdges), childIds);
    const rank = new Map<string, number>();
    if (order.ok) {
      for (const id of order.value) {
        let r = 0;
        for (const e of inSetEdges) if (e.successor_id === id) r = Math.max(r, (rank.get(e.predecessor_id) ?? 0) + 1);
        rank.set(id, r);
      }
    }
    const seenInRank = new Map<number, number>();
    const minDue = children.reduce<string | null>((m, c) => (c.due_date && (m === null || c.due_date < m) ? c.due_date : m), null);

    const nodes: FlowNode[] = children.map((c, i) => {
      const saved = savedByNode.get(c.id);
      const r = rank.get(c.id) ?? 0;
      const rowInRank = seenInRank.get(r) ?? 0;
      seenInRank.set(r, rowInRank + 1);
      let x = r * COL_W;
      const y = saved ? saved.y : rowInRank * ROW_H + (r % 2) * 24;
      if (saved) {
        x = saved.x;
      } else if (mode === 'dates' && c.due_date && minDue) {
        x = Math.max(0, Math.round((Date.parse(c.due_date) - Date.parse(minDue)) / 86_400_000)) * 80;
      }
      return {
        id: c.id,
        title: c.title,
        nodeType: c.node_type,
        x,
        y: saved ? saved.y : i * 4 + y, // tiny per-index nudge keeps siblings distinct
        layoutId: saved?.id,
        collapsed: saved?.collapsed ?? false,
        groupId: saved?.group_id ?? null,
        dueDate: c.due_date,
      };
    });

    const edges: FlowEdge[] = inSetEdges.map((e) => ({ id: e.id, predecessorId: e.predecessor_id, successorId: e.successor_id, edgeType: e.edge_type }));
    const groups = groupRows.map(toDiagramGroup).filter((g) => g.diagram_id === diagramId);
    return { nodes, edges, groups, tree, edgeIndex };
  }, [tree, edgeRows, layoutRows, groupRows, diagramId, mode]);
}

export interface GanttBar {
  taskId: string;
  title: string;
  /** Day offsets from the chart's first day. */
  startDay: number;
  endDay: number;
  onCriticalPath: boolean;
}

export interface GanttView {
  bars: GanttBar[];
  edges: { predecessorId: string; successorId: string }[];
  /** First day of the chart (IsoDate) and total day span. */
  fromDate: IsoDate | null;
  days: number;
  criticalPathIds: string[];
}

/**
 * Gantt view-model (§12.2): one bar per descendant task (committed-block span,
 * else a due-date day), dependency edges, and the critical path (longest path
 * over estimates, from core). Day offsets are relative to the earliest dated
 * item so the screen can lay out a simple time axis.
 */
export function useGantt(projectId: string | null, now: Instant): GanttView {
  const { factContext: ctx, rows } = usePrismsData();
  const edgeRows = rows.edges;
  const blockRows = rows.schedule_blocks;

  return useMemo(() => {
    if (projectId === null) return { bars: [], edges: [], fromDate: null, days: 0, criticalPathIds: [] };
    const tz = ctx.timezone;
    const dr = ctx.dayResetHour;
    const tasks = descendantsOf(ctx.tree, projectId).filter((n) => n.node_type === 'task');
    const taskIds = new Set(tasks.map((t) => t.id));
    const allEdges = edgeRows.map(toEdge);

    // committed-block span per task
    const span = new Map<string, { start: IsoDate; end: IsoDate }>();
    for (const b of blockRows.map(toScheduleBlock)) {
      if (b.status !== 'committed' || !taskIds.has(b.task_id)) continue;
      const s = bucketDate(b.starts_at, dr, tz);
      const e = bucketDate(b.ends_at, dr, tz);
      const cur = span.get(b.task_id);
      span.set(b.task_id, { start: cur && cur.start < s ? cur.start : s, end: cur && cur.end > e ? cur.end : e });
    }

    const cp = criticalPath(tasks, allEdges.filter((e) => taskIds.has(e.predecessor_id) && taskIds.has(e.successor_id)));
    const criticalPathIds = cp.ok ? [...cp.value.nodeIds] : [];
    const cpSet = new Set(criticalPathIds);

    // pick each task's [start,end] dates: block span, else due_date (single day)
    const dated = tasks
      .map((t) => {
        const sp = span.get(t.id);
        if (sp) return { task: t, start: sp.start, end: sp.end };
        if (t.due_date) return { task: t, start: t.due_date, end: t.due_date };
        return null;
      })
      .filter((d): d is { task: Node; start: IsoDate; end: IsoDate } => d !== null);

    if (dated.length === 0) return { bars: [], edges: [], fromDate: null, days: 0, criticalPathIds };

    const today = ctx.today(now);
    let fromDate = today;
    let toDate = today;
    for (const d of dated) {
      if (d.start < fromDate) fromDate = d.start;
      if (d.end > toDate) toDate = d.end;
    }
    const dayOffset = (date: IsoDate): number => Math.round((Date.parse(date) - Date.parse(fromDate)) / 86_400_000);
    const days = dayOffset(toDate) + 1;

    const bars: GanttBar[] = dated
      .map((d) => ({
        taskId: d.task.id,
        title: d.task.title,
        startDay: dayOffset(d.start),
        endDay: dayOffset(d.end) + 1,
        onCriticalPath: cpSet.has(d.task.id),
      }))
      .sort((a, b) => a.startDay - b.startDay || (a.title < b.title ? -1 : 1));

    const edges = allEdges
      .filter((e) => taskIds.has(e.predecessor_id) && taskIds.has(e.successor_id))
      .map((e) => ({ predecessorId: e.predecessor_id, successorId: e.successor_id }));

    return { bars, edges, fromDate, days, criticalPathIds };
  }, [ctx, edgeRows, blockRows, projectId, now]);
}

/** Automation rules (§9) for the rule editor. */
export function useRules(): AutomationRule[] {
  const rows = useRows(Q_RULES);
  return useMemo(() => rows.map(toAutomationRule).sort((a, b) => (a.created_at < b.created_at ? -1 : 1)), [rows]);
}

/** Blocker rules (§9) for the blocker editor — served warm (§7.14). */
export function useBlockers(): BlockerRule[] {
  const { rows } = usePrismsData();
  return useMemo(() => rows.blocker_rules.map(toBlockerRule).sort((a, b) => (a.created_at < b.created_at ? -1 : 1)), [rows.blocker_rules]);
}

export interface AggregateRow {
  subjectKind: 'habit' | 'node' | 'user';
  subjectId: string | null;
  metric: string;
  value: unknown;
  computedAt: string;
  computedBy: 'client' | 'server';
}

export interface UserSettingsView {
  hasRow: boolean;
  dayResetHour: number;
  timezone: string;
  weatherLocation: unknown;
  /** Annex L built-in automation. Opt-OUT: no row (or no column) still means ON. */
  journalDayLog: boolean;
}

/** User settings row, with architecture defaults when a fresh account has not synced one yet. */
export function useUserSettings(): UserSettingsView {
  const { rows } = usePrismsData();
  return useMemo(() => {
    const row = rows.user_settings[0] ? toUserSettings(rows.user_settings[0]) : null;
    return {
      hasRow: row !== null,
      dayResetHour: row?.day_reset_hour ?? 4,
      timezone: row?.timezone ?? 'America/New_York',
      weatherLocation: row?.weather_location ?? null,
      journalDayLog: row?.journal_day_log ?? DEFAULT_JOURNAL_DAY_LOG,
    };
  }, [rows.user_settings]);
}

/**
 * The generated "Day log" for one journal day (Annex L), or null when the flag
 * is off or the day holds nothing. DERIVED at render from the warm provider —
 * there is no day-log table, no writer, and nothing to reconcile.
 *
 * Two properties come free from reading the provider's MERGED rows:
 * - offline-instant: a pending `node.check_off` has already patched the facts,
 *   so the footer updates in the same render pass with zero write code;
 * - every mutation path is covered by construction — a completion from the timer
 *   review path, an automation spawn, a restored import all change the same
 *   inputs, so there is no per-verb collector to keep in sync with the commands.
 *
 * Memoized on `[rows.schedule_blocks, ctx, date]` — NOT on `now`, so unlike
 * `useWorklist` it never recomputes on the 1-second tick.
 */
export function useDayLog(date: IsoDate): DayLogEntries | null {
  const { factContext: ctx, rows } = usePrismsData();
  const { journalDayLog } = useUserSettings();
  const blockRows = rows.schedule_blocks;
  return useMemo(() => {
    if (!journalDayLog) return null;
    return computeDayLog({
      date,
      nodes: ctx.tree.byId.values(), // live nodes only (tombstones excluded)
      blocks: blockRows.map(toScheduleBlock),
      dayResetHour: ctx.dayResetHour,
      timezone: ctx.timezone,
    });
  }, [ctx, blockRows, date, journalDayLog]);
}

/** Server-computed aggregates (burndown, streaks, …) with their freshness. */
export function useAggregates(): AggregateRow[] {
  const rows = useRows('SELECT * FROM computed_aggregates WHERE deleted_at IS NULL');
  return useMemo(
    () =>
      rows.map(toComputedAggregate).map((a) => ({
        subjectKind: a.subject_kind,
        subjectId: a.subject_id,
        metric: a.metric,
        value: a.value,
        computedAt: a.computed_at,
        computedBy: a.computed_by,
      })),
    [rows],
  );
}

/** Optimistic command writers bound to the live PowerSync database. */
export function useCommands(ctx: CommandContext) {
  const db = usePowerSync();
  // The two-layer overlay store over PowerSync's SQLite (execute/getAll/writeTransaction).
  return useMemo(() => createCommands(createSqlOverlayStore(db as unknown as SqlExecutor), ctx), [db, ctx]);
}

export interface ReviewItemView {
  id: string;
  itemType: string;
  severity: string;
  title: string;
  detail: string;
  status: string;
  commandId: string | null;
  createdAt: string;
}

/**
 * The conflict/rejection inbox (§7.13): open, server-synced `sync_review_items`,
 * newest first. The server (M5) and jobs (M6) create them — command rejections,
 * dependency rejections, HLC conflicts, stale suggestions, automation drift/
 * backstop, schema blocks, import/sync warnings — and they stream down here.
 *
 * Read BROADLY (no status filter) and re-apply `status='open'` on the MERGED row:
 * an optimistic review.resolve/dismiss (M10) flips status in the overlay, but
 * useRows evaluates the SQL predicate only against the replica — so a just-closed
 * item (and any server-side soft-deleted one) must be post-filtered out here.
 */
export function useReviewInbox(): ReviewItemView[] {
  const rows = useRows(Q_REVIEW);
  return useMemo(
    () =>
      rows
        .filter((r) => String(r['status'] ?? 'open') === 'open' && r['deleted_at'] == null)
        .map((r) => ({
          id: String(r['id']),
          itemType: String(r['item_type']),
          severity: String(r['severity'] ?? 'warning'),
          title: String(r['title'] ?? ''),
          detail: typeof r['detail'] === 'string' ? r['detail'] : JSON.stringify(r['detail'] ?? ''),
          status: String(r['status'] ?? 'open'),
          commandId: r['command_id'] == null ? null : String(r['command_id']),
          createdAt: String(r['created_at'] ?? ''),
        }))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1)),
    [rows],
  );
}

// --- tags (confirmable event tags) ----------------------------------------

/** A tag placed on a block plus its current answer (pending = no live answer). */
export interface BlockTagView {
  tag: Tag;
  /** The placement row id (to answer/unplace). */
  placementId: string;
  /** The live answer row id, or null when pending (to clear back to pending). */
  answerId: string | null;
  answer: TagAnswerValue | 'pending';
}

/** The reusable tag catalog for the picker (non-deleted, label-sorted). */
export function useTagCatalog(): Tag[] {
  const rows = useRows('SELECT * FROM tags WHERE deleted_at IS NULL ORDER BY label');
  return useMemo(() => rows.map(toTag), [rows]);
}

/** Tags placed on one schedule block with their yes/no/pending answers (§ tags). */
export function useBlockTags(blockId: string): BlockTagView[] {
  const placements = useRows('SELECT * FROM tag_placements WHERE deleted_at IS NULL');
  const tags = useRows('SELECT * FROM tags WHERE deleted_at IS NULL');
  const answers = useRows('SELECT * FROM tag_answers WHERE deleted_at IS NULL');
  return useMemo(() => {
    const tagById = new Map(tags.map((r) => { const t = toTag(r); return [t.id, t] as const; }));
    const answerByPlacement = new Map(answers.map((r) => { const a = toTagAnswer(r); return [a.placement_id, a] as const; }));
    const out: BlockTagView[] = [];
    for (const row of placements) {
      const p = toTagPlacement(row);
      if (p.block_id !== blockId) continue;
      const tag = tagById.get(p.tag_id);
      if (!tag) continue;
      const ans = answerByPlacement.get(p.id) ?? null;
      out.push({ tag, placementId: p.id, answerId: ans?.id ?? null, answer: ans?.value ?? 'pending' });
    }
    return out.sort((a, b) => a.tag.label.localeCompare(b.tag.label));
  }, [placements, tags, answers, blockId]);
}

// --- journal (a note on any calendar day, D3) -----------------------------

// One ref-counted month-subscription manager per PowerSync db, module-scoped so
// several mounted journal views SHARE holds (the Agenda + a day panel on the same
// month subscribe once). WeakMap → GC'd with the db on account switch.
const journalSubs = new WeakMap<object, JournalMonthSubscriptions>();
function journalSubsFor(db: object): JournalMonthSubscriptions {
  let mgr = journalSubs.get(db);
  if (!mgr) {
    mgr = createJournalMonthSubscriptions(db as unknown as StreamSubscriber);
    journalSubs.set(db, mgr);
  }
  return mgr;
}

export interface JournalMonthsRead {
  entries: JournalEntry[];
  isLoading: boolean;
}

/**
 * The journal notes for the given month(s), reactive + merged with the overlay
 * (D3). HOLDS the month subscriptions while mounted (ref-counted) so the rows
 * sync down lazily — a fresh device pulls ZERO journal rows until a month is
 * viewed — and releases on unmount/month change (PowerSync's TTL then evicts).
 * Pass the month(s) covering the visible range; a week can span two months, so
 * pass both. Overlay-only inserts (a new day not yet synced) are filtered to the
 * requested months since `mergeTable` appends them regardless of the SQL filter.
 */
export function useJournalMonths(monthKeys: readonly string[]): JournalMonthsRead {
  const db = usePowerSync();
  const key = useMemo(() => [...new Set(monthKeys)].sort(), [monthKeys.join('\0')]);

  const mgr = journalSubsFor(db as unknown as object);
  useEffect(() => {
    const releases = key.map((m) => mgr.hold(m));
    return () => {
      for (const release of releases) release();
    };
  }, [mgr, key]);

  /**
   * `isLoading` deliberately reflects only the LOCAL read, never "has this month
   * finished its first sync". Gating on first sync looks right online and is a
   * trap offline: `waitForFirstSync` never resolves without a connection, so the
   * day panel sat on "Loading…" forever with the note already in local SQLite —
   * caught by the offline e2e. The title no longer needs that gate anyway: it is
   * blank until the ENTRY exists, which is a fact the local read establishes.
   */
  const sql = key.length
    ? `SELECT * FROM journal_entries WHERE deleted_at IS NULL AND month_key IN (${key.map(() => '?').join(',')})`
    : 'SELECT * FROM journal_entries WHERE 0';
  const read = useRowsRead(sql, key);
  const entries = useMemo(
    () =>
      read.data
        .map(toJournalEntry)
        .filter((e) => e.deleted_at === null && key.includes(e.month_key))
        .sort((a, b) => (a.entry_date < b.entry_date ? -1 : a.entry_date > b.entry_date ? 1 : 0)),
    [read.data, key],
  );
  return { entries, isLoading: read.isLoading };
}

export interface JournalDayRead {
  entry: JournalEntry | null;
  isLoading: boolean;
}

/** One day's note (or null), derived from its month subscription (D3). */
export function useJournalDay(date: string): JournalDayRead {
  const months = useMemo(() => [date.slice(0, 7)], [date]);
  const { entries, isLoading } = useJournalMonths(months);
  const entry = useMemo(() => entries.find((e) => e.entry_date === date) ?? null, [entries, date]);
  return { entry, isLoading };
}
