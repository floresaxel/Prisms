/**
 * M8 — the optimistic command writers, cut over to the two-layer overlay (1.3
 * §7.2). Each `createCommands` method now builds a named §8.1 command and enqueues
 * it (client_commands) with its optimistic effect(s) (overlay_effects) via
 * `executeCommand` — no direct replica writes. Method signatures are unchanged,
 * so the screens are untouched; this asserts the new storage path per verb.
 */
import { describe, expect, it } from 'vitest';

import type { ClientCommand, OverlayEffect } from '@prisms/core';

import { createCommands, type CommandContext } from '../src/powersync/commands';
import type { OverlayStore } from '../src/powersync/overlay-store';

// real UUIDs — the catalog validates `uuidSchema`, so payload ids must be valid.
const NODE = '11111111-1111-7111-8111-111111111111';
const PARENT = '22222222-2222-7222-8222-222222222222';
const TASK = '33333333-3333-7333-8333-333333333333';
const ENTRY = '44444444-4444-7444-8444-444444444444';
const LAYOUT = '55555555-5555-7555-8555-555555555555';
const SCORE = '66666666-6666-7666-8666-666666666666';
const CRITERION = '77777777-7777-7777-8777-777777777777';
const PROJECT = '88888888-8888-7888-8888-888888888888';
const DIAGRAM = '99999999-9999-7999-8999-999999999999';
const BLOCK = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const REPLACED = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const SIBLING = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';

function captureStore() {
  const commands: ClientCommand[] = [];
  const effects: OverlayEffect[] = [];
  const store: OverlayStore = {
    async enqueue(command, cmdEffects) {
      commands.push(command);
      effects.push(...cmdEffects);
    },
    async pendingCommands() {
      return commands;
    },
    async effectsFor(table) {
      return effects.filter((e) => e.table === table);
    },
    async replicaRows() {
      return [];
    },
    async reconcileApplied() {},
    async rollbackRejected() {},
    async reviewItems() {
      return [];
    },
  };
  return { store, commands, effects };
}

const ctx: CommandContext = { userId: 'u1', deviceId: 'dev-1', now: () => '2026-06-28T00:00:00.000Z' };
const deps = () => {
  let n = 0;
  return { mintId: () => `cmd-${++n}`, nextHlc: () => `hlc-${n}`, now: () => '2026-06-28T00:00:00.000Z' };
};

describe('createCommands — updates enqueue a minimal-field overlay', () => {
  it('rename → node.rename command + an update effect; no trust fields leak', async () => {
    const { store, commands, effects } = captureStore();
    await createCommands(store, ctx, deps()).rename(NODE, 'New');
    expect(commands[0]).toMatchObject({ id: 'cmd-1', name: 'node.rename', hlc: 'hlc-1', payload: { id: NODE, title: 'New' }, status: 'pending' });
    expect(Object.keys(commands[0]!.payload as object)).toEqual(['id', 'title']);
    expect(effects).toEqual([{ command_id: 'cmd-1', hlc: 'hlc-1', table: 'nodes', row_id: NODE, op: 'update', fields: { title: 'New' }, seq: 0 }]);
  });

  it('checkOff → node.check_off with completed_at + default disposition', async () => {
    const { store, commands, effects } = captureStore();
    await createCommands(store, ctx, deps()).checkOff(NODE);
    expect(commands[0]!.name).toBe('node.check_off');
    expect(effects[0]).toMatchObject({ table: 'nodes', row_id: NODE, op: 'update', fields: { completed_at: '2026-06-28T00:00:00.000Z', completion_disposition: 'completed' } });
  });

  it('softDelete → node.soft_delete with an op-delete effect', async () => {
    const { store, commands, effects } = captureStore();
    await createCommands(store, ctx, deps()).softDelete(NODE);
    expect(commands[0]!.name).toBe('node.soft_delete');
    expect(effects[0]).toEqual({ command_id: 'cmd-1', hlc: 'hlc-1', table: 'nodes', row_id: NODE, op: 'delete', fields: {}, seq: 0 });
  });
});

describe('createCommands — creates mint a row id and seed an insert', () => {
  it('createTask → node.create; returns the row id carried in the payload + effect', async () => {
    const { store, commands, effects } = captureStore();
    const id = await createCommands(store, ctx, deps()).createTask({ parentId: PARENT, title: 'T', sortOrder: 'a0', estimateMinutes: 30 });
    expect(typeof id).toBe('string');
    expect(commands[0]).toMatchObject({ name: 'node.create', payload: { id, parent_id: PARENT, node_type: 'task', title: 'T', sort_order: 'a0', estimate_minutes: 30 } });
    expect(effects[0]).toMatchObject({ table: 'nodes', row_id: id, op: 'insert' });
    expect(effects[0]!.fields).toMatchObject({ id, user_id: 'u1', title: 'T', node_type: 'task' });
  });

  it('clockIn → timer.clock_in; effect carries planned=1 and the device id', async () => {
    const { store, commands, effects } = captureStore();
    const entryId = await createCommands(store, ctx, deps()).clockIn(TASK);
    expect(commands[0]).toMatchObject({ name: 'timer.clock_in', payload: { entry_id: entryId, task_id: TASK, started_at: '2026-06-28T00:00:00.000Z' } });
    expect(effects[0]).toMatchObject({ table: 'time_entries', row_id: entryId, op: 'insert', fields: { planned: 1, device_id: 'dev-1' } });
  });

  it('createRule → JSON columns land as TEXT in the effect; enabled as 0/1', async () => {
    const { store, effects } = captureStore();
    await createCommands(store, ctx, deps()).createRule({
      trigger: 'task_completed',
      conditions: { all: [] },
      actions: [{ action: 'spawn_task', slot: 0, template: { title: 'X', parent: 'same_as_trigger' } }],
    });
    expect(effects[0]).toMatchObject({ table: 'automation_rules', op: 'insert' });
    expect(effects[0]!.fields['conditions']).toBe('{"all":[]}');
    expect(effects[0]!.fields['enabled']).toBe(1);
  });
});

describe('createCommands — special cases', () => {
  it('review completing a session emits TWO effects: the entry + the node completion', async () => {
    const { store, commands, effects } = captureStore();
    await createCommands(store, ctx, deps()).review({ entryId: ENTRY, focusFactor: 0.9, completedSession: true, taskId: TASK });
    expect(commands[0]!.name).toBe('timer.review');
    expect(effects).toHaveLength(2);
    expect(effects[0]).toMatchObject({ table: 'time_entries', row_id: ENTRY, op: 'update', fields: { focus_factor: 0.9, completed_session: 1 } });
    expect(effects[1]).toMatchObject({ table: 'nodes', row_id: TASK, op: 'update', fields: { completed_at: '2026-06-28T00:00:00.000Z', completion_disposition: 'completed' } });
  });

  it('review WITHOUT completion emits only the entry effect', async () => {
    const { store, effects } = captureStore();
    await createCommands(store, ctx, deps()).review({ entryId: ENTRY, focusFactor: 0.5, completedSession: false });
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ table: 'time_entries', row_id: ENTRY });
  });

  it('setLayoutPosition: an existing layout updates optimistically; a first placement has no overlay', async () => {
    const a = captureStore();
    await createCommands(a.store, ctx, deps()).setLayoutPosition({ existingId: LAYOUT, diagramId: DIAGRAM, nodeId: NODE, x: 1, y: 2, groupId: null });
    expect(a.commands[0]!.name).toBe('layout.set_position');
    expect(a.effects).toEqual([{ command_id: 'cmd-1', hlc: 'hlc-1', table: 'diagram_layouts', row_id: LAYOUT, op: 'update', fields: { x: 1, y: 2, group_id: null }, seq: 0 }]);

    const b = captureStore();
    await createCommands(b.store, ctx, deps()).setLayoutPosition({ diagramId: DIAGRAM, nodeId: NODE, x: 5, y: 6 });
    expect(b.commands[0]!.name).toBe('layout.set_position'); // command still uploads
    expect(b.effects).toHaveLength(0); // server mints the row id → it syncs back, no overlay
  });

  it('clockIn with force → timer.clock_in carries force:true (§8 blocked-task override)', async () => {
    const { store, commands } = captureStore();
    await createCommands(store, ctx, deps()).clockIn(TASK, { force: true });
    expect(commands[0]).toMatchObject({ name: 'timer.clock_in', payload: { task_id: TASK, force: true } });
  });

  it('clockIn without force → no force key (default guarded clock-in)', async () => {
    const { store, commands } = captureStore();
    await createCommands(store, ctx, deps()).clockIn(TASK);
    expect(Object.keys(commands[0]!.payload as object)).not.toContain('force');
  });

  it('acceptSuggestion mirrors §7.5: promote + soft-delete the replaced block + supersede overlapping siblings', async () => {
    const blocks: Record<string, unknown>[] = [
      { id: BLOCK, task_id: TASK, status: 'suggested', starts_at: '2026-07-01T14:00:00.000Z', ends_at: '2026-07-01T15:00:00.000Z', replaces_block_id: REPLACED, superseded_at: null, deleted_at: null },
      { id: SIBLING, task_id: TASK, status: 'suggested', starts_at: '2026-07-01T14:30:00.000Z', ends_at: '2026-07-01T15:30:00.000Z', replaces_block_id: null, superseded_at: null, deleted_at: null },
      { id: REPLACED, task_id: TASK, status: 'committed', starts_at: '2026-07-01T09:00:00.000Z', ends_at: '2026-07-01T10:00:00.000Z', replaces_block_id: null, superseded_at: null, deleted_at: null },
    ];
    const { store, commands, effects } = captureStore();
    store.replicaRows = async (table) => (table === 'schedule_blocks' ? blocks : []);
    await createCommands(store, ctx, deps()).acceptSuggestion(BLOCK);

    expect(commands[0]).toMatchObject({ name: 'block.accept_suggestion', payload: { id: BLOCK } });
    const byRow = new Map(effects.map((e) => [e.row_id, e]));
    expect(byRow.get(BLOCK)).toMatchObject({ op: 'update', fields: { status: 'committed', suggestion_reason: null } });
    expect(byRow.get(REPLACED)).toMatchObject({ op: 'delete' });
    expect(byRow.get(SIBLING)).toMatchObject({ op: 'update', fields: { superseded_at: '2026-06-28T00:00:00.000Z' } });
  });

  it('setScore upserts by the carried row id (existing or freshly minted)', async () => {
    const { store, commands, effects } = captureStore();
    await createCommands(store, ctx, deps()).setScore({ existingId: SCORE, criterionId: CRITERION, projectId: PROJECT, score: 4 });
    expect(commands[0]).toMatchObject({ name: 'score.set', payload: { id: SCORE, criterion_id: CRITERION, project_id: PROJECT, score: 4 } });
    expect(effects[0]).toMatchObject({ table: 'decision_scores', row_id: SCORE, op: 'insert' });
  });
});
