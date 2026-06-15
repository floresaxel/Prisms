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

/** PowerSync stores array columns as JSON text; commands expect the array. */
function jsonArray(value: unknown): number[] {
  if (Array.isArray(value)) return value as number[];
  if (typeof value === 'string' && value.length > 0) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? (parsed as number[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** PowerSync stores jsonb columns (conditions/actions/scope/predicate) as text. */
function jsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

const bool = (value: unknown): boolean => value === 1 || value === true || value === '1';

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

function habitCommand(entry: CrudLike): TranslatedCommand | null {
  const d = entry.opData;
  if (entry.op === 'DELETE') return { name: 'habit.delete', payload: { id: entry.id } };
  if (entry.op === 'PUT') {
    const payload: Record<string, unknown> = {
      id: entry.id,
      ...pick(d, ['vision_id', 'title', 'rrule', 'streak_mode', 'daily_target_minutes', 'mastery_target_hours']),
    };
    if (has(d, 'level_thresholds_hours')) payload['level_thresholds_hours'] = jsonArray(d!['level_thresholds_hours']);
    return { name: 'habit.create', payload };
  }
  // PATCH
  if (has(d, 'deleted_at') && d!['deleted_at'] != null) return { name: 'habit.delete', payload: { id: entry.id } };
  const update: Record<string, unknown> = pick(d, ['title', 'rrule', 'streak_mode', 'daily_target_minutes', 'mastery_target_hours']);
  if (has(d, 'level_thresholds_hours')) update['level_thresholds_hours'] = jsonArray(d!['level_thresholds_hours']);
  return Object.keys(update).length > 0 ? { name: 'habit.update', payload: { id: entry.id, ...update } } : null;
}

function habitCompletionCommand(entry: CrudLike): TranslatedCommand | null {
  const d = entry.opData;
  // completions are append-only facts; only the check-off (PUT) ships.
  if (entry.op === 'PUT') {
    return {
      name: 'habit.check_off',
      payload: { id: entry.id, habit_id: d?.['habit_id'], occurrence_date: d?.['occurrence_date'], completed_at: d?.['completed_at'] },
    };
  }
  return null;
}

function decisionBoardCommand(entry: CrudLike): TranslatedCommand | null {
  // boards have only a create command (no rename/delete in the catalog).
  if (entry.op === 'PUT') return { name: 'board.create', payload: { id: entry.id, ...pick(entry.opData, ['title']) } };
  return null;
}

function decisionCriterionCommand(entry: CrudLike): TranslatedCommand | null {
  const d = entry.opData;
  if (entry.op === 'PUT') {
    return { name: 'criterion.create', payload: { id: entry.id, ...pick(d, ['board_id', 'label', 'weight']) } };
  }
  if (entry.op === 'PATCH' && has(d, 'weight')) {
    return { name: 'criterion.set_weight', payload: { id: entry.id, weight: d!['weight'] } };
  }
  return null;
}

function decisionScoreCommand(entry: CrudLike): TranslatedCommand | null {
  const d = entry.opData;
  // score.set is an upsert keyed by (criterion_id, project_id); the writer
  // re-states those key fields on update so the command always carries them.
  if (entry.op === 'PUT' || (entry.op === 'PATCH' && has(d, 'score'))) {
    return { name: 'score.set', payload: { id: entry.id, criterion_id: d?.['criterion_id'], project_id: d?.['project_id'], score: d?.['score'] } };
  }
  return null;
}

function edgeCommand(entry: CrudLike): TranslatedCommand | null {
  const d = entry.opData;
  if (entry.op === 'DELETE') return { name: 'edge.delete', payload: { id: entry.id } };
  if (entry.op === 'PUT') {
    return {
      name: 'edge.create',
      payload: { id: entry.id, predecessor_id: d?.['predecessor_id'], successor_id: d?.['successor_id'], ...pick(d, ['edge_type', 'lag_minutes']) },
    };
  }
  if (has(d, 'deleted_at') && d!['deleted_at'] != null) return { name: 'edge.delete', payload: { id: entry.id } };
  return null;
}

function diagramLayoutCommand(entry: CrudLike): TranslatedCommand | null {
  const d = entry.opData;
  if (entry.op === 'DELETE') return null;
  // collapsed-first so a collapse write (which also seeds x=0,y=0 on insert)
  // is never mistaken for a position write.
  if (has(d, 'collapsed')) {
    return { name: 'layout.set_collapsed', payload: { diagram_id: d!['diagram_id'], node_id: d!['node_id'], collapsed: bool(d!['collapsed']) } };
  }
  if (has(d, 'x') || has(d, 'y')) {
    return {
      name: 'layout.set_position',
      payload: { diagram_id: d!['diagram_id'], node_id: d!['node_id'], x: Number(d!['x']), y: Number(d!['y']), ...(has(d, 'group_id') ? { group_id: d!['group_id'] ?? null } : {}) },
    };
  }
  return null;
}

function diagramGroupCommand(entry: CrudLike): TranslatedCommand | null {
  const d = entry.opData;
  if (entry.op === 'DELETE') return { name: 'group.delete', payload: { id: entry.id } };
  if (entry.op === 'PUT') {
    return { name: 'group.create', payload: { id: entry.id, diagram_id: d?.['diagram_id'], label: d?.['label'], ...(has(d, 'color') ? { color: d!['color'] ?? null } : {}) } };
  }
  if (has(d, 'deleted_at') && d!['deleted_at'] != null) return { name: 'group.delete', payload: { id: entry.id } };
  const update: Record<string, unknown> = {};
  if (has(d, 'label')) update['label'] = d!['label'];
  if (has(d, 'color')) update['color'] = d!['color'] ?? null;
  return Object.keys(update).length > 0 ? { name: 'group.update', payload: { id: entry.id, ...update } } : null;
}

function automationRuleCommand(entry: CrudLike): TranslatedCommand | null {
  const d = entry.opData;
  if (entry.op === 'DELETE') return { name: 'rule.delete', payload: { id: entry.id } };
  if (entry.op === 'PUT') {
    return {
      name: 'rule.create',
      payload: { id: entry.id, trigger: d?.['trigger'], conditions: jsonValue(d?.['conditions']), actions: jsonValue(d?.['actions']), ...(has(d, 'enabled') ? { enabled: bool(d!['enabled']) } : {}) },
    };
  }
  if (has(d, 'deleted_at') && d!['deleted_at'] != null) return { name: 'rule.delete', payload: { id: entry.id } };
  if (has(d, 'enabled')) return { name: 'rule.toggle', payload: { id: entry.id, enabled: bool(d!['enabled']) } };
  return null;
}

function blockerRuleCommand(entry: CrudLike): TranslatedCommand | null {
  const d = entry.opData;
  if (entry.op === 'DELETE') return { name: 'blocker.delete', payload: { id: entry.id } };
  if (entry.op === 'PUT') {
    return {
      name: 'blocker.create',
      payload: { id: entry.id, scope: jsonValue(d?.['scope']), predicate: jsonValue(d?.['predicate']), label: d?.['label'], ...(has(d, 'enabled') ? { enabled: bool(d!['enabled']) } : {}) },
    };
  }
  if (has(d, 'deleted_at') && d!['deleted_at'] != null) return { name: 'blocker.delete', payload: { id: entry.id } };
  if (has(d, 'enabled')) return { name: 'blocker.toggle', payload: { id: entry.id, enabled: bool(d!['enabled']) } };
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
    case 'edges':
      return edgeCommand(entry);
    case 'time_entries':
      return timeEntryCommand(entry);
    case 'schedule_blocks':
      return scheduleBlockCommand(entry);
    case 'diagram_layouts':
      return diagramLayoutCommand(entry);
    case 'diagram_groups':
      return diagramGroupCommand(entry);
    case 'automation_rules':
      return automationRuleCommand(entry);
    case 'blocker_rules':
      return blockerRuleCommand(entry);
    case 'habits':
      return habitCommand(entry);
    case 'habit_completions':
      return habitCompletionCommand(entry);
    case 'decision_boards':
      return decisionBoardCommand(entry);
    case 'decision_criteria':
      return decisionCriterionCommand(entry);
    case 'decision_scores':
      return decisionScoreCommand(entry);
    case 'user_settings':
      return settingsCommand(entry);
    default:
      return null;
  }
}
