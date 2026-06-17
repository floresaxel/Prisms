/**
 * Optimistic command writers (§2.1, §12.3). Each issues the minimal local
 * SQL write to PowerSync's SQLite — the UI updates instantly via reactive
 * queries, and PowerSync queues the change for the connector to translate
 * into a named command (crud-to-command.ts). A server rejection rolls back
 * when the unchanged row syncs back down.
 */
import { newId } from './client-runtime';

/** The subset of the PowerSync database surface these writers need. */
export interface WritableDb {
  execute(sql: string, params?: unknown[]): Promise<unknown>;
}

export interface CommandContext {
  userId: string;
  deviceId: string;
  /** ISO timestamp; defaults to now. */
  now?: () => string;
}

const iso = (ctx: CommandContext) => (ctx.now ? ctx.now() : new Date().toISOString());

export function createCommands(db: WritableDb, ctx: CommandContext) {
  return {
    /**
     * Check a task off (node.check_off). `disposition` records whether the task
     * was finished ('completed', default) or descoped ('obsolete'); both set
     * completed_at so the task reads as done, but obsolete leaves the project's
     * completion denominator (§7.2).
     */
    async checkOff(taskId: string, opts?: { disposition?: 'completed' | 'obsolete' }): Promise<void> {
      const now = iso(ctx);
      const disposition = opts?.disposition ?? 'completed';
      await db.execute('UPDATE nodes SET completed_at = ?, completion_disposition = ?, updated_at = ? WHERE id = ?', [now, disposition, now, taskId]);
    },
    async uncheck(taskId: string): Promise<void> {
      await db.execute('UPDATE nodes SET completed_at = NULL, completion_disposition = NULL, updated_at = ? WHERE id = ?', [iso(ctx), taskId]);
    },
    async rename(taskId: string, title: string): Promise<void> {
      await db.execute('UPDATE nodes SET title = ?, updated_at = ? WHERE id = ?', [title, iso(ctx), taskId]);
    },
    async softDelete(taskId: string): Promise<void> {
      const now = iso(ctx);
      await db.execute('UPDATE nodes SET deleted_at = ?, updated_at = ? WHERE id = ?', [now, now, taskId]);
    },
    async createVision(title: string): Promise<string> {
      const id = newId();
      const now = iso(ctx);
      await db.execute(
        'INSERT INTO nodes (id, user_id, node_type, title, description, sort_order, attributes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, ctx.userId, 'vision', title, '', 'a0', '{}', now, now],
      );
      return id;
    },
    /** Inbox item (§1.2): a parentless `activity` node, justification deferred until promote. */
    async createActivity(input: { title: string; sortOrder: string }): Promise<string> {
      const id = newId();
      const now = iso(ctx);
      await db.execute(
        'INSERT INTO nodes (id, user_id, node_type, title, description, sort_order, attributes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, ctx.userId, 'activity', input.title, '', input.sortOrder, '{}', now, now],
      );
      return id;
    },
    /**
     * activity.promote (§8.1, I3): an inbox item becomes a real task by gaining
     * a justification. One write sets node_type + the parent (xor habit_id);
     * the CRUD bridge maps it to the activity.promote command.
     */
    async promoteActivity(id: string, target: { parentId: string } | { habitId: string }): Promise<void> {
      const now = iso(ctx);
      if ('parentId' in target) {
        await db.execute(
          'UPDATE nodes SET node_type = ?, parent_id = ?, habit_id = NULL, updated_at = ? WHERE id = ?',
          ['task', target.parentId, now, id],
        );
      } else {
        await db.execute(
          'UPDATE nodes SET node_type = ?, habit_id = ?, parent_id = NULL, updated_at = ? WHERE id = ?',
          ['task', target.habitId, now, id],
        );
      }
    },
    async createTask(input: { id?: string; parentId: string; title: string; sortOrder: string; estimateMinutes?: number }): Promise<string> {
      const id = input.id ?? newId();
      const now = iso(ctx);
      await db.execute(
        'INSERT INTO nodes (id, user_id, parent_id, node_type, title, description, sort_order, estimate_minutes, attributes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, ctx.userId, input.parentId, 'task', input.title, '', input.sortOrder, input.estimateMinutes ?? null, '{}', now, now],
      );
      return id;
    },
    async clockIn(taskId: string): Promise<string> {
      const id = newId();
      const now = iso(ctx);
      await db.execute(
        'INSERT INTO time_entries (id, user_id, task_id, started_at, planned, device_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [id, ctx.userId, taskId, now, 1, ctx.deviceId, now, now],
      );
      return id;
    },
    async clockOut(entryId: string): Promise<void> {
      const now = iso(ctx);
      await db.execute('UPDATE time_entries SET ended_at = ?, updated_at = ? WHERE id = ?', [now, now, entryId]);
    },
    /**
     * Focus review at clock-out (§1.2, §8.1): records the productivity factor
     * and "completed?" flag. When the session finished the task, it ALSO checks
     * the task off (timer.review "may also set node.completed_at") — two facts,
     * two minimal-field writes.
     */
    async review(input: { entryId: string; focusFactor: number; completedSession: boolean; taskId?: string }): Promise<void> {
      const now = iso(ctx);
      await db.execute(
        'UPDATE time_entries SET focus_factor = ?, completed_session = ?, updated_at = ? WHERE id = ?',
        [input.focusFactor, input.completedSession ? 1 : 0, now, input.entryId],
      );
      if (input.completedSession && input.taskId) {
        await db.execute('UPDATE nodes SET completed_at = ?, completion_disposition = ?, updated_at = ? WHERE id = ?', [now, 'completed', now, input.taskId]);
      }
    },
    // --- schedule blocks (agenda, §10/§12.2) --------------------------------
    /** Place a committed calendar block (drag-to-agenda drop). */
    async createBlock(input: { id?: string; taskId: string; startsAt: string; endsAt: string; anchorType?: 'none' | 'start' | 'end' | 'both' }): Promise<string> {
      const id = input.id ?? newId();
      const now = iso(ctx);
      await db.execute(
        'INSERT INTO schedule_blocks (id, user_id, task_id, starts_at, ends_at, anchor_type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, ctx.userId, input.taskId, input.startsAt, input.endsAt, input.anchorType ?? 'none', 'committed', now, now],
      );
      return id;
    },
    /** Move/resize a block (rejected server-side if anchored, I7). */
    async moveBlock(id: string, startsAt: string, endsAt: string): Promise<void> {
      const now = iso(ctx);
      await db.execute('UPDATE schedule_blocks SET starts_at = ?, ends_at = ?, updated_at = ? WHERE id = ?', [startsAt, endsAt, now, id]);
    },
    async setBlockAnchor(id: string, anchorType: 'none' | 'start' | 'end' | 'both'): Promise<void> {
      await db.execute('UPDATE schedule_blocks SET anchor_type = ?, updated_at = ? WHERE id = ?', [anchorType, iso(ctx), id]);
    },
    async deleteBlock(id: string): Promise<void> {
      const now = iso(ctx);
      await db.execute('UPDATE schedule_blocks SET deleted_at = ?, updated_at = ? WHERE id = ?', [now, now, id]);
    },
    /** Promote a suggested block to a committed fact (§2.6). */
    async acceptSuggestion(id: string): Promise<void> {
      await db.execute('UPDATE schedule_blocks SET status = ?, suggestion_reason = NULL, updated_at = ? WHERE id = ?', ['committed', iso(ctx), id]);
    },
    /** Dismiss a suggested block (soft-delete; maps to block.delete). */
    async rejectSuggestion(id: string): Promise<void> {
      const now = iso(ctx);
      await db.execute('UPDATE schedule_blocks SET deleted_at = ?, updated_at = ? WHERE id = ?', [now, now, id]);
    },
    // --- node dates (kanban-by-date, §1.2) ----------------------------------
    /** Set a task's start/due dates (kanban drag = node.set_dates). */
    async setDates(taskId: string, patch: { startDate?: string | null; dueDate?: string | null }): Promise<void> {
      const now = iso(ctx);
      const sets: string[] = [];
      const params: unknown[] = [];
      if ('startDate' in patch) {
        sets.push('start_date = ?');
        params.push(patch.startDate ?? null);
      }
      if ('dueDate' in patch) {
        sets.push('due_date = ?');
        params.push(patch.dueDate ?? null);
      }
      if (sets.length === 0) return;
      sets.push('updated_at = ?');
      params.push(now, taskId);
      await db.execute(`UPDATE nodes SET ${sets.join(', ')} WHERE id = ?`, params);
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
      const now = iso(ctx);
      await db.execute(
        'INSERT INTO habits (id, user_id, vision_id, title, rrule, streak_mode, daily_target_minutes, mastery_target_hours, level_thresholds_hours, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          id,
          ctx.userId,
          input.visionId,
          input.title,
          input.rrule,
          input.streakMode,
          input.dailyTargetMinutes ?? null,
          input.masteryTargetHours ?? null,
          JSON.stringify(input.levelThresholdsHours ?? []),
          now,
          now,
        ],
      );
      return id;
    },
    async updateHabit(id: string, patch: { title?: string; rrule?: string; dailyTargetMinutes?: number | null; masteryTargetHours?: number | null; levelThresholdsHours?: number[] }): Promise<void> {
      const now = iso(ctx);
      const sets: string[] = [];
      const params: unknown[] = [];
      if (patch.title !== undefined) { sets.push('title = ?'); params.push(patch.title); }
      if (patch.rrule !== undefined) { sets.push('rrule = ?'); params.push(patch.rrule); }
      if ('dailyTargetMinutes' in patch) { sets.push('daily_target_minutes = ?'); params.push(patch.dailyTargetMinutes ?? null); }
      if ('masteryTargetHours' in patch) { sets.push('mastery_target_hours = ?'); params.push(patch.masteryTargetHours ?? null); }
      if (patch.levelThresholdsHours !== undefined) { sets.push('level_thresholds_hours = ?'); params.push(JSON.stringify(patch.levelThresholdsHours)); }
      if (sets.length === 0) return;
      sets.push('updated_at = ?');
      params.push(now, id);
      await db.execute(`UPDATE habits SET ${sets.join(', ')} WHERE id = ?`, params);
    },
    async deleteHabit(id: string): Promise<void> {
      const now = iso(ctx);
      await db.execute('UPDATE habits SET deleted_at = ?, updated_at = ? WHERE id = ?', [now, now, id]);
    },
    /** Check a habit off for one occurrence (the caller buckets occurrenceDate). */
    async checkOffHabit(input: { habitId: string; occurrenceDate: string }): Promise<string> {
      const id = newId();
      const now = iso(ctx);
      await db.execute(
        'INSERT INTO habit_completions (id, user_id, habit_id, occurrence_date, completed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, ctx.userId, input.habitId, input.occurrenceDate, now, now, now],
      );
      return id;
    },

    // --- decision board (§6.0) ----------------------------------------------
    async createBoard(title: string): Promise<string> {
      const id = newId();
      const now = iso(ctx);
      await db.execute('INSERT INTO decision_boards (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [id, ctx.userId, title, now, now]);
      return id;
    },
    async createCriterion(input: { boardId: string; label: string; weight: number }): Promise<string> {
      const id = newId();
      const now = iso(ctx);
      await db.execute(
        'INSERT INTO decision_criteria (id, user_id, board_id, label, weight, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, ctx.userId, input.boardId, input.label, input.weight, now, now],
      );
      return id;
    },
    async setCriterionWeight(id: string, weight: number): Promise<void> {
      await db.execute('UPDATE decision_criteria SET weight = ?, updated_at = ? WHERE id = ?', [weight, iso(ctx), id]);
    },
    /**
     * Upsert a project's score on a criterion (score.set, keyed by
     * criterion_id+project_id). On update we re-state the key fields so the
     * CRUD patch carries them for the command bridge.
     */
    async setScore(input: { existingId?: string; criterionId: string; projectId: string; score: number }): Promise<void> {
      const now = iso(ctx);
      if (input.existingId) {
        await db.execute(
          'UPDATE decision_scores SET score = ?, criterion_id = ?, project_id = ?, updated_at = ? WHERE id = ?',
          [input.score, input.criterionId, input.projectId, now, input.existingId],
        );
      } else {
        await db.execute(
          'INSERT INTO decision_scores (id, user_id, criterion_id, project_id, score, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [newId(), ctx.userId, input.criterionId, input.projectId, input.score, now, now],
        );
      }
    },

    // --- tags (confirmable event tags) --------------------------------------
    /** Create a reusable catalog tag ("on time?"); optionally scoped to a habit. */
    async createTag(input: { id?: string; label: string; habitId?: string | null }): Promise<string> {
      const id = input.id ?? newId();
      const now = iso(ctx);
      await db.execute(
        'INSERT INTO tags (id, user_id, label, habit_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [id, ctx.userId, input.label, input.habitId ?? null, now, now],
      );
      return id;
    },
    async renameTag(id: string, label: string): Promise<void> {
      await db.execute('UPDATE tags SET label = ?, updated_at = ? WHERE id = ?', [label, iso(ctx), id]);
    },
    async deleteTag(id: string): Promise<void> {
      const now = iso(ctx);
      await db.execute('UPDATE tags SET deleted_at = ?, updated_at = ? WHERE id = ?', [now, now, id]);
    },
    /** Place a tag on a schedule block (event); idempotent by (block, tag) server-side. */
    async placeTag(input: { id?: string; blockId: string; tagId: string }): Promise<string> {
      const id = input.id ?? newId();
      const now = iso(ctx);
      await db.execute(
        'INSERT INTO tag_placements (id, user_id, block_id, tag_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [id, ctx.userId, input.blockId, input.tagId, now, now],
      );
      return id;
    },
    async unplaceTag(id: string): Promise<void> {
      const now = iso(ctx);
      await db.execute('UPDATE tag_placements SET deleted_at = ?, updated_at = ? WHERE id = ?', [now, now, id]);
    },
    /**
     * Answer a placed tag yes/no (tag.answer, upsert keyed by placement_id). On
     * update we re-state placement_id so the CRUD patch carries it for the bridge.
     */
    async answerTag(input: { existingId?: string; placementId: string; value: 'yes' | 'no' }): Promise<void> {
      const now = iso(ctx);
      if (input.existingId) {
        await db.execute(
          'UPDATE tag_answers SET value = ?, answered_at = ?, placement_id = ?, updated_at = ? WHERE id = ?',
          [input.value, now, input.placementId, now, input.existingId],
        );
      } else {
        await db.execute(
          'INSERT INTO tag_answers (id, user_id, placement_id, value, answered_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [newId(), ctx.userId, input.placementId, input.value, now, now, now],
        );
      }
    },
    /** Clear an answer back to pending (soft-delete the answer row). */
    async clearTagAnswer(answerId: string): Promise<void> {
      const now = iso(ctx);
      await db.execute('UPDATE tag_answers SET deleted_at = ?, updated_at = ? WHERE id = ?', [now, now, answerId]);
    },

    // --- edges (the dependency graph, §6.7 I4) ------------------------------
    async createEdge(input: { id?: string; predecessorId: string; successorId: string; edgeType?: 'FS' | 'SS' | 'FF' | 'SF'; lagMinutes?: number }): Promise<string> {
      const id = input.id ?? newId();
      const now = iso(ctx);
      await db.execute(
        'INSERT INTO edges (id, user_id, predecessor_id, successor_id, edge_type, lag_minutes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [id, ctx.userId, input.predecessorId, input.successorId, input.edgeType ?? 'FS', input.lagMinutes ?? 0, now, now],
      );
      return id;
    },
    async deleteEdge(id: string): Promise<void> {
      const now = iso(ctx);
      await db.execute('UPDATE edges SET deleted_at = ?, updated_at = ? WHERE id = ?', [now, now, id]);
    },

    // --- diagram layout & groups (§12.1–12.2) -------------------------------
    /** Persist a node's position in a diagram (layout.set_position, upsert by diagram+node). */
    async setLayoutPosition(input: { existingId?: string; diagramId: string; nodeId: string; x: number; y: number; groupId?: string | null }): Promise<void> {
      const now = iso(ctx);
      if (input.existingId) {
        await db.execute(
          'UPDATE diagram_layouts SET x = ?, y = ?, group_id = ?, diagram_id = ?, node_id = ?, updated_at = ? WHERE id = ?',
          [input.x, input.y, input.groupId ?? null, input.diagramId, input.nodeId, now, input.existingId],
        );
      } else {
        await db.execute(
          'INSERT INTO diagram_layouts (id, user_id, diagram_id, node_id, x, y, group_id, collapsed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [newId(), ctx.userId, input.diagramId, input.nodeId, input.x, input.y, input.groupId ?? null, 0, now, now],
        );
      }
    },
    async setLayoutCollapsed(input: { existingId?: string; diagramId: string; nodeId: string; collapsed: boolean }): Promise<void> {
      const now = iso(ctx);
      if (input.existingId) {
        await db.execute(
          'UPDATE diagram_layouts SET collapsed = ?, diagram_id = ?, node_id = ?, updated_at = ? WHERE id = ?',
          [input.collapsed ? 1 : 0, input.diagramId, input.nodeId, now, input.existingId],
        );
      } else {
        await db.execute(
          'INSERT INTO diagram_layouts (id, user_id, diagram_id, node_id, x, y, collapsed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [newId(), ctx.userId, input.diagramId, input.nodeId, 0, 0, input.collapsed ? 1 : 0, now, now],
        );
      }
    },
    async createGroup(input: { id?: string; diagramId: string; label: string; color?: string | null }): Promise<string> {
      const id = input.id ?? newId();
      const now = iso(ctx);
      await db.execute(
        'INSERT INTO diagram_groups (id, user_id, diagram_id, label, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, ctx.userId, input.diagramId, input.label, input.color ?? null, now, now],
      );
      return id;
    },
    async updateGroup(id: string, patch: { label?: string; color?: string | null }): Promise<void> {
      const now = iso(ctx);
      const sets: string[] = [];
      const params: unknown[] = [];
      if (patch.label !== undefined) { sets.push('label = ?'); params.push(patch.label); }
      if ('color' in patch) { sets.push('color = ?'); params.push(patch.color ?? null); }
      if (sets.length === 0) return;
      sets.push('updated_at = ?');
      params.push(now, id);
      await db.execute(`UPDATE diagram_groups SET ${sets.join(', ')} WHERE id = ?`, params);
    },
    async deleteGroup(id: string): Promise<void> {
      const now = iso(ctx);
      await db.execute('UPDATE diagram_groups SET deleted_at = ?, updated_at = ? WHERE id = ?', [now, now, id]);
    },

    // --- automation & blocker rules (§9) ------------------------------------
    async createRule(input: { id?: string; trigger: 'task_completed' | 'task_created'; conditions: unknown; actions: unknown; enabled?: boolean }): Promise<string> {
      const id = input.id ?? newId();
      const now = iso(ctx);
      await db.execute(
        'INSERT INTO automation_rules (id, user_id, trigger, conditions, actions, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [id, ctx.userId, input.trigger, JSON.stringify(input.conditions), JSON.stringify(input.actions), input.enabled === false ? 0 : 1, now, now],
      );
      return id;
    },
    async toggleRule(id: string, enabled: boolean): Promise<void> {
      await db.execute('UPDATE automation_rules SET enabled = ?, updated_at = ? WHERE id = ?', [enabled ? 1 : 0, iso(ctx), id]);
    },
    async deleteRule(id: string): Promise<void> {
      const now = iso(ctx);
      await db.execute('UPDATE automation_rules SET deleted_at = ?, updated_at = ? WHERE id = ?', [now, now, id]);
    },
    async createBlocker(input: { id?: string; scope: unknown; predicate: unknown; label: string; enabled?: boolean }): Promise<string> {
      const id = input.id ?? newId();
      const now = iso(ctx);
      await db.execute(
        'INSERT INTO blocker_rules (id, user_id, scope, predicate, label, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [id, ctx.userId, JSON.stringify(input.scope), JSON.stringify(input.predicate), input.label, input.enabled === false ? 0 : 1, now, now],
      );
      return id;
    },
    async toggleBlocker(id: string, enabled: boolean): Promise<void> {
      await db.execute('UPDATE blocker_rules SET enabled = ?, updated_at = ? WHERE id = ?', [enabled ? 1 : 0, iso(ctx), id]);
    },
    async deleteBlocker(id: string): Promise<void> {
      const now = iso(ctx);
      await db.execute('UPDATE blocker_rules SET deleted_at = ?, updated_at = ? WHERE id = ?', [now, now, id]);
    },

    async updateSettings(patch: { day_reset_hour?: number; timezone?: string }): Promise<void> {
      const now = iso(ctx);
      const sets: string[] = ['updated_at = ?'];
      const params: unknown[] = [now];
      if (patch.day_reset_hour !== undefined) {
        sets.unshift('day_reset_hour = ?');
        params.unshift(patch.day_reset_hour);
      }
      if (patch.timezone !== undefined) {
        sets.unshift('timezone = ?');
        params.unshift(patch.timezone);
      }
      params.push(ctx.userId);
      await db.execute(`UPDATE user_settings SET ${sets.join(', ')} WHERE id = ?`, params);
    },
    /**
     * Create the user's settings row (id = user_id, matching the server PK) when
     * none has synced yet — the server upserts on user_id, so this is the first
     * settings.update for a fresh account.
     */
    async insertSettings(patch: { day_reset_hour: number; timezone: string }): Promise<void> {
      const now = iso(ctx);
      await db.execute(
        'INSERT INTO user_settings (id, day_reset_hour, timezone, updated_at) VALUES (?, ?, ?, ?)',
        [ctx.userId, patch.day_reset_hour, patch.timezone, now],
      );
    },
  };
}

export type Commands = ReturnType<typeof createCommands>;
