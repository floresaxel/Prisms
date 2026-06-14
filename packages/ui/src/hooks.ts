/**
 * Reactive hooks (§12.2): PowerSync reactive queries → core selectors → React.
 * No view caches derived status; it recomputes on data change (microseconds).
 */
import { useMemo } from 'react';

import { usePowerSync, useQuery } from '@powersync/react';
import {
  buildFactContext,
  buildTreeIndex,
  canonicalProgress,
  isoToEpochMillis,
  minutesLeftInDay,
  minutesLeftInTask,
  taskStatus,
  type FactContext,
  type Instant,
  type Node,
  type ProgressValue,
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
