/**
 * Optimistic command writers (§2.1, §12.3) — the two-layer store path (1.3
 * §7.2; M8). Each method builds a named §8.1 command and delegates to
 * `executeCommand.execute`, which strips trust fields, validates, mints the
 * command id + HLC at write, and writes `client_commands` + `overlay_effects`
 * in ONE transaction. The UI reads the merge (`mergeTable(replica, overlay)`),
 * so edits show instantly; a server rejection rolls back by DROPPING the overlay
 * (not by waiting for the canonical row to re-sync). Row ids are minted here
 * (UUIDv7) and carried in the payload; the command id is separate (§7.2b).
 *
 * Method signatures are unchanged from the v1.0 direct-write layer so the screens
 * are untouched — only the storage path moved from replica `db.execute` to the
 * overlay.
 */
import { newId } from './client-runtime';
import { buildAcceptSuggestionEffects, type AcceptSuggestionBlock, type EffectSpec } from './effects';
import { createExecuteCommand, type ExecuteDeps } from './execute';
import { readMergedRows, type OverlayStore } from './overlay-store';

export interface CommandContext {
  userId: string;
  deviceId: string;
  /** ISO timestamp for fact fields (completed_at, started_at, …); defaults to now. */
  now?: () => string;
}

const iso = (ctx: CommandContext) => (ctx.now ? ctx.now() : new Date().toISOString());

export function createCommands(store: OverlayStore, ctx: CommandContext, deps: ExecuteDeps = {}) {
  const exec = createExecuteCommand(store, { userId: ctx.userId, deviceId: ctx.deviceId }, deps);
  const run = (name: Parameters<typeof exec.execute>[0], payload: Record<string, unknown>, opts?: Parameters<typeof exec.execute>[2]) =>
    exec.execute(name, payload, opts);

  return {
    async checkOff(taskId: string, opts?: { disposition?: 'completed' | 'obsolete'; completedInBlockId?: string | null }): Promise<void> {
      await run('node.check_off', {
        id: taskId,
        completed_at: iso(ctx),
        ...(opts?.disposition ? { disposition: opts.disposition } : {}),
        ...(opts && 'completedInBlockId' in opts ? { completed_in_block_id: opts.completedInBlockId ?? null } : {}),
      });
    },
    async uncheck(taskId: string): Promise<void> {
      await run('node.uncheck', { id: taskId });
    },
    async rename(taskId: string, title: string): Promise<void> {
      await run('node.rename', { id: taskId, title });
    },
    async softDelete(taskId: string): Promise<void> {
      // parity with v1.0: optimistically remove the named node; the server
      // cascades the §I10 closure and the descendants sync back tombstoned.
      await run('node.soft_delete', { id: taskId });
    },
    async createVision(title: string): Promise<string> {
      const id = newId();
      await run('node.create', { id, node_type: 'vision', title, sort_order: 'a0' });
      return id;
    },
    /** Inbox item (§1.2): a parentless `activity` node, justification deferred until promote. */
    async createActivity(input: { title: string; sortOrder: string }): Promise<string> {
      const id = newId();
      await run('node.create', { id, node_type: 'activity', title: input.title, sort_order: input.sortOrder });
      return id;
    },
    /** activity.promote (§8.1, I3): an inbox item becomes a real task by gaining a justification. */
    async promoteActivity(id: string, target: { parentId: string } | { habitId: string }): Promise<void> {
      await run('activity.promote', 'parentId' in target ? { id, parent_id: target.parentId } : { id, habit_id: target.habitId });
    },
    async createTask(input: { id?: string; parentId: string; title: string; sortOrder: string; estimateMinutes?: number }): Promise<string> {
      const id = input.id ?? newId();
      await run('node.create', {
        id,
        parent_id: input.parentId,
        node_type: 'task',
        title: input.title,
        sort_order: input.sortOrder,
        ...(input.estimateMinutes !== undefined ? { estimate_minutes: input.estimateMinutes } : {}),
      });
      return id;
    },
    /** Clock in (§8). `force` overrides the blocked-task guard; the open entry then makes the task `ongoing`. */
    async clockIn(taskId: string, opts?: { force?: boolean }): Promise<string> {
      const id = newId();
      await run('timer.clock_in', { entry_id: id, task_id: taskId, started_at: iso(ctx), ...(opts?.force ? { force: true } : {}) });
      return id;
    },
    async clockOut(entryId: string): Promise<void> {
      await run('timer.clock_out', { entry_id: entryId, ended_at: iso(ctx) });
    },
    /**
     * Focus review at clock-out (§1.2, §8.1). A completing session ALSO checks the
     * task off — the SAME timer.review command, so it ships as one command with a
     * second optimistic effect on the node (the server derives the completion).
     */
    async review(input: { entryId: string; focusFactor: number; completedSession: boolean; taskId?: string }): Promise<void> {
      const extraEffects: EffectSpec[] =
        input.completedSession && input.taskId
          ? [{ table: 'nodes', row_id: input.taskId, op: 'update', fields: { completed_at: iso(ctx), completion_disposition: 'completed' } }]
          : [];
      await run('timer.review', { entry_id: input.entryId, focus_factor: input.focusFactor, completed_session: input.completedSession }, { extraEffects });
    },
    // --- schedule blocks (agenda, §10/§12.2) --------------------------------
    async createBlock(input: { id?: string; taskId: string; startsAt: string; endsAt: string; anchorType?: 'none' | 'start' | 'end' | 'both' }): Promise<string> {
      const id = input.id ?? newId();
      await run('block.create', { id, task_id: input.taskId, starts_at: input.startsAt, ends_at: input.endsAt, ...(input.anchorType ? { anchor_type: input.anchorType } : {}) });
      return id;
    },
    async moveBlock(id: string, startsAt: string, endsAt: string): Promise<void> {
      await run('block.move', { id, starts_at: startsAt, ends_at: endsAt });
    },
    async setBlockAnchor(id: string, anchorType: 'none' | 'start' | 'end' | 'both'): Promise<void> {
      await run('block.set_anchor', { id, anchor_type: anchorType });
    },
    async deleteBlock(id: string): Promise<void> {
      await run('block.delete', { id });
    },
    /**
     * Promote a suggested block to a committed fact (§7.5). The optimistic
     * effects MIRROR the server transaction: besides promoting the suggestion,
     * they soft-delete the flexible block it replaces and supersede overlapping
     * sibling suggestions — read from the merged block state so the agenda
     * reflects the whole §7.5 outcome instantly. The server re-applies
     * authoritatively; a stale suggestion is rejected (E_STALE_SUGGESTION) and
     * the overlay rolls back into a review item.
     */
    async acceptSuggestion(id: string): Promise<void> {
      const rows = (await readMergedRows(store, 'schedule_blocks')) as Record<string, unknown>[];
      const blocks: AcceptSuggestionBlock[] = rows.map((r) => ({
        id: String(r['id']),
        task_id: String(r['task_id']),
        status: String(r['status']),
        starts_at: String(r['starts_at']),
        ends_at: String(r['ends_at']),
        replaces_block_id: r['replaces_block_id'] == null ? null : String(r['replaces_block_id']),
        superseded_at: r['superseded_at'] == null ? null : String(r['superseded_at']),
        deleted_at: r['deleted_at'] == null ? null : String(r['deleted_at']),
      }));
      await run('block.accept_suggestion', { id }, { effects: buildAcceptSuggestionEffects(blocks, id, iso(ctx)) });
    },
    /** Dismiss a suggested block (§7.5). */
    async rejectSuggestion(id: string): Promise<void> {
      await run('block.reject_suggestion', { id });
    },
    // --- node dates (kanban-by-date, §1.2) ----------------------------------
    async setDates(taskId: string, patch: { startDate?: string | null; dueDate?: string | null }): Promise<void> {
      const payload: Record<string, unknown> = { id: taskId };
      if ('startDate' in patch) payload['start_date'] = patch.startDate ?? null;
      if ('dueDate' in patch) payload['due_date'] = patch.dueDate ?? null;
      if (Object.keys(payload).length === 1) return;
      await run('node.set_dates', payload);
    },

    // --- habits & skills (§1.2, §7.2) ---------------------------------------
    async createHabit(input: {
      visionId: string;
      title: string;
      rrule: string;
      streakMode: 'perfect_planned' | 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';
      dailyTargetMinutes?: number | null;
      masteryTargetHours?: number | null;
      levelThresholdsHours?: number[];
    }): Promise<string> {
      const id = newId();
      await run('habit.create', {
        id,
        vision_id: input.visionId,
        title: input.title,
        rrule: input.rrule,
        streak_mode: input.streakMode,
        ...(input.dailyTargetMinutes != null ? { daily_target_minutes: input.dailyTargetMinutes } : {}),
        ...(input.masteryTargetHours != null ? { mastery_target_hours: input.masteryTargetHours } : {}),
        ...(input.levelThresholdsHours ? { level_thresholds_hours: input.levelThresholdsHours } : {}),
      });
      return id;
    },
    async updateHabit(id: string, patch: { title?: string; rrule?: string; dailyTargetMinutes?: number | null; masteryTargetHours?: number | null; levelThresholdsHours?: number[] }): Promise<void> {
      const payload: Record<string, unknown> = { id };
      if (patch.title !== undefined) payload['title'] = patch.title;
      if (patch.rrule !== undefined) payload['rrule'] = patch.rrule;
      if ('dailyTargetMinutes' in patch) payload['daily_target_minutes'] = patch.dailyTargetMinutes ?? null;
      if ('masteryTargetHours' in patch) payload['mastery_target_hours'] = patch.masteryTargetHours ?? null;
      if (patch.levelThresholdsHours !== undefined) payload['level_thresholds_hours'] = patch.levelThresholdsHours;
      if (Object.keys(payload).length === 1) return;
      await run('habit.update', payload);
    },
    async deleteHabit(id: string): Promise<void> {
      await run('habit.delete', { id });
    },
    async checkOffHabit(input: { habitId: string; occurrenceDate: string }): Promise<string> {
      const id = newId();
      await run('habit.check_off', { id, habit_id: input.habitId, occurrence_date: input.occurrenceDate, completed_at: iso(ctx) });
      return id;
    },

    // --- decision board (§6.0) ----------------------------------------------
    async createBoard(title: string): Promise<string> {
      const id = newId();
      await run('board.create', { id, title });
      return id;
    },
    async createCriterion(input: { boardId: string; label: string; weight: number }): Promise<string> {
      const id = newId();
      await run('criterion.create', { id, board_id: input.boardId, label: input.label, weight: input.weight });
      return id;
    },
    async setCriterionWeight(id: string, weight: number): Promise<void> {
      await run('criterion.set_weight', { id, weight });
    },
    /** Upsert a project's score on a criterion (score.set, keyed by criterion+project). */
    async setScore(input: { existingId?: string; criterionId: string; projectId: string; score: number }): Promise<void> {
      await run('score.set', { id: input.existingId ?? newId(), criterion_id: input.criterionId, project_id: input.projectId, score: input.score });
    },

    // --- tags (confirmable event tags) --------------------------------------
    async createTag(input: { id?: string; label: string; habitId?: string | null }): Promise<string> {
      const id = input.id ?? newId();
      await run('tag.create', { id, label: input.label, ...(input.habitId !== undefined ? { habit_id: input.habitId ?? null } : {}) });
      return id;
    },
    async renameTag(id: string, label: string): Promise<void> {
      await run('tag.rename', { id, label });
    },
    async deleteTag(id: string): Promise<void> {
      await run('tag.delete', { id });
    },
    async placeTag(input: { id?: string; blockId: string; tagId: string }): Promise<string> {
      const id = input.id ?? newId();
      await run('tag.place', { id, block_id: input.blockId, tag_id: input.tagId });
      return id;
    },
    async unplaceTag(id: string): Promise<void> {
      await run('tag.unplace', { id });
    },
    /** Answer a placed tag yes/no (tag.answer, upsert keyed by placement_id). */
    async answerTag(input: { existingId?: string; placementId: string; value: 'yes' | 'no' }): Promise<void> {
      await run('tag.answer', { id: input.existingId ?? newId(), placement_id: input.placementId, value: input.value, answered_at: iso(ctx) });
    },
    async clearTagAnswer(answerId: string): Promise<void> {
      await run('tag.clear_answer', { id: answerId });
    },

    // --- edges (the dependency graph, §6.7 I4) ------------------------------
    async createEdge(input: { id?: string; predecessorId: string; successorId: string; edgeType?: 'FS' | 'SS' | 'FF' | 'SF'; lagMinutes?: number }): Promise<string> {
      const id = input.id ?? newId();
      await run('edge.create', {
        id,
        predecessor_id: input.predecessorId,
        successor_id: input.successorId,
        ...(input.edgeType ? { edge_type: input.edgeType } : {}),
        ...(input.lagMinutes !== undefined ? { lag_minutes: input.lagMinutes } : {}),
      });
      return id;
    },
    async deleteEdge(id: string): Promise<void> {
      await run('edge.delete', { id });
    },

    // --- diagram layout & groups (§12.1–12.2) -------------------------------
    /**
     * Persist a node's position (layout.set_position, upsert by diagram+node).
     * Repositioning an existing layout is optimistic (update its row); a FIRST
     * placement has no row id (the server mints it), so it has no overlay and
     * appears once it syncs back — the flowchart masks the lag with local drag state.
     */
    async setLayoutPosition(input: { existingId?: string; diagramId: string; nodeId: string; x: number; y: number; groupId?: string | null }): Promise<void> {
      const payload = { diagram_id: input.diagramId, node_id: input.nodeId, x: input.x, y: input.y, ...(input.groupId !== undefined ? { group_id: input.groupId ?? null } : {}) };
      const effects: EffectSpec[] = input.existingId
        ? [{ table: 'diagram_layouts', row_id: input.existingId, op: 'update', fields: { x: input.x, y: input.y, group_id: input.groupId ?? null } }]
        : [];
      await run('layout.set_position', payload, { effects });
    },
    async setLayoutCollapsed(input: { existingId?: string; diagramId: string; nodeId: string; collapsed: boolean }): Promise<void> {
      const payload = { diagram_id: input.diagramId, node_id: input.nodeId, collapsed: input.collapsed };
      const effects: EffectSpec[] = input.existingId
        ? [{ table: 'diagram_layouts', row_id: input.existingId, op: 'update', fields: { collapsed: input.collapsed ? 1 : 0 } }]
        : [];
      await run('layout.set_collapsed', payload, { effects });
    },
    async createGroup(input: { id?: string; diagramId: string; label: string; color?: string | null }): Promise<string> {
      const id = input.id ?? newId();
      await run('group.create', { id, diagram_id: input.diagramId, label: input.label, ...(input.color !== undefined ? { color: input.color ?? null } : {}) });
      return id;
    },
    async updateGroup(id: string, patch: { label?: string; color?: string | null }): Promise<void> {
      const payload: Record<string, unknown> = { id };
      if (patch.label !== undefined) payload['label'] = patch.label;
      if ('color' in patch) payload['color'] = patch.color ?? null;
      if (Object.keys(payload).length === 1) return;
      await run('group.update', payload);
    },
    async deleteGroup(id: string): Promise<void> {
      await run('group.delete', { id });
    },

    // --- automation & blocker rules (§9) ------------------------------------
    async createRule(input: { id?: string; trigger: 'task_completed' | 'task_created'; conditions: unknown; actions: unknown; enabled?: boolean }): Promise<string> {
      const id = input.id ?? newId();
      await run('rule.create', { id, trigger: input.trigger, conditions: input.conditions, actions: input.actions, ...(input.enabled !== undefined ? { enabled: input.enabled } : {}) });
      return id;
    },
    async toggleRule(id: string, enabled: boolean): Promise<void> {
      await run('rule.toggle', { id, enabled });
    },
    async deleteRule(id: string): Promise<void> {
      await run('rule.delete', { id });
    },
    async createBlocker(input: { id?: string; scope: unknown; predicate: unknown; label: string; enabled?: boolean }): Promise<string> {
      const id = input.id ?? newId();
      await run('blocker.create', { id, scope: input.scope, predicate: input.predicate, label: input.label, ...(input.enabled !== undefined ? { enabled: input.enabled } : {}) });
      return id;
    },
    async toggleBlocker(id: string, enabled: boolean): Promise<void> {
      await run('blocker.toggle', { id, enabled });
    },
    async deleteBlocker(id: string): Promise<void> {
      await run('blocker.delete', { id });
    },

    async updateSettings(patch: { day_reset_hour?: number; timezone?: string }): Promise<void> {
      const payload: Record<string, unknown> = {};
      if (patch.day_reset_hour !== undefined) payload['day_reset_hour'] = patch.day_reset_hour;
      if (patch.timezone !== undefined) payload['timezone'] = patch.timezone;
      if (Object.keys(payload).length === 0) return;
      await run('settings.update', payload);
    },
    /** First settings write for a fresh account (the server upserts on user_id). */
    async insertSettings(patch: { day_reset_hour: number; timezone: string }): Promise<void> {
      await run('settings.update', { day_reset_hour: patch.day_reset_hour, timezone: patch.timezone });
    },

    // --- review inbox (§7.13, M10) ------------------------------------------
    /** Close a review item as resolved (the user acted on it). Optimistic. */
    async resolveReviewItem(id: string): Promise<void> {
      await run('review.resolve', { id });
    },
    /** Close a review item as dismissed (the user judged it not actionable). */
    async dismissReviewItem(id: string): Promise<void> {
      await run('review.dismiss', { id });
    },
  };
}

export type Commands = ReturnType<typeof createCommands>;
