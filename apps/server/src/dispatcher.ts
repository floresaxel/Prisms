/**
 * Command dispatcher — the §8 write path, full §8.1 catalog (s11).
 *
 * Pipeline per command, in order: (1) Zod parse against the catalog schema →
 * (2) ownership: every referenced row's user_id must equal the token user →
 * (3) invariant checks from @prisms/core (the same functions the client ran)
 * → (4) apply via Drizzle in a transaction → (5) append command_log. The
 * command id is the idempotency key: replays return the original result as
 * `noop`. Rejections carry machine-readable codes (§8). Completions/creations
 * enqueue automation.backstop (§9.4, run by the S13 job).
 */
import {
  COMMAND_SCHEMAS,
  buildEdgeIndex,
  buildTreeIndex,
  checkActivityPromote,
  checkBlockCreate,
  checkBlockMove,
  checkClockIn,
  checkClockOut,
  checkEdgeCreate,
  checkHabitVision,
  checkNodeCreate,
  checkNodeMove,
  checkNodeRetype,
  checkRule,
  isCommandName,
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
  time_entries,
  user_settings,
} from '@prisms/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
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

  // --- row loaders (ownership reads; not deleted-filtered so we can detect
  // cross-user references precisely) ---------------------------------------
  const one = async <T>(rows: Promise<T[]>): Promise<T | undefined> => (await rows)[0];
  const loadNodeRow = (tx: Tx, id: string) => one(tx.select().from(nodes).where(eq(nodes.id, id)).limit(1));
  const loadTree = async (tx: Tx, userId: string): Promise<TreeIndex> =>
    buildTreeIndex(await tx.select().from(nodes).where(eq(nodes.user_id, userId)));
  const loadEdgeIndex = async (tx: Tx, userId: string) =>
    buildEdgeIndex(
      await tx.select().from(edges).where(and(eq(edges.user_id, userId), isNull(edges.deleted_at))),
    );

  // --- handler: one per verb. Receives the parsed payload; does ownership +
  // invariant + apply, returns applied/rejected (+ optional backstop). ------
  async function runHandler(name: CommandName, tx: Tx, userId: string, deviceId: string, payload: unknown): Promise<HandlerOut> {
    const now = nowIso();
    const applied = (backstop?: BackstopJob): HandlerOut => ({ status: 'applied', backstop });

    switch (name) {
      // --- nodes ------------------------------------------------------------
      case 'node.create': {
        const p = payload as Payload<'node.create'>;
        const existing = await loadNodeRow(tx, p.id);
        if (existing) return reject('E_DUPLICATE', `node ${p.id} already exists`);
        const tree = await loadTree(tx, userId);
        const bad = fromCheck(checkNodeCreate(tree, p));
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
        return applied(
          p.node_type === 'task' ? { userId, trigger: 'task_created', nodeId: p.id } : undefined,
        );
      }
      case 'node.rename': {
        const p = payload as Payload<'node.rename'>;
        const row = await loadNodeRow(tx, p.id);
        const own = ownershipReject('node', p.id, row, userId);
        if (own) return own;
        await tx.update(nodes).set({ title: p.title, updated_at: now }).where(eq(nodes.id, p.id));
        return applied();
      }
      case 'node.set_description': {
        const p = payload as Payload<'node.set_description'>;
        const row = await loadNodeRow(tx, p.id);
        const own = ownershipReject('node', p.id, row, userId);
        if (own) return own;
        await tx.update(nodes).set({ description: p.description, updated_at: now }).where(eq(nodes.id, p.id));
        return applied();
      }
      case 'node.move': {
        const p = payload as Payload<'node.move'>;
        const row = await loadNodeRow(tx, p.id);
        const own = ownershipReject('node', p.id, row, userId);
        if (own) return own;
        const tree = await loadTree(tx, userId);
        const bad = fromCheck(checkNodeMove(tree, p));
        if (bad) return bad;
        await tx
          .update(nodes)
          .set({ parent_id: p.new_parent_id, sort_order: p.sort_order, updated_at: now })
          .where(eq(nodes.id, p.id));
        return applied();
      }
      case 'node.retype': {
        const p = payload as Payload<'node.retype'>;
        const row = await loadNodeRow(tx, p.id);
        const own = ownershipReject('node', p.id, row, userId);
        if (own) return own;
        const tree = await loadTree(tx, userId);
        const bad = fromCheck(checkNodeRetype(tree, p));
        if (bad) return bad;
        await tx.update(nodes).set({ node_type: p.node_type, updated_at: now }).where(eq(nodes.id, p.id));
        return applied();
      }
      case 'node.set_dates': {
        const p = payload as Payload<'node.set_dates'>;
        const row = await loadNodeRow(tx, p.id);
        const own = ownershipReject('node', p.id, row, userId);
        if (own) return own;
        const set: Record<string, unknown> = { updated_at: now };
        if ('start_date' in p) set['start_date'] = p.start_date ?? null;
        if ('due_date' in p) set['due_date'] = p.due_date ?? null;
        await tx.update(nodes).set(set).where(eq(nodes.id, p.id));
        return applied();
      }
      case 'node.set_estimate': {
        const p = payload as Payload<'node.set_estimate'>;
        const row = await loadNodeRow(tx, p.id);
        const own = ownershipReject('node', p.id, row, userId);
        if (own) return own;
        await tx.update(nodes).set({ estimate_minutes: p.estimate_minutes, updated_at: now }).where(eq(nodes.id, p.id));
        return applied();
      }
      case 'node.reorder': {
        const p = payload as Payload<'node.reorder'>;
        const row = await loadNodeRow(tx, p.id);
        const own = ownershipReject('node', p.id, row, userId);
        if (own) return own;
        await tx.update(nodes).set({ sort_order: p.sort_order, updated_at: now }).where(eq(nodes.id, p.id));
        return applied();
      }
      case 'node.check_off': {
        const p = payload as Payload<'node.check_off'>;
        const row = await loadNodeRow(tx, p.id);
        const own = ownershipReject('node', p.id, row, userId);
        if (own) return own;
        await tx.update(nodes).set({ completed_at: p.completed_at, updated_at: now }).where(eq(nodes.id, p.id));
        return applied(
          row!.node_type === 'task' ? { userId, trigger: 'task_completed', nodeId: p.id } : undefined,
        );
      }
      case 'node.uncheck': {
        const p = payload as Payload<'node.uncheck'>;
        const row = await loadNodeRow(tx, p.id);
        const own = ownershipReject('node', p.id, row, userId);
        if (own) return own;
        await tx.update(nodes).set({ completed_at: null, updated_at: now }).where(eq(nodes.id, p.id));
        return applied();
      }
      case 'node.soft_delete': {
        const p = payload as Payload<'node.soft_delete'>;
        const row = await loadNodeRow(tx, p.id);
        const own = ownershipReject('node', p.id, row, userId);
        if (own) return own;
        const tree = await loadTree(tx, userId);
        const ids = softDeleteClosure(tree, p.id); // I10 cascade closure
        if (ids.length > 0) {
          await tx.update(nodes).set({ deleted_at: now, updated_at: now }).where(
            and(eq(nodes.user_id, userId), inArray(nodes.id, ids)),
          );
        }
        return applied();
      }
      case 'activity.promote': {
        const p = payload as Payload<'activity.promote'>;
        const row = await loadNodeRow(tx, p.id);
        const own = ownershipReject('activity', p.id, row, userId);
        if (own) return own;
        const tree = await loadTree(tx, userId);
        const bad = fromCheck(checkActivityPromote(tree, p));
        if (bad) return bad;
        await tx
          .update(nodes)
          .set({ node_type: 'task', parent_id: p.parent_id ?? null, habit_id: p.habit_id ?? null, updated_at: now })
          .where(eq(nodes.id, p.id));
        return applied({ userId, trigger: 'task_created', nodeId: p.id });
      }

      // --- edges ------------------------------------------------------------
      case 'edge.create': {
        const p = payload as Payload<'edge.create'>;
        const existing = await one(tx.select().from(edges).where(eq(edges.id, p.id)).limit(1));
        if (existing) return reject('E_DUPLICATE', `edge ${p.id} already exists`);
        const tree = await loadTree(tx, userId);
        const edgeIndex = await loadEdgeIndex(tx, userId);
        const bad = fromCheck(checkEdgeCreate(tree, edgeIndex, p));
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
        const existing = await one(tx.select().from(schedule_blocks).where(eq(schedule_blocks.id, p.id)).limit(1));
        if (existing) return reject('E_DUPLICATE', `block ${p.id} already exists`);
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
        await tx.update(schedule_blocks).set({ starts_at: p.starts_at, ends_at: p.ends_at, updated_at: now }).where(eq(schedule_blocks.id, p.id));
        return applied();
      }
      case 'block.set_anchor': {
        const p = payload as Payload<'block.set_anchor'>;
        const block = await one(tx.select().from(schedule_blocks).where(eq(schedule_blocks.id, p.id)).limit(1));
        const own = ownershipReject('block', p.id, block, userId);
        if (own) return own;
        await tx.update(schedule_blocks).set({ anchor_type: p.anchor_type, updated_at: now }).where(eq(schedule_blocks.id, p.id));
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
        const existing = await one(tx.select().from(time_entries).where(eq(time_entries.id, p.entry_id)).limit(1));
        if (existing) return reject('E_DUPLICATE', `time entry ${p.entry_id} already exists`);
        const task = await loadNodeRow(tx, p.task_id);
        const own = ownershipReject('task', p.task_id, task, userId);
        if (own) return own;
        const openCount = await one(
          tx
            .select({ n: sql<number>`count(*)::int` })
            .from(time_entries)
            .where(and(eq(time_entries.user_id, userId), isNull(time_entries.ended_at), isNull(time_entries.deleted_at))),
        );
        const bad = fromCheck(checkClockIn(task as CoreNode, p.task_id, (openCount?.n ?? 0) > 0));
        if (bad) return bad;
        await tx.insert(time_entries).values({
          id: p.entry_id,
          user_id: userId,
          task_id: p.task_id,
          started_at: p.started_at,
          ended_at: null,
          planned: p.planned ?? true,
          device_id: deviceId,
          updated_at: now,
        });
        return applied();
      }
      case 'timer.clock_out': {
        const p = payload as Payload<'timer.clock_out'>;
        const entry = await one(tx.select().from(time_entries).where(eq(time_entries.id, p.entry_id)).limit(1));
        const own = ownershipReject('time entry', p.entry_id, entry, userId);
        if (own) return own;
        const bad = fromCheck(checkClockOut(entry!, p.entry_id, p));
        if (bad) return bad;
        await tx.update(time_entries).set({ ended_at: p.ended_at, updated_at: now }).where(eq(time_entries.id, p.entry_id));
        return applied();
      }
      case 'timer.review': {
        const p = payload as Payload<'timer.review'>;
        const entry = await one(tx.select().from(time_entries).where(eq(time_entries.id, p.entry_id)).limit(1));
        const own = ownershipReject('time entry', p.entry_id, entry, userId);
        if (own) return own;
        await tx
          .update(time_entries)
          .set({ focus_factor: p.focus_factor, completed_session: p.completed_session, updated_at: now })
          .where(eq(time_entries.id, p.entry_id));
        // may also complete the task (§8.1): set completed_at to the session end
        if (p.completed_session && entry!.ended_at !== null) {
          const task = await loadNodeRow(tx, entry!.task_id);
          if (task && task.user_id === userId && task.completed_at === null) {
            await tx.update(nodes).set({ completed_at: entry!.ended_at, updated_at: now }).where(eq(nodes.id, task.id));
            return applied({ userId, trigger: 'task_completed', nodeId: task.id });
          }
        }
        return applied();
      }

      // --- habits -----------------------------------------------------------
      case 'habit.create': {
        const p = payload as Payload<'habit.create'>;
        const existing = await one(tx.select().from(habits).where(eq(habits.id, p.id)).limit(1));
        if (existing) return reject('E_DUPLICATE', `habit ${p.id} already exists`);
        const tree = await loadTree(tx, userId);
        const bad = fromCheck(checkHabitVision(tree, p.vision_id));
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
        const row = await one(tx.select().from(habits).where(eq(habits.id, p.id)).limit(1));
        const own = ownershipReject('habit', p.id, row, userId);
        if (own) return own;
        const set: Record<string, unknown> = { updated_at: now };
        if (p.title !== undefined) set['title'] = p.title;
        if (p.rrule !== undefined) set['rrule'] = p.rrule;
        if (p.streak_mode !== undefined) set['streak_mode'] = p.streak_mode;
        if ('daily_target_minutes' in p) set['daily_target_minutes'] = p.daily_target_minutes ?? null;
        if ('mastery_target_hours' in p) set['mastery_target_hours'] = p.mastery_target_hours ?? null;
        if (p.level_thresholds_hours !== undefined) set['level_thresholds_hours'] = p.level_thresholds_hours;
        await tx.update(habits).set(set).where(eq(habits.id, p.id));
        return applied();
      }
      case 'habit.delete': {
        const p = payload as Payload<'habit.delete'>;
        const row = await one(tx.select().from(habits).where(eq(habits.id, p.id)).limit(1));
        const own = ownershipReject('habit', p.id, row, userId);
        if (own) return own;
        await tx.update(habits).set({ deleted_at: now, updated_at: now }).where(eq(habits.id, p.id));
        return applied();
      }
      case 'habit.check_off': {
        const p = payload as Payload<'habit.check_off'>;
        const existing = await one(tx.select().from(habit_completions).where(eq(habit_completions.id, p.id)).limit(1));
        if (existing) return reject('E_DUPLICATE', `habit completion ${p.id} already exists`);
        const habit = await one(tx.select().from(habits).where(eq(habits.id, p.habit_id)).limit(1));
        const own = ownershipReject('habit', p.habit_id, habit, userId);
        if (own) return own;
        await tx.insert(habit_completions).values({
          id: p.id,
          user_id: userId,
          habit_id: p.habit_id,
          occurrence_date: p.occurrence_date,
          completed_at: p.completed_at,
          updated_at: now,
        });
        return applied();
      }

      // --- sprints ----------------------------------------------------------
      case 'sprint.create': {
        const p = payload as Payload<'sprint.create'>;
        const existing = await one(tx.select().from(sprints).where(eq(sprints.id, p.id)).limit(1));
        if (existing) return reject('E_DUPLICATE', `sprint ${p.id} already exists`);
        await tx.insert(sprints).values({
          id: p.id,
          user_id: userId,
          title: p.title,
          starts_on: p.starts_on,
          ends_on: p.ends_on,
          updated_at: now,
        });
        return applied();
      }
      case 'sprint.add_node': {
        const p = payload as Payload<'sprint.add_node'>;
        const sprint = await one(tx.select().from(sprints).where(eq(sprints.id, p.sprint_id)).limit(1));
        const ownS = ownershipReject('sprint', p.sprint_id, sprint, userId);
        if (ownS) return ownS;
        const node = await loadNodeRow(tx, p.node_id);
        const ownN = ownershipReject('node', p.node_id, node, userId);
        if (ownN) return ownN;
        await tx.insert(sprint_memberships).values({
          id: p.id,
          user_id: userId,
          sprint_id: p.sprint_id,
          node_id: p.node_id,
          updated_at: now,
        });
        return applied();
      }
      case 'sprint.remove_node': {
        const p = payload as Payload<'sprint.remove_node'>;
        const row = await one(tx.select().from(sprint_memberships).where(eq(sprint_memberships.id, p.id)).limit(1));
        const own = ownershipReject('sprint membership', p.id, row, userId);
        if (own) return own;
        await tx.update(sprint_memberships).set({ deleted_at: now, updated_at: now }).where(eq(sprint_memberships.id, p.id));
        return applied();
      }
      case 'sprint.delete': {
        const p = payload as Payload<'sprint.delete'>;
        const row = await one(tx.select().from(sprints).where(eq(sprints.id, p.id)).limit(1));
        const own = ownershipReject('sprint', p.id, row, userId);
        if (own) return own;
        await tx.update(sprints).set({ deleted_at: now, updated_at: now }).where(eq(sprints.id, p.id));
        return applied();
      }

      // --- decision board ---------------------------------------------------
      case 'board.create': {
        const p = payload as Payload<'board.create'>;
        const existing = await one(tx.select().from(decision_boards).where(eq(decision_boards.id, p.id)).limit(1));
        if (existing) return reject('E_DUPLICATE', `board ${p.id} already exists`);
        await tx.insert(decision_boards).values({ id: p.id, user_id: userId, title: p.title, updated_at: now });
        return applied();
      }
      case 'criterion.create': {
        const p = payload as Payload<'criterion.create'>;
        const existing = await one(tx.select().from(decision_criteria).where(eq(decision_criteria.id, p.id)).limit(1));
        if (existing) return reject('E_DUPLICATE', `criterion ${p.id} already exists`);
        const board = await one(tx.select().from(decision_boards).where(eq(decision_boards.id, p.board_id)).limit(1));
        const own = ownershipReject('board', p.board_id, board, userId);
        if (own) return own;
        await tx.insert(decision_criteria).values({ id: p.id, user_id: userId, board_id: p.board_id, label: p.label, weight: p.weight, updated_at: now });
        return applied();
      }
      case 'criterion.set_weight': {
        const p = payload as Payload<'criterion.set_weight'>;
        const row = await one(tx.select().from(decision_criteria).where(eq(decision_criteria.id, p.id)).limit(1));
        const own = ownershipReject('criterion', p.id, row, userId);
        if (own) return own;
        await tx.update(decision_criteria).set({ weight: p.weight, updated_at: now }).where(eq(decision_criteria.id, p.id));
        return applied();
      }
      case 'score.set': {
        const p = payload as Payload<'score.set'>;
        const criterion = await one(tx.select().from(decision_criteria).where(eq(decision_criteria.id, p.criterion_id)).limit(1));
        const own = ownershipReject('criterion', p.criterion_id, criterion, userId);
        if (own) return own;
        // upsert on (criterion_id, project_id) — the §6.0 UNIQUE
        await tx
          .insert(decision_scores)
          .values({ id: p.id, user_id: userId, criterion_id: p.criterion_id, project_id: p.project_id, score: p.score, updated_at: now })
          .onConflictDoUpdate({
            target: [decision_scores.criterion_id, decision_scores.project_id],
            set: { score: p.score, updated_at: now },
          });
        return applied();
      }

      // --- automation & blocker rules ---------------------------------------
      case 'rule.create': {
        const p = payload as Payload<'rule.create'>;
        const existing = await one(tx.select().from(automation_rules).where(eq(automation_rules.id, p.id)).limit(1));
        if (existing) return reject('E_DUPLICATE', `rule ${p.id} already exists`);
        const existingRules = await tx.select().from(automation_rules).where(and(eq(automation_rules.user_id, userId), isNull(automation_rules.deleted_at)));
        const bad = fromCheck(checkRule({ trigger: p.trigger, conditions: p.conditions, actions: p.actions }, existingRules));
        if (bad) return bad;
        await tx.insert(automation_rules).values({
          id: p.id,
          user_id: userId,
          trigger: p.trigger,
          conditions: p.conditions,
          actions: p.actions,
          enabled: p.enabled ?? true,
          updated_at: now,
        });
        return applied();
      }
      case 'rule.update': {
        const p = payload as Payload<'rule.update'>;
        const row = await one(tx.select().from(automation_rules).where(eq(automation_rules.id, p.id)).limit(1));
        const own = ownershipReject('rule', p.id, row, userId);
        if (own) return own;
        const merged = {
          trigger: p.trigger ?? row!.trigger,
          conditions: p.conditions ?? row!.conditions,
          actions: p.actions ?? row!.actions,
        };
        const others = await tx.select().from(automation_rules).where(and(eq(automation_rules.user_id, userId), isNull(automation_rules.deleted_at)));
        const bad = fromCheck(checkRule(merged, others.filter((r) => r.id !== p.id)));
        if (bad) return bad;
        await tx.update(automation_rules).set({ ...merged, updated_at: now }).where(eq(automation_rules.id, p.id));
        return applied();
      }
      case 'rule.toggle': {
        const p = payload as Payload<'rule.toggle'>;
        const row = await one(tx.select().from(automation_rules).where(eq(automation_rules.id, p.id)).limit(1));
        const own = ownershipReject('rule', p.id, row, userId);
        if (own) return own;
        await tx.update(automation_rules).set({ enabled: p.enabled, updated_at: now }).where(eq(automation_rules.id, p.id));
        return applied();
      }
      case 'rule.delete': {
        const p = payload as Payload<'rule.delete'>;
        const row = await one(tx.select().from(automation_rules).where(eq(automation_rules.id, p.id)).limit(1));
        const own = ownershipReject('rule', p.id, row, userId);
        if (own) return own;
        await tx.update(automation_rules).set({ deleted_at: now, updated_at: now }).where(eq(automation_rules.id, p.id));
        return applied();
      }
      case 'blocker.create': {
        const p = payload as Payload<'blocker.create'>;
        const existing = await one(tx.select().from(blocker_rules).where(eq(blocker_rules.id, p.id)).limit(1));
        if (existing) return reject('E_DUPLICATE', `blocker ${p.id} already exists`);
        await tx.insert(blocker_rules).values({
          id: p.id,
          user_id: userId,
          scope: p.scope,
          predicate: p.predicate,
          label: p.label,
          enabled: p.enabled ?? true,
          updated_at: now,
        });
        return applied();
      }
      case 'blocker.update': {
        const p = payload as Payload<'blocker.update'>;
        const row = await one(tx.select().from(blocker_rules).where(eq(blocker_rules.id, p.id)).limit(1));
        const own = ownershipReject('blocker', p.id, row, userId);
        if (own) return own;
        const set: Record<string, unknown> = { updated_at: now };
        if (p.scope !== undefined) set['scope'] = p.scope;
        if (p.predicate !== undefined) set['predicate'] = p.predicate;
        if (p.label !== undefined) set['label'] = p.label;
        await tx.update(blocker_rules).set(set).where(eq(blocker_rules.id, p.id));
        return applied();
      }
      case 'blocker.toggle': {
        const p = payload as Payload<'blocker.toggle'>;
        const row = await one(tx.select().from(blocker_rules).where(eq(blocker_rules.id, p.id)).limit(1));
        const own = ownershipReject('blocker', p.id, row, userId);
        if (own) return own;
        await tx.update(blocker_rules).set({ enabled: p.enabled, updated_at: now }).where(eq(blocker_rules.id, p.id));
        return applied();
      }
      case 'blocker.delete': {
        const p = payload as Payload<'blocker.delete'>;
        const row = await one(tx.select().from(blocker_rules).where(eq(blocker_rules.id, p.id)).limit(1));
        const own = ownershipReject('blocker', p.id, row, userId);
        if (own) return own;
        await tx.update(blocker_rules).set({ deleted_at: now, updated_at: now }).where(eq(blocker_rules.id, p.id));
        return applied();
      }

      // --- diagram layout & groups ------------------------------------------
      case 'layout.set_position': {
        const p = payload as Payload<'layout.set_position'>;
        const node = await loadNodeRow(tx, p.node_id);
        const own = ownershipReject('node', p.node_id, node, userId);
        if (own) return own;
        await tx
          .insert(diagram_layouts)
          .values({
            id: sql`gen_random_uuid()`,
            user_id: userId,
            diagram_id: p.diagram_id,
            node_id: p.node_id,
            x: p.x,
            y: p.y,
            group_id: p.group_id ?? null,
            updated_at: now,
          })
          .onConflictDoUpdate({
            target: [diagram_layouts.diagram_id, diagram_layouts.node_id],
            set: { x: p.x, y: p.y, group_id: p.group_id ?? null, updated_at: now },
          });
        return applied();
      }
      case 'layout.set_collapsed': {
        const p = payload as Payload<'layout.set_collapsed'>;
        const node = await loadNodeRow(tx, p.node_id);
        const own = ownershipReject('node', p.node_id, node, userId);
        if (own) return own;
        await tx
          .insert(diagram_layouts)
          .values({
            id: sql`gen_random_uuid()`,
            user_id: userId,
            diagram_id: p.diagram_id,
            node_id: p.node_id,
            x: 0,
            y: 0,
            collapsed: p.collapsed,
            updated_at: now,
          })
          .onConflictDoUpdate({
            target: [diagram_layouts.diagram_id, diagram_layouts.node_id],
            set: { collapsed: p.collapsed, updated_at: now },
          });
        return applied();
      }
      case 'group.create': {
        const p = payload as Payload<'group.create'>;
        const existing = await one(tx.select().from(diagram_groups).where(eq(diagram_groups.id, p.id)).limit(1));
        if (existing) return reject('E_DUPLICATE', `group ${p.id} already exists`);
        await tx.insert(diagram_groups).values({ id: p.id, user_id: userId, diagram_id: p.diagram_id, label: p.label, color: p.color ?? null, updated_at: now });
        return applied();
      }
      case 'group.update': {
        const p = payload as Payload<'group.update'>;
        const row = await one(tx.select().from(diagram_groups).where(eq(diagram_groups.id, p.id)).limit(1));
        const own = ownershipReject('group', p.id, row, userId);
        if (own) return own;
        const set: Record<string, unknown> = { updated_at: now };
        if (p.label !== undefined) set['label'] = p.label;
        if ('color' in p) set['color'] = p.color ?? null;
        await tx.update(diagram_groups).set(set).where(eq(diagram_groups.id, p.id));
        return applied();
      }
      case 'group.delete': {
        const p = payload as Payload<'group.delete'>;
        const row = await one(tx.select().from(diagram_groups).where(eq(diagram_groups.id, p.id)).limit(1));
        const own = ownershipReject('group', p.id, row, userId);
        if (own) return own;
        await tx.update(diagram_groups).set({ deleted_at: now, updated_at: now }).where(eq(diagram_groups.id, p.id));
        return applied();
      }

      // --- settings ---------------------------------------------------------
      case 'settings.update': {
        const p = payload as Payload<'settings.update'>;
        const insert: Record<string, unknown> = { user_id: userId, updated_at: now };
        const set: Record<string, unknown> = { updated_at: now };
        if (p.day_reset_hour !== undefined) {
          insert['day_reset_hour'] = p.day_reset_hour;
          set['day_reset_hour'] = p.day_reset_hour;
        }
        if (p.timezone !== undefined) {
          insert['timezone'] = p.timezone;
          set['timezone'] = p.timezone;
        }
        if (p.weather_location !== undefined) {
          insert['weather_location'] = p.weather_location;
          set['weather_location'] = p.weather_location;
        }
        await tx.insert(user_settings).values(insert as typeof user_settings.$inferInsert).onConflictDoUpdate({ target: user_settings.user_id, set });
        return applied();
      }
    }
  }

  async function handleCommand(
    userId: string,
    deviceId: string,
    cmd: { id: string; name: string; hlc: string; payload: unknown },
  ): Promise<CommandOutcome> {
    // step 5 (idempotency, fast path): a replayed command id returns the
    // original result as noop.
    const prior = await one(
      db.select({ user_id: command_log.user_id, result: command_log.result }).from(command_log).where(eq(command_log.id, cmd.id)).limit(1),
    );
    if (prior) {
      if (prior.user_id !== userId) {
        return { id: cmd.id, result: 'rejected', reject_code: 'E_OWNERSHIP', reject_reason: 'command id belongs to another user' };
      }
      return { id: cmd.id, result: 'noop', original_result: prior.result === 'applied' ? 'applied' : 'rejected' };
    }

    // step 1: name + Zod parse against the catalog schema.
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

    // steps 2-5 atomically; the command_log PK makes concurrent replays a noop.
    try {
      const { out } = await db.transaction(async (tx) => {
        const result = await runHandler(cmd.name as CommandName, tx, userId, deviceId, parsed.data);
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
      // concurrent replay: the command_log PK conflict rolled the tx back.
      if (isUniqueViolation(error)) {
        const existing = await one(db.select({ result: command_log.result }).from(command_log).where(eq(command_log.id, cmd.id)).limit(1));
        if (existing) {
          return { id: cmd.id, result: 'noop', original_result: existing.result === 'applied' ? 'applied' : 'rejected' };
        }
      }
      throw error;
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

  return {
    async handleUpload(userId, body): Promise<UploadResponse> {
      const parsed = uploadRequestSchema.safeParse(body);
      if (!parsed.success) return { kind: 'parse_error', issues: parsed.error.issues };
      const { device_id, commands } = parsed.data;

      // rate limit per user+verb (§13), pre-checked over the whole batch.
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
