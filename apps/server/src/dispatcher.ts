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
  buildEdgeIndex,
  buildTreeIndex,
  checkActivityPromote,
  checkBlockCreate,
  checkBlockMove,
  checkClockOut,
  checkEdgeCreate,
  checkHabitVision,
  checkNodeCreate,
  checkNodeMove,
  checkNodeRetype,
  checkRule,
  isCommandName,
  resolveOpenTimeEntries,
  softDeleteClosure,
  uploadRequestSchema,
  type CommandName,
  type CommandOutcome,
  type DomainError,
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
  habit_completions,
  habits,
  nodes,
  schedule_blocks,
  sprint_memberships,
  sprints,
  tag_answers,
  tag_placements,
  tags,
  time_entries,
  user_settings,
} from '@prisms/db';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, inArray } from 'drizzle-orm';
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

type HandlerRejected = { status: 'rejected'; code: string; reason: string };
type HandlerOut = { status: 'applied'; backstop?: BackstopJob } | HandlerRejected;

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
  options: { enqueueBackstop?: (job: BackstopJob) => void | Promise<void>; nowIso?: () => string } = {},
): Dispatcher {
  const nowIso = options.nowIso ?? (() => new Date().toISOString());

  const one = async <T>(rows: Promise<T[]>): Promise<T | undefined> => (await rows)[0];
  const loadNodeRow = (tx: Tx, id: string) => one(tx.select().from(nodes).where(eq(nodes.id, id)).limit(1));
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
  const loadTree = async (tx: Tx, userId: string): Promise<TreeIndex> =>
    buildTreeIndex(await tx.select().from(nodes).where(eq(nodes.user_id, userId)));
  const loadEdgeIndex = async (tx: Tx, userId: string) =>
    buildEdgeIndex(await tx.select().from(edges).where(and(eq(edges.user_id, userId), isNull(edges.deleted_at))));

  /**
   * §7.3 last-writer-wins by HLC. Returns the subset of `candidate` fields
   * whose incoming HLC beats the recorded last writer (and records the new
   * winner). HLC strings are zero-padded so lexical compare == HLC order.
   * Losing fields are simply not written (the command is still logged).
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
      }
    }
    return winning;
  }

  async function runHandler(name: CommandName, tx: Tx, userId: string, deviceId: string, hlc: string, payload: unknown): Promise<HandlerOut> {
    const now = nowIso();
    const applied = (backstop?: BackstopJob): HandlerOut => ({ status: 'applied', backstop });
    // §9.4 idempotent create: an existing row (same user) is a converged no-op.
    const convergeOrOwn = (existing: { user_id: string } | undefined, kind: string, id: string): HandlerOut | null =>
      !existing ? null : existing.user_id === userId ? { status: 'applied' } : reject('E_OWNERSHIP', `${kind} ${id} belongs to another user`);
    /** Ownership-checked, HLC-filtered single-row field update on `nodes`. */
    const updateNode = async (id: string, fields: Record<string, unknown>): Promise<HandlerOut> => {
      const own = ownershipReject('node', id, await loadNodeRow(tx, id), userId);
      if (own) return own;
      const win = await lwwFields(tx, hlc, userId, 'nodes', id, fields);
      if (Object.keys(win).length > 0) await tx.update(nodes).set({ ...win, updated_at: now }).where(eq(nodes.id, id));
      return applied();
    };

    switch (name) {
      // --- nodes ------------------------------------------------------------
      case 'node.create': {
        const p = payload as Payload<'node.create'>;
        const conv = convergeOrOwn(await loadNodeRow(tx, p.id), 'node', p.id);
        if (conv) return conv;
        const bad = fromCheck(checkNodeCreate(await loadTree(tx, userId), p));
        if (bad) return bad;
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
          updated_at: now,
        });
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
      case 'node.move': {
        const p = payload as Payload<'node.move'>;
        const own = ownershipReject('node', p.id, await loadNodeRow(tx, p.id), userId);
        if (own) return own;
        const bad = fromCheck(checkNodeMove(await loadTree(tx, userId), p));
        if (bad) return bad;
        const win = await lwwFields(tx, hlc, userId, 'nodes', p.id, { parent_id: p.new_parent_id, sort_order: p.sort_order });
        if (Object.keys(win).length > 0) await tx.update(nodes).set({ ...win, updated_at: now }).where(eq(nodes.id, p.id));
        return applied();
      }
      case 'node.retype': {
        const p = payload as Payload<'node.retype'>;
        const own = ownershipReject('node', p.id, await loadNodeRow(tx, p.id), userId);
        if (own) return own;
        const bad = fromCheck(checkNodeRetype(await loadTree(tx, userId), p));
        if (bad) return bad;
        const win = await lwwFields(tx, hlc, userId, 'nodes', p.id, { node_type: p.node_type });
        if (Object.keys(win).length > 0) await tx.update(nodes).set({ ...win, updated_at: now }).where(eq(nodes.id, p.id));
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
        const win = await lwwFields(tx, hlc, userId, 'nodes', p.id, { completed_at: p.completed_at, completion_disposition: p.disposition ?? 'completed' });
        if (Object.keys(win).length > 0) await tx.update(nodes).set({ ...win, updated_at: now }).where(eq(nodes.id, p.id));
        return applied(row!.node_type === 'task' ? { userId, trigger: 'task_completed', nodeId: p.id } : undefined);
      }
      case 'node.uncheck': {
        const p = payload as Payload<'node.uncheck'>;
        return updateNode(p.id, { completed_at: null, completion_disposition: null });
      }
      case 'node.soft_delete': {
        const p = payload as Payload<'node.soft_delete'>;
        const own = ownershipReject('node', p.id, await loadNodeRow(tx, p.id), userId);
        if (own) return own;
        const ids = softDeleteClosure(await loadTree(tx, userId), p.id); // I10
        if (ids.length > 0) {
          await tx.update(nodes).set({ deleted_at: now, updated_at: now }).where(and(eq(nodes.user_id, userId), inArray(nodes.id, ids)));
        }
        return applied();
      }
      case 'activity.promote': {
        const p = payload as Payload<'activity.promote'>;
        const own = ownershipReject('activity', p.id, await loadNodeRow(tx, p.id), userId);
        if (own) return own;
        const bad = fromCheck(checkActivityPromote(await loadTree(tx, userId), p));
        if (bad) return bad;
        const win = await lwwFields(tx, hlc, userId, 'nodes', p.id, { node_type: 'task' as const, parent_id: p.parent_id ?? null, habit_id: p.habit_id ?? null });
        if (Object.keys(win).length > 0) await tx.update(nodes).set({ ...win, updated_at: now }).where(eq(nodes.id, p.id));
        return applied({ userId, trigger: 'task_created', nodeId: p.id });
      }

      // --- edges ------------------------------------------------------------
      case 'edge.create': {
        const p = payload as Payload<'edge.create'>;
        const conv = convergeOrOwn(await one(tx.select().from(edges).where(eq(edges.id, p.id)).limit(1)), 'edge', p.id);
        if (conv) return conv;
        const bad = fromCheck(checkEdgeCreate(await loadTree(tx, userId), await loadEdgeIndex(tx, userId), p));
        if (bad) return bad;
        await tx.insert(edges).values({
          id: p.id,
          user_id: userId,
          predecessor_id: p.predecessor_id,
          successor_id: p.successor_id,
          edge_type: p.edge_type ?? 'FS',
          lag_minutes: p.lag_minutes ?? 0,
          updated_at: now,
        });
        return applied();
      }
      case 'edge.delete': {
        const p = payload as Payload<'edge.delete'>;
        const row = await one(tx.select().from(edges).where(eq(edges.id, p.id)).limit(1));
        const own = ownershipReject('edge', p.id, row, userId);
        if (own) return own;
        await tx.update(edges).set({ deleted_at: now, updated_at: now }).where(eq(edges.id, p.id));
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
          updated_at: now,
        });
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
        if (Object.keys(win).length > 0) await tx.update(schedule_blocks).set({ ...win, updated_at: now }).where(eq(schedule_blocks.id, p.id));
        return applied();
      }
      case 'block.set_anchor': {
        const p = payload as Payload<'block.set_anchor'>;
        const block = await one(tx.select().from(schedule_blocks).where(eq(schedule_blocks.id, p.id)).limit(1));
        const own = ownershipReject('block', p.id, block, userId);
        if (own) return own;
        const win = await lwwFields(tx, hlc, userId, 'schedule_blocks', p.id, { anchor_type: p.anchor_type });
        if (Object.keys(win).length > 0) await tx.update(schedule_blocks).set({ ...win, updated_at: now }).where(eq(schedule_blocks.id, p.id));
        return applied();
      }
      case 'block.delete': {
        const p = payload as Payload<'block.delete'>;
        const block = await one(tx.select().from(schedule_blocks).where(eq(schedule_blocks.id, p.id)).limit(1));
        const own = ownershipReject('block', p.id, block, userId);
        if (own) return own;
        await tx.update(schedule_blocks).set({ deleted_at: now, updated_at: now }).where(eq(schedule_blocks.id, p.id));
        return applied();
      }
      case 'block.accept_suggestion': {
        const p = payload as Payload<'block.accept_suggestion'>;
        const block = await one(tx.select().from(schedule_blocks).where(eq(schedule_blocks.id, p.id)).limit(1));
        const own = ownershipReject('block', p.id, block, userId);
        if (own) return own;
        await tx.update(schedule_blocks).set({ status: 'committed', suggestion_reason: null, updated_at: now }).where(eq(schedule_blocks.id, p.id));
        return applied();
      }
      case 'block.reject_suggestion': {
        const p = payload as Payload<'block.reject_suggestion'>;
        const block = await one(tx.select().from(schedule_blocks).where(eq(schedule_blocks.id, p.id)).limit(1));
        const own = ownershipReject('block', p.id, block, userId);
        if (own) return own;
        await tx.update(schedule_blocks).set({ deleted_at: now, updated_at: now }).where(eq(schedule_blocks.id, p.id));
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

        const openEntry = await one(
          tx.select().from(time_entries).where(and(eq(time_entries.user_id, userId), isNull(time_entries.ended_at), isNull(time_entries.deleted_at))).limit(1),
        );
        const insertEntry = (endedAt: string | null) =>
          tx.insert(time_entries).values({
            id: p.entry_id,
            user_id: userId,
            task_id: p.task_id,
            started_at: p.started_at,
            ended_at: endedAt,
            completed_session: endedAt === null ? undefined : null,
            planned: p.planned ?? true,
            device_id: deviceId,
            updated_at: now,
          });

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
          await tx.update(time_entries).set({ ended_at: res.closures[0]!.ended_at, completed_session: null, updated_at: now }).where(eq(time_entries.id, openEntry.id));
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
        await tx.update(time_entries).set({ ended_at: p.ended_at, updated_at: now }).where(eq(time_entries.id, p.entry_id));
        return applied();
      }
      case 'timer.review': {
        const p = payload as Payload<'timer.review'>;
        const entry = await one(tx.select().from(time_entries).where(eq(time_entries.id, p.entry_id)).limit(1));
        const own = ownershipReject('time entry', p.entry_id, entry, userId);
        if (own) return own;
        const win = await lwwFields(tx, hlc, userId, 'time_entries', p.entry_id, { focus_factor: p.focus_factor, completed_session: p.completed_session });
        if (Object.keys(win).length > 0) await tx.update(time_entries).set({ ...win, updated_at: now }).where(eq(time_entries.id, p.entry_id));
        if (p.completed_session && entry!.ended_at !== null) {
          const task = await loadNodeRow(tx, entry!.task_id);
          if (task && task.user_id === userId && task.completed_at === null) {
            const winC = await lwwFields(tx, hlc, userId, 'nodes', task.id, { completed_at: entry!.ended_at, completion_disposition: 'completed' as const });
            if (Object.keys(winC).length > 0) await tx.update(nodes).set({ ...winC, updated_at: now }).where(eq(nodes.id, task.id));
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
        const bad = fromCheck(checkHabitVision(await loadTree(tx, userId), p.vision_id));
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
          updated_at: now,
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
        if (Object.keys(win).length > 0) await tx.update(habits).set({ ...win, updated_at: now }).where(eq(habits.id, p.id));
        return applied();
      }
      case 'habit.delete': {
        const p = payload as Payload<'habit.delete'>;
        const own = ownershipReject('habit', p.id, await one(tx.select().from(habits).where(eq(habits.id, p.id)).limit(1)), userId);
        if (own) return own;
        await tx.update(habits).set({ deleted_at: now, updated_at: now }).where(eq(habits.id, p.id));
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
          .values({ id: p.id, user_id: userId, habit_id: p.habit_id, occurrence_date: p.occurrence_date, completed_at: p.completed_at, updated_at: now })
          .onConflictDoNothing({ target: [habit_completions.habit_id, habit_completions.occurrence_date] });
        return applied();
      }

      // --- sprints ----------------------------------------------------------
      case 'sprint.create': {
        const p = payload as Payload<'sprint.create'>;
        const conv = convergeOrOwn(await one(tx.select().from(sprints).where(eq(sprints.id, p.id)).limit(1)), 'sprint', p.id);
        if (conv) return conv;
        await tx.insert(sprints).values({ id: p.id, user_id: userId, title: p.title, starts_on: p.starts_on, ends_on: p.ends_on, updated_at: now });
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
        await tx.insert(sprint_memberships).values({ id: p.id, user_id: userId, sprint_id: p.sprint_id, node_id: p.node_id, updated_at: now }).onConflictDoNothing({ target: [sprint_memberships.sprint_id, sprint_memberships.node_id] });
        return applied();
      }
      case 'sprint.remove_node': {
        const p = payload as Payload<'sprint.remove_node'>;
        const own = ownershipReject('sprint membership', p.id, await one(tx.select().from(sprint_memberships).where(eq(sprint_memberships.id, p.id)).limit(1)), userId);
        if (own) return own;
        await tx.update(sprint_memberships).set({ deleted_at: now, updated_at: now }).where(eq(sprint_memberships.id, p.id));
        return applied();
      }
      case 'sprint.delete': {
        const p = payload as Payload<'sprint.delete'>;
        const own = ownershipReject('sprint', p.id, await one(tx.select().from(sprints).where(eq(sprints.id, p.id)).limit(1)), userId);
        if (own) return own;
        await tx.update(sprints).set({ deleted_at: now, updated_at: now }).where(eq(sprints.id, p.id));
        return applied();
      }

      // --- decision board ---------------------------------------------------
      case 'board.create': {
        const p = payload as Payload<'board.create'>;
        const conv = convergeOrOwn(await one(tx.select().from(decision_boards).where(eq(decision_boards.id, p.id)).limit(1)), 'board', p.id);
        if (conv) return conv;
        await tx.insert(decision_boards).values({ id: p.id, user_id: userId, title: p.title, updated_at: now });
        return applied();
      }
      case 'criterion.create': {
        const p = payload as Payload<'criterion.create'>;
        const conv = convergeOrOwn(await one(tx.select().from(decision_criteria).where(eq(decision_criteria.id, p.id)).limit(1)), 'criterion', p.id);
        if (conv) return conv;
        const own = ownershipReject('board', p.board_id, await one(tx.select().from(decision_boards).where(eq(decision_boards.id, p.board_id)).limit(1)), userId);
        if (own) return own;
        await tx.insert(decision_criteria).values({ id: p.id, user_id: userId, board_id: p.board_id, label: p.label, weight: p.weight, updated_at: now });
        return applied();
      }
      case 'criterion.set_weight': {
        const p = payload as Payload<'criterion.set_weight'>;
        const own = ownershipReject('criterion', p.id, await one(tx.select().from(decision_criteria).where(eq(decision_criteria.id, p.id)).limit(1)), userId);
        if (own) return own;
        const win = await lwwFields(tx, hlc, userId, 'decision_criteria', p.id, { weight: p.weight });
        if (Object.keys(win).length > 0) await tx.update(decision_criteria).set({ ...win, updated_at: now }).where(eq(decision_criteria.id, p.id));
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
          await tx.insert(decision_scores).values({ id: p.id, user_id: userId, criterion_id: p.criterion_id, project_id: p.project_id, score: p.score, updated_at: now });
          await lwwFields(tx, hlc, userId, 'decision_scores', p.id, { score: p.score });
        } else {
          const win = await lwwFields(tx, hlc, userId, 'decision_scores', existing.id, { score: p.score });
          if (Object.keys(win).length > 0) await tx.update(decision_scores).set({ ...win, updated_at: now }).where(eq(decision_scores.id, existing.id));
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
        await tx.insert(tags).values({ id: p.id, user_id: userId, label: p.label, habit_id: p.habit_id ?? null, updated_at: now });
        return applied();
      }
      case 'tag.rename': {
        const p = payload as Payload<'tag.rename'>;
        const own = ownershipReject('tag', p.id, await one(tx.select().from(tags).where(eq(tags.id, p.id)).limit(1)), userId);
        if (own) return own;
        const win = await lwwFields(tx, hlc, userId, 'tags', p.id, { label: p.label });
        if (Object.keys(win).length > 0) await tx.update(tags).set({ ...win, updated_at: now }).where(eq(tags.id, p.id));
        return applied();
      }
      case 'tag.delete': {
        const p = payload as Payload<'tag.delete'>;
        const own = ownershipReject('tag', p.id, await one(tx.select().from(tags).where(eq(tags.id, p.id)).limit(1)), userId);
        if (own) return own;
        await tx.update(tags).set({ deleted_at: now, updated_at: now }).where(eq(tags.id, p.id));
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
        await tx.insert(tag_placements).values({ id: p.id, user_id: userId, block_id: p.block_id, tag_id: p.tag_id, updated_at: now });
        return applied();
      }
      case 'tag.unplace': {
        const p = payload as Payload<'tag.unplace'>;
        const own = ownershipReject('tag placement', p.id, await one(tx.select().from(tag_placements).where(eq(tag_placements.id, p.id)).limit(1)), userId);
        if (own) return own;
        await tx.update(tag_placements).set({ deleted_at: now, updated_at: now }).where(eq(tag_placements.id, p.id));
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
          await tx.insert(tag_answers).values({ id: p.id, user_id: userId, placement_id: p.placement_id, value: p.value, answered_at: p.answered_at, updated_at: now });
          await lwwFields(tx, hlc, userId, 'tag_answers', p.id, { value: p.value, answered_at: p.answered_at });
        } else {
          const win = await lwwFields(tx, hlc, userId, 'tag_answers', existing.id, { value: p.value, answered_at: p.answered_at });
          if (Object.keys(win).length > 0) await tx.update(tag_answers).set({ ...win, updated_at: now }).where(eq(tag_answers.id, existing.id));
        }
        return applied();
      }
      case 'tag.clear_answer': {
        const p = payload as Payload<'tag.clear_answer'>;
        const own = ownershipReject('tag answer', p.id, await one(tx.select().from(tag_answers).where(eq(tag_answers.id, p.id)).limit(1)), userId);
        if (own) return own;
        await tx.update(tag_answers).set({ deleted_at: now, updated_at: now }).where(eq(tag_answers.id, p.id));
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
        await tx.insert(automation_rules).values({ id: p.id, user_id: userId, trigger: p.trigger, conditions: p.conditions, actions: p.actions, enabled: p.enabled ?? true, updated_at: now });
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
        if (Object.keys(win).length > 0) await tx.update(automation_rules).set({ ...win, updated_at: now }).where(eq(automation_rules.id, p.id));
        return applied();
      }
      case 'rule.toggle': {
        const p = payload as Payload<'rule.toggle'>;
        const own = ownershipReject('rule', p.id, await one(tx.select().from(automation_rules).where(eq(automation_rules.id, p.id)).limit(1)), userId);
        if (own) return own;
        const win = await lwwFields(tx, hlc, userId, 'automation_rules', p.id, { enabled: p.enabled });
        if (Object.keys(win).length > 0) await tx.update(automation_rules).set({ ...win, updated_at: now }).where(eq(automation_rules.id, p.id));
        return applied();
      }
      case 'rule.delete': {
        const p = payload as Payload<'rule.delete'>;
        const own = ownershipReject('rule', p.id, await one(tx.select().from(automation_rules).where(eq(automation_rules.id, p.id)).limit(1)), userId);
        if (own) return own;
        await tx.update(automation_rules).set({ deleted_at: now, updated_at: now }).where(eq(automation_rules.id, p.id));
        return applied();
      }
      case 'blocker.create': {
        const p = payload as Payload<'blocker.create'>;
        const conv = convergeOrOwn(await one(tx.select().from(blocker_rules).where(eq(blocker_rules.id, p.id)).limit(1)), 'blocker', p.id);
        if (conv) return conv;
        await tx.insert(blocker_rules).values({ id: p.id, user_id: userId, scope: p.scope, predicate: p.predicate, label: p.label, enabled: p.enabled ?? true, updated_at: now });
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
        if (Object.keys(win).length > 0) await tx.update(blocker_rules).set({ ...win, updated_at: now }).where(eq(blocker_rules.id, p.id));
        return applied();
      }
      case 'blocker.toggle': {
        const p = payload as Payload<'blocker.toggle'>;
        const own = ownershipReject('blocker', p.id, await one(tx.select().from(blocker_rules).where(eq(blocker_rules.id, p.id)).limit(1)), userId);
        if (own) return own;
        const win = await lwwFields(tx, hlc, userId, 'blocker_rules', p.id, { enabled: p.enabled });
        if (Object.keys(win).length > 0) await tx.update(blocker_rules).set({ ...win, updated_at: now }).where(eq(blocker_rules.id, p.id));
        return applied();
      }
      case 'blocker.delete': {
        const p = payload as Payload<'blocker.delete'>;
        const own = ownershipReject('blocker', p.id, await one(tx.select().from(blocker_rules).where(eq(blocker_rules.id, p.id)).limit(1)), userId);
        if (own) return own;
        await tx.update(blocker_rules).set({ deleted_at: now, updated_at: now }).where(eq(blocker_rules.id, p.id));
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
          await tx.insert(diagram_layouts).values({ id, user_id: userId, diagram_id: p.diagram_id, node_id: p.node_id, ...fields, updated_at: now });
          await lwwFields(tx, hlc, userId, 'diagram_layouts', id, fields);
        } else {
          const ownLayout = ownershipReject('layout', existing.id, existing, userId);
          if (ownLayout) return ownLayout;
          const win = await lwwFields(tx, hlc, userId, 'diagram_layouts', existing.id, fields);
          if (Object.keys(win).length > 0) await tx.update(diagram_layouts).set({ ...win, updated_at: now }).where(eq(diagram_layouts.id, existing.id));
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
          await tx.insert(diagram_layouts).values({ id, user_id: userId, diagram_id: p.diagram_id, node_id: p.node_id, x: 0, y: 0, collapsed: p.collapsed, updated_at: now });
          await lwwFields(tx, hlc, userId, 'diagram_layouts', id, { collapsed: p.collapsed });
        } else {
          const ownLayout = ownershipReject('layout', existing.id, existing, userId);
          if (ownLayout) return ownLayout;
          const win = await lwwFields(tx, hlc, userId, 'diagram_layouts', existing.id, { collapsed: p.collapsed });
          if (Object.keys(win).length > 0) await tx.update(diagram_layouts).set({ ...win, updated_at: now }).where(eq(diagram_layouts.id, existing.id));
        }
        return applied();
      }
      case 'group.create': {
        const p = payload as Payload<'group.create'>;
        const conv = convergeOrOwn(await one(tx.select().from(diagram_groups).where(eq(diagram_groups.id, p.id)).limit(1)), 'group', p.id);
        if (conv) return conv;
        const ownDiagram = ownershipReject('diagram', p.diagram_id, await loadNodeRow(tx, p.diagram_id), userId);
        if (ownDiagram) return ownDiagram;
        await tx.insert(diagram_groups).values({ id: p.id, user_id: userId, diagram_id: p.diagram_id, label: p.label, color: p.color ?? null, updated_at: now });
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
        if (Object.keys(win).length > 0) await tx.update(diagram_groups).set({ ...win, updated_at: now }).where(eq(diagram_groups.id, p.id));
        return applied();
      }
      case 'group.delete': {
        const p = payload as Payload<'group.delete'>;
        const own = ownershipReject('group', p.id, await one(tx.select().from(diagram_groups).where(eq(diagram_groups.id, p.id)).limit(1)), userId);
        if (own) return own;
        await tx.update(diagram_groups).set({ deleted_at: now, updated_at: now }).where(eq(diagram_groups.id, p.id));
        return applied();
      }

      // --- settings ---------------------------------------------------------
      case 'settings.update': {
        const p = payload as Payload<'settings.update'>;
        const candidate: Record<string, unknown> = {};
        if (p.day_reset_hour !== undefined) candidate['day_reset_hour'] = p.day_reset_hour;
        if (p.timezone !== undefined) candidate['timezone'] = p.timezone;
        if (p.weather_location !== undefined) candidate['weather_location'] = p.weather_location;
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
    cmd: { id: string; name: string; hlc: string; payload: unknown },
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
      result,
      reject_reason: rejectReason,
    });
  }

  async function handleCommand(
    userId: string,
    deviceId: string,
    cmd: { id: string; name: string; hlc: string; payload: unknown },
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

    if (!isCommandName(cmd.name)) {
      await logResult(userId, deviceId, cmd, 'rejected', 'E_UNKNOWN_COMMAND: unknown command');
      return { id: cmd.id, result: 'rejected', reject_code: 'E_UNKNOWN_COMMAND', reject_reason: `unknown command "${cmd.name}"` };
    }
    const parsed = COMMAND_SCHEMAS[cmd.name].safeParse(cmd.payload);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const reason = first ? `${first.path.join('.') || 'payload'}: ${first.message}` : 'invalid payload';
      await logResult(userId, deviceId, cmd, 'rejected', `E_PARSE: ${reason}`);
      return { id: cmd.id, result: 'rejected', reject_code: 'E_PARSE', reject_reason: reason };
    }

    try {
      const { out } = await db.transaction(async (tx) => {
        const result = await runHandler(cmd.name as CommandName, tx, userId, deviceId, cmd.hlc, parsed.data);
        await tx.insert(command_log).values({
          id: cmd.id,
          user_id: userId,
          name: cmd.name,
          payload: cmd.payload as never,
          device_id: deviceId,
          hlc: cmd.hlc,
          result: result.status === 'applied' ? 'applied' : 'rejected',
          reject_reason: result.status === 'rejected' ? `${result.code}: ${result.reason}` : null,
        });
        return { out: result };
      });
      if (out.status === 'applied') {
        if (out.backstop && options.enqueueBackstop) await options.enqueueBackstop(out.backstop);
        return { id: cmd.id, result: 'applied' };
      }
      return { id: cmd.id, result: 'rejected', reject_code: out.code, reject_reason: out.reason };
    } catch (error) {
      if (isUniqueViolation(error)) {
        const existing = await one(db.select({ result: command_log.result }).from(command_log).where(eq(command_log.id, cmd.id)).limit(1));
        if (existing) return { id: cmd.id, result: 'noop', original_result: existing.result === 'applied' ? 'applied' : 'rejected' };
      }
      throw error;
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

      const results: CommandOutcome[] = [];
      for (const cmd of commands) results.push(await handleCommand(userId, device_id, cmd));
      return { kind: 'ok', results };
    },
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === '23505';
}
