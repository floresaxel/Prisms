/**
 * Reactive hooks (§12.2): PowerSync reactive queries → core selectors → React.
 * No view caches derived status; it recomputes on data change (microseconds).
 */
import { useMemo } from 'react';

import { usePowerSync, useQuery } from '@powersync/react';
import {
  addDays,
  asEpochMillis,
  bucketDate,
  buildFactContext,
  buildTreeIndex,
  canonicalPractice,
  canonicalProgress,
  canonicalStreak,
  DEFAULT_WINDOWS,
  habitTaskIds,
  isJustified,
  isoToEpochMillis,
  minutesLeftInDay,
  minutesLeftInTask,
  rawMinutes,
  taskStatus,
  type CommittedBlock,
  type FactContext,
  type Habit,
  type Instant,
  type IsoDate,
  type Node,
  type PracticeValue,
  type ProgressValue,
  type SchedulableTask,
  type SchedulerDependency,
  type SchedulerInput,
  type StreakValue,
  type TaskStatus,
  type TimeEntry,
  type TreeIndex,
} from '@prisms/core';

import { createCommands, type CommandContext } from './powersync/commands';
import {
  toBlockerRule,
  toComputedAggregate,
  toEdge,
  toExternalFact,
  toHabit,
  toHabitCompletion,
  toMembership,
  toNode,
  toScheduleBlock,
  toSprint,
  toTimeEntry,
  toUserSettings,
} from './powersync/rows';

type Row = Record<string, unknown>;
const useRows = (sql: string) => useQuery<Row>(sql).data ?? [];

/** Live tree of non-deleted nodes. */
export function useNodeTree(): TreeIndex {
  const rows = useRows('SELECT * FROM nodes WHERE deleted_at IS NULL');
  return useMemo(() => buildTreeIndex(rows.map(toNode)), [rows]);
}

/** The full FactContext used by status + blocker evaluation. */
export function useFactContext(): FactContext {
  const nodes = useRows('SELECT * FROM nodes WHERE deleted_at IS NULL');
  const edges = useRows('SELECT * FROM edges WHERE deleted_at IS NULL');
  const entries = useRows('SELECT * FROM time_entries WHERE deleted_at IS NULL');
  const blocks = useRows('SELECT * FROM schedule_blocks WHERE deleted_at IS NULL');
  const sprints = useRows('SELECT * FROM sprints WHERE deleted_at IS NULL');
  const memberships = useRows('SELECT * FROM sprint_memberships WHERE deleted_at IS NULL');
  const blockers = useRows('SELECT * FROM blocker_rules WHERE deleted_at IS NULL');
  const facts = useRows('SELECT * FROM external_facts WHERE deleted_at IS NULL');
  const settings = useRows('SELECT * FROM user_settings LIMIT 1');

  return useMemo(
    () =>
      buildFactContext({
        nodes: nodes.map(toNode),
        edges: edges.map(toEdge),
        time_entries: entries.map(toTimeEntry),
        schedule_blocks: blocks.map(toScheduleBlock),
        sprints: sprints.map(toSprint),
        sprint_memberships: memberships.map(toMembership),
        blocker_rules: blockers.map(toBlockerRule),
        external_facts: facts.map(toExternalFact),
        user_settings: settings[0] ? toUserSettings(settings[0]) : null,
      }),
    [nodes, edges, entries, blocks, sprints, memberships, blockers, facts, settings],
  );
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
}

/**
 * The "available items" worklist (§1.2): tasks the user can act on now —
 * available, prioritized, scheduled, or ongoing (not done, not blocked),
 * ordered ongoing-first then by status precedence. Each item carries its
 * progress (§7.2) and time-left-in-task indicator.
 */
export function useWorklist(now: Instant): WorklistItem[] {
  const ctx = useFactContext();
  const entryRows = useRows('SELECT * FROM time_entries WHERE deleted_at IS NULL');
  return useMemo(() => {
    const entries = entryRows.map(toTimeEntry);
    const items: WorklistItem[] = [];
    for (const node of ctx.tree.byId.values()) {
      if (node.node_type !== 'task') continue;
      const status = taskStatus(node, ctx, now);
      if (status === 'done' || status === 'blocked') continue;
      const open = ctx.openEntryFor(node.id);
      items.push({
        task: node,
        status,
        openEntryId: open?.id,
        progress: canonicalProgress(node, entries),
        minutesLeftInTask: minutesLeftInTask(node, entries),
      });
    }
    const rank: Record<TaskStatus, number> = { ongoing: 0, scheduled: 1, prioritized: 2, available: 3, blocked: 4, done: 5 };
    return items.sort((a, b) => rank[a.status] - rank[b.status] || (a.task.title < b.task.title ? -1 : 1));
  }, [ctx, entryRows, now]);
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
  const rows = useRows('SELECT * FROM time_entries WHERE ended_at IS NULL AND deleted_at IS NULL');
  const tree = useNodeTree();
  return useMemo(() => {
    const open = rows.map(toTimeEntry);
    if (open.length === 0) return null;
    const winner = open.reduce((a, b) =>
      b.started_at > a.started_at || (b.started_at === a.started_at && b.id > a.id) ? b : a,
    );
    return {
      entry: winner,
      task: tree.byId.get(winner.task_id),
      elapsedMs: Math.max(0, now - isoToEpochMillis(winner.started_at)),
    };
  }, [rows, tree, now]);
}

/** Activity inbox (§1.2): parentless `activity` items awaiting promotion. */
export function useActivityInbox(): Node[] {
  const rows = useRows("SELECT * FROM nodes WHERE node_type = 'activity' AND deleted_at IS NULL");
  return useMemo(
    () => rows.map(toNode).sort((a, b) => (a.sort_order < b.sort_order ? -1 : a.sort_order > b.sort_order ? 1 : a.id < b.id ? -1 : 1)),
    [rows],
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

export interface Agenda {
  /** SchedulerInput (greedy) for `validWindowsFor` drag hints (§10). */
  input: SchedulerInput;
  tasksById: ReadonlyMap<string, SchedulableTask>;
  /** Committed + suggested blocks to render in the calendar. */
  blocks: AgendaBlock[];
  /** Past `time_entries` as the historical event layer (§12.2). */
  entries: AgendaEntry[];
  /** Schedulable tasks not yet placed — the to-do side panel. */
  todo: TodoTask[];
}

/**
 * Agenda data (§12.2, §10 client mode): mirrors the server's scheduler-context
 * loader on the client so drag-to-agenda window hints, suggestions, the grey
 * (unjustified) rule, and the time-entry history layer all work offline.
 */
export function useAgenda(now: Instant, horizonDays = 7): Agenda {
  const ctx = useFactContext();
  const edgeRows = useRows('SELECT * FROM edges WHERE deleted_at IS NULL');
  const blockRows = useRows('SELECT * FROM schedule_blocks WHERE deleted_at IS NULL');
  const entryRows = useRows('SELECT * FROM time_entries WHERE deleted_at IS NULL');
  const sprintRows = useRows('SELECT * FROM sprints WHERE deleted_at IS NULL');
  const membershipRows = useRows('SELECT * FROM sprint_memberships WHERE deleted_at IS NULL');

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
    const todo: TodoTask[] = tasks
      .filter((t) => !scheduledTaskIds.has(t.id))
      .map((t) => ({ task: tree.byId.get(t.id) as Node, schedulable: t }))
      .sort((a, b) => (a.task.title < b.task.title ? -1 : a.task.title > b.task.title ? 1 : 0));

    return { input, tasksById, blocks, entries, todo };
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
  const ctx = useFactContext();
  const habitRows = useRows('SELECT * FROM habits WHERE deleted_at IS NULL');
  const completionRows = useRows('SELECT * FROM habit_completions WHERE deleted_at IS NULL');
  const entryRows = useRows('SELECT * FROM time_entries WHERE deleted_at IS NULL');
  const blockRows = useRows('SELECT * FROM schedule_blocks WHERE deleted_at IS NULL');
  const aggRows = useRows("SELECT * FROM computed_aggregates WHERE deleted_at IS NULL AND subject_kind = 'habit'");

  return useMemo(() => {
    const nodes = [...ctx.tree.byId.values()];
    const entries = entryRows.map(toTimeEntry);
    const completions = completionRows.map(toHabitCompletion);
    const blocks = blockRows.map(toScheduleBlock);
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
      const streak = canonicalStreak({ habit, completions, nodes, schedule_blocks: blocks, time_entries: entries, settings }, now);
      const practice = canonicalPractice(habit, nodes, entries);

      let todayMinutes = 0;
      for (const e of entries) {
        if (!taskIds.has(e.task_id)) continue;
        if (bucketDate(e.started_at, settings.day_reset_hour, settings.timezone) !== today) continue;
        todayMinutes += e.ended_at === null ? Math.max(0, (now - isoToEpochMillis(e.started_at)) / 60_000) : rawMinutes(e);
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
        serverComputedAt: serverAt.get(habit.id) ?? null,
      });
    }
    return views.sort((a, b) => (a.habit.title < b.habit.title ? -1 : a.habit.title > b.habit.title ? 1 : 0));
  }, [ctx, habitRows, completionRows, entryRows, blockRows, aggRows, now]);
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
 */
export function useKanban(now: Instant, dayCount = 5): KanbanColumn[] {
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
  }, [ctx, now, dayCount]);
}

export interface AggregateRow {
  subjectKind: 'habit' | 'node' | 'user';
  subjectId: string | null;
  metric: string;
  value: unknown;
  computedAt: string;
  computedBy: 'client' | 'server';
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
  return useMemo(() => createCommands(db, ctx), [db, ctx]);
}
