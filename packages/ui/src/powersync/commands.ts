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
    async checkOff(taskId: string): Promise<void> {
      const now = iso(ctx);
      await db.execute('UPDATE nodes SET completed_at = ?, updated_at = ? WHERE id = ?', [now, now, taskId]);
    },
    async uncheck(taskId: string): Promise<void> {
      await db.execute('UPDATE nodes SET completed_at = NULL, updated_at = ? WHERE id = ?', [iso(ctx), taskId]);
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
        await db.execute('UPDATE nodes SET completed_at = ?, updated_at = ? WHERE id = ?', [now, now, input.taskId]);
      }
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
  };
}

export type Commands = ReturnType<typeof createCommands>;
