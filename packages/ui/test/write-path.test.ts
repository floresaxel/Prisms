/**
 * R5 — the client write-path completion (§7.2d): the three skipped steps now run
 * inside `execute()` against MERGED (replica+overlay) state, so offline parity holds.
 *   - S7-F4 invariant pre-flight: an invalid command is rejected instantly (no envelope).
 *   - S7-F1 offline automation spawning: completing a rule-bearing task inserts the
 *     spawned node optimistically, with a deterministic UUIDv5 id + 'automation'
 *     provenance so the server's authoritative row reconciles it byte-identically.
 *   - S7-F7 soft-delete closure: deleting a subtree root hides the whole subtree.
 *   - S7-F5 depends_on: a command referencing a still-pending create depends on it.
 *
 * A fake `OverlayStore` captures the enqueued commands + effects and serves seeded
 * replica rows, so the pure write-path logic runs without a browser/SQLite.
 */
import { describe, expect, it } from 'vitest';

import { defaultCommandMeta, spawnedTaskId, type OverlayEffect, type OverlayRow } from '@prisms/core';

import { createCommands, type CommandContext } from '../src/powersync/commands';
import { CommandError } from '../src/powersync/execute';
import type { OverlayStore, PendingCommand } from '../src/powersync/overlay-store';

const MILE = '11111111-1111-7111-8111-111111111111';
const TASK = '22222222-2222-7222-8222-222222222222';
const PROJ = '33333333-3333-7333-8333-333333333333';
const ENTRY = '44444444-4444-7444-8444-444444444444';
const RULE = '55555555-5555-7555-8555-555555555555';
const SUCC = '66666666-6666-7666-8666-666666666666';
const VIS = '77777777-7777-7777-8777-777777777777';
const ROAD = '88888888-8888-7888-8888-888888888888';

/** A full, justification-valid ancestry vision→roadmap→project→milestone (I3). */
const chain = (): Row[] => [node(VIS, 'vision'), node(ROAD, 'roadmap', VIS), node(PROJ, 'project', ROAD), node(MILE, 'milestone', PROJ)];

type Row = Record<string, unknown>;
const node = (id: string, type: string, parent: string | null = null, extra: Row = {}): Row => ({
  id, user_id: 'u1', node_type: type, title: id, parent_id: parent, sort_order: 'a0', deleted_at: null, completed_at: null, ...extra,
});
const openEntry = (id: string, taskId: string): Row => ({
  id, user_id: 'u1', task_id: taskId, started_at: '2026-06-28T00:00:00.000Z', ended_at: null, deleted_at: null,
});
const spawnRule = (id: string): Row => ({
  id, user_id: 'u1', trigger: 'task_completed',
  conditions: JSON.stringify({ all: [] }), // vacuous → always fires
  actions: JSON.stringify([{ action: 'spawn_task', slot: 0, template: { title: 'Apply stain' } }]),
  enabled: 1, deleted_at: null,
});

function makeStore(seed: Record<string, Row[]> = {}) {
  const commands: PendingCommand[] = [];
  const effects: OverlayEffect[] = [];
  const store: OverlayStore = {
    async enqueue(command, cmdEffects, dependsOn = []) {
      const meta = defaultCommandMeta([...dependsOn]);
      commands.push({ ...command, command_version: meta.command_version, schema_version: meta.schema_version, client_version: null, depends_on: [...dependsOn] });
      effects.push(...cmdEffects);
    },
    async pendingCommands() { return commands; },
    async effectsFor(table) { return effects.filter((e) => e.table === table); },
    async replicaRows(table) { return (seed[table] ?? []) as OverlayRow[]; },
    async markApplied() {},
    async reconcileConfirmed() { return { cleared: [] }; },
    async rollbackRejected() {},
    async reviewItems() { return []; },
  };
  return { store, commands, effects };
}

const ctx: CommandContext = { userId: 'u1', deviceId: 'dev-1', now: () => '2026-06-28T00:00:00.000Z' };
const deps = () => {
  let n = 0;
  return { mintId: () => `cmd-${++n}`, nextHlc: () => `hlc-${++n}`, now: () => '2026-06-28T00:00:00.000Z' };
};

describe('R5 §7.2d write-path guards', () => {
  it('S7-F4: a second clock-in while a timer is open is rejected instantly — no envelope', async () => {
    const { store, commands, effects } = makeStore({ nodes: [node(TASK, 'task', MILE)], time_entries: [openEntry(ENTRY, TASK)] });
    const cmds = createCommands(store, ctx, deps());
    await expect(cmds.clockIn(TASK)).rejects.toBeInstanceOf(CommandError);
    await expect(cmds.clockIn(TASK)).rejects.toThrow(/already running/i);
    expect(commands).toHaveLength(0); // no command
    expect(effects).toHaveLength(0); // no overlay
  });

  it('S7-F4: clocking into a task with no open timer proceeds', async () => {
    const { store, commands } = makeStore({ nodes: [node(TASK, 'task', MILE)] });
    await createCommands(store, ctx, deps()).clockIn(TASK);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.name).toBe('timer.clock_in');
  });

  it('S7-F1: completing a rule-bearing task spawns the automation node optimistically (deterministic id + provenance)', async () => {
    const { store, effects } = makeStore({ nodes: [...chain(), node(TASK, 'task', MILE)], automation_rules: [spawnRule(RULE)] });
    await createCommands(store, ctx, deps()).checkOff(TASK);

    // the spawn id is UUIDv5(rule:trigger:slot) — the SAME id the server mints, so
    // the authoritative row reconciles this optimistic one byte-identically.
    const spawnId = spawnedTaskId(RULE, TASK, 0);
    const spawn = effects.find((e) => e.table === 'nodes' && e.op === 'insert' && e.row_id === spawnId);
    expect(spawn, 'the spawned node must be in the overlay').toBeDefined();
    expect(spawn!.fields['title']).toBe('Apply stain');
    expect(spawn!.fields['parent_id']).toBe(MILE); // same_as_trigger = the task's parent
    expect(spawn!.fields['source_kind']).toBe('automation'); // predicted provenance (§7.8)
    // it rides in the SAME command as the check-off (one enqueue txn).
    expect(spawn!.command_id).toBe(effects[0]!.command_id);
  });

  it('S7-F7: soft-deleting a subtree root hides the WHOLE subtree (I10 closure)', async () => {
    const { store, effects } = makeStore({ nodes: [node(PROJ, 'project'), node(MILE, 'milestone', PROJ), node(TASK, 'task', MILE)] });
    await createCommands(store, ctx, deps()).softDelete(PROJ);
    const deleted = effects.filter((e) => e.op === 'delete').map((e) => e.row_id).sort();
    expect(deleted).toEqual([MILE, PROJ, TASK].sort()); // root + descendants
  });

  it('S7-F5: a command referencing a still-pending create derives depends_on', async () => {
    const { store, commands } = makeStore({ nodes: [node(SUCC, 'task', MILE)] });
    const cmds = createCommands(store, ctx, deps());
    const visionId = await cmds.createVision('V'); // cmd-1: node.create, inserts the vision
    await cmds.createEdge({ predecessorId: visionId, successorId: SUCC }); // cmd-2: references the pending vision

    expect(commands).toHaveLength(2);
    expect(commands[1]!.name).toBe('edge.create');
    expect(commands[1]!.depends_on).toEqual([commands[0]!.id]); // depends on the pending create
  });
});
