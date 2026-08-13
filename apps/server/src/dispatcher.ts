/**
 * Command dispatcher — the §8 write path, full §8.1 catalog (s11), with the
 * §7.3/§7.4 convergence rules (s12).
 *
 * Pipeline per command: (1) Zod parse against the catalog schema → (2)
 * ownership: every referenced row's user_id must equal the token user → (3)
 * invariant checks from @prisms/core → (4) apply via Drizzle in a transaction
 * → (5) append command_log. The command id is the idempotency key.
 *
 * Convergence (s12):
 * - Same-field conflicts resolve by HLC, not arrival order (§7.3): field
 *   updates pass through `lwwFields`, which only writes a field when the
 *   command's HLC beats the last writer's (tracked in command_field_versions).
 * - Creates are idempotent by row id (§9.4): a row that already exists is a
 *   converged no-op, so duplicate server automation backstops agree.
 * - Double clock-in resolves by §7.4 (latest started_at stays open).
 */
import {
  COMMAND_SCHEMAS,
  asEpochMillis,
  buildEdgeIndex,
  buildFactContext,
  buildTreeIndex,
  checkActivityPromote,
  checkBlockCreate,
  checkBlockMove,
  checkClockOut,
  checkCompletion,
  checkEdgeCreate,
  checkHabitVision,
  checkNodeCreate,
  checkNodeMove,
  checkNodeRetype,
  checkRule,
  checkStepParent,
  incomingEdges,
  isBlockedForAcceptance,
  isClientTooOld,
  isCommandName,
  renormalizedOrders,
  resolveOpenTimeEntries,
  runAutomations,
  softDeleteClosure,
  stripTrustFields,
  uploadRequestSchema,
  ROW_SCHEMA_VERSION,
  type AutomationRule,
  type CommandName,
  type CommandOutcome,
  type DomainError,
  type Edge as CoreEdge,
  type EdgeIndex,
  type FactContext,
  type Node as CoreNode,
  type Result,
  type TreeIndex,
} from '@prisms/core';
import {
  automation_rules,
  blocker_rules,
  command_field_versions,
  command_log,
  decision_boards,
  decision_criteria,
  decision_scores,
  diagram_groups,
  diagram_layouts,
  edges,
  external_facts,
  habit_completions,
  habits,
  journal_entries,
  nodes,
  schedule_blocks,
  sprint_memberships,
  sprints,
  sync_review_items,
  tag_answers,
  tag_placements,
  tags,
  task_steps,
  time_entries,
  user_settings,
} from '@prisms/db';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { z } from 'zod';

import type { RateLimiter } from './rate-limit';

type Db = PostgresJsDatabase;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Payload<N extends CommandName> = z.infer<(typeof COMMAND_SCHEMAS)[N]>;

export interface BackstopJob {
  userId: string;
  trigger: 'task_created' | 'task_completed';
  nodeId: string;
}

/**
 * A compact §7.2f effect summary written to `command_log.effects` (S4-F3/D3):
 * which rows a command created/updated/deleted (+ the field names it wrote),
 * and — for automation-spawned rows — the user command that triggered them.
 * User-facing recoverability + undo groundwork; not a replacement for the facts.
 */
interface EffectSummary {
  table: string;
  row_id: string;
  op: 'insert' | 'update' | 'delete';
  fields?: readonly string[];
  triggering_command_id?: string;
}

type HandlerRejected = { status: 'rejected'; code: string; reason: string };
type HandlerOut = { status: 'applied'; backstop?: BackstopJob } | HandlerRejected;

/** A command envelope as received (§7.2e adds depends_on; §8 adds versions). */
interface Cmd {
  id: string;
  name: string;
  hlc: string;
  payload: unknown;
  depends_on?: readonly string[];
  command_version?: number;
  schema_version?: number;
  client_version?: string;
}

/** The lowest client row schema_version the server still accepts (§7.11). */
const MIN_CLIENT_SCHEMA_VERSION = ROW_SCHEMA_VERSION;

/** The FactContext-backing tables the per-batch context cache tracks (S4-F2). */
const CONTEXT_TABLES = ['nodes', 'edges', 'time_entries', 'schedule_blocks', 'sprints', 'sprint_memberships', 'blocker_rules', 'external_facts', 'user_settings'] as const;
type ContextTable = (typeof CONTEXT_TABLES)[number];

/**
 * Which context tables a command may write — the per-batch cache invalidates
 * these after the command applies (S4-F2). MUST be a SUPERSET of the command's
 * actual context writes; a command ABSENT here invalidates ALL context tables
 * (the safe default). Over-invalidation only costs a reload, never correctness.
 * Verbs writing only non-context tables (habit_*, decision, automation_rules,
 * diagram, tags, review) are absent → they invalidate all (safe; they don't
 * read the heavy context anyway). node.create/check_off/activity.promote include
 * `edges` because their task_created/completed automation may spawn edges.
 */
const CONTEXT_WRITES: Partial<Record<CommandName, readonly ContextTable[]>> = {
  'node.create': ['nodes', 'edges'],
  'node.check_off': ['nodes', 'edges'],
  'activity.promote': ['nodes', 'edges'],
  'node.rename': ['nodes'],
  'node.set_description': ['nodes'],
  'node.set_attributes': ['nodes'],
  'node.move': ['nodes'],
  'node.retype': ['nodes'],
  'node.set_dates': ['nodes'],
  'node.set_estimate': ['nodes'],
  'node.reorder': ['nodes'],
  'node.uncheck': ['nodes'],
  'node.soft_delete': ['nodes'],
  'edge.create': ['edges'],
  'edge.delete': ['edges'],
  'block.create': ['schedule_blocks'],
  'block.move': ['schedule_blocks'],
  'block.set_anchor': ['schedule_blocks'],
  'block.delete': ['schedule_blocks'],
  'block.accept_suggestion': ['schedule_blocks'],
  'block.reject_suggestion': ['schedule_blocks'],
  'timer.clock_in': ['time_entries'],
  'timer.clock_out': ['time_entries'],
  'timer.review': ['time_entries'],
  'settings.update': ['user_settings'],
  // task_steps is NOT a context table (steps have no status/schedule/estimate,
  // D4) — a step command invalidates NO context, so an explicit empty set beats
  // the absent-means-invalidate-all default.
  'step.add': [],
  'step.rename': [],
  'step.toggle': [],
  'step.reorder': [],
  'step.remove': [],
};

/** Map a rejection code to the review-item it produces (§7.13). */
function reviewItemFor(code: string) {
  if (code === 'E_CLIENT_TOO_OLD') return { item_type: 'schema_version_block', severity: 'error' } as const;
  if (code === 'E_DEPENDENCY_REJECTED') return { item_type: 'dependency_rejection', severity: 'warning' } as const;
  if (code === 'E_STALE_SUGGESTION') return { item_type: 'stale_suggestion', severity: 'warning' } as const;
  return { item_type: 'command_rejection', severity: 'warning' } as const;
}

export type UploadResponse =
  | { kind: 'parse_error'; issues: unknown }
  | { kind: 'rate_limited'; verb: string; retryAfterSeconds: number }
  | { kind: 'ok'; results: CommandOutcome[] };

export interface Dispatcher {
  handleUpload(userId: string, body: unknown): Promise<UploadResponse>;
}

const reject = (code: string, reason: string): HandlerRejected => ({ status: 'rejected', code, reason });
const ownershipReject = (kind: string, id: string, row: { user_id: string } | undefined, userId: string): HandlerRejected | null => {
  if (!row) return reject('E_NOT_FOUND', `${kind} ${id} not found`);
  if (row.user_id !== userId) return reject('E_OWNERSHIP', `${kind} ${id} belongs to another user`);
  return null;
};
const fromCheck = (result: Result<void, DomainError>): HandlerRejected | null =>
  result.ok ? null : reject(result.error.code, result.error.message);

export function createDispatcher(
  db: Db,
  limiter: RateLimiter,
  options: {
    enqueueBackstop?: (job: BackstopJob) => void | Promise<void>;
    nowIso?: () => string;
    /** S4-F2 kill-switch / perf-test baseline: a fresh context per command (no cross-command reuse). */
    disableBatchCache?: boolean;
  } = {},
): Dispatcher {
  const nowIso = options.nowIso ?? (() => new Date().toISOString());

  const one = async <T>(rows: Promise<T[]>): Promise<T | undefined> => (await rows)[0];
  /**
   * SEC-7/F13: ownership-check an OPTIONAL habit reference. null/undefined is a
   * legitimate "no habit" and passes; a named habit must exist and belong to the
   * command's user. Returns a rejection, or null when the reference is fine.
   */
  const ownHabitRef = async (tx: Tx, habitId: string | null | undefined, userId: string): Promise<HandlerRejected | null> => {
    if (habitId === null || habitId === undefined) return null;
    return ownershipReject('habit', habitId, await one(tx.select().from(habits).where(eq(habits.id, habitId)).limit(1)), userId);
  };
  const loadNodeRow = (tx: Tx, id: string) => one(tx.select().from(nodes).where(eq(nodes.id, id)).limit(1));
  const loadStepRow = (tx: Tx, id: string) => one(tx.select().from(task_steps).where(eq(task_steps.id, id)).limit(1));
  const loadDecisionScoreByPair = (tx: Tx, criterionId: string, projectId: string) =>
    one(
      tx
        .select()
        .from(decision_scores)
        .where(and(eq(decision_scores.criterion_id, criterionId), eq(decision_scores.project_id, projectId)))
        .limit(1),
    );
  const loadLayoutByPair = (tx: Tx, diagramId: string, nodeId: string) =>
    one(
      tx
        .select()
        .from(diagram_layouts)
        .where(and(eq(diagram_layouts.diagram_id, diagramId), eq(diagram_layouts.node_id, nodeId)))
        .limit(1),
    );
  // tag placement/answer dedupe by their live (non-deleted) natural keys — the
  // partial unique indexes (WHERE deleted_at IS NULL) are the DB backstop.
  const loadTagPlacementByPair = (tx: Tx, blockId: string, tagId: string) =>
    one(
      tx
        .select()
        .from(tag_placements)
        .where(and(eq(tag_placements.block_id, blockId), eq(tag_placements.tag_id, tagId), isNull(tag_placements.deleted_at)))
        .limit(1),
    );
  const loadTagAnswerByPlacement = (tx: Tx, placementId: string) =>
    one(
      tx
        .select()
        .from(tag_answers)
        .where(and(eq(tag_answers.placement_id, placementId), isNull(tag_answers.deleted_at)))
        .limit(1),
    );
  const loadTreeRaw = async (tx: Tx, userId: string): Promise<TreeIndex> =>
    buildTreeIndex(await tx.select().from(nodes).where(eq(nodes.user_id, userId)));
  const loadEdgeIndexRaw = async (tx: Tx, userId: string) =>
    buildEdgeIndex(await tx.select().from(edges).where(and(eq(edges.user_id, userId), isNull(edges.deleted_at))));
  // The full FactContext for server-side status checks (completion gate §7.6,
  // blocked-task clock-in §8). The 9 table reads run CONCURRENTLY (S4-F2: was 9
  // sequential round-trips per gated command).
  const loadFactContextRaw = async (tx: Tx, userId: string): Promise<FactContext> => {
    const [nodeRows, edgeRows, entryRows, blockRows, sprintRows, membershipRows, blockerRows, factRows, settings] = await Promise.all([
      tx.select().from(nodes).where(eq(nodes.user_id, userId)),
      tx.select().from(edges).where(eq(edges.user_id, userId)),
      tx.select().from(time_entries).where(eq(time_entries.user_id, userId)),
      tx.select().from(schedule_blocks).where(eq(schedule_blocks.user_id, userId)),
      tx.select().from(sprints).where(eq(sprints.user_id, userId)),
      tx.select().from(sprint_memberships).where(eq(sprint_memberships.user_id, userId)),
      tx.select().from(blocker_rules).where(eq(blocker_rules.user_id, userId)),
      tx.select().from(external_facts).where(eq(external_facts.user_id, userId)),
      one(tx.select().from(user_settings).where(eq(user_settings.user_id, userId)).limit(1)),
    ]);
    return buildFactContext({
      nodes: nodeRows,
      edges: edgeRows,
      time_entries: entryRows,
      schedule_blocks: blockRows,
      sprints: sprintRows,
      sprint_memberships: membershipRows,
      blocker_rules: blockerRows,
      external_facts: factRows,
      user_settings: settings ?? null,
    });
  };

  /**
   * §7.2/§7.5: each command applies in its own transaction, but a whole upload
   * BATCH is one user's sequential commands — so the heavy per-command context
   * loads (`loadTree`/`loadFactContext`, each an O(all-rows) read at 100k) can be
   * memoized ACROSS the batch and reloaded only when a prior command wrote the
   * underlying table (S4-F2). The built artifacts (tree/edgeIndex/factContext) are
   * cached lazily; `invalidate(tables)` clears the ones depending on a written
   * table. Commands read the context BEFORE they write (invariant checks), so the
   * cache always reflects the latest COMMITTED state per table; the in-txn
   * automation reads fresh (uncached) because it must see the handler's own write.
   */
  class BatchContext {
    private treeP?: Promise<TreeIndex>;
    private edgeIndexP?: Promise<EdgeIndex>;
    private factP?: Promise<FactContext>;
    tree(tx: Tx, userId: string): Promise<TreeIndex> {
      return (this.treeP ??= loadTreeRaw(tx, userId));
    }
    edgeIndex(tx: Tx, userId: string): Promise<EdgeIndex> {
      return (this.edgeIndexP ??= loadEdgeIndexRaw(tx, userId));
    }
    factContext(tx: Tx, userId: string): Promise<FactContext> {
      return (this.factP ??= loadFactContextRaw(tx, userId));
    }
    /** Clear cached artifacts that depend on any of the written context tables. */
    invalidate(tables: readonly ContextTable[]): void {
      if (tables.length === 0) return;
      if (tables.includes('nodes')) this.treeP = undefined;
      if (tables.includes('edges')) this.edgeIndexP = undefined;
      this.factP = undefined; // FactContext aggregates all 9 tables
    }
    invalidateAll(): void {
      this.treeP = this.edgeIndexP = this.factP = undefined;
    }
  }

  /**
   * §10.1 automation, run SYNCHRONOUSLY inside the command transaction and
   * re-applied authoritatively by the server. The pure rules engine computes
   * the full fixpoint (MAX_DEPTH=5) over the live fact set; spawned rows are
   * deterministic (UUIDv5) so two devices' triggers converge and a replay is a
   * structural no-op (ON CONFLICT DO NOTHING on the id). The async
   * automation-backstop (M6) is now only a drift/offline-gap safety-net.
   * Provenance is server-assigned: source_kind='automation', the triggering
   * command id, and the trigger in source_detail.
   */
  async function runAutomationInTx(tx: Tx, job: BackstopJob, commandId: string, hlc: string, effects: EffectSummary[]): Promise<void> {
    const triggerNode = (await loadNodeRow(tx, job.nodeId)) as CoreNode | undefined;
    if (!triggerNode || triggerNode.deleted_at !== null) return;
    const [nodeRows, edgeRows, ruleRows] = await Promise.all([
      tx.select().from(nodes).where(eq(nodes.user_id, job.userId)),
      tx.select().from(edges).where(and(eq(edges.user_id, job.userId), isNull(edges.deleted_at))),
      tx.select().from(automation_rules).where(and(eq(automation_rules.user_id, job.userId), isNull(automation_rules.deleted_at))),
    ]);
    const out = runAutomations({
      trigger: { kind: job.trigger, node: triggerNode },
      rules: ruleRows as AutomationRule[],
      rows: { nodes: nodeRows as CoreNode[], edges: edgeRows as CoreEdge[] },
    });
    // §7.13: a cascade cut off at MAX_DEPTH is surfaced as a warning (rare; deep fan-out).
    if (out.depthLimited) {
      const at = nowIso();
      await tx.insert(sync_review_items).values({
        id: randomUUID(),
        user_id: job.userId,
        command_id: commandId,
        item_type: 'sync_warning',
        severity: 'warning',
        title: 'Automation cascade reached the depth limit and was truncated',
        detail: { trigger_node_id: job.nodeId, reason: 'max_depth' },
        status: 'open',
        source_kind: 'server_job',
        created_at: at,
        updated_at: at,
      });
    }
    if (out.nodes.length === 0 && out.edges.length === 0) return;

    // §6.7: spawned rows are server-authoritative but must still satisfy the
    // hierarchy (I1) + justification (I3) invariants the user write-path enforces
    // — a rule whose template targets a type-illegal or absent parent must not
    // commit an invariant-violating row. Validate against live + spawned nodes
    // and drop any spawn that fails (and any edge that would dangle off it).
    const tree = buildTreeIndex([...(nodeRows as CoreNode[]), ...out.nodes]);
    const liveIds = new Set((nodeRows as CoreNode[]).filter((n) => n.deleted_at === null).map((n) => n.id));
    const keptNodeIds = new Set<string>();
    const keepNodes = out.nodes.filter((n) => {
      if (fromCheck(checkNodeCreate(tree, n))) return false; // I1/I3 violation → drop
      keptNodeIds.add(n.id);
      return true;
    });
    const endpointOk = (id: string) => liveIds.has(id) || keptNodeIds.has(id);
    const keepEdges = out.edges.filter((e) => endpointOk(e.predecessor_id) && endpointOk(e.successor_id));

    // §7.8 server-assigned provenance: real version-of-record hlc + current row
    // schema_version (not the engine's legacy sentinel/defaults), source_kind
    // 'automation', and the producing rule + slot.
    const provById = new Map(out.provenance.map((p) => [p.id, p]));
    const stampProv = <T extends { id: string }>(row: T) => {
      const p = provById.get(row.id);
      return {
        ...row,
        hlc,
        schema_version: ROW_SCHEMA_VERSION,
        source_kind: 'automation' as const,
        source_id: p?.rule_id ?? null,
        created_by_command_id: commandId,
        last_modified_by_command_id: commandId,
        // §10.2: attribute the rule + template version that produced the row so a
        // later drift item can name both generations (S3-F4).
        source_detail: {
          trigger_command_id: commandId,
          trigger_node_id: job.nodeId,
          action_slot: p?.slot ?? null,
          rule_version: p?.rule_version ?? null,
          template_version: p?.template_version ?? null,
        },
      };
    };

    // §10.1: automation is authoritative but best-effort — a residual stored-rule
    // defect must NOT roll back the user's command. Run the inserts in a SAVEPOINT
    // so any failure rolls back only the automation; the enqueued backstop (M6)
    // retries. Bare onConflictDoNothing() skips on ANY unique index (the id PK and
    // the §7.7 partial endpoint index on edges), not just the id.
    const spawned: EffectSummary[] = [];
    try {
      await tx.transaction(async (sp) => {
        for (const node of keepNodes) {
          const r = await sp.insert(nodes).values(stampProv(node) as typeof nodes.$inferInsert).onConflictDoNothing();
          if ((r.count ?? 0) > 0) spawned.push({ table: 'nodes', row_id: node.id, op: 'insert', triggering_command_id: commandId });
        }
        for (const edge of keepEdges) {
          const r = await sp.insert(edges).values(stampProv(edge) as typeof edges.$inferInsert).onConflictDoNothing();
          if ((r.count ?? 0) > 0) spawned.push({ table: 'edges', row_id: edge.id, op: 'insert', triggering_command_id: commandId });
        }
      });
      // §7.2f: record the actually-inserted spawns (a replay's no-op skips) only
      // after the SAVEPOINT committed, attributed to the triggering command (S4-F3).
      effects.push(...spawned);
    } catch {
      // automation rolled back atomically; the command + command_log still commit.
    }
  }

  /**
   * §7.13: when a field write LOSES last-writer-wins to a strictly-newer writer
   * and its value materially differs from the winner, surface an `hlc_conflict`
   * review item that preserves the losing value so the user can reconcile. The
   * materiality check (value actually differs) keeps convergent re-writes — same
   * value, older HLC — from creating noise. The winning value is read with safe
   * identifier quoting; `table`/`field` are internal catalog constants, not input.
   */
  async function maybeHlcConflict(
    tx: Tx,
    userId: string,
    table: string,
    rowId: string,
    field: string,
    losingValue: unknown,
    winningHlc: string,
    losingHlc: string,
  ): Promise<void> {
    const res = (await tx.execute(
      sql`SELECT ${sql.identifier(field)} AS v FROM ${sql.identifier(table)} WHERE id = ${rowId} LIMIT 1`,
    )) as unknown as { v: unknown }[];
    const winningValue = res[0]?.v;
    if (winningValue === undefined) return;
    if (JSON.stringify(winningValue) === JSON.stringify(losingValue)) return; // not materially different
    const at = nowIso();
    await tx.insert(sync_review_items).values({
      id: randomUUID(),
      user_id: userId,
      command_id: null,
      item_type: 'hlc_conflict',
      severity: 'warning',
      title: `A concurrent edit to ${table}.${field} won; your older value was not applied`,
      detail: { table, row_id: rowId, field, winning_value: winningValue, losing_value: losingValue, winning_hlc: winningHlc, losing_hlc: losingHlc } as typeof sync_review_items.$inferInsert.detail,
      status: 'open',
      source_kind: 'system',
      created_at: at,
      updated_at: at,
    });
  }

  /**
   * §7.3 last-writer-wins by HLC. Returns the subset of `candidate` fields
   * whose incoming HLC beats the recorded last writer (and records the new
   * winner). HLC strings are zero-padded so lexical compare == HLC order.
   * Losing fields are not written; a strictly-older material loss raises an
   * `hlc_conflict` item (§7.13).
   */
  async function lwwFields<T extends Record<string, unknown>>(
    tx: Tx,
    hlc: string,
    userId: string,
    table: string,
    rowId: string,
    candidate: T,
  ): Promise<Partial<T>> {
    const winning: Partial<T> = {};
    for (const key of Object.keys(candidate) as (keyof T & string)[]) {
      const current = await one(
        tx
          .select({ hlc: command_field_versions.hlc })
          .from(command_field_versions)
          .where(and(eq(command_field_versions.table_name, table), eq(command_field_versions.row_id, rowId), eq(command_field_versions.field, key)))
          .limit(1),
      );
      if (!current || hlc > current.hlc) {
        winning[key] = candidate[key];
        await tx
          .insert(command_field_versions)
          .values({ user_id: userId, table_name: table, row_id: rowId, field: key, hlc })
          .onConflictDoUpdate({
            target: [command_field_versions.table_name, command_field_versions.row_id, command_field_versions.field],
            set: { hlc },
          });
      } else if (hlc < current.hlc) {
        // strictly older than the recorded winner → a losing concurrent write.
        // (hlc === current.hlc is an idempotent replay/tie, not a conflict.)
        await maybeHlcConflict(tx, userId, table, rowId, key, candidate[key], current.hlc, hlc);
      }
    }
    return winning;
  }

  async function runHandler(name: CommandName, tx: Tx, userId: string, deviceId: string, commandId: string, hlc: string, payload: unknown, batchCtx: BatchContext, effects: EffectSummary[]): Promise<HandlerOut> {
    const now = nowIso();
    /** Record a §7.2f effect summary entry (S4-F3). */
    const rec = (table: string, rowId: string, op: 'insert' | 'update' | 'delete', fields?: readonly string[]): void => {
      effects.push(fields && fields.length ? { table, row_id: rowId, op, fields } : { table, row_id: rowId, op });
    };
    const nowMs = asEpochMillis(Date.parse(now));
    // §7.2c server-assigned trust fields. `sys` stamps every update (the row's
    // last writer + hlc); `born` adds create-time provenance for inserts. The
    // command id is the provenance link (== command_log.id, §7.2b). Client
    // values for these are stripped before parse. (user_settings is exempt.)
    const sys = { updated_at: now, last_modified_by_command_id: commandId, hlc };
    const born = { ...sys, created_by_command_id: commandId, source_kind: 'user' as const, schema_version: ROW_SCHEMA_VERSION };
    const applied = (backstop?: BackstopJob): HandlerOut => ({ status: 'applied', backstop });
    /** §7.6 completion gate — load the context only when the task has predecessors. */
    const completionGate = async (task: CoreNode): Promise<HandlerOut | null> => {
      if (incomingEdges(await batchCtx.edgeIndex(tx, userId), task.id).length === 0) return null;
      return fromCheck(checkCompletion(task, await batchCtx.factContext(tx, userId), nowMs));
    };
    // §9.4 idempotent create: an existing row (same user) is a converged no-op.
    const convergeOrOwn = (existing: { user_id: string } | undefined, kind: string, id: string): HandlerOut | null =>
      !existing ? null : existing.user_id === userId ? { status: 'applied' } : reject('E_OWNERSHIP', `${kind} ${id} belongs to another user`);
    /** Ownership-checked, HLC-filtered single-row field update on `nodes`. */
    const updateNode = async (id: string, fields: Record<string, unknown>): Promise<HandlerOut> => {
      const own = ownershipReject('node', id, await loadNodeRow(tx, id), userId);
      if (own) return own;
      const win = await lwwFields(tx, hlc, userId, 'nodes', id, fields);
      const changed = Object.keys(win);
      if (changed.length > 0) {
        await tx.update(nodes).set({ ...win, ...sys }).where(eq(nodes.id, id));
        rec('nodes', id, 'update', changed);
      }
      return applied();
    };
    /** Ownership + parent-task gate (D4) then an HLC-filtered field update on `task_steps`. */
    const updateStep = async (id: string, fields: Record<string, unknown>): Promise<HandlerOut> => {
      const step = await loadStepRow(tx, id);
      const own = ownershipReject('step', id, step, userId);
      if (own) return own;
      const bad = fromCheck(checkStepParent((await loadNodeRow(tx, step!.task_id)) as CoreNode | undefined, step!.task_id));
      if (bad) return bad;
      const win = await lwwFields(tx, hlc, userId, 'task_steps', id, fields);
      const changed = Object.keys(win);
      if (changed.length > 0) {
        await tx.update(task_steps).set({ ...win, ...sys }).where(eq(task_steps.id, id));
        rec('task_steps', id, 'update', changed);
      }
      return applied();
    };

    switch (name) {
      // --- nodes ------------------------------------------------------------
      case 'node.create': {
        const p = payload as Payload<'node.create'>;
        const conv = convergeOrOwn(await loadNodeRow(tx, p.id), 'node', p.id);
        if (conv) return conv;
        const bad = fromCheck(checkNodeCreate(await batchCtx.tree(tx, userId), p));
        if (bad) return bad;
        // SEC-7/F13: a referenced habit must exist and be OURS. `nodes.habit_id`
        // carries no FK, and I3 justification only tests `habit_id !== null` —
        // so any uuid satisfied "this task traces to a real habit". Same check
        // tag.create already performs before writing its own habit_id.
        const ownHabit = await ownHabitRef(tx, p.habit_id, userId);
        if (ownHabit) return ownHabit;
        await tx.insert(nodes).values({
          id: p.id,
          user_id: userId,
          parent_id: p.parent_id ?? null,
          node_type: p.node_type,
          title: p.title,
          description: p.description ?? '',
          sort_order: p.sort_order,
          start_date: p.start_date ?? null,
          due_date: p.due_date ?? null,
          estimate_minutes: p.estimate_minutes ?? null,
          habit_id: p.habit_id ?? null,
          attributes: p.attributes ?? {},
          ...born,
        });
        rec('nodes', p.id, 'insert');
        return applied(p.node_type === 'task' ? { userId, trigger: 'task_created', nodeId: p.id } : undefined);
      }
      case 'node.rename': {
        const p = payload as Payload<'node.rename'>;
        return updateNode(p.id, { title: p.title });
      }
      case 'node.set_description': {
        const p = payload as Payload<'node.set_description'>;
        return updateNode(p.id, { description: p.description });
      }
      case 'node.set_attributes': {
        const p = payload as Payload<'node.set_attributes'>;
        // One LWW field for the whole bag (the verb replaces, never merges), so
        // two devices editing a vision's colour and horizon converge on one of
        // the two bags rather than a half-and-half node neither device wrote.
        return updateNode(p.id, { attributes: p.attributes });
      }
      case 'node.move': {
        const p = payload as Payload<'node.move'>;
        const own = ownershipReject('node', p.id, await loadNodeRow(tx, p.id), userId);
        if (own) return own;
        const bad = fromCheck(checkNodeMove(await batchCtx.tree(tx, userId), p));
        if (bad) return bad;
        const win = await lwwFields(tx, hlc, userId, 'nodes', p.id, { parent_id: p.new_parent_id, sort_order: p.sort_order });
        if (Object.keys(win).length > 0) {
          await tx.update(nodes).set({ ...win, ...sys }).where(eq(nodes.id, p.id));
          rec('nodes', p.id, 'update', Object.keys(win));
        }
        return applied();
      }
      case 'node.retype': {
        const p = payload as Payload<'node.retype'>;
        const own = ownershipReject('node', p.id, await loadNodeRow(tx, p.id), userId);
        if (own) return own;
        const bad = fromCheck(checkNodeRetype(await batchCtx.tree(tx, userId), p));
        if (bad) return bad;
        const win = await lwwFields(tx, hlc, userId, 'nodes', p.id, { node_type: p.node_type });
        if (Object.keys(win).length > 0) {
          await tx.update(nodes).set({ ...win, ...sys }).where(eq(nodes.id, p.id));
          rec('nodes', p.id, 'update', Object.keys(win));
        }
        return applied();
      }
      case 'node.set_dates': {
        const p = payload as Payload<'node.set_dates'>;
        const candidate: Record<string, unknown> = {};
        if ('start_date' in p) candidate['start_date'] = p.start_date ?? null;
        if ('due_date' in p) candidate['due_date'] = p.due_date ?? null;
        return updateNode(p.id, candidate);
      }
      case 'node.set_estimate': {
        const p = payload as Payload<'node.set_estimate'>;
        return updateNode(p.id, { estimate_minutes: p.estimate_minutes });
      }
      case 'node.reorder': {
        const p = payload as Payload<'node.reorder'>;
        return updateNode(p.id, { sort_order: p.sort_order });
      }
      case 'node.check_off': {
        const p = payload as Payload<'node.check_off'>;
        const row = await loadNodeRow(tx, p.id);
        const own = ownershipReject('node', p.id, row, userId);
        if (own) return own;
        // §7.6: cannot complete while an FF/FS/SF predecessor requirement is unmet.
        if (row!.completed_at === null) {
          const gate = await completionGate(row as CoreNode);
          if (gate) return gate;
        }
        // Phase 3: when a completing-in block is named, it must exist and be owned
        // (any owned committed block — an unscheduled task may be logged into one).
        if (p.completed_in_block_id != null) {
          const ownBlock = ownershipReject('block', p.completed_in_block_id, await one(tx.select().from(schedule_blocks).where(eq(schedule_blocks.id, p.completed_in_block_id)).limit(1)), userId);
          if (ownBlock) return ownBlock;
        }
        const win = await lwwFields(tx, hlc, userId, 'nodes', p.id, {
          completed_at: p.completed_at,
          completion_disposition: p.disposition ?? 'completed',
          completed_in_block_id: p.completed_in_block_id ?? null,
        });
        if (Object.keys(win).length > 0) {
          await tx.update(nodes).set({ ...win, ...sys }).where(eq(nodes.id, p.id));
          rec('nodes', p.id, 'update', Object.keys(win));
        }
        return applied(row!.node_type === 'task' ? { userId, trigger: 'task_completed', nodeId: p.id } : undefined);
      }
      case 'node.uncheck': {
        const p = payload as Payload<'node.uncheck'>;
        return updateNode(p.id, { completed_at: null, completion_disposition: null, completed_in_block_id: null });
      }
      case 'node.soft_delete': {
        const p = payload as Payload<'node.soft_delete'>;
        const own = ownershipReject('node', p.id, await loadNodeRow(tx, p.id), userId);
        if (own) return own;
        const ids = softDeleteClosure(await batchCtx.tree(tx, userId), p.id); // I10
        if (ids.length > 0) {
          await tx.update(nodes).set({ deleted_at: now, ...sys }).where(and(eq(nodes.user_id, userId), inArray(nodes.id, ids)));
          for (const id of ids) rec('nodes', id, 'delete');
          // D4 cascade: soft-delete the checklist steps of every deleted task.
          const stepRows = await tx
            .select({ id: task_steps.id })
            .from(task_steps)
            .where(and(eq(task_steps.user_id, userId), inArray(task_steps.task_id, ids), isNull(task_steps.deleted_at)));
          if (stepRows.length > 0) {
            await tx
              .update(task_steps)
              .set({ deleted_at: now, ...sys })
              .where(and(eq(task_steps.user_id, userId), inArray(task_steps.task_id, ids), isNull(task_steps.deleted_at)));
            for (const s of stepRows) rec('task_steps', s.id, 'delete');
          }
        }
        return applied();
      }
      case 'activity.promote': {
        const p = payload as Payload<'activity.promote'>;
        const own = ownershipReject('activity', p.id, await loadNodeRow(tx, p.id), userId);
        if (own) return own;
        const bad = fromCheck(checkActivityPromote(await batchCtx.tree(tx, userId), p));
        if (bad) return bad;
        // SEC-7/F13: as in node.create — promoting "via habit" must name a habit
        // we own, or the I3 justification it satisfies is fictional.
        const ownHabit = await ownHabitRef(tx, p.habit_id, userId);
        if (ownHabit) return ownHabit;
        const win = await lwwFields(tx, hlc, userId, 'nodes', p.id, { node_type: 'task' as const, parent_id: p.parent_id ?? null, habit_id: p.habit_id ?? null });
        if (Object.keys(win).length > 0) {
          await tx.update(nodes).set({ ...win, ...sys }).where(eq(nodes.id, p.id));
          rec('nodes', p.id, 'update', Object.keys(win));
        }
        return applied({ userId, trigger: 'task_created', nodeId: p.id });
      }

      // --- edges ------------------------------------------------------------
      case 'edge.create': {
        const p = payload as Payload<'edge.create'>;
        const conv = convergeOrOwn(await one(tx.select().from(edges).where(eq(edges.id, p.id)).limit(1)), 'edge', p.id);
        if (conv) return conv;
        const bad = fromCheck(checkEdgeCreate(await batchCtx.tree(tx, userId), await batchCtx.edgeIndex(tx, userId), p));
        if (bad) return bad;
        await tx.insert(edges).values({
          id: p.id,
          user_id: userId,
          predecessor_id: p.predecessor_id,
          successor_id: p.successor_id,
          edge_type: p.edge_type ?? 'FS',
          lag_minutes: p.lag_minutes ?? 0,
          ...born,
        });
        rec('edges', p.id, 'insert');
        return applied();
      }
      case 'edge.delete': {
        const p = payload as Payload<'edge.delete'>;
        const row = await one(tx.select().from(edges).where(eq(edges.id, p.id)).limit(1));
        const own = ownershipReject('edge', p.id, row, userId);
        if (own) return own;
        await tx.update(edges).set({ deleted_at: now, ...sys }).where(eq(edges.id, p.id));
        rec('edges', p.id, 'delete');
        return applied();
      }

      // --- schedule blocks --------------------------------------------------
      case 'block.create': {
        const p = payload as Payload<'block.create'>;
        const conv = convergeOrOwn(await one(tx.select().from(schedule_blocks).where(eq(schedule_blocks.id, p.id)).limit(1)), 'block', p.id);
        if (conv) return conv;
        const task = await loadNodeRow(tx, p.task_id);
        const own = ownershipReject('task', p.task_id, task, userId);
        if (own) return own;
        const bad = fromCheck(checkBlockCreate(task as CoreNode, p.task_id, p));
        if (bad) return bad;
        await tx.insert(schedule_blocks).values({
          id: p.id,
          user_id: userId,
          task_id: p.task_id,
          starts_at: p.starts_at,
          ends_at: p.ends_at,
          anchor_type: p.anchor_type ?? 'none',
          status: 'committed',
          ...born,
        });
        rec('schedule_blocks', p.id, 'insert');
        return applied();
      }
      case 'block.move': {
        const p = payload as Payload<'block.move'>;
        const block = await one(tx.select().from(schedule_blocks).where(eq(schedule_blocks.id, p.id)).limit(1));
        const own = ownershipReject('block', p.id, block, userId);
        if (own) return own;
        const task = await loadNodeRow(tx, block!.task_id);
        const bad = fromCheck(checkBlockMove(block!, p.id, task as CoreNode | undefined, p));
        if (bad) return bad;
        const win = await lwwFields(tx, hlc, userId, 'schedule_blocks', p.id, { starts_at: p.starts_at, ends_at: p.ends_at });
        if (Object.keys(win).length > 0) await tx.update(schedule_blocks).set({ ...win, ...sys }).where(eq(schedule_blocks.id, p.id));
        return applied();
      }
      case 'block.set_anchor': {
        const p = payload as Payload<'block.set_anchor'>;
        const block = await one(tx.select().from(schedule_blocks).where(eq(schedule_blocks.id, p.id)).limit(1));
        const own = ownershipReject('block', p.id, block, userId);
        if (own) return own;
        const win = await lwwFields(tx, hlc, userId, 'schedule_blocks', p.id, { anchor_type: p.anchor_type });
        if (Object.keys(win).length > 0) await tx.update(schedule_blocks).set({ ...win, ...sys }).where(eq(schedule_blocks.id, p.id));
        return applied();
      }
      case 'block.delete': {
        const p = payload as Payload<'block.delete'>;
        const block = await one(tx.select().from(schedule_blocks).where(eq(schedule_blocks.id, p.id)).limit(1));
        const own = ownershipReject('block', p.id, block, userId);
        if (own) return own;
        await tx.update(schedule_blocks).set({ deleted_at: now, ...sys }).where(eq(schedule_blocks.id, p.id));
        return applied();
      }
      case 'block.accept_suggestion': {
        // §7.5 accept transaction, run atomically inside the command txn.
        const p = payload as Payload<'block.accept_suggestion'>;
        const block = await one(tx.select().from(schedule_blocks).where(eq(schedule_blocks.id, p.id)).limit(1));
        const own = ownershipReject('block', p.id, block, userId);
        if (own) return own;
        // not superseded or deleted (a stale batch cannot be accepted).
        if (block!.deleted_at !== null || block!.superseded_at !== null) {
          return reject('E_STALE_SUGGESTION', `suggestion ${p.id} is superseded or deleted (§7.5)`);
        }
        // already committed ⇒ converged no-op (idempotent accept).
        if (block!.status !== 'suggested') return applied();
        // the task must not be done (I8).
        const task = await loadNodeRow(tx, block!.task_id);
        if (task && task.completed_at !== null) return reject('E_DONE_IMMUTABLE', `task ${block!.task_id} is done (I8)`);
        // normalize timestamptz strings the way timer.clock_in does (postgres-js
        // returns "YYYY-MM-DD HH:MM:SS+00"); compare numerically.
        const toMs = (s: string) => new Date(s).getTime();
        const startMs = toMs(block!.starts_at);
        const endMs = toMs(block!.ends_at);
        const overlaps = (s: string, e: string) => startMs < toMs(e) && toMs(s) < endMs;
        // reject if it overlaps an anchored committed block (I9).
        const committed = await tx
          .select()
          .from(schedule_blocks)
          .where(and(eq(schedule_blocks.user_id, userId), eq(schedule_blocks.status, 'committed'), isNull(schedule_blocks.deleted_at)));
        for (const b of committed) {
          if (b.id === block!.id || b.anchor_type === 'none') continue;
          if (overlaps(b.starts_at, b.ends_at)) {
            return reject('E_SUGGESTION_OVERLAPS_ANCHOR', `suggestion overlaps anchored block ${b.id} (I9)`);
          }
        }
        // soft-delete the flexible block this suggestion replaces, if any.
        if (block!.replaces_block_id !== null) {
          await tx
            .update(schedule_blocks)
            .set({ deleted_at: now, ...sys })
            .where(and(eq(schedule_blocks.id, block!.replaces_block_id), eq(schedule_blocks.user_id, userId)));
        }
        // promote to committed; a committed block carries no suggestion metadata (§7.5).
        await tx
          .update(schedule_blocks)
          .set({ status: 'committed', suggestion_reason: null, suggestion_batch_id: null, replaces_block_id: null, superseded_at: null, ...sys })
          .where(eq(schedule_blocks.id, block!.id));
        // supersede other live suggestions for the same task that overlap it.
        const siblings = await tx
          .select()
          .from(schedule_blocks)
          .where(
            and(
              eq(schedule_blocks.user_id, userId),
              eq(schedule_blocks.task_id, block!.task_id),
              eq(schedule_blocks.status, 'suggested'),
              isNull(schedule_blocks.deleted_at),
              isNull(schedule_blocks.superseded_at),
            ),
          );
        for (const o of siblings) {
          if (o.id === block!.id) continue;
          if (overlaps(o.starts_at, o.ends_at)) {
            await tx.update(schedule_blocks).set({ superseded_at: now, ...sys }).where(eq(schedule_blocks.id, o.id));
          }
        }
        return applied();
      }
      case 'block.reject_suggestion': {
        // §7.5: soft-delete only the suggestion.
        const p = payload as Payload<'block.reject_suggestion'>;
        const block = await one(tx.select().from(schedule_blocks).where(eq(schedule_blocks.id, p.id)).limit(1));
        const own = ownershipReject('block', p.id, block, userId);
        if (own) return own;
        await tx.update(schedule_blocks).set({ deleted_at: now, ...sys }).where(eq(schedule_blocks.id, p.id));
        return applied();
      }

      // --- time tracking ----------------------------------------------------
      case 'timer.clock_in': {
        const p = payload as Payload<'timer.clock_in'>;
        const conv = convergeOrOwn(await one(tx.select().from(time_entries).where(eq(time_entries.id, p.entry_id)).limit(1)), 'time entry', p.entry_id);
        if (conv) return conv;
        const task = await loadNodeRow(tx, p.task_id);
        const own = ownershipReject('task', p.task_id, task, userId);
        if (own) return own;
        if ((task as CoreNode).completed_at !== null) return reject('E_DONE_IMMUTABLE', `task ${p.task_id} is done (I8)`);
        // §8/§10.3/R19: clocking into a blocked task is rejected unless force —
        // but ONLY dependency/non-external blocking gates acceptance.
        // `isBlockedForAcceptance` excludes weather-reading blocker rules, so an
        // advisory-weather-only-blocked task clocks in WITHOUT force (external
        // facts must never cause a rejection or divergence, V10). The display
        // path (client badges) still shows it weather-blocked/unverified.
        if (!p.force && isBlockedForAcceptance(task as CoreNode, await batchCtx.factContext(tx, userId), nowMs)) {
          return reject('E_BLOCKED_TASK', `task ${p.task_id} is blocked; clock in with force to override (§8)`);
        }

        const openEntry = await one(
          tx.select().from(time_entries).where(and(eq(time_entries.user_id, userId), isNull(time_entries.ended_at), isNull(time_entries.deleted_at))).limit(1),
        );
        const insertEntry = async (endedAt: string | null): Promise<void> => {
          await tx.insert(time_entries).values({
            id: p.entry_id,
            user_id: userId,
            task_id: p.task_id,
            started_at: p.started_at,
            ended_at: endedAt,
            completed_session: endedAt === null ? undefined : null,
            planned: p.planned ?? true,
            device_id: deviceId,
            ...born,
          });
          rec('time_entries', p.entry_id, 'insert');
        };

        if (!openEntry) {
          await insertEntry(null);
          return applied();
        }
        // I5: a second clock-in on the SAME device is a straight rejection.
        if (openEntry.device_id === deviceId) {
          return reject('E_TIMER_ALREADY_RUNNING', 'another timer is already running on this device (I5)');
        }
        // §7.4: cross-device offline race — latest started_at stays open.
        // Normalize the stored timestamp to ISO so it compares correctly with
        // the ISO payload (Postgres returns "YYYY-MM-DD HH:MM:SS+00").
        const res = resolveOpenTimeEntries([
          { id: openEntry.id, started_at: new Date(openEntry.started_at).toISOString() },
          { id: p.entry_id, started_at: p.started_at },
        ])!;
        if (res.keepOpenId === p.entry_id) {
          await tx.update(time_entries).set({ ended_at: res.closures[0]!.ended_at, completed_session: null, ...sys }).where(eq(time_entries.id, openEntry.id));
          await insertEntry(null);
        } else {
          await insertEntry(res.closures.find((c) => c.id === p.entry_id)!.ended_at);
        }
        return applied();
      }
      case 'timer.clock_out': {
        const p = payload as Payload<'timer.clock_out'>;
        const entry = await one(tx.select().from(time_entries).where(eq(time_entries.id, p.entry_id)).limit(1));
        const own = ownershipReject('time entry', p.entry_id, entry, userId);
        if (own) return own;
        const bad = fromCheck(checkClockOut(entry, p.entry_id, p));
        if (bad) return bad;
        await tx.update(time_entries).set({ ended_at: p.ended_at, ...sys }).where(eq(time_entries.id, p.entry_id));
        return applied();
      }
      case 'timer.review': {
        const p = payload as Payload<'timer.review'>;
        const entry = await one(tx.select().from(time_entries).where(eq(time_entries.id, p.entry_id)).limit(1));
        const own = ownershipReject('time entry', p.entry_id, entry, userId);
        if (own) return own;
        const win = await lwwFields(tx, hlc, userId, 'time_entries', p.entry_id, { focus_factor: p.focus_factor, completed_session: p.completed_session });
        if (Object.keys(win).length > 0) await tx.update(time_entries).set({ ...win, ...sys }).where(eq(time_entries.id, p.entry_id));
        if (p.completed_session && entry!.ended_at !== null) {
          const task = await loadNodeRow(tx, entry!.task_id);
          if (task && task.user_id === userId && task.completed_at === null) {
            // §7.6: a review that would complete the task is gated like node.check_off.
            const gate = await completionGate(task as CoreNode);
            if (gate) return gate;
            const winC = await lwwFields(tx, hlc, userId, 'nodes', task.id, { completed_at: entry!.ended_at, completion_disposition: 'completed' as const });
            if (Object.keys(winC).length > 0) await tx.update(nodes).set({ ...winC, ...sys }).where(eq(nodes.id, task.id));
            return applied({ userId, trigger: 'task_completed', nodeId: task.id });
          }
        }
        return applied();
      }

      // --- habits -----------------------------------------------------------
      case 'habit.create': {
        const p = payload as Payload<'habit.create'>;
        const conv = convergeOrOwn(await one(tx.select().from(habits).where(eq(habits.id, p.id)).limit(1)), 'habit', p.id);
        if (conv) return conv;
        const bad = fromCheck(checkHabitVision(await batchCtx.tree(tx, userId), p.vision_id));
        if (bad) return bad;
        await tx.insert(habits).values({
          id: p.id,
          user_id: userId,
          vision_id: p.vision_id,
          title: p.title,
          rrule: p.rrule,
          streak_mode: p.streak_mode,
          daily_target_minutes: p.daily_target_minutes ?? null,
          mastery_target_hours: p.mastery_target_hours ?? null,
          level_thresholds_hours: p.level_thresholds_hours ?? [],
          ...born,
        });
        return applied();
      }
      case 'habit.update': {
        const p = payload as Payload<'habit.update'>;
        const own = ownershipReject('habit', p.id, await one(tx.select().from(habits).where(eq(habits.id, p.id)).limit(1)), userId);
        if (own) return own;
        const candidate: Record<string, unknown> = {};
        if (p.title !== undefined) candidate['title'] = p.title;
        if (p.rrule !== undefined) candidate['rrule'] = p.rrule;
        if (p.streak_mode !== undefined) candidate['streak_mode'] = p.streak_mode;
        if ('daily_target_minutes' in p) candidate['daily_target_minutes'] = p.daily_target_minutes ?? null;
        if ('mastery_target_hours' in p) candidate['mastery_target_hours'] = p.mastery_target_hours ?? null;
        if (p.level_thresholds_hours !== undefined) candidate['level_thresholds_hours'] = p.level_thresholds_hours;
        const win = await lwwFields(tx, hlc, userId, 'habits', p.id, candidate);
        if (Object.keys(win).length > 0) await tx.update(habits).set({ ...win, ...sys }).where(eq(habits.id, p.id));
        return applied();
      }
      case 'habit.delete': {
        const p = payload as Payload<'habit.delete'>;
        const own = ownershipReject('habit', p.id, await one(tx.select().from(habits).where(eq(habits.id, p.id)).limit(1)), userId);
        if (own) return own;
        await tx.update(habits).set({ deleted_at: now, ...sys }).where(eq(habits.id, p.id));
        return applied();
      }
      case 'habit.check_off': {
        const p = payload as Payload<'habit.check_off'>;
        const conv = convergeOrOwn(await one(tx.select().from(habit_completions).where(eq(habit_completions.id, p.id)).limit(1)), 'habit completion', p.id);
        if (conv) return conv;
        const own = ownershipReject('habit', p.habit_id, await one(tx.select().from(habits).where(eq(habits.id, p.habit_id)).limit(1)), userId);
        if (own) return own;
        await tx
          .insert(habit_completions)
          .values({ id: p.id, user_id: userId, habit_id: p.habit_id, occurrence_date: p.occurrence_date, completed_at: p.completed_at, ...born })
          // partial unique index (§7.7): the arbiter predicate must match.
          .onConflictDoNothing({ target: [habit_completions.habit_id, habit_completions.occurrence_date], where: isNull(habit_completions.deleted_at) });
        return applied();
      }

      // --- sprints ----------------------------------------------------------
      case 'sprint.create': {
        const p = payload as Payload<'sprint.create'>;
        const conv = convergeOrOwn(await one(tx.select().from(sprints).where(eq(sprints.id, p.id)).limit(1)), 'sprint', p.id);
        if (conv) return conv;
        await tx.insert(sprints).values({ id: p.id, user_id: userId, title: p.title, starts_on: p.starts_on, ends_on: p.ends_on, ...born });
        return applied();
      }
      case 'sprint.add_node': {
        const p = payload as Payload<'sprint.add_node'>;
        const conv = convergeOrOwn(await one(tx.select().from(sprint_memberships).where(eq(sprint_memberships.id, p.id)).limit(1)), 'sprint membership', p.id);
        if (conv) return conv;
        const ownS = ownershipReject('sprint', p.sprint_id, await one(tx.select().from(sprints).where(eq(sprints.id, p.sprint_id)).limit(1)), userId);
        if (ownS) return ownS;
        const ownN = ownershipReject('node', p.node_id, await loadNodeRow(tx, p.node_id), userId);
        if (ownN) return ownN;
        await tx.insert(sprint_memberships).values({ id: p.id, user_id: userId, sprint_id: p.sprint_id, node_id: p.node_id, ...born }).onConflictDoNothing({ target: [sprint_memberships.sprint_id, sprint_memberships.node_id], where: isNull(sprint_memberships.deleted_at) });
        return applied();
      }
      case 'sprint.remove_node': {
        const p = payload as Payload<'sprint.remove_node'>;
        const own = ownershipReject('sprint membership', p.id, await one(tx.select().from(sprint_memberships).where(eq(sprint_memberships.id, p.id)).limit(1)), userId);
        if (own) return own;
        await tx.update(sprint_memberships).set({ deleted_at: now, ...sys }).where(eq(sprint_memberships.id, p.id));
        return applied();
      }
      case 'sprint.delete': {
        const p = payload as Payload<'sprint.delete'>;
        const own = ownershipReject('sprint', p.id, await one(tx.select().from(sprints).where(eq(sprints.id, p.id)).limit(1)), userId);
        if (own) return own;
        await tx.update(sprints).set({ deleted_at: now, ...sys }).where(eq(sprints.id, p.id));
        return applied();
      }

      // --- decision board ---------------------------------------------------
      case 'board.create': {
        const p = payload as Payload<'board.create'>;
        const conv = convergeOrOwn(await one(tx.select().from(decision_boards).where(eq(decision_boards.id, p.id)).limit(1)), 'board', p.id);
        if (conv) return conv;
        await tx.insert(decision_boards).values({ id: p.id, user_id: userId, title: p.title, ...born });
        return applied();
      }
      case 'criterion.create': {
        const p = payload as Payload<'criterion.create'>;
        const conv = convergeOrOwn(await one(tx.select().from(decision_criteria).where(eq(decision_criteria.id, p.id)).limit(1)), 'criterion', p.id);
        if (conv) return conv;
        const own = ownershipReject('board', p.board_id, await one(tx.select().from(decision_boards).where(eq(decision_boards.id, p.board_id)).limit(1)), userId);
        if (own) return own;
        await tx.insert(decision_criteria).values({ id: p.id, user_id: userId, board_id: p.board_id, label: p.label, weight: p.weight, ...born });
        return applied();
      }
      case 'criterion.set_weight': {
        const p = payload as Payload<'criterion.set_weight'>;
        const own = ownershipReject('criterion', p.id, await one(tx.select().from(decision_criteria).where(eq(decision_criteria.id, p.id)).limit(1)), userId);
        if (own) return own;
        const win = await lwwFields(tx, hlc, userId, 'decision_criteria', p.id, { weight: p.weight });
        if (Object.keys(win).length > 0) await tx.update(decision_criteria).set({ ...win, ...sys }).where(eq(decision_criteria.id, p.id));
        return applied();
      }
      case 'score.set': {
        const p = payload as Payload<'score.set'>;
        const own = ownershipReject('criterion', p.criterion_id, await one(tx.select().from(decision_criteria).where(eq(decision_criteria.id, p.criterion_id)).limit(1)), userId);
        if (own) return own;
        const project = await loadNodeRow(tx, p.project_id);
        const ownProject = ownershipReject('project', p.project_id, project, userId);
        if (ownProject) return ownProject;
        if (project!.node_type !== 'project') return reject('E_HIERARCHY', `score.set project_id must reference a project, not a ${project!.node_type}`);

        const existingById = await one(tx.select().from(decision_scores).where(eq(decision_scores.id, p.id)).limit(1));
        const ownExisting = existingById ? ownershipReject('score', p.id, existingById, userId) : null;
        if (ownExisting) return ownExisting;
        if (existingById && (existingById.criterion_id !== p.criterion_id || existingById.project_id !== p.project_id)) {
          return reject('E_DUPLICATE', 'score.set id already belongs to a different criterion/project pair');
        }

        const existing = existingById ?? (await loadDecisionScoreByPair(tx, p.criterion_id, p.project_id));
        if (!existing) {
          await tx.insert(decision_scores).values({ id: p.id, user_id: userId, criterion_id: p.criterion_id, project_id: p.project_id, score: p.score, ...born });
          await lwwFields(tx, hlc, userId, 'decision_scores', p.id, { score: p.score });
        } else {
          const win = await lwwFields(tx, hlc, userId, 'decision_scores', existing.id, { score: p.score });
          if (Object.keys(win).length > 0) await tx.update(decision_scores).set({ ...win, ...sys }).where(eq(decision_scores.id, existing.id));
        }
        return applied();
      }

      // --- tags (confirmable event tags) ------------------------------------
      case 'tag.create': {
        const p = payload as Payload<'tag.create'>;
        const conv = convergeOrOwn(await one(tx.select().from(tags).where(eq(tags.id, p.id)).limit(1)), 'tag', p.id);
        if (conv) return conv;
        if (p.habit_id != null) {
          const ownHabit = ownershipReject('habit', p.habit_id, await one(tx.select().from(habits).where(eq(habits.id, p.habit_id)).limit(1)), userId);
          if (ownHabit) return ownHabit;
        }
        await tx.insert(tags).values({ id: p.id, user_id: userId, label: p.label, habit_id: p.habit_id ?? null, ...born });
        return applied();
      }
      case 'tag.rename': {
        const p = payload as Payload<'tag.rename'>;
        const own = ownershipReject('tag', p.id, await one(tx.select().from(tags).where(eq(tags.id, p.id)).limit(1)), userId);
        if (own) return own;
        const win = await lwwFields(tx, hlc, userId, 'tags', p.id, { label: p.label });
        if (Object.keys(win).length > 0) await tx.update(tags).set({ ...win, ...sys }).where(eq(tags.id, p.id));
        return applied();
      }
      case 'tag.delete': {
        const p = payload as Payload<'tag.delete'>;
        const own = ownershipReject('tag', p.id, await one(tx.select().from(tags).where(eq(tags.id, p.id)).limit(1)), userId);
        if (own) return own;
        await tx.update(tags).set({ deleted_at: now, ...sys }).where(eq(tags.id, p.id));
        return applied();
      }
      case 'tag.place': {
        const p = payload as Payload<'tag.place'>;
        const conv = convergeOrOwn(await one(tx.select().from(tag_placements).where(eq(tag_placements.id, p.id)).limit(1)), 'tag placement', p.id);
        if (conv) return conv;
        const ownBlock = ownershipReject('block', p.block_id, await one(tx.select().from(schedule_blocks).where(eq(schedule_blocks.id, p.block_id)).limit(1)), userId);
        if (ownBlock) return ownBlock;
        const ownTag = ownershipReject('tag', p.tag_id, await one(tx.select().from(tags).where(eq(tags.id, p.tag_id)).limit(1)), userId);
        if (ownTag) return ownTag;
        // Placing on a block whose task is already done is allowed (the core scenario).
        // Converged no-op if the live (block, tag) pair is already placed.
        if (await loadTagPlacementByPair(tx, p.block_id, p.tag_id)) return applied();
        await tx.insert(tag_placements).values({ id: p.id, user_id: userId, block_id: p.block_id, tag_id: p.tag_id, ...born });
        return applied();
      }
      case 'tag.unplace': {
        const p = payload as Payload<'tag.unplace'>;
        const own = ownershipReject('tag placement', p.id, await one(tx.select().from(tag_placements).where(eq(tag_placements.id, p.id)).limit(1)), userId);
        if (own) return own;
        await tx.update(tag_placements).set({ deleted_at: now, ...sys }).where(eq(tag_placements.id, p.id));
        return applied();
      }
      case 'tag.answer': {
        const p = payload as Payload<'tag.answer'>;
        const ownPlacement = ownershipReject('tag placement', p.placement_id, await one(tx.select().from(tag_placements).where(eq(tag_placements.id, p.placement_id)).limit(1)), userId);
        if (ownPlacement) return ownPlacement;
        const existingById = await one(tx.select().from(tag_answers).where(eq(tag_answers.id, p.id)).limit(1));
        const ownExisting = existingById ? ownershipReject('tag answer', p.id, existingById, userId) : null;
        if (ownExisting) return ownExisting;
        if (existingById && existingById.placement_id !== p.placement_id) {
          return reject('E_DUPLICATE', 'tag.answer id already belongs to a different placement');
        }
        // upsert keyed by placement (one live answer per placement); LWW the value.
        const existing = existingById ?? (await loadTagAnswerByPlacement(tx, p.placement_id));
        if (!existing) {
          await tx.insert(tag_answers).values({ id: p.id, user_id: userId, placement_id: p.placement_id, value: p.value, answered_at: p.answered_at, ...born });
          await lwwFields(tx, hlc, userId, 'tag_answers', p.id, { value: p.value, answered_at: p.answered_at });
        } else {
          const win = await lwwFields(tx, hlc, userId, 'tag_answers', existing.id, { value: p.value, answered_at: p.answered_at });
          if (Object.keys(win).length > 0) await tx.update(tag_answers).set({ ...win, ...sys }).where(eq(tag_answers.id, existing.id));
        }
        return applied();
      }
      case 'tag.clear_answer': {
        const p = payload as Payload<'tag.clear_answer'>;
        const own = ownershipReject('tag answer', p.id, await one(tx.select().from(tag_answers).where(eq(tag_answers.id, p.id)).limit(1)), userId);
        if (own) return own;
        await tx.update(tag_answers).set({ deleted_at: now, ...sys }).where(eq(tag_answers.id, p.id));
        return applied();
      }

      // --- journal (a note on any calendar day, D4) -------------------------
      case 'journal.write': {
        const p = payload as Payload<'journal.write'>;
        // month_key is SERVER-derived from entry_date (never client-supplied); a
        // date::text cast is DateStyle-dependent, so derive it in JS (D1/D3).
        const month_key = p.entry_date.slice(0, 7);
        const existingById = await one(tx.select().from(journal_entries).where(eq(journal_entries.id, p.id)).limit(1));
        const ownExisting = existingById ? ownershipReject('journal entry', p.id, existingById, userId) : null;
        if (ownExisting) return ownExisting;
        // a known id rebound to a DIFFERENT day is a client bug, not an upsert (tag.answer's guard).
        if (existingById && existingById.entry_date !== p.entry_date) {
          return reject('E_DUPLICATE', 'journal.write id already belongs to a different day');
        }
        // Upsert keyed by the day (one live note per (user, entry_date)); LWW the content.
        const liveByDay = () =>
          one(
            tx
              .select()
              .from(journal_entries)
              .where(and(eq(journal_entries.user_id, userId), eq(journal_entries.entry_date, p.entry_date), isNull(journal_entries.deleted_at)))
              .limit(1),
          );
        let live = existingById ?? (await liveByDay());
        if (!live) {
          // No live row yet: insert, GUARDING the §7.7 partial-unique arbiter race —
          // a concurrent upload may create the same day between our lookup and this
          // insert. onConflictDoNothing turns that unique violation into 0 rows so we
          // fall through to the merge path instead of erroring or dropping content
          // (D4; habit.check_off's bare DoNothing would silently drop the loser).
          const inserted = await tx
            .insert(journal_entries)
            .values({ id: p.id, user_id: userId, entry_date: p.entry_date, month_key, content: p.content, ...born })
            .onConflictDoNothing({ target: [journal_entries.user_id, journal_entries.entry_date], where: isNull(journal_entries.deleted_at) })
            .returning({ id: journal_entries.id });
          if (inserted.length > 0) {
            await lwwFields(tx, hlc, userId, 'journal_entries', p.id, { content: p.content });
            rec('journal_entries', p.id, 'insert');
            return applied();
          }
          live = await liveByDay(); // lost the race — merge onto the row that won it
          if (!live) return applied();
        }

        // Merge content onto the live row. `crossDevice` = a DIFFERENT id already owns
        // this day (two offline devices minted ids for the same new day → D5); a
        // same-id write is the user editing their own note (never a conflict).
        const crossDevice = live.id !== p.id;
        const priorContent = live.content;
        const priorHlc = crossDevice
          ? (
              await one(
                tx
                  .select({ hlc: command_field_versions.hlc })
                  .from(command_field_versions)
                  .where(
                    and(
                      eq(command_field_versions.table_name, 'journal_entries'),
                      eq(command_field_versions.row_id, live.id),
                      eq(command_field_versions.field, 'content'),
                    ),
                  )
                  .limit(1),
              )
            )?.hlc ?? live.hlc
          : live.hlc;
        const win = await lwwFields(tx, hlc, userId, 'journal_entries', live.id, { content: p.content });
        if (Object.keys(win).length > 0) {
          await tx.update(journal_entries).set({ ...win, ...sys }).where(eq(journal_entries.id, live.id));
          rec('journal_entries', live.id, 'update', Object.keys(win));
          // The incoming content WON. If it overwrote a DIFFERENT device's materially
          // different prose, surface the overwritten text so it stays recoverable —
          // the generic lwwFields conflict only fires when the INCOMING write loses (D2).
          if (crossDevice && priorContent !== p.content) {
            await maybeHlcConflict(tx, userId, 'journal_entries', live.id, 'content', priorContent, hlc, priorHlc);
          }
        } else {
          // Incoming content LOST — lwwFields already surfaced it (maybeHlcConflict).
          // Still record the authoritative row so the client rewrites its overlay id
          // (the optimistic insert of a losing duplicate) and reconciles it away (D5).
          rec('journal_entries', live.id, 'update', []);
        }
        return applied();
      }
      case 'journal.set_locked': {
        const p = payload as Payload<'journal.set_locked'>;
        // Acts on an existing row and never mints one: an empty note is not
        // stored, so there is nothing to lock on a day that holds nothing. Only
        // ever touches `locked`, so a lock racing an edit of the same day settles
        // per FIELD and neither clobbers the other.
        const lockRow = await one(tx.select().from(journal_entries).where(eq(journal_entries.id, p.id)).limit(1));
        const ownLock = ownershipReject('journal entry', p.id, lockRow, userId);
        if (ownLock) return ownLock;
        const winLock = await lwwFields(tx, hlc, userId, 'journal_entries', p.id, { locked: p.locked });
        if (Object.keys(winLock).length > 0) {
          await tx.update(journal_entries).set({ ...winLock, ...sys }).where(eq(journal_entries.id, p.id));
          rec('journal_entries', p.id, 'update', Object.keys(winLock));
        } else {
          rec('journal_entries', p.id, 'update', []);
        }
        return applied();
      }
      case 'journal.set_title': {
        const p = payload as Payload<'journal.set_title'>;
        // A title belongs to a note that exists — an empty note is never stored —
        // so unlike set_locked this never mints a row.
        const row = await one(tx.select().from(journal_entries).where(eq(journal_entries.id, p.id)).limit(1));
        const ownTitle = ownershipReject('journal entry', p.id, row, userId);
        if (ownTitle) return ownTitle;
        const winTitle = await lwwFields(tx, hlc, userId, 'journal_entries', p.id, { title: p.title });
        if (Object.keys(winTitle).length > 0) {
          await tx.update(journal_entries).set({ ...winTitle, ...sys }).where(eq(journal_entries.id, p.id));
          rec('journal_entries', p.id, 'update', Object.keys(winTitle));
        } else {
          rec('journal_entries', p.id, 'update', []);
        }
        return applied();
      }
      case 'journal.delete': {
        const p = payload as Payload<'journal.delete'>;
        const own = ownershipReject('journal entry', p.id, await one(tx.select().from(journal_entries).where(eq(journal_entries.id, p.id)).limit(1)), userId);
        if (own) return own;
        await tx.update(journal_entries).set({ deleted_at: now, ...sys }).where(eq(journal_entries.id, p.id));
        rec('journal_entries', p.id, 'delete');
        return applied();
      }

      // --- task steps (checklist on a task, W3/D4) --------------------------
      case 'step.add': {
        const p = payload as Payload<'step.add'>;
        const conv = convergeOrOwn(await loadStepRow(tx, p.id), 'step', p.id);
        if (conv) return conv;
        // I1 parent typing + I8 freeze (+ ownership) on the parent task.
        const parent = await loadNodeRow(tx, p.task_id);
        const ownParent = ownershipReject('task', p.task_id, parent, userId);
        if (ownParent) return ownParent;
        const bad = fromCheck(checkStepParent(parent as CoreNode | undefined, p.task_id));
        if (bad) return bad;
        await tx.insert(task_steps).values({ id: p.id, user_id: userId, task_id: p.task_id, title: p.title, done: false, sort_order: p.sort_order, ...born });
        rec('task_steps', p.id, 'insert');
        return applied();
      }
      case 'step.rename': {
        const p = payload as Payload<'step.rename'>;
        return updateStep(p.id, { title: p.title });
      }
      case 'step.toggle': {
        const p = payload as Payload<'step.toggle'>;
        return updateStep(p.id, { done: p.done });
      }
      case 'step.reorder': {
        const p = payload as Payload<'step.reorder'>;
        return updateStep(p.id, { sort_order: p.sort_order });
      }
      case 'step.remove': {
        const p = payload as Payload<'step.remove'>;
        const step = await loadStepRow(tx, p.id);
        const own = ownershipReject('step', p.id, step, userId);
        if (own) return own;
        // freeze on a done parent (I8 spirit); a cascade delete (node.soft_delete) bypasses this.
        const bad = fromCheck(checkStepParent((await loadNodeRow(tx, step!.task_id)) as CoreNode | undefined, step!.task_id));
        if (bad) return bad;
        await tx.update(task_steps).set({ deleted_at: now, ...sys }).where(eq(task_steps.id, p.id));
        rec('task_steps', p.id, 'delete');
        return applied();
      }

      // --- automation & blocker rules ---------------------------------------
      case 'rule.create': {
        const p = payload as Payload<'rule.create'>;
        const conv = convergeOrOwn(await one(tx.select().from(automation_rules).where(eq(automation_rules.id, p.id)).limit(1)), 'rule', p.id);
        if (conv) return conv;
        const existingRules = await tx.select().from(automation_rules).where(and(eq(automation_rules.user_id, userId), isNull(automation_rules.deleted_at)));
        const bad = fromCheck(checkRule({ trigger: p.trigger, conditions: p.conditions, actions: p.actions }, existingRules));
        if (bad) return bad;
        await tx.insert(automation_rules).values({ id: p.id, user_id: userId, trigger: p.trigger, conditions: p.conditions, actions: p.actions, enabled: p.enabled ?? true, ...born });
        return applied();
      }
      case 'rule.update': {
        const p = payload as Payload<'rule.update'>;
        const row = await one(tx.select().from(automation_rules).where(eq(automation_rules.id, p.id)).limit(1));
        const own = ownershipReject('rule', p.id, row, userId);
        if (own) return own;
        const merged = { trigger: p.trigger ?? row!.trigger, conditions: p.conditions ?? row!.conditions, actions: p.actions ?? row!.actions };
        const others = await tx.select().from(automation_rules).where(and(eq(automation_rules.user_id, userId), isNull(automation_rules.deleted_at)));
        const bad = fromCheck(checkRule(merged, others.filter((r) => r.id !== p.id)));
        if (bad) return bad;
        const candidate: Record<string, unknown> = {};
        if (p.trigger !== undefined) candidate['trigger'] = p.trigger;
        if (p.conditions !== undefined) candidate['conditions'] = p.conditions;
        if (p.actions !== undefined) candidate['actions'] = p.actions;
        const win = await lwwFields(tx, hlc, userId, 'automation_rules', p.id, candidate);
        if (Object.keys(win).length > 0) await tx.update(automation_rules).set({ ...win, ...sys }).where(eq(automation_rules.id, p.id));
        return applied();
      }
      case 'rule.toggle': {
        const p = payload as Payload<'rule.toggle'>;
        const own = ownershipReject('rule', p.id, await one(tx.select().from(automation_rules).where(eq(automation_rules.id, p.id)).limit(1)), userId);
        if (own) return own;
        const win = await lwwFields(tx, hlc, userId, 'automation_rules', p.id, { enabled: p.enabled });
        if (Object.keys(win).length > 0) await tx.update(automation_rules).set({ ...win, ...sys }).where(eq(automation_rules.id, p.id));
        return applied();
      }
      case 'rule.delete': {
        const p = payload as Payload<'rule.delete'>;
        const own = ownershipReject('rule', p.id, await one(tx.select().from(automation_rules).where(eq(automation_rules.id, p.id)).limit(1)), userId);
        if (own) return own;
        await tx.update(automation_rules).set({ deleted_at: now, ...sys }).where(eq(automation_rules.id, p.id));
        return applied();
      }
      case 'blocker.create': {
        const p = payload as Payload<'blocker.create'>;
        const conv = convergeOrOwn(await one(tx.select().from(blocker_rules).where(eq(blocker_rules.id, p.id)).limit(1)), 'blocker', p.id);
        if (conv) return conv;
        await tx.insert(blocker_rules).values({ id: p.id, user_id: userId, scope: p.scope, predicate: p.predicate, label: p.label, enabled: p.enabled ?? true, ...born });
        return applied();
      }
      case 'blocker.update': {
        const p = payload as Payload<'blocker.update'>;
        const own = ownershipReject('blocker', p.id, await one(tx.select().from(blocker_rules).where(eq(blocker_rules.id, p.id)).limit(1)), userId);
        if (own) return own;
        const candidate: Record<string, unknown> = {};
        if (p.scope !== undefined) candidate['scope'] = p.scope;
        if (p.predicate !== undefined) candidate['predicate'] = p.predicate;
        if (p.label !== undefined) candidate['label'] = p.label;
        const win = await lwwFields(tx, hlc, userId, 'blocker_rules', p.id, candidate);
        if (Object.keys(win).length > 0) await tx.update(blocker_rules).set({ ...win, ...sys }).where(eq(blocker_rules.id, p.id));
        return applied();
      }
      case 'blocker.toggle': {
        const p = payload as Payload<'blocker.toggle'>;
        const own = ownershipReject('blocker', p.id, await one(tx.select().from(blocker_rules).where(eq(blocker_rules.id, p.id)).limit(1)), userId);
        if (own) return own;
        const win = await lwwFields(tx, hlc, userId, 'blocker_rules', p.id, { enabled: p.enabled });
        if (Object.keys(win).length > 0) await tx.update(blocker_rules).set({ ...win, ...sys }).where(eq(blocker_rules.id, p.id));
        return applied();
      }
      case 'blocker.delete': {
        const p = payload as Payload<'blocker.delete'>;
        const own = ownershipReject('blocker', p.id, await one(tx.select().from(blocker_rules).where(eq(blocker_rules.id, p.id)).limit(1)), userId);
        if (own) return own;
        await tx.update(blocker_rules).set({ deleted_at: now, ...sys }).where(eq(blocker_rules.id, p.id));
        return applied();
      }

      // --- diagram layout & groups ------------------------------------------
      case 'layout.set_position': {
        const p = payload as Payload<'layout.set_position'>;
        const ownDiagram = ownershipReject('diagram', p.diagram_id, await loadNodeRow(tx, p.diagram_id), userId);
        if (ownDiagram) return ownDiagram;
        const own = ownershipReject('node', p.node_id, await loadNodeRow(tx, p.node_id), userId);
        if (own) return own;
        if (p.group_id !== undefined && p.group_id !== null) {
          const group = await one(tx.select().from(diagram_groups).where(eq(diagram_groups.id, p.group_id)).limit(1));
          const ownGroup = ownershipReject('group', p.group_id, group, userId);
          if (ownGroup) return ownGroup;
          if (group!.diagram_id !== p.diagram_id) return reject('E_HIERARCHY', 'layout group must belong to the same diagram');
        }
        const existing = await loadLayoutByPair(tx, p.diagram_id, p.node_id);
        const fields = { x: p.x, y: p.y, group_id: p.group_id ?? null };
        if (!existing) {
          const id = randomUUID();
          await tx.insert(diagram_layouts).values({ id, user_id: userId, diagram_id: p.diagram_id, node_id: p.node_id, ...fields, ...born });
          await lwwFields(tx, hlc, userId, 'diagram_layouts', id, fields);
        } else {
          const ownLayout = ownershipReject('layout', existing.id, existing, userId);
          if (ownLayout) return ownLayout;
          const win = await lwwFields(tx, hlc, userId, 'diagram_layouts', existing.id, fields);
          if (Object.keys(win).length > 0) await tx.update(diagram_layouts).set({ ...win, ...sys }).where(eq(diagram_layouts.id, existing.id));
        }
        return applied();
      }
      case 'layout.set_collapsed': {
        const p = payload as Payload<'layout.set_collapsed'>;
        const ownDiagram = ownershipReject('diagram', p.diagram_id, await loadNodeRow(tx, p.diagram_id), userId);
        if (ownDiagram) return ownDiagram;
        const own = ownershipReject('node', p.node_id, await loadNodeRow(tx, p.node_id), userId);
        if (own) return own;
        const existing = await loadLayoutByPair(tx, p.diagram_id, p.node_id);
        if (!existing) {
          const id = randomUUID();
          await tx.insert(diagram_layouts).values({ id, user_id: userId, diagram_id: p.diagram_id, node_id: p.node_id, x: 0, y: 0, collapsed: p.collapsed, ...born });
          await lwwFields(tx, hlc, userId, 'diagram_layouts', id, { collapsed: p.collapsed });
        } else {
          const ownLayout = ownershipReject('layout', existing.id, existing, userId);
          if (ownLayout) return ownLayout;
          const win = await lwwFields(tx, hlc, userId, 'diagram_layouts', existing.id, { collapsed: p.collapsed });
          if (Object.keys(win).length > 0) await tx.update(diagram_layouts).set({ ...win, ...sys }).where(eq(diagram_layouts.id, existing.id));
        }
        return applied();
      }
      case 'layout.renormalize_order': {
        // §7.10a: deterministic, idempotent sort_order cleanup over a sibling
        // group. Reassign clean, evenly-spaced fractions in canonical order;
        // HLC-LWW so a concurrent reorder with a later HLC still wins.
        const p = payload as Payload<'layout.renormalize_order'>;
        for (const id of p.node_ids) {
          const own = ownershipReject('node', id, await loadNodeRow(tx, id), userId);
          if (own) return own;
        }
        const orders = renormalizedOrders(p.node_ids.length);
        for (let i = 0; i < p.node_ids.length; i += 1) {
          const id = p.node_ids[i]!;
          const win = await lwwFields(tx, hlc, userId, 'nodes', id, { sort_order: orders[i]! });
          if (Object.keys(win).length > 0) await tx.update(nodes).set({ ...win, ...sys }).where(eq(nodes.id, id));
        }
        return applied();
      }
      case 'group.create': {
        const p = payload as Payload<'group.create'>;
        const conv = convergeOrOwn(await one(tx.select().from(diagram_groups).where(eq(diagram_groups.id, p.id)).limit(1)), 'group', p.id);
        if (conv) return conv;
        const ownDiagram = ownershipReject('diagram', p.diagram_id, await loadNodeRow(tx, p.diagram_id), userId);
        if (ownDiagram) return ownDiagram;
        await tx.insert(diagram_groups).values({ id: p.id, user_id: userId, diagram_id: p.diagram_id, label: p.label, color: p.color ?? null, ...born });
        return applied();
      }
      case 'group.update': {
        const p = payload as Payload<'group.update'>;
        const own = ownershipReject('group', p.id, await one(tx.select().from(diagram_groups).where(eq(diagram_groups.id, p.id)).limit(1)), userId);
        if (own) return own;
        const candidate: Record<string, unknown> = {};
        if (p.label !== undefined) candidate['label'] = p.label;
        if ('color' in p) candidate['color'] = p.color ?? null;
        const win = await lwwFields(tx, hlc, userId, 'diagram_groups', p.id, candidate);
        if (Object.keys(win).length > 0) await tx.update(diagram_groups).set({ ...win, ...sys }).where(eq(diagram_groups.id, p.id));
        return applied();
      }
      case 'group.delete': {
        const p = payload as Payload<'group.delete'>;
        const own = ownershipReject('group', p.id, await one(tx.select().from(diagram_groups).where(eq(diagram_groups.id, p.id)).limit(1)), userId);
        if (own) return own;
        await tx.update(diagram_groups).set({ deleted_at: now, ...sys }).where(eq(diagram_groups.id, p.id));
        return applied();
      }

      // --- review inbox (§7.13) ---------------------------------------------
      case 'review.resolve':
      case 'review.dismiss': {
        // Close a durable review item. Server-owned trust fields (status is one)
        // are assigned here, not by the client; the client only names WHICH item
        // and HOW (resolve vs dismiss) via the verb.
        const p = payload as Payload<'review.resolve'>;
        const item = await one(tx.select().from(sync_review_items).where(eq(sync_review_items.id, p.id)).limit(1));
        const own = ownershipReject('review item', p.id, item, userId);
        if (own) return own;
        const status = name === 'review.resolve' ? ('resolved' as const) : ('dismissed' as const);
        // §7.10 HLC-LWW on the terminal status so a concurrent resolve/dismiss on
        // two devices converges deterministically (later HLC wins); resolved_at
        // records the close time.
        const win = await lwwFields(tx, hlc, userId, 'sync_review_items', p.id, { status });
        if (Object.keys(win).length > 0) {
          await tx.update(sync_review_items).set({ status, resolved_at: now, ...sys }).where(eq(sync_review_items.id, p.id));
        }
        return applied();
      }

      // --- settings ---------------------------------------------------------
      case 'settings.update': {
        const p = payload as Payload<'settings.update'>;
        const candidate: Record<string, unknown> = {};
        if (p.day_reset_hour !== undefined) candidate['day_reset_hour'] = p.day_reset_hour;
        if (p.timezone !== undefined) candidate['timezone'] = p.timezone;
        if (p.weather_location !== undefined) candidate['weather_location'] = p.weather_location;
        // EXPLICIT field list: a settings field missing here applies as a silent
        // no-op — the command succeeds and nothing changes (Annex L).
        if (p.journal_day_log !== undefined) candidate['journal_day_log'] = p.journal_day_log;
        const win = await lwwFields(tx, hlc, userId, 'user_settings', userId, candidate);
        if (Object.keys(win).length === 0) return applied(); // every field lost LWW
        await tx
          .insert(user_settings)
          .values({ user_id: userId, updated_at: now, ...(win as Record<string, unknown>) } as typeof user_settings.$inferInsert)
          .onConflictDoUpdate({ target: user_settings.user_id, set: { updated_at: now, ...win } });
        return applied();
      }
    }
  }

  async function logResult(
    userId: string,
    deviceId: string,
    cmd: Cmd,
    result: 'applied' | 'rejected',
    rejectReason: string | null,
  ): Promise<void> {
    await db.insert(command_log).values({
      id: cmd.id,
      user_id: userId,
      name: cmd.name,
      payload: cmd.payload as never,
      device_id: deviceId,
      hlc: cmd.hlc,
      command_version: cmd.command_version ?? 1,
      // absent schema_version records as 0 (below-floor), matching the §7.11 gate.
      schema_version: cmd.schema_version ?? 0,
      client_version: cmd.client_version ?? null,
      depends_on: cmd.depends_on ? [...cmd.depends_on] : [],
      result,
      reject_reason: rejectReason,
    });
  }

  /** Create a durable review item for a rejection (§7.13); returns its id. */
  async function createReviewItem(userId: string, cmd: Cmd, code: string, reason: string): Promise<string> {
    const id = randomUUID();
    const at = nowIso();
    const { item_type, severity } = reviewItemFor(code);
    await db.insert(sync_review_items).values({
      id,
      user_id: userId,
      command_id: cmd.id,
      item_type,
      severity,
      title: `${cmd.name} rejected (${code})`,
      detail: { reject_code: code, reason, ...(cmd.depends_on ? { depends_on: [...cmd.depends_on] } : {}) },
      status: 'open',
      created_at: at,
      updated_at: at,
      hlc: cmd.hlc,
      schema_version: ROW_SCHEMA_VERSION,
      source_kind: 'system',
      created_by_command_id: cmd.id,
      last_modified_by_command_id: cmd.id,
    });
    return id;
  }

  /**
   * §7.2e causal check, run in HLC order. A command whose `depends_on` lists a
   * command rejected in this batch (or previously, for this user) is
   * `dependency_rejected`. A dependency is satisfied only if it already applied
   * (earlier in this batch, or a prior applied/noop command of THIS user). Any
   * other id — unknown to the server, belonging to another user, a self-
   * reference, or in this batch but not yet applied (out of HLC order) — is
   * `unknown_target`. The lookup is user-scoped so depends_on cannot probe
   * another user's command ids.
   */
  async function causalReject(userId: string, cmd: Cmd, rejectedInBatch: ReadonlySet<string>, appliedInBatch: ReadonlySet<string>): Promise<HandlerRejected | null> {
    for (const dep of cmd.depends_on ?? []) {
      if (rejectedInBatch.has(dep)) return reject('E_DEPENDENCY_REJECTED', `depends on ${dep}, which was rejected`);
      if (appliedInBatch.has(dep)) continue; // satisfied earlier in this batch
      const prior = await one(
        db.select({ result: command_log.result }).from(command_log).where(and(eq(command_log.id, dep), eq(command_log.user_id, userId))).limit(1),
      );
      if (prior) {
        if (prior.result === 'rejected') return reject('E_DEPENDENCY_REJECTED', `depends on ${dep}, which was rejected`);
        continue; // applied/noop — satisfied
      }
      return reject('E_UNKNOWN_TARGET', `depends on ${dep}, which is unknown or not yet applied`);
    }
    return null;
  }

  async function handleCommand(
    userId: string,
    deviceId: string,
    cmd: Cmd,
    rejectedInBatch: ReadonlySet<string>,
    appliedInBatch: ReadonlySet<string>,
    batchCtx: BatchContext,
  ): Promise<CommandOutcome> {
    const prior = await one(
      db.select({ user_id: command_log.user_id, result: command_log.result }).from(command_log).where(eq(command_log.id, cmd.id)).limit(1),
    );
    if (prior) {
      if (prior.user_id !== userId) {
        return { id: cmd.id, result: 'rejected', reject_code: 'E_OWNERSHIP', reject_reason: 'command id belongs to another user' };
      }
      return { id: cmd.id, result: 'noop', original_result: prior.result === 'applied' ? 'applied' : 'rejected' };
    }

    // §7.11 schema floor: a client below the floor is rejected, never guessed. An
    // ABSENT schema_version is treated as below-floor (0) — a client that omits it
    // can't be trusted to be at the current row shape (S4-F1). Safe because clients
    // have emitted schema_version since R6 (D7: client-first, this rejection second).
    const clientSchemaVersion = cmd.schema_version ?? 0;
    if (isClientTooOld(clientSchemaVersion, MIN_CLIENT_SCHEMA_VERSION)) {
      const reason =
        cmd.schema_version === undefined
          ? `client sent no schema_version (required; floor is ${MIN_CLIENT_SCHEMA_VERSION})`
          : `client schema_version ${cmd.schema_version} is below the floor ${MIN_CLIENT_SCHEMA_VERSION}`;
      await logResult(userId, deviceId, cmd, 'rejected', `E_CLIENT_TOO_OLD: ${reason}`);
      return { id: cmd.id, result: 'rejected', reject_code: 'E_CLIENT_TOO_OLD', reject_reason: reason };
    }

    // §7.2e causal dependency / unknown-target gate.
    const causal = await causalReject(userId, cmd, rejectedInBatch, appliedInBatch);
    if (causal) {
      await logResult(userId, deviceId, cmd, 'rejected', `${causal.code}: ${causal.reason}`);
      return { id: cmd.id, result: 'rejected', reject_code: causal.code, reject_reason: causal.reason };
    }

    if (!isCommandName(cmd.name)) {
      await logResult(userId, deviceId, cmd, 'rejected', 'E_UNKNOWN_COMMAND: unknown command');
      return { id: cmd.id, result: 'rejected', reject_code: 'E_UNKNOWN_COMMAND', reject_reason: `unknown command "${cmd.name}"` };
    }
    // §7.2c: strip server-owned trust fields BEFORE validation — a client that
    // supplies user_id/provenance/hlc/schema_version is not rejected; the values
    // are dropped and the server assigns its own.
    const parsed = COMMAND_SCHEMAS[cmd.name].safeParse(stripTrustFields(cmd.payload));
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const reason = first ? `${first.path.join('.') || 'payload'}: ${first.message}` : 'invalid payload';
      await logResult(userId, deviceId, cmd, 'rejected', `E_PARSE: ${reason}`);
      return { id: cmd.id, result: 'rejected', reject_code: 'E_PARSE', reject_reason: reason };
    }

    try {
      const { out, effects: appliedEffects } = await db.transaction(async (tx) => {
        // §7.2f effect summary the handler + automation accumulate (S4-F3).
        const effects: EffectSummary[] = [];
        const result = await runHandler(cmd.name as CommandName, tx, userId, deviceId, cmd.id, cmd.hlc, parsed.data, batchCtx, effects);
        // §10.1: run automation to fixpoint in the SAME txn (authoritative).
        if (result.status === 'applied' && result.backstop) await runAutomationInTx(tx, result.backstop, cmd.id, cmd.hlc, effects);
        await tx.insert(command_log).values({
          id: cmd.id,
          user_id: userId,
          name: cmd.name,
          payload: cmd.payload as never,
          device_id: deviceId,
          hlc: cmd.hlc,
          command_version: cmd.command_version ?? 1,
          // a command that reaches the txn passed the floor, so schema_version is
          // present; 0 is the below-floor sentinel that never gets here.
          schema_version: cmd.schema_version ?? 0,
          client_version: cmd.client_version ?? null,
          depends_on: cmd.depends_on ? [...cmd.depends_on] : [],
          // §7.2f (S4-F3): the compact per-command effect summary. Empty on a
          // rejection (the handler returned before writing).
          effects: (result.status === 'applied' ? effects : []) as never,
          result: result.status === 'applied' ? 'applied' : 'rejected',
          reject_reason: result.status === 'rejected' ? `${result.code}: ${result.reason}` : null,
        });
        return { out: result, effects };
      });
      if (out.status === 'applied') {
        // S4-F2: this command committed — drop the cached context artifacts that
        // depend on the tables it wrote so the next command in the batch reloads
        // fresh (unlisted command → invalidate all, the safe default).
        batchCtx.invalidate(CONTEXT_WRITES[cmd.name as CommandName] ?? CONTEXT_TABLES);
        if (out.backstop && options.enqueueBackstop) await options.enqueueBackstop(out.backstop);
        // §7.2b: the provenance id stamped on every created/updated row == the
        // command id, so the optimistic overlay reconciles without identity churn.
        // D5: the authoritative {table,row_id,op} effects ride the ack so a client
        // whose optimistic row id diverged (two devices, same new day) can rewrite
        // its overlay to the server's id and reconcile instead of ghosting.
        return {
          id: cmd.id,
          result: 'applied' as const,
          created_by_command_id: cmd.id,
          ...(appliedEffects.length
            ? { effects: appliedEffects.map((e) => ({ table: e.table, row_id: e.row_id, op: e.op })) }
            : {}),
        };
      }
      return { id: cmd.id, result: 'rejected', reject_code: out.code, reject_reason: out.reason };
    } catch (error) {
      if (isUniqueViolation(error)) {
        const existing = await one(db.select({ result: command_log.result }).from(command_log).where(eq(command_log.id, cmd.id)).limit(1));
        if (existing) return { id: cmd.id, result: 'noop', original_result: existing.result === 'applied' ? 'applied' : 'rejected' };
      }
      // Transient infra (connection / serialization / deadlock) → rethrow so the
      // upload 500s and the client keeps the command pending for retry.
      if (isRetryableError(error)) throw error;
      // S4-F8: a poison command (a data/logic error) must NOT 500 the whole batch
      // and wedge the device's queue. Its txn already rolled back (no partial
      // effects); reject it E_INTERNAL + a linked review item (created by the
      // caller) and let the batch continue. The real cause is logged server-side;
      // the client sees only a generic reason (no internal-error leak).
      const detail = error instanceof Error ? error.message : String(error);
      await logResult(userId, deviceId, cmd, 'rejected', `E_INTERNAL: ${detail}`);
      return { id: cmd.id, result: 'rejected', reject_code: 'E_INTERNAL', reject_reason: 'internal error applying the command' };
    }
  }

  return {
    async handleUpload(userId, body): Promise<UploadResponse> {
      const parsed = uploadRequestSchema.safeParse(body);
      if (!parsed.success) return { kind: 'parse_error', issues: parsed.error.issues };
      const { device_id, commands } = parsed.data;

      const perVerb = new Map<string, number>();
      for (const cmd of commands) perVerb.set(cmd.name, (perVerb.get(cmd.name) ?? 0) + 1);
      for (const [verb, count] of perVerb) {
        const res = limiter.consume(`${userId}:${verb}`, count);
        if (!res.allowed) return { kind: 'rate_limited', verb, retryAfterSeconds: res.retryAfterSeconds };
      }

      // §7.2e: apply in HLC order per device (commands carry a monotonic HLC).
      const ordered = [...commands].sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0));
      const rejectedInBatch = new Set<string>();
      const appliedInBatch = new Set<string>();
      const byId = new Map<string, CommandOutcome>();
      // One context cache for the whole batch (S4-F2); the baseline uses a fresh
      // one per command (no cross-command reuse).
      const batchCtx = new BatchContext();
      for (const cmd of ordered) {
        const outcome = await handleCommand(userId, device_id, cmd, rejectedInBatch, appliedInBatch, options.disableBatchCache ? new BatchContext() : batchCtx);
        if (outcome.result === 'rejected') {
          rejectedInBatch.add(cmd.id);
          // §7.13: every server rejection produces a durable review item.
          outcome.review_item_ids = [await createReviewItem(userId, cmd, outcome.reject_code ?? 'E_INTERNAL', outcome.reject_reason ?? '')];
        } else if (outcome.result === 'applied') {
          appliedInBatch.add(cmd.id);
        }
        byId.set(cmd.id, outcome);
      }
      // respond in request order (clients match by id; keep it deterministic).
      return { kind: 'ok', results: commands.map((c) => byId.get(c.id)!) };
    },
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === '23505';
}

/**
 * Transient errors that should 500 the upload (so the client retries the whole
 * batch), NOT be converted to a per-command E_INTERNAL rejection (S4-F8): pg
 * connection-exception (08*), serialization failure / deadlock (40001/40P01),
 * admin shutdown (57P01), insufficient resources (53*), and node network errors.
 * Everything else (constraint/data/logic errors) is a poison command.
 */
function isRetryableError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = String((error as { code?: unknown }).code ?? '');
  return (
    /^08/.test(code) ||
    /^53/.test(code) ||
    code === '40001' ||
    code === '40P01' ||
    code === '57P01' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT'
  );
}
