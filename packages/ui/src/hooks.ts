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
  buildEdgeIndex,
  buildFactContext,
  buildTreeIndex,
  canonicalBurndown,
  canonicalCompletion,
  canonicalPractice,
  canonicalProgress,
  canonicalStreak,
  childrenOf,
  criticalPath,
  DEFAULT_WINDOWS,
  descendantsOf,
  habitTaskIds,
  isJustified,
  isoToEpochMillis,
  minutesLeftInDay,
  minutesLeftInTask,
  minutesUntilNextBlock,
  rankProjects,
  rawMinutes,
  taskStatus,
  topologicalOrder,
  type AutomationRule,
  type BlockerRule,
  type BurndownValue,
  type CommittedBlock,
  type CompletionValue,
  type DecisionBoard,
  type DecisionCriterion,
  type DiagramGroup,
  type EdgeIndex,
  type FactContext,
  type Habit,
  type Instant,
  type IsoDate,
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
  type TimeEntry,
  type TreeIndex,
} from '@prisms/core';

import { createCommands, type CommandContext } from './powersync/commands';
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
  toExternalFact,
  toHabit,
  toHabitCompletion,
  toMembership,
  toNode,
  toScheduleBlock,
  toSprint,
  toTag,
  toTagAnswer,
  toTagPlacement,
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
  /** True when the task has ≥1 committed block (Phase 3 grouping/association). */
  scheduled: boolean;
  /** The committed block to auto-associate a completion with (null = none/unscheduled). */
  committedBlockId: string | null;
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
  const ctx = useFactContext();
  const entryRows = useRows('SELECT * FROM time_entries WHERE deleted_at IS NULL');
  const blockRows = useRows("SELECT * FROM schedule_blocks WHERE status = 'committed' AND deleted_at IS NULL");
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
      items.push({
        task: node,
        status,
        openEntryId: open?.id,
        progress: canonicalProgress(node, entries),
        minutesLeftInTask: minutesLeftInTask(node, entries),
        scheduled: taskBlocks.length > 0,
        committedBlockId: pickCommittedBlock(taskBlocks, now),
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
  const ctx = useFactContext();
  const blockRows = useRows("SELECT * FROM schedule_blocks WHERE status = 'committed' AND deleted_at IS NULL");
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

export interface HabitTasksView {
  habit: Habit;
  /** The habit's actionable (not done/blocked) recurring task instances. */
  tasks: WorklistItem[];
}

/** Each habit's recurring task instances (nodes.habit_id) as actionable items (Phase 4a). */
export function useHabitTasks(now: Instant): HabitTasksView[] {
  const items = useWorklist(now);
  const habitRows = useRows('SELECT * FROM habits WHERE deleted_at IS NULL');
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

/** Minutes until the next committed block starts (§7.2 time-left trio); null when none ahead. */
export function useNextBlockMinutes(now: Instant, taskId?: string): number | null {
  const rows = useRows('SELECT * FROM schedule_blocks WHERE deleted_at IS NULL');
  return useMemo(() => minutesUntilNextBlock(rows.map(toScheduleBlock), now, taskId), [rows, now, taskId]);
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
  const boardRows = useRows('SELECT * FROM decision_boards WHERE deleted_at IS NULL');
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
  const ctx = useFactContext();
  // include soft-deleted tasks so the burndown scope-out (a deleted task
  // leaving the series) is reflected.
  const taskRows = useRows("SELECT * FROM nodes WHERE node_type = 'task'");
  const blockRows = useRows('SELECT * FROM schedule_blocks WHERE deleted_at IS NULL');
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
  const tree = useNodeTree();
  const edgeRows = useRows('SELECT * FROM edges WHERE deleted_at IS NULL');
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
  const ctx = useFactContext();
  const edgeRows = useRows('SELECT * FROM edges WHERE deleted_at IS NULL');
  const blockRows = useRows('SELECT * FROM schedule_blocks WHERE deleted_at IS NULL');

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
  const rows = useRows('SELECT * FROM automation_rules WHERE deleted_at IS NULL');
  return useMemo(() => rows.map(toAutomationRule).sort((a, b) => (a.created_at < b.created_at ? -1 : 1)), [rows]);
}

/** Blocker rules (§9) for the blocker editor. */
export function useBlockers(): BlockerRule[] {
  const rows = useRows('SELECT * FROM blocker_rules WHERE deleted_at IS NULL');
  return useMemo(() => rows.map(toBlockerRule).sort((a, b) => (a.created_at < b.created_at ? -1 : 1)), [rows]);
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
}

/** User settings row, with architecture defaults when a fresh account has not synced one yet. */
export function useUserSettings(): UserSettingsView {
  const rows = useRows('SELECT * FROM user_settings LIMIT 1');
  return useMemo(() => {
    const row = rows[0] ? toUserSettings(rows[0]) : null;
    return {
      hasRow: row !== null,
      dayResetHour: row?.day_reset_hour ?? 4,
      timezone: row?.timezone ?? 'America/New_York',
      weatherLocation: row?.weather_location ?? null,
    };
  }, [rows]);
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
