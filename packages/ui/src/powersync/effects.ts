/**
 * Optimistic overlay effect builder for the full §8.1 command catalog (1.3
 * §7.2, §7.2a; M8). PURE — a deterministic function of `(name, payload, ctx)`,
 * unit-tested without a browser. The generalization of the M0 `buildRenameEffect`
 * slice to every verb.
 *
 * Each command maps to the minimal row effect(s) it makes locally, in the SAME
 * loose representation PowerSync stores the replica in, so the merged read
 * (`mergeTable(replica, overlay)`) feeds the row mappers (`rows.ts`) cleanly:
 *  - JSON columns (attributes, conditions, actions, scope, predicate,
 *    level_thresholds_hours, weather_location) are JSON **text**, not objects —
 *    the mappers `JSON.parse` them and would drop a raw object as the fallback;
 *  - booleans (enabled, planned, completed_session) are integer 0/1;
 *  - `insert` seeds a complete-enough row (id + user_id + timestamps + the named
 *    fields) so an overlay-only create renders; `update` is minimal-field (§2.8)
 *    — only the columns the command names — so it patches without clobber;
 *  - soft-deletes use op `delete` so the row disappears from the merged read
 *    immediately (it reappears tombstoned, then is filtered, once it syncs back).
 *
 * The optimistic effect predicts ONLY display state; the server re-applies every
 * command authoritatively (R17) and the identical canonical row reconciles the
 * overlay away (§7.2). Two verbs whose target row id is NOT in the payload
 * (`layout.set_position`/`layout.set_collapsed`, keyed by diagram+node) return no
 * effect here — the live writer (commands.ts) supplies the resolved row id.
 */
import { renormalizedOrders, type CommandName, type JsonObject, type JsonValue } from '@prisms/core';

/** Context the server would assign; the overlay may predict it for display (§7.8). */
export interface OptimisticEffectCtx {
  userId: string;
  deviceId: string;
  /** ISO timestamp stamped on optimistic create rows. */
  now: string;
}

/** A row effect without the command-stamped fields (`command_id`/`hlc`/`seq`). */
export interface EffectSpec {
  table: string;
  row_id: string;
  op: 'insert' | 'update' | 'delete';
  fields: JsonObject;
}

const j = (v: unknown): string => JSON.stringify(v ?? null);
const b = (v: unknown): number => (v ? 1 : 0);

/** Drop `undefined` (keep explicit `null`) so only named fields are written. */
function clean(fields: Record<string, unknown>): JsonObject {
  const out: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) out[k] = v as JsonValue;
  return out;
}

/**
 * The optimistic effect(s) of one command. `payload` is the already-validated
 * command payload (the caller parses against COMMAND_SCHEMAS first).
 */
export function buildOptimisticEffects(name: CommandName, payload: unknown, ctx: OptimisticEffectCtx): EffectSpec[] {
  const p = (payload ?? {}) as Record<string, unknown>;
  const id = String(p['id'] ?? '');

  const ins = (table: string, rowId: unknown, fields: Record<string, unknown>): EffectSpec => ({
    table,
    row_id: String(rowId),
    op: 'insert',
    fields: clean({ id: rowId, user_id: ctx.userId, ...fields, created_at: ctx.now, updated_at: ctx.now }),
  });
  const upd = (table: string, rowId: unknown, fields: Record<string, unknown>): EffectSpec => ({
    table,
    row_id: String(rowId),
    op: 'update',
    fields: clean(fields),
  });
  const del = (table: string, rowId: unknown): EffectSpec => ({ table, row_id: String(rowId), op: 'delete', fields: {} });

  switch (name) {
    // --- nodes --------------------------------------------------------------
    case 'node.create':
      return [
        ins('nodes', p['id'], {
          parent_id: p['parent_id'] ?? null,
          node_type: p['node_type'],
          title: p['title'],
          description: p['description'] ?? '',
          sort_order: p['sort_order'],
          start_date: p['start_date'] ?? null,
          due_date: p['due_date'] ?? null,
          estimate_minutes: p['estimate_minutes'] ?? null,
          habit_id: p['habit_id'] ?? null,
          attributes: j(p['attributes'] ?? {}),
        }),
      ];
    case 'node.rename':
      return [upd('nodes', id, { title: p['title'] })];
    case 'node.set_description':
      return [upd('nodes', id, { description: p['description'] })];
    case 'node.set_dates': {
      const f: Record<string, unknown> = {};
      if ('start_date' in p) f['start_date'] = p['start_date'] ?? null;
      if ('due_date' in p) f['due_date'] = p['due_date'] ?? null;
      return [upd('nodes', id, f)];
    }
    case 'node.set_estimate':
      return [upd('nodes', id, { estimate_minutes: p['estimate_minutes'] ?? null })];
    case 'node.reorder':
      return [upd('nodes', id, { sort_order: p['sort_order'] })];
    case 'node.move':
      return [upd('nodes', id, { parent_id: p['new_parent_id'] ?? null, sort_order: p['sort_order'] })];
    case 'node.retype':
      return [upd('nodes', id, { node_type: p['node_type'] })];
    case 'node.check_off': {
      const f: Record<string, unknown> = { completed_at: p['completed_at'], completion_disposition: p['disposition'] ?? 'completed' };
      if ('completed_in_block_id' in p) f['completed_in_block_id'] = p['completed_in_block_id'] ?? null;
      return [upd('nodes', id, f)];
    }
    case 'node.uncheck':
      return [upd('nodes', id, { completed_at: null, completion_disposition: null, completed_in_block_id: null })];
    case 'node.soft_delete':
      // primary effect only; the live writer adds the §I10 descendant closure.
      return [del('nodes', id)];
    case 'activity.promote': {
      const f: Record<string, unknown> = { node_type: 'task' };
      if (p['habit_id'] != null) {
        f['habit_id'] = p['habit_id'];
        f['parent_id'] = null;
      } else {
        f['parent_id'] = p['parent_id'] ?? null;
        f['habit_id'] = null;
      }
      return [upd('nodes', id, f)];
    }

    // --- edges --------------------------------------------------------------
    case 'edge.create':
      return [
        ins('edges', p['id'], {
          predecessor_id: p['predecessor_id'],
          successor_id: p['successor_id'],
          edge_type: p['edge_type'] ?? 'FS',
          lag_minutes: p['lag_minutes'] ?? 0,
        }),
      ];
    case 'edge.delete':
      return [del('edges', id)];

    // --- schedule blocks ----------------------------------------------------
    case 'block.create':
      return [
        ins('schedule_blocks', p['id'], {
          task_id: p['task_id'],
          starts_at: p['starts_at'],
          ends_at: p['ends_at'],
          anchor_type: p['anchor_type'] ?? 'none',
          status: 'committed',
        }),
      ];
    case 'block.move':
      return [upd('schedule_blocks', id, { starts_at: p['starts_at'], ends_at: p['ends_at'] })];
    case 'block.set_anchor':
      return [upd('schedule_blocks', id, { anchor_type: p['anchor_type'] })];
    case 'block.delete':
      return [del('schedule_blocks', id)];
    case 'block.accept_suggestion':
      // optimistic promote; the server §7.5 txn also supersedes siblings + soft-
      // deletes the replaced block (those reconcile on sync).
      return [upd('schedule_blocks', id, { status: 'committed', suggestion_reason: null })];
    case 'block.reject_suggestion':
      return [del('schedule_blocks', id)];

    // --- time tracking ------------------------------------------------------
    case 'timer.clock_in':
      return [
        ins('time_entries', p['entry_id'], {
          task_id: p['task_id'],
          started_at: p['started_at'],
          planned: b(p['planned'] ?? true),
          device_id: ctx.deviceId,
        }),
      ];
    case 'timer.clock_out':
      return [upd('time_entries', p['entry_id'], { ended_at: p['ended_at'] })];
    case 'timer.review':
      // the time-entry facts; a completing review also sets node.completed_at, but
      // that needs the entry's task_id (not in the payload) so the live writer adds it.
      return [upd('time_entries', p['entry_id'], { focus_factor: p['focus_factor'], completed_session: b(p['completed_session']) })];

    // --- habits -------------------------------------------------------------
    case 'habit.create':
      return [
        ins('habits', p['id'], {
          vision_id: p['vision_id'],
          title: p['title'],
          rrule: p['rrule'],
          streak_mode: p['streak_mode'],
          daily_target_minutes: p['daily_target_minutes'] ?? null,
          mastery_target_hours: p['mastery_target_hours'] ?? null,
          level_thresholds_hours: j(p['level_thresholds_hours'] ?? []),
        }),
      ];
    case 'habit.update': {
      const f: Record<string, unknown> = {};
      if ('title' in p) f['title'] = p['title'];
      if ('rrule' in p) f['rrule'] = p['rrule'];
      if ('streak_mode' in p) f['streak_mode'] = p['streak_mode'];
      if ('daily_target_minutes' in p) f['daily_target_minutes'] = p['daily_target_minutes'] ?? null;
      if ('mastery_target_hours' in p) f['mastery_target_hours'] = p['mastery_target_hours'] ?? null;
      if ('level_thresholds_hours' in p) f['level_thresholds_hours'] = j(p['level_thresholds_hours']);
      return [upd('habits', id, f)];
    }
    case 'habit.delete':
      return [del('habits', id)];
    case 'habit.check_off':
      return [ins('habit_completions', p['id'], { habit_id: p['habit_id'], occurrence_date: p['occurrence_date'], completed_at: p['completed_at'] })];

    // --- sprints ------------------------------------------------------------
    case 'sprint.create':
      return [ins('sprints', p['id'], { title: p['title'], starts_on: p['starts_on'], ends_on: p['ends_on'] })];
    case 'sprint.add_node':
      return [ins('sprint_memberships', p['id'], { sprint_id: p['sprint_id'], node_id: p['node_id'] })];
    case 'sprint.remove_node':
      return [del('sprint_memberships', id)];
    case 'sprint.delete':
      return [del('sprints', id)];

    // --- decision board -----------------------------------------------------
    case 'board.create':
      return [ins('decision_boards', p['id'], { title: p['title'] })];
    case 'criterion.create':
      return [ins('decision_criteria', p['id'], { board_id: p['board_id'], label: p['label'], weight: p['weight'] })];
    case 'criterion.set_weight':
      return [upd('decision_criteria', id, { weight: p['weight'] })];
    case 'score.set':
      // upsert keyed by (criterion, project); the command carries the row id, so a
      // create-or-patch `insert` (mergeRow seeds an overlay-only row, or patches the
      // replica one) is correct either way.
      return [ins('decision_scores', p['id'], { criterion_id: p['criterion_id'], project_id: p['project_id'], score: p['score'] })];

    // --- tags ---------------------------------------------------------------
    case 'tag.create':
      return [ins('tags', p['id'], { label: p['label'], habit_id: p['habit_id'] ?? null })];
    case 'tag.rename':
      return [upd('tags', id, { label: p['label'] })];
    case 'tag.delete':
      return [del('tags', id)];
    case 'tag.place':
      return [ins('tag_placements', p['id'], { block_id: p['block_id'], tag_id: p['tag_id'] })];
    case 'tag.unplace':
      return [del('tag_placements', id)];
    case 'tag.answer':
      return [ins('tag_answers', p['id'], { placement_id: p['placement_id'], value: p['value'], answered_at: p['answered_at'] })];
    case 'tag.clear_answer':
      return [del('tag_answers', id)];

    // --- automation & blocker rules ----------------------------------------
    case 'rule.create':
      return [
        ins('automation_rules', p['id'], {
          trigger: p['trigger'],
          conditions: j(p['conditions'] ?? {}),
          actions: j(p['actions'] ?? []),
          enabled: b(p['enabled'] ?? true),
        }),
      ];
    case 'rule.update': {
      const f: Record<string, unknown> = {};
      if ('trigger' in p) f['trigger'] = p['trigger'];
      if ('conditions' in p) f['conditions'] = j(p['conditions']);
      if ('actions' in p) f['actions'] = j(p['actions']);
      return [upd('automation_rules', id, f)];
    }
    case 'rule.toggle':
      return [upd('automation_rules', id, { enabled: b(p['enabled']) })];
    case 'rule.delete':
      return [del('automation_rules', id)];
    case 'blocker.create':
      return [
        ins('blocker_rules', p['id'], {
          scope: j(p['scope'] ?? {}),
          predicate: j(p['predicate'] ?? {}),
          label: p['label'],
          enabled: b(p['enabled'] ?? true),
        }),
      ];
    case 'blocker.update': {
      const f: Record<string, unknown> = {};
      if ('scope' in p) f['scope'] = j(p['scope']);
      if ('predicate' in p) f['predicate'] = j(p['predicate']);
      if ('label' in p) f['label'] = p['label'];
      return [upd('blocker_rules', id, f)];
    }
    case 'blocker.toggle':
      return [upd('blocker_rules', id, { enabled: b(p['enabled']) })];
    case 'blocker.delete':
      return [del('blocker_rules', id)];

    // --- diagram layout & groups -------------------------------------------
    case 'layout.set_position':
    case 'layout.set_collapsed':
      // keyed by (diagram_id, node_id); the row id is not in the payload, so the
      // live writer (commands.ts, which knows the existing layout id) supplies it.
      return [];
    case 'layout.renormalize_order': {
      const nodeIds = Array.isArray(p['node_ids']) ? (p['node_ids'] as string[]) : [];
      const orders = renormalizedOrders(nodeIds.length);
      return nodeIds.map((nodeId, i) => upd('nodes', nodeId, { sort_order: orders[i] }));
    }
    case 'group.create':
      return [ins('diagram_groups', p['id'], { diagram_id: p['diagram_id'], label: p['label'], color: p['color'] ?? null })];
    case 'group.update': {
      const f: Record<string, unknown> = {};
      if ('label' in p) f['label'] = p['label'];
      if ('color' in p) f['color'] = p['color'] ?? null;
      return [upd('diagram_groups', id, f)];
    }
    case 'group.delete':
      return [del('diagram_groups', id)];

    // --- settings -----------------------------------------------------------
    case 'settings.update': {
      const f: Record<string, unknown> = {};
      if ('day_reset_hour' in p) f['day_reset_hour'] = p['day_reset_hour'];
      if ('timezone' in p) f['timezone'] = p['timezone'];
      if ('weather_location' in p) f['weather_location'] = j(p['weather_location'] ?? null);
      // the settings row id is the user id (server PK), so the merged read patches it.
      return [upd('user_settings', ctx.userId, f)];
    }

    default: {
      // compile-time exhaustiveness: a new CommandName without an effect here fails the build.
      const _exhaustive: never = name;
      void _exhaustive;
      return [];
    }
  }
}
