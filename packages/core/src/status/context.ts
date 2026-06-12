/**
 * FactContext (§7.1): the indexed, read-only view of synced rows that the
 * status function, phase derivation, and predicate evaluator consume.
 *
 * Built once per fact-set change (microseconds for normal datasets, §12.2);
 * never caches derived status. All inputs are plain table rows — identical on
 * device and server (principle 4). Soft-deleted rows are excluded everywhere.
 */
import type {
  BlockerRule,
  ExternalFact,
  Node,
  ScheduleBlock,
  Sprint,
  SprintMembership,
  TimeEntry,
  UserSettings,
} from '../domain/entities';
import type { IsoDate, Uuid } from '../domain/primitives';
import { ancestorsOf, buildTreeIndex, getNode, type TreeIndex } from '../graph/tree';
import { buildEdgeIndex, type EdgeIndex } from '../graph/dag';
import type { Edge } from '../domain/entities';
import { bucketDate } from '../time/bucket';
import { isoToEpochMillis, type Instant } from '../time/instant';

/** Mirrors the user_settings DDL defaults (§6.0). */
export const DEFAULT_DAY_RESET_HOUR = 4;
export const DEFAULT_TIMEZONE = 'America/New_York';

export interface FactRows {
  nodes: readonly Node[];
  edges?: readonly Edge[];
  time_entries?: readonly TimeEntry[];
  schedule_blocks?: readonly ScheduleBlock[];
  sprints?: readonly Sprint[];
  sprint_memberships?: readonly SprintMembership[];
  blocker_rules?: readonly BlockerRule[];
  external_facts?: readonly ExternalFact[];
  user_settings?: Pick<UserSettings, 'day_reset_hour' | 'timezone'> | null;
}

export interface FactContext {
  readonly tree: TreeIndex;
  readonly edgeIndex: EdgeIndex;
  readonly dayResetHour: number;
  readonly timezone: string;
  node(id: Uuid): Node | undefined;
  /** Open (running) time entry — clock-in is the ONLY path to `ongoing`. */
  openEntryFor(taskId: Uuid): TimeEntry | undefined;
  /** Any non-deleted entry, open or closed — the SS gate (§7.1). */
  hasAnyEntry(nodeId: Uuid): boolean;
  /** A committed (never suggested, §2.6) block still current or upcoming. */
  hasCommittedBlockAtOrAfter(taskId: Uuid, now: Instant): boolean;
  /** Direct or inherited (ancestor) membership in a sprint active today. */
  inActiveSprint(nodeId: Uuid, now: Instant): boolean;
  enabledBlockerRules(): readonly BlockerRule[];
  /** weather_forecast fact by exact key or `<location-slug>/<key>` suffix. */
  weatherFact(key: string): ExternalFact | undefined;
  /** The user's current day bucket (§7.2) — every "today" goes through this. */
  today(now: Instant): IsoDate;
}

const live = <T extends { deleted_at: string | null }>(rows: readonly T[] | undefined): T[] =>
  (rows ?? []).filter((r) => r.deleted_at === null);

export function buildFactContext(rows: FactRows): FactContext {
  const tree = buildTreeIndex(rows.nodes);
  const edgeIndex = buildEdgeIndex(rows.edges ?? []);

  const openEntries = new Map<Uuid, TimeEntry>();
  const nodesWithEntries = new Set<Uuid>();
  for (const entry of live(rows.time_entries)) {
    nodesWithEntries.add(entry.task_id);
    if (entry.ended_at === null) {
      const current = openEntries.get(entry.task_id);
      // §7.4 transient double-open: expose the latest-started one.
      if (!current || entry.started_at > current.started_at) {
        openEntries.set(entry.task_id, entry);
      }
    }
  }

  // committed block end instants per task (suggested blocks are proposals,
  // not facts — they never make a task `scheduled`)
  const committedEndsMs = new Map<Uuid, number[]>();
  for (const block of live(rows.schedule_blocks)) {
    if (block.status !== 'committed') continue;
    const ends = isoToEpochMillis(block.ends_at);
    const list = committedEndsMs.get(block.task_id);
    if (list) list.push(ends);
    else committedEndsMs.set(block.task_id, [ends]);
  }

  const sprints = live(rows.sprints);
  const sprintsById = new Map<Uuid, Sprint>(sprints.map((s) => [s.id, s]));
  const sprintIdsByNode = new Map<Uuid, Set<Uuid>>();
  for (const membership of live(rows.sprint_memberships)) {
    if (!sprintsById.has(membership.sprint_id)) continue;
    const set = sprintIdsByNode.get(membership.node_id) ?? new Set<Uuid>();
    set.add(membership.sprint_id);
    sprintIdsByNode.set(membership.node_id, set);
  }

  const blockerRules = live(rows.blocker_rules).filter((r) => r.enabled);

  const weatherByKey = new Map<string, ExternalFact>();
  const weatherByDateSegment = new Map<string, ExternalFact>();
  for (const fact of live(rows.external_facts)) {
    if (fact.kind !== 'weather_forecast') continue;
    weatherByKey.set(fact.key, fact);
    const segment = fact.key.split('/').at(-1);
    if (segment !== undefined) {
      const existing = weatherByDateSegment.get(segment);
      if (!existing || fact.computed_at > existing.computed_at) {
        weatherByDateSegment.set(segment, fact);
      }
    }
  }

  const dayResetHour = rows.user_settings?.day_reset_hour ?? DEFAULT_DAY_RESET_HOUR;
  const timezone = rows.user_settings?.timezone ?? DEFAULT_TIMEZONE;

  const today = (now: Instant): IsoDate => bucketDate(now, dayResetHour, timezone);

  const sprintActiveToday = (sprintId: Uuid, day: IsoDate): boolean => {
    const sprint = sprintsById.get(sprintId);
    return sprint !== undefined && sprint.starts_on <= day && day <= sprint.ends_on;
  };

  return {
    tree,
    edgeIndex,
    dayResetHour,
    timezone,
    node: (id) => getNode(tree, id),
    openEntryFor: (taskId) => openEntries.get(taskId),
    hasAnyEntry: (nodeId) => nodesWithEntries.has(nodeId),
    hasCommittedBlockAtOrAfter: (taskId, now) =>
      (committedEndsMs.get(taskId) ?? []).some((ends) => ends > now),
    inActiveSprint: (nodeId, now) => {
      const day = today(now);
      const candidates = [nodeId, ...ancestorsOf(tree, nodeId).map((a) => a.id)];
      return candidates.some((id) => {
        const sprintIds = sprintIdsByNode.get(id);
        if (!sprintIds) return false;
        for (const sprintId of sprintIds) {
          if (sprintActiveToday(sprintId, day)) return true;
        }
        return false;
      });
    },
    enabledBlockerRules: () => blockerRules,
    weatherFact: (key) => weatherByKey.get(key) ?? weatherByDateSegment.get(key),
    today,
  };
}
