/**
 * Optimistic command writer for the two-layer store (1.3 §7.2, §7.2b–§7.2c).
 *
 * Replaces the v1.0 direct replica write (`db.execute('UPDATE nodes …')`) with:
 *   1. strip server-owned trust fields from the payload (§7.2c),
 *   2. validate against the catalog (the server re-validates authoritatively),
 *   3. mint the command id (UUIDv7) and tick the device HLC AT WRITE TIME (§7.2b)
 *      — not at upload, so `command_log.id` equals this id (V2),
 *   4. write `client_commands` + `overlay_effects` in ONE transaction (R15).
 *
 * `execute(name, payload)` is the generic writer over the full §8.1 catalog
 * (the optimistic effects come from `buildOptimisticEffects`); `renameNode` is a
 * thin convenience wrapper kept from the M0 slice. The id minting / HLC tick /
 * clock are injected so the harness is deterministic; the app passes the
 * browser-tier `newId` / `createHlc` defaults. Effects may be supplemented by the
 * caller (e.g. soft-delete closure, layout row-id resolution) via `extraEffects`.
 */
import {
  buildFactContext,
  buildTreeIndex,
  checkClockIn,
  checkNodeCreate,
  checkNodeMove,
  COMMAND_SCHEMAS,
  domainError,
  getNode,
  isBlockedForAcceptance,
  isoToEpochMillis,
  runAutomations,
  softDeleteClosure,
  stripTrustFields,
  type ClientCommand,
  type CommandName,
  type DomainError,
  type Edge,
  type Instant,
  type Node,
  type OverlayEffect,
  type SpawnProvenance,
  type TriggerEvent,
} from '@prisms/core';

import { createHlc, newId } from './client-runtime';
import { buildOptimisticEffects, type EffectSpec } from './effects';
import { readMergedRows, type OverlayStore } from './overlay-store';
import { toAutomationRule, toBlockerRule, toEdge, toExternalFact, toNode, toTimeEntry } from './rows';

export interface ExecuteContext {
  userId: string;
  deviceId: string;
}

export interface ExecuteDeps {
  /** Mint a client command id (UUIDv7). Defaults to the browser-tier `newId`. */
  mintId?: () => string;
  /** Tick + encode the device HLC. Defaults to `createHlc(ctx.deviceId)`. */
  nextHlc?: () => string;
  /** ISO timestamp for the queued command. Defaults to wall clock. */
  now?: () => string;
}

/** Per-call overrides for verbs whose full effect set needs live state. */
export interface ExecuteOptions {
  /**
   * Effects to use INSTEAD of `buildOptimisticEffects` (for verbs whose target
   * row id isn't in the payload, e.g. layout upserts), or [] to skip the overlay.
   */
  effects?: EffectSpec[];
  /** Effects to APPEND to the built ones (e.g. the §I10 soft-delete closure). */
  extraEffects?: EffectSpec[];
}

export interface ExecuteCommand {
  /** Generic writer: validate → mint id/HLC → queue command + overlay effects. */
  execute(name: CommandName, payload: Record<string, unknown>, opts?: ExecuteOptions): Promise<string>;
  /** node.rename convenience wrapper (M0 slice). */
  renameNode(nodeId: string, title: string): Promise<string>;
}

/** A typed command failure (invariant pre-flight rejection or bad payload) surfaced to the UI. */
export class CommandError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CommandError';
  }
}

// --- §7.2d write-path guards: read MERGED (replica+overlay) facts at write time,
// the same seam `acceptSuggestion` already uses (readMergedRows). Self-contained
// here so the R7-owned data-provider is untouched (option (b) in the R5 log). ---
const mergedNodes = async (store: OverlayStore): Promise<Node[]> =>
  (await readMergedRows(store, 'nodes')).map((r) => toNode(r as Record<string, unknown>));
const mergedEdges = async (store: OverlayStore): Promise<Edge[]> =>
  (await readMergedRows(store, 'edges')).map((r) => toEdge(r as Record<string, unknown>));

/**
 * §7.2d step 2 (S7-F4): run the verb's invariant against MERGED state before enqueue
 * — the audit's headline case (a second clock-in) plus an I1-violating move. The
 * client's local state may be INCOMPLETE (a referenced row not yet synced / Tier-2
 * lazy), so this is CONSERVATIVE: it only rejects when the referenced row IS locally
 * present and definitively violates an invariant; otherwise it defers to the server
 * (which re-validates every command authoritatively). Returns the error, or null.
 */
async function preflightError(name: CommandName, p: Record<string, unknown>, store: OverlayStore, nowMs: Instant): Promise<DomainError | null> {
  switch (name) {
    case 'node.move': {
      const tree = buildTreeIndex(await mergedNodes(store));
      const id = String(p['id'] ?? '');
      const newParent = p['new_parent_id'] == null ? null : String(p['new_parent_id']);
      // defer unless both endpoints are locally known (else a sync gap looks illegal).
      if (!getNode(tree, id)) return null;
      if (newParent !== null && !getNode(tree, newParent)) return null;
      const r = checkNodeMove(tree, { id, new_parent_id: newParent });
      return r.ok ? null : r.error; // both present ⇒ any violation (I1/cycle) is real
    }
    case 'timer.clock_in': {
      const [nodes, edges, entries, blockers, facts] = await Promise.all([
        mergedNodes(store),
        mergedEdges(store),
        readMergedRows(store, 'time_entries').then((rs) => rs.map((r) => toTimeEntry(r as Record<string, unknown>))),
        readMergedRows(store, 'blocker_rules').then((rs) => rs.map((r) => toBlockerRule(r as Record<string, unknown>))),
        readMergedRows(store, 'external_facts').then((rs) => rs.map((r) => toExternalFact(r as Record<string, unknown>))),
      ]);
      const ctx = buildFactContext({ nodes, edges, time_entries: entries, blocker_rules: blockers, external_facts: facts });
      const taskId = String(p['task_id'] ?? '');
      const task = ctx.node(taskId);
      if (!task) return null; // task not in local state → defer to the server
      const hasOpenEntry = entries.some((e) => e.ended_at === null && e.deleted_at === null); // I5 is user-wide
      const chk = checkClockIn(task, taskId, hasOpenEntry); // task present ⇒ only I5/I8 fire
      if (!chk.ok) return chk.error;
      // Mirror R2: a weather-only-blocked task clocks in WITHOUT force locally too
      // (external facts must never gate acceptance); force skips the dependency gate.
      if (!p['force'] && isBlockedForAcceptance(task, ctx, nowMs)) {
        return domainError('E_BLOCKED_TASK', `task ${taskId} is blocked; clock in with force to override (§8)`);
      }
      return null;
    }
    default:
      return null;
  }
}

/** §I10 closure (S7-F7): `del` effects for the deleted node's descendants (the root already has one). */
async function softDeleteEffects(name: CommandName, p: Record<string, unknown>, store: OverlayStore): Promise<EffectSpec[]> {
  if (name !== 'node.soft_delete') return [];
  const rootId = String(p['id'] ?? '');
  const tree = buildTreeIndex(await mergedNodes(store));
  return softDeleteClosure(tree, rootId)
    .filter((id) => id !== rootId)
    .map((id) => ({ table: 'nodes', row_id: id, op: 'delete', fields: {} }));
}

const spawnDetail = (prov: SpawnProvenance | undefined, triggerNodeId: string): string =>
  JSON.stringify({ trigger_node_id: triggerNodeId, action_slot: prov?.slot ?? null, rule_version: prov?.rule_version ?? null, template_version: prov?.template_version ?? null });

/** The optimistic insert effect for an automation-spawned node (source_kind='automation', §7.8). */
function spawnedNodeEffect(n: Node, prov: SpawnProvenance | undefined, triggerNodeId: string): EffectSpec {
  return {
    table: 'nodes',
    row_id: n.id,
    op: 'insert',
    fields: {
      id: n.id, user_id: n.user_id, parent_id: n.parent_id, node_type: n.node_type,
      title: n.title, description: n.description, sort_order: n.sort_order,
      start_date: n.start_date, due_date: n.due_date, estimate_minutes: n.estimate_minutes,
      completed_at: n.completed_at, completion_disposition: n.completion_disposition,
      habit_id: n.habit_id, attributes: JSON.stringify(n.attributes ?? {}),
      source_kind: 'automation', source_id: prov?.rule_id ?? null, source_detail: spawnDetail(prov, triggerNodeId),
      created_at: n.created_at, updated_at: n.updated_at,
    },
  };
}
function spawnedEdgeEffect(e: Edge, prov: SpawnProvenance | undefined, triggerNodeId: string): EffectSpec {
  return {
    table: 'edges',
    row_id: e.id,
    op: 'insert',
    fields: {
      id: e.id, user_id: e.user_id, predecessor_id: e.predecessor_id, successor_id: e.successor_id,
      edge_type: e.edge_type, lag_minutes: e.lag_minutes,
      source_kind: 'automation', source_id: prov?.rule_id ?? null, source_detail: spawnDetail(prov, triggerNodeId),
      created_at: e.created_at, updated_at: e.updated_at,
    },
  };
}

/**
 * §10.1 offline automation spawning (S7-F1 High). On a task_created/task_completed
 * verb, run core `runAutomations` against merged facts and return the spawn insert
 * effects — appended to THIS command's overlay (same command_id/hlc), mirroring the
 * server's in-txn spawn. UUIDv5 spawn ids + predicted 'automation' provenance make
 * the server's authoritative rows reconcile these byte-identically. The I1/I3 spawn
 * validation mirrors `dispatcher.runAutomationInTx` exactly (drop illegal spawns +
 * dangling edges).
 */
async function automationSpawnEffects(name: CommandName, p: Record<string, unknown>, store: OverlayStore, userId: string, createdAt: string): Promise<EffectSpec[]> {
  const isCheckOff = name === 'node.check_off';
  const isCreateTask = name === 'node.create' && p['node_type'] === 'task';
  if (!isCheckOff && !isCreateTask) return [];
  const [nodes, edges, rules] = await Promise.all([
    mergedNodes(store),
    mergedEdges(store),
    readMergedRows(store, 'automation_rules').then((rs) => rs.map((r) => toAutomationRule(r as Record<string, unknown>))),
  ]);
  let trigger: TriggerEvent;
  if (isCheckOff) {
    const node = nodes.find((n) => n.id === p['id']);
    if (!node || node.node_type !== 'task') return [];
    trigger = {
      kind: 'task_completed',
      node: { ...node, completed_at: String(p['completed_at'] ?? node.completed_at ?? createdAt), completion_disposition: (p['disposition'] as Node['completion_disposition']) ?? 'completed' },
    };
  } else {
    trigger = { kind: 'task_created', node: toNode({ ...p, user_id: userId, created_at: createdAt, updated_at: createdAt }) };
  }
  const out = runAutomations({ trigger, rules, rows: { nodes, edges } });
  if (out.nodes.length === 0 && out.edges.length === 0) return [];
  // §6.7 I1/I3: validate spawns against live + spawned nodes; drop violations + dangling edges.
  const tree = buildTreeIndex([...nodes, ...out.nodes]);
  const liveIds = new Set(nodes.filter((n) => n.deleted_at === null).map((n) => n.id));
  const keptIds = new Set<string>();
  const keepNodes = out.nodes.filter((n) => {
    if (!checkNodeCreate(tree, n).ok) return false;
    keptIds.add(n.id);
    return true;
  });
  const endpointOk = (id: string) => liveIds.has(id) || keptIds.has(id);
  const keepEdges = out.edges.filter((e) => endpointOk(e.predecessor_id) && endpointOk(e.successor_id));
  const provById = new Map(out.provenance.map((pr) => [pr.id, pr]));
  return [
    ...keepNodes.map((n) => spawnedNodeEffect(n, provById.get(n.id), trigger.node.id)),
    ...keepEdges.map((e) => spawnedEdgeEffect(e, provById.get(e.id), trigger.node.id)),
  ];
}

/** §7.2e (S7-F5): a payload row-id inserted by a still-pending command is a causal dependency. */
const DEP_FK_FIELDS = ['parent_id', 'new_parent_id', 'task_id', 'predecessor_id', 'successor_id', 'node_id', 'block_id', 'tag_id', 'placement_id', 'board_id', 'criterion_id', 'project_id', 'vision_id', 'sprint_id', 'group_id', 'habit_id', 'replaces_block_id'];
const DEP_SOURCE_TABLES = ['nodes', 'edges', 'schedule_blocks', 'tags', 'tag_placements', 'diagram_groups', 'decision_boards', 'decision_criteria', 'sprints', 'habits'];
async function deriveDependsOn(p: Record<string, unknown>, store: OverlayStore): Promise<string[]> {
  const ownId = p['id'];
  const refs = new Set<string>();
  for (const f of DEP_FK_FIELDS) {
    const v = p[f];
    if (typeof v === 'string' && v.length > 0 && v !== ownId) refs.add(v);
  }
  if (refs.size === 0) return [];
  // overlay_effects only ever holds effects of still-PENDING commands, so an
  // insert effect there = a not-yet-uploaded create. Map its row_id → command_id.
  const byRow = new Map<string, string>();
  const lists = await Promise.all(DEP_SOURCE_TABLES.map((t) => store.effectsFor(t)));
  for (const list of lists) for (const e of list) if (e.op === 'insert') byRow.set(e.row_id, e.command_id);
  const deps = new Set<string>();
  for (const ref of refs) {
    const cmd = byRow.get(ref);
    if (cmd) deps.add(cmd);
  }
  return [...deps];
}

export function createExecuteCommand(store: OverlayStore, ctx: ExecuteContext, deps: ExecuteDeps = {}): ExecuteCommand {
  const mintId = deps.mintId ?? newId;
  const nextHlc = deps.nextHlc ?? createHlc(ctx.deviceId);
  const now = deps.now ?? (() => new Date().toISOString());

  async function execute(name: CommandName, rawPayload: Record<string, unknown>, opts: ExecuteOptions = {}): Promise<string> {
    const payload = stripTrustFields(rawPayload);
    const parsed = COMMAND_SCHEMAS[name].safeParse(payload);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new CommandError('E_PARSE', `${name} invalid: ${first ? `${first.path.join('.') || 'payload'}: ${first.message}` : 'bad payload'}`);
    }
    const data = parsed.data as Record<string, unknown>;
    const createdAt = now();

    // §7.2d step 2 (S7-F4): invariant pre-flight against merged state. A failure is
    // an immediate typed error — no id minted, no envelope, no overlay, no review item.
    const preErr = await preflightError(name, data, store, isoToEpochMillis(createdAt));
    if (preErr) throw new CommandError(preErr.code, preErr.message);

    const commandId = mintId();
    const hlc = nextHlc();

    const specs = opts.effects ?? buildOptimisticEffects(name, parsed.data, { userId: ctx.userId, deviceId: ctx.deviceId, now: createdAt });
    // §I10 soft-delete closure (S7-F7) + §10.1 offline automation spawning (S7-F1),
    // appended to THIS command's effects (same command_id/hlc) — one enqueue txn.
    const closure = await softDeleteEffects(name, data, store);
    const spawns = await automationSpawnEffects(name, data, store, ctx.userId, createdAt);
    const allSpecs = [...specs, ...(opts.extraEffects ?? []), ...closure, ...spawns];
    const effects: OverlayEffect[] = allSpecs.map((s, seq) => ({
      command_id: commandId,
      hlc,
      table: s.table,
      row_id: s.row_id,
      op: s.op,
      fields: s.fields,
      seq,
    }));

    // §7.2e (S7-F5): causal deps on still-pending inserts this payload references.
    const dependsOn = await deriveDependsOn(data, store);

    const command: ClientCommand = {
      id: commandId,
      name,
      hlc,
      payload: parsed.data as ClientCommand['payload'],
      status: 'pending',
      created_at: createdAt,
    };
    await store.enqueue(command, effects, dependsOn);
    return commandId;
  }

  return {
    execute,
    renameNode(nodeId, title) {
      return execute('node.rename', { id: nodeId, title });
    },
  };
}
