/**
 * Incremental, fact-keyed `StatusIndex` (1.3 §7.12). The pure `statusOf`/
 * `taskStatus` stays the canonical reference; this index maintains the SAME
 * derived value per task node WITHOUT a full table scan per command.
 *
 * `apply(effects)` ingests the minimal effects of a command (the overlay /
 * server effect summary) and recomputes status only for the affected nodes and
 * their dependency neighbours — never unrelated nodes. Correctness is pinned by
 * a property test: rebuilding from scratch equals the incrementally maintained
 * value over any effect stream.
 *
 * Reverse-dependency model (which fact change invalidates which task's status):
 *  - a node's `completed_at`      → itself + its edge successors (FS/SS gates);
 *  - a node's time entries        → itself (ongoing/SS) + its successors;
 *  - an edge insert/delete        → the successor (its incoming set changed);
 *  - a committed schedule block    → its task (scheduled);
 *  - a sprint membership          → the node + its descendants (sprint is
 *                                   inherited from ancestors);
 *  - a sprint's dates             → its members + their descendants;
 *  - `parent_id` (move)           → the node + its descendants (ancestor set);
 *  - blocker rules                → all tasks (rules can match broadly, rare);
 *  - weather facts                → all tasks IF a blocker rule reads weather;
 *  - `project.phase` blockers     → execution-fact changes fan out to all tasks
 *                                   (phase aggregates a project's whole subtree).
 *
 * `now` is fixed at construction (the per-`now` tick is the read-path concern,
 * M11/M12); fact effects drive `apply`.
 */
import type { BlockerRule, Edge, ExternalFact, Node, ScheduleBlock, Sprint, SprintMembership, TimeEntry } from '../domain/entities';
import { SYNC_ROW_DEFAULTS } from '../domain/entities';
import type { Uuid } from '../domain/primitives';
import { descendantsOf, type TreeIndex } from '../graph/tree';
import { outgoingEdges, type EdgeIndex } from '../graph/dag';
import { bucketDate } from '../time/bucket';
import { isoToEpochMillis, type Instant } from '../time/instant';

import { DEFAULT_DAY_RESET_HOUR, DEFAULT_TIMEZONE, type FactContext, type FactRows } from './context';
import { taskStatus, type TaskStatus } from './status';

/** A row effect the index can apply (the OverlayEffect / server effect shape). */
export interface StatusEffect {
  readonly table: string;
  readonly op: 'insert' | 'update' | 'delete';
  readonly row_id: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface StatusApplyResult {
  /** Task nodes whose status VALUE changed. */
  readonly changed: Uuid[];
  /** Task nodes recomputed — the touch set (must stay local; instrumented). */
  readonly recomputed: Uuid[];
}

const str = (v: unknown): string | null => (v == null ? null : String(v));

function toNode(id: Uuid, f: Readonly<Record<string, unknown>>): Node {
  return {
    ...SYNC_ROW_DEFAULTS,
    id,
    user_id: String(f['user_id'] ?? ''),
    parent_id: str(f['parent_id']),
    node_type: f['node_type'] as Node['node_type'],
    title: String(f['title'] ?? ''),
    description: String(f['description'] ?? ''),
    sort_order: String(f['sort_order'] ?? ''),
    start_date: str(f['start_date']),
    due_date: str(f['due_date']),
    estimate_minutes: f['estimate_minutes'] == null ? null : Number(f['estimate_minutes']),
    completed_at: str(f['completed_at']),
    completion_disposition: (f['completed_at'] == null ? null : (f['completion_disposition'] ?? 'completed')) as Node['completion_disposition'],
    completed_in_block_id: str(f['completed_in_block_id']),
    habit_id: str(f['habit_id']),
    attributes: (f['attributes'] ?? {}) as Node['attributes'],
    created_at: String(f['created_at'] ?? ''),
    updated_at: String(f['updated_at'] ?? ''),
    deleted_at: str(f['deleted_at']),
  };
}

export class StatusIndex {
  private readonly nodes = new Map<Uuid, Node>();
  private readonly childrenByParent = new Map<Uuid | null, Node[]>();
  private readonly edgesById = new Map<Uuid, Edge>();
  private readonly incoming = new Map<Uuid, Edge[]>();
  private readonly outgoing = new Map<Uuid, Edge[]>();
  private readonly entries = new Map<Uuid, TimeEntry>();
  private readonly openByTask = new Map<Uuid, Map<Uuid, TimeEntry>>();
  private readonly entryCountByTask = new Map<Uuid, number>();
  // per-task entry starts (entryId → started_at ms) so `earliestEntryStart`
  // recomputes the SS/SF lag reference (§7.6) after a removal without a scan.
  private readonly entryStartsByTask = new Map<Uuid, Map<Uuid, Instant>>();
  private readonly blocks = new Map<Uuid, ScheduleBlock>();
  private readonly committedEndsByTask = new Map<Uuid, Map<Uuid, number>>();
  private readonly sprints = new Map<Uuid, Sprint>();
  private readonly memberships = new Map<Uuid, SprintMembership>();
  private readonly sprintIdsByNode = new Map<Uuid, Set<Uuid>>();
  private readonly membersBySprint = new Map<Uuid, Set<Uuid>>();
  // reference count per (node, sprint) pair so two memberships of the same pair
  // don't drop the link when only one is removed (mirrors the Set-of-rows rebuild).
  private readonly sprintPairCount = new Map<string, number>();
  private readonly blockerRules = new Map<Uuid, BlockerRule>();
  private readonly externalFacts = new Map<Uuid, ExternalFact>();
  private weatherByKey = new Map<string, ExternalFact>();
  private weatherBySegment = new Map<string, ExternalFact>();
  private enabledBlockers: BlockerRule[] = [];
  private usesProjectPhase = false;
  private usesWeather = false;

  private dayResetHour: number;
  private timezone: string;
  private readonly now: Instant;

  private readonly statusByNode = new Map<Uuid, TaskStatus>();
  private readonly tree: TreeIndex;
  private readonly edgeIndex: EdgeIndex;
  private readonly view: FactContext;

  constructor(rows: FactRows, now: Instant, settings?: { day_reset_hour?: number; timezone?: string }) {
    this.now = now;
    this.dayResetHour = settings?.day_reset_hour ?? rows.user_settings?.day_reset_hour ?? DEFAULT_DAY_RESET_HOUR;
    this.timezone = settings?.timezone ?? rows.user_settings?.timezone ?? DEFAULT_TIMEZONE;

    this.tree = { byId: this.nodes, childrenByParent: this.childrenByParent };
    this.edgeIndex = { byId: this.edgesById, incoming: this.incoming, outgoing: this.outgoing };
    // A FactContext that reads the live, incrementally-maintained maps.
    // dayResetHour/timezone are kept in sync on a settings.update (applyOne).
    this.view = {
      tree: this.tree,
      edgeIndex: this.edgeIndex,
      dayResetHour: this.dayResetHour,
      timezone: this.timezone,
      node: (id) => this.nodes.get(id),
      openEntryFor: (taskId) => this.openEntryFor(taskId),
      hasAnyEntry: (nodeId) => (this.entryCountByTask.get(nodeId) ?? 0) > 0,
      earliestEntryStart: (taskId) => this.earliestEntryStart(taskId),
      hasCommittedBlockAtOrAfter: (taskId, at) => {
        const ends = this.committedEndsByTask.get(taskId);
        if (!ends) return false;
        for (const e of ends.values()) if (e > at) return true;
        return false;
      },
      inActiveSprint: (nodeId, at) => this.inActiveSprint(nodeId, at),
      enabledBlockerRules: () => this.enabledBlockers,
      weatherFact: (key) => this.weatherByKey.get(key) ?? this.weatherBySegment.get(key),
      today: (at) => bucketDate(at, this.dayResetHour, this.timezone),
    };

    this.build(rows);
  }

  /** Status of a task node, or undefined for a non-task / missing node. */
  statusOf(id: Uuid): TaskStatus | undefined {
    return this.statusByNode.get(id);
  }

  /** A read-only snapshot of every tracked task status. */
  allStatuses(): ReadonlyMap<Uuid, TaskStatus> {
    return this.statusByNode;
  }

  // --- initial full build ----------------------------------------------------

  private build(rows: FactRows): void {
    for (const n of rows.nodes) if (n.deleted_at === null) this.addNode(n);
    for (const e of rows.edges ?? []) if (e.deleted_at === null) this.addEdge(e);
    for (const t of rows.time_entries ?? []) if (t.deleted_at === null) this.addEntry(t);
    for (const b of rows.schedule_blocks ?? []) if (b.deleted_at === null) this.addBlock(b);
    for (const s of rows.sprints ?? []) if (s.deleted_at === null) this.sprints.set(s.id, s);
    for (const m of rows.sprint_memberships ?? []) if (m.deleted_at === null) this.addMembership(m);
    for (const r of rows.blocker_rules ?? []) if (r.deleted_at === null) this.blockerRules.set(r.id, r);
    for (const f of rows.external_facts ?? []) if (f.deleted_at === null) this.externalFacts.set(f.id, f);
    this.refreshBlockers();
    this.refreshWeather();
    for (const node of this.nodes.values()) {
      if (node.node_type === 'task') this.statusByNode.set(node.id, taskStatus(node, this.view, this.now));
    }
  }

  // --- derived-map maintenance ----------------------------------------------

  private addNode(node: Node): void {
    this.nodes.set(node.id, { ...node });
    const stored = this.nodes.get(node.id)!;
    const list = this.childrenByParent.get(stored.parent_id);
    if (list) list.push(stored);
    else this.childrenByParent.set(stored.parent_id, [stored]);
  }

  private removeChild(parentId: Uuid | null, id: Uuid): void {
    const list = this.childrenByParent.get(parentId);
    if (!list) return;
    const i = list.findIndex((n) => n.id === id);
    if (i >= 0) list.splice(i, 1);
    if (list.length === 0) this.childrenByParent.delete(parentId);
  }

  private addEdge(edge: Edge): void {
    this.edgesById.set(edge.id, edge);
    (this.outgoing.get(edge.predecessor_id) ?? this.outgoing.set(edge.predecessor_id, []).get(edge.predecessor_id)!).push(edge);
    (this.incoming.get(edge.successor_id) ?? this.incoming.set(edge.successor_id, []).get(edge.successor_id)!).push(edge);
  }

  private removeEdge(id: Uuid): Edge | undefined {
    const edge = this.edgesById.get(id);
    if (!edge) return undefined;
    this.edgesById.delete(id);
    const out = this.outgoing.get(edge.predecessor_id);
    if (out) {
      const i = out.findIndex((e) => e.id === id);
      if (i >= 0) out.splice(i, 1);
    }
    const inc = this.incoming.get(edge.successor_id);
    if (inc) {
      const i = inc.findIndex((e) => e.id === id);
      if (i >= 0) inc.splice(i, 1);
    }
    return edge;
  }

  private addEntry(entry: TimeEntry): void {
    this.entries.set(entry.id, entry);
    this.entryCountByTask.set(entry.task_id, (this.entryCountByTask.get(entry.task_id) ?? 0) + 1);
    const starts = this.entryStartsByTask.get(entry.task_id) ?? new Map<Uuid, Instant>();
    starts.set(entry.id, isoToEpochMillis(entry.started_at));
    this.entryStartsByTask.set(entry.task_id, starts);
    if (entry.ended_at === null) {
      const open = this.openByTask.get(entry.task_id) ?? new Map<Uuid, TimeEntry>();
      open.set(entry.id, entry);
      this.openByTask.set(entry.task_id, open);
    }
  }

  private removeEntry(id: Uuid): TimeEntry | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    this.entries.delete(id);
    const count = (this.entryCountByTask.get(entry.task_id) ?? 1) - 1;
    if (count <= 0) this.entryCountByTask.delete(entry.task_id);
    else this.entryCountByTask.set(entry.task_id, count);
    const starts = this.entryStartsByTask.get(entry.task_id);
    if (starts) {
      starts.delete(id);
      if (starts.size === 0) this.entryStartsByTask.delete(entry.task_id);
    }
    this.openByTask.get(entry.task_id)?.delete(id);
    return entry;
  }

  /** Earliest `started_at` ms across a task's tracked entries (§7.6 SS/SF lag). */
  private earliestEntryStart(taskId: Uuid): Instant | undefined {
    const starts = this.entryStartsByTask.get(taskId);
    if (!starts || starts.size === 0) return undefined;
    let min: Instant | undefined;
    for (const ms of starts.values()) if (min === undefined || ms < min) min = ms;
    return min;
  }

  private openEntryFor(taskId: Uuid): TimeEntry | undefined {
    const open = this.openByTask.get(taskId);
    if (!open || open.size === 0) return undefined;
    let winner: TimeEntry | undefined;
    for (const e of open.values()) if (!winner || e.started_at > winner.started_at) winner = e;
    return winner;
  }

  private addBlock(block: ScheduleBlock): void {
    this.blocks.set(block.id, block);
    if (block.status === 'committed') {
      const ends = this.committedEndsByTask.get(block.task_id) ?? new Map<Uuid, number>();
      ends.set(block.id, isoToEpochMillis(block.ends_at));
      this.committedEndsByTask.set(block.task_id, ends);
    }
  }

  private removeBlock(id: Uuid): ScheduleBlock | undefined {
    const block = this.blocks.get(id);
    if (!block) return undefined;
    this.blocks.delete(id);
    this.committedEndsByTask.get(block.task_id)?.delete(id);
    return block;
  }

  private addMembership(m: SprintMembership): void {
    this.memberships.set(m.id, m);
    const key = `${m.node_id}:${m.sprint_id}`;
    const count = (this.sprintPairCount.get(key) ?? 0) + 1;
    this.sprintPairCount.set(key, count);
    if (count > 1) return; // pair already linked by another membership
    (this.sprintIdsByNode.get(m.node_id) ?? this.sprintIdsByNode.set(m.node_id, new Set()).get(m.node_id)!).add(m.sprint_id);
    (this.membersBySprint.get(m.sprint_id) ?? this.membersBySprint.set(m.sprint_id, new Set()).get(m.sprint_id)!).add(m.node_id);
  }

  private removeMembership(id: Uuid): SprintMembership | undefined {
    const m = this.memberships.get(id);
    if (!m) return undefined;
    this.memberships.delete(id);
    const key = `${m.node_id}:${m.sprint_id}`;
    const count = (this.sprintPairCount.get(key) ?? 1) - 1;
    if (count > 0) {
      this.sprintPairCount.set(key, count);
      return m; // another membership still links this pair
    }
    this.sprintPairCount.delete(key);
    this.sprintIdsByNode.get(m.node_id)?.delete(m.sprint_id);
    this.membersBySprint.get(m.sprint_id)?.delete(m.node_id);
    return m;
  }

  private inActiveSprint(nodeId: Uuid, at: Instant): boolean {
    const day = bucketDate(at, this.dayResetHour, this.timezone);
    const candidates = [nodeId, ...this.ancestorsOf(nodeId)];
    for (const id of candidates) {
      const sprintIds = this.sprintIdsByNode.get(id);
      if (!sprintIds) continue;
      for (const sprintId of sprintIds) {
        const sprint = this.sprints.get(sprintId);
        if (sprint && sprint.starts_on <= day && day <= sprint.ends_on) return true;
      }
    }
    return false;
  }

  private ancestorsOf(id: Uuid): Uuid[] {
    const out: Uuid[] = [];
    const seen = new Set<Uuid>([id]);
    let current = this.nodes.get(id);
    while (current && current.parent_id !== null && !seen.has(current.parent_id)) {
      const parent = this.nodes.get(current.parent_id);
      if (!parent) break;
      out.push(parent.id);
      seen.add(parent.id);
      current = parent;
    }
    return out;
  }

  private refreshBlockers(): void {
    this.enabledBlockers = [...this.blockerRules.values()].filter((r) => r.deleted_at === null && r.enabled);
    const json = JSON.stringify(this.enabledBlockers.map((r) => r.predicate));
    this.usesProjectPhase = json.includes('project.phase');
    this.usesWeather = json.includes('weather.');
  }

  private refreshWeather(): void {
    this.weatherByKey = new Map();
    this.weatherBySegment = new Map();
    for (const fact of this.externalFacts.values()) {
      if (fact.deleted_at !== null || fact.kind !== 'weather_forecast') continue;
      this.weatherByKey.set(fact.key, fact);
      const segment = fact.key.split('/').at(-1);
      if (segment !== undefined) {
        const existing = this.weatherBySegment.get(segment);
        if (!existing || fact.computed_at > existing.computed_at) this.weatherBySegment.set(segment, fact);
      }
    }
  }

  private allTaskIds(): Uuid[] {
    const ids: Uuid[] = [];
    for (const n of this.nodes.values()) if (n.node_type === 'task') ids.push(n.id);
    return ids;
  }

  private successorsOf(nodeId: Uuid): Uuid[] {
    return outgoingEdges(this.edgeIndex, nodeId).map((e) => e.successor_id);
  }

  private descendantIds(nodeId: Uuid): Uuid[] {
    return descendantsOf(this.tree, nodeId).map((n) => n.id);
  }

  // --- apply -----------------------------------------------------------------

  apply(effects: readonly StatusEffect[]): StatusApplyResult {
    const dirty = new Set<Uuid>();
    for (const effect of effects) this.applyOne(effect, dirty);
    return this.recompute(dirty);
  }

  private applyOne(effect: StatusEffect, dirty: Set<Uuid>): void {
    const id = effect.row_id;
    switch (effect.table) {
      case 'nodes':
        return this.applyNode(effect, dirty);
      case 'edges':
        return this.applyEdge(effect, dirty);
      case 'time_entries':
        return this.applyEntry(effect, dirty);
      case 'schedule_blocks':
        return this.applyBlock(effect, dirty);
      case 'sprint_memberships':
        return this.applyMembership(effect, dirty);
      case 'sprints':
        return this.applySprint(effect, dirty);
      case 'blocker_rules':
        return this.applyBlockerRule(effect, dirty);
      case 'external_facts':
        return this.applyExternalFact(effect, dirty);
      case 'user_settings': {
        if (effect.fields['day_reset_hour'] != null) this.dayResetHour = Number(effect.fields['day_reset_hour']);
        if (effect.fields['timezone'] != null) this.timezone = String(effect.fields['timezone']);
        const view = this.view as { dayResetHour: number; timezone: string };
        view.dayResetHour = this.dayResetHour;
        view.timezone = this.timezone;
        for (const t of this.allTaskIds()) dirty.add(t);
        return;
      }
      default:
        // a table that does not influence status (tags, decisions, …) is ignored.
        void id;
        return;
    }
  }

  private applyNode(effect: StatusEffect, dirty: Set<Uuid>): void {
    const id = effect.row_id;
    if (effect.op === 'delete' || effect.fields['deleted_at'] != null) {
      const existed = this.nodes.get(id);
      if (existed) {
        this.removeChild(existed.parent_id, id);
        this.nodes.delete(id);
        for (const s of this.successorsOf(id)) dirty.add(s);
      }
      this.statusByNode.delete(id);
      if (this.usesProjectPhase) for (const t of this.allTaskIds()) dirty.add(t);
      return;
    }
    const existing = this.nodes.get(id);
    if (!existing) {
      this.addNode(toNode(id, effect.fields));
      dirty.add(id);
    } else {
      const parentChanged = 'parent_id' in effect.fields && str(effect.fields['parent_id']) !== existing.parent_id;
      const completedChanged = 'completed_at' in effect.fields && str(effect.fields['completed_at']) !== existing.completed_at;
      if (parentChanged) this.removeChild(existing.parent_id, id);
      Object.assign(existing, this.coerceNode(effect.fields));
      if (parentChanged) {
        const list = this.childrenByParent.get(existing.parent_id);
        if (list) list.push(existing);
        else this.childrenByParent.set(existing.parent_id, [existing]);
        for (const d of this.descendantIds(id)) dirty.add(d);
      }
      dirty.add(id);
      if (completedChanged) for (const s of this.successorsOf(id)) dirty.add(s);
      if (this.usesProjectPhase && completedChanged) for (const t of this.allTaskIds()) dirty.add(t);
    }
  }

  /** Coerce only the node columns present in an update's fields. */
  private coerceNode(f: Readonly<Record<string, unknown>>): Partial<Node> {
    const out: Record<string, unknown> = {};
    for (const key of ['parent_id', 'node_type', 'title', 'description', 'sort_order', 'start_date', 'due_date', 'completed_at', 'completion_disposition', 'completed_in_block_id', 'habit_id', 'attributes', 'deleted_at'] as const) {
      if (key in f) out[key] = f[key];
    }
    if ('estimate_minutes' in f) out['estimate_minutes'] = f['estimate_minutes'] == null ? null : Number(f['estimate_minutes']);
    return out as Partial<Node>;
  }

  private applyEdge(effect: StatusEffect, dirty: Set<Uuid>): void {
    if (effect.op === 'delete' || effect.fields['deleted_at'] != null) {
      const removed = this.removeEdge(effect.row_id);
      if (removed) dirty.add(removed.successor_id);
      return;
    }
    if (this.edgesById.has(effect.row_id)) {
      const old = this.removeEdge(effect.row_id);
      if (old) dirty.add(old.successor_id);
    }
    const edge = { id: effect.row_id, ...effect.fields } as unknown as Edge;
    this.addEdge(edge);
    dirty.add(edge.successor_id);
  }

  private applyEntry(effect: StatusEffect, dirty: Set<Uuid>): void {
    const markTask = (taskId: Uuid) => {
      dirty.add(taskId);
      for (const s of this.successorsOf(taskId)) dirty.add(s);
      if (this.usesProjectPhase) for (const t of this.allTaskIds()) dirty.add(t);
    };
    if (effect.op === 'delete' || effect.fields['deleted_at'] != null) {
      const removed = this.removeEntry(effect.row_id);
      if (removed) markTask(removed.task_id);
      return;
    }
    const existing = this.entries.get(effect.row_id);
    if (existing) this.removeEntry(effect.row_id);
    const entry = { id: effect.row_id, ...(existing ?? {}), ...effect.fields } as unknown as TimeEntry;
    this.addEntry(entry);
    markTask(entry.task_id);
  }

  private applyBlock(effect: StatusEffect, dirty: Set<Uuid>): void {
    const markTask = (taskId: Uuid) => {
      dirty.add(taskId);
      if (this.usesProjectPhase) for (const t of this.allTaskIds()) dirty.add(t);
    };
    if (effect.op === 'delete' || effect.fields['deleted_at'] != null) {
      const removed = this.removeBlock(effect.row_id);
      if (removed) markTask(removed.task_id);
      return;
    }
    const existing = this.blocks.get(effect.row_id);
    if (existing) this.removeBlock(effect.row_id);
    const block = { id: effect.row_id, ...(existing ?? {}), ...effect.fields } as unknown as ScheduleBlock;
    this.addBlock(block);
    markTask(block.task_id);
  }

  private applyMembership(effect: StatusEffect, dirty: Set<Uuid>): void {
    const mark = (nodeId: Uuid) => {
      dirty.add(nodeId);
      for (const d of this.descendantIds(nodeId)) dirty.add(d);
    };
    if (effect.op === 'delete' || effect.fields['deleted_at'] != null) {
      const removed = this.removeMembership(effect.row_id);
      if (removed) mark(removed.node_id);
      return;
    }
    const existing = this.memberships.get(effect.row_id);
    if (existing) this.removeMembership(effect.row_id);
    const m = { id: effect.row_id, ...(existing ?? {}), ...effect.fields } as unknown as SprintMembership;
    this.addMembership(m);
    mark(m.node_id);
  }

  private applySprint(effect: StatusEffect, dirty: Set<Uuid>): void {
    const markMembers = (sprintId: Uuid) => {
      for (const nodeId of this.membersBySprint.get(sprintId) ?? []) {
        dirty.add(nodeId);
        for (const d of this.descendantIds(nodeId)) dirty.add(d);
      }
    };
    if (effect.op === 'delete' || effect.fields['deleted_at'] != null) {
      this.sprints.delete(effect.row_id);
      markMembers(effect.row_id);
      return;
    }
    const existing = this.sprints.get(effect.row_id);
    this.sprints.set(effect.row_id, { id: effect.row_id, ...(existing ?? {}), ...effect.fields } as unknown as Sprint);
    markMembers(effect.row_id);
  }

  private applyBlockerRule(effect: StatusEffect, dirty: Set<Uuid>): void {
    if (effect.op === 'delete' || effect.fields['deleted_at'] != null) {
      this.blockerRules.delete(effect.row_id);
    } else {
      const existing = this.blockerRules.get(effect.row_id);
      this.blockerRules.set(effect.row_id, { id: effect.row_id, ...(existing ?? {}), ...effect.fields } as unknown as BlockerRule);
    }
    this.refreshBlockers();
    for (const t of this.allTaskIds()) dirty.add(t); // blocker rules can match broadly
  }

  private applyExternalFact(effect: StatusEffect, dirty: Set<Uuid>): void {
    if (effect.op === 'delete' || effect.fields['deleted_at'] != null) {
      this.externalFacts.delete(effect.row_id);
    } else {
      const existing = this.externalFacts.get(effect.row_id);
      this.externalFacts.set(effect.row_id, { id: effect.row_id, ...(existing ?? {}), ...effect.fields } as unknown as ExternalFact);
    }
    this.refreshWeather();
    if (this.usesWeather) for (const t of this.allTaskIds()) dirty.add(t);
  }

  private recompute(dirty: Set<Uuid>): StatusApplyResult {
    const changed: Uuid[] = [];
    const recomputed: Uuid[] = [];
    for (const id of dirty) {
      const node = this.nodes.get(id);
      if (!node || node.node_type !== 'task') {
        if (this.statusByNode.delete(id)) changed.push(id);
        continue;
      }
      recomputed.push(id);
      const next = taskStatus(node, this.view, this.now);
      if (this.statusByNode.get(id) !== next) {
        this.statusByNode.set(id, next);
        changed.push(id);
      }
    }
    return { changed, recomputed };
  }
}
