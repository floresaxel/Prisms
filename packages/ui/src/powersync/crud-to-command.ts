/**
 * PowerSync CRUD → named command (§7.3): the device never sends SQL. Local
 * optimistic writes land in PowerSync's CRUD queue as per-column patches;
 * this pure function wraps each into the matching §8.1 command with only the
 * fields it names (minimal-field patches, §2.8). The server dispatcher is the
 * inverse. Pure ⇒ unit-tested without a browser.
 */
import type { CommandName } from '@prisms/core';

export type CrudOp = 'PUT' | 'PATCH' | 'DELETE';

/** Shape of a PowerSync CrudEntry (the bits we use). */
export interface CrudLike {
  op: CrudOp;
  table: string;
  id: string;
  opData?: Record<string, unknown> | null;
}

export interface TranslatedCommand {
  name: CommandName;
  payload: Record<string, unknown>;
}

const has = (data: Record<string, unknown> | null | undefined, key: string): boolean =>
  data != null && Object.prototype.hasOwnProperty.call(data, key);

/** Pick present keys from opData into a payload. */
function pick(data: Record<string, unknown> | null | undefined, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (data) for (const key of keys) if (has(data, key)) out[key] = data[key];
  return out;
}

function nodeCommand(entry: CrudLike): TranslatedCommand | null {
  const d = entry.opData;
  if (entry.op === 'DELETE') return { name: 'node.soft_delete', payload: { id: entry.id } };
  if (entry.op === 'PUT') {
    return {
      name: 'node.create',
      payload: {
        id: entry.id,
        ...pick(d, ['node_type', 'title', 'sort_order', 'parent_id', 'habit_id', 'description', 'start_date', 'due_date', 'estimate_minutes']),
      },
    };
  }
  // PATCH — infer the verb from the changed column (per-field mutations).
  if (has(d, 'deleted_at') && d!['deleted_at'] != null) return { name: 'node.soft_delete', payload: { id: entry.id } };
  if (has(d, 'completed_at')) {
    return d!['completed_at'] == null
      ? { name: 'node.uncheck', payload: { id: entry.id } }
      : { name: 'node.check_off', payload: { id: entry.id, completed_at: d!['completed_at'] } };
  }
  // activity.promote retypes to task AND attaches a justification (parent xor
  // habit, I3) in one write — distinguished from a plain retype by the
  // co-changed parent_id/habit_id (§8.1).
  if (has(d, 'node_type') && (has(d, 'parent_id') || has(d, 'habit_id'))) {
    return d!['habit_id'] != null
      ? { name: 'activity.promote', payload: { id: entry.id, habit_id: d!['habit_id'] } }
      : { name: 'activity.promote', payload: { id: entry.id, parent_id: d!['parent_id'] } };
  }
  if (has(d, 'node_type')) return { name: 'node.retype', payload: { id: entry.id, node_type: d!['node_type'] } };
  if (has(d, 'parent_id')) return { name: 'node.move', payload: { id: entry.id, new_parent_id: d!['parent_id'] ?? null, sort_order: d!['sort_order'] } };
  if (has(d, 'sort_order')) return { name: 'node.reorder', payload: { id: entry.id, sort_order: d!['sort_order'] } };
  if (has(d, 'title')) return { name: 'node.rename', payload: { id: entry.id, title: d!['title'] } };
  if (has(d, 'description')) return { name: 'node.set_description', payload: { id: entry.id, description: d!['description'] } };
  if (has(d, 'start_date') || has(d, 'due_date')) return { name: 'node.set_dates', payload: { id: entry.id, ...pick(d, ['start_date', 'due_date']) } };
  if (has(d, 'estimate_minutes')) return { name: 'node.set_estimate', payload: { id: entry.id, estimate_minutes: d!['estimate_minutes'] } };
  return null;
}

function timeEntryCommand(entry: CrudLike): TranslatedCommand | null {
  const d = entry.opData;
  if (entry.op === 'PUT') {
    return {
      name: 'timer.clock_in',
      payload: { entry_id: entry.id, task_id: d?.['task_id'], started_at: d?.['started_at'], ...(has(d, 'planned') ? { planned: !!d!['planned'] } : {}) },
    };
  }
  if (entry.op === 'PATCH') {
    if (has(d, 'focus_factor') || has(d, 'completed_session')) {
      return { name: 'timer.review', payload: { entry_id: entry.id, focus_factor: d!['focus_factor'], completed_session: !!d!['completed_session'] } };
    }
    if (has(d, 'ended_at') && d!['ended_at'] != null) return { name: 'timer.clock_out', payload: { entry_id: entry.id, ended_at: d!['ended_at'] } };
  }
  return null;
}

function scheduleBlockCommand(entry: CrudLike): TranslatedCommand | null {
  const d = entry.opData;
  if (entry.op === 'DELETE') return { name: 'block.delete', payload: { id: entry.id } };
  if (entry.op === 'PUT') {
    return {
      name: 'block.create',
      payload: {
        id: entry.id,
        task_id: d?.['task_id'],
        starts_at: d?.['starts_at'],
        ends_at: d?.['ends_at'],
        ...(has(d, 'anchor_type') ? { anchor_type: d!['anchor_type'] } : {}),
      },
    };
  }
  // PATCH — per-field verb inference.
  if (has(d, 'deleted_at') && d!['deleted_at'] != null) return { name: 'block.delete', payload: { id: entry.id } };
  // accepting a suggestion flips status committed (suggestion_reason cleared too).
  if (has(d, 'status')) return { name: 'block.accept_suggestion', payload: { id: entry.id } };
  if (has(d, 'anchor_type')) return { name: 'block.set_anchor', payload: { id: entry.id, anchor_type: d!['anchor_type'] } };
  if (has(d, 'starts_at') || has(d, 'ends_at')) {
    return { name: 'block.move', payload: { id: entry.id, starts_at: d!['starts_at'], ends_at: d!['ends_at'] } };
  }
  return null;
}

function settingsCommand(entry: CrudLike): TranslatedCommand | null {
  if (entry.op === 'DELETE') return null;
  const payload = pick(entry.opData, ['day_reset_hour', 'timezone', 'weather_location']);
  return Object.keys(payload).length > 0 ? { name: 'settings.update', payload } : null;
}

/** Map a CRUD entry to its command, or null when it carries no mutation we ship. */
export function crudToCommand(entry: CrudLike): TranslatedCommand | null {
  switch (entry.table) {
    case 'nodes':
      return nodeCommand(entry);
    case 'time_entries':
      return timeEntryCommand(entry);
    case 'schedule_blocks':
      return scheduleBlockCommand(entry);
    case 'user_settings':
      return settingsCommand(entry);
    default:
      return null;
  }
}
