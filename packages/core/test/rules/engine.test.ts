/**
 * S7 DoD: the §1.2 lecture example produces exactly the pre-brief + 3h study
 * task with an FS edge; duplicate server runs produce byte-identical output;
 * depth-guard cuts cascades at MAX_DEPTH; replay is a no-op.
 */
import { describe, expect, it } from 'vitest';

import { findEdgeBetween } from '../../src/graph/dag';
import {
  MAX_DEPTH,
  runAutomations,
  spawnedTaskId,
  type RulesEngineInput,
} from '../../src/rules/engine';
import { buildEdgeIndex } from '../../src/graph/dag';
import type { AutomationRule, Node } from '../../src/domain/entities';
import { idOf, makeAutomationRule, makeNode } from '../helpers/fixtures';

// --- the §1.2 / §9.3 lecture rule ------------------------------------------
const LECTURE_RULE_ID = idOf(500);
const lectureRule: AutomationRule = makeAutomationRule({
  id: LECTURE_RULE_ID,
  trigger: 'task_completed',
  conditions: { all: [{ fact: 'node.title', op: 'matches', value: 'lecture' }] },
  actions: [
    {
      action: 'spawn_task',
      slot: 0,
      template: {
        title: 'Pre-brief: {trigger.title}',
        estimate_minutes: 30,
        parent: 'same_as_trigger',
        due: 'trigger.completed_at + P2D',
      },
    },
    {
      action: 'spawn_task',
      slot: 1,
      template: {
        title: 'Study & practice: {trigger.title}',
        estimate_minutes: 180,
        parent: 'same_as_trigger',
        edge_from_slot: 0,
        edge_type: 'FS',
      },
    },
  ],
});

const lectureTask = makeNode({
  id: idOf(1),
  node_type: 'task',
  parent_id: idOf(99),
  title: 'Lecture 4: Dynamics',
  completed_at: '2026-06-12T14:00:00.000Z',
});

function lectureInput(): RulesEngineInput {
  return {
    trigger: { kind: 'task_completed', node: lectureTask },
    rules: [lectureRule],
    rows: { nodes: [lectureTask] },
  };
}

describe('lecture example (§1.2 DoD)', () => {
  it('spawns exactly a 30-min pre-brief + 3h study task joined by an FS edge', () => {
    const out = runAutomations(lectureInput());

    expect(out.nodes).toHaveLength(2);
    expect(out.edges).toHaveLength(1);
    expect(out.firedRuleIds).toEqual([LECTURE_RULE_ID]);
    expect(out.depthLimited).toBe(false);

    const preBrief = out.nodes.find((n) => n.title.startsWith('Pre-brief'))!;
    const study = out.nodes.find((n) => n.title.startsWith('Study'))!;

    expect(preBrief.title).toBe('Pre-brief: Lecture 4: Dynamics');
    expect(preBrief.estimate_minutes).toBe(30);
    expect(preBrief.parent_id).toBe(idOf(99)); // same_as_trigger
    expect(preBrief.node_type).toBe('task');
    expect(preBrief.due_date).toBe('2026-06-14'); // completed 06-12 + P2D

    expect(study.title).toBe('Study & practice: Lecture 4: Dynamics');
    expect(study.estimate_minutes).toBe(180);
    expect(study.parent_id).toBe(idOf(99));

    // the FS edge runs pre-brief → study
    const edge = out.edges[0]!;
    expect(edge.predecessor_id).toBe(preBrief.id);
    expect(edge.successor_id).toBe(study.id);
    expect(edge.edge_type).toBe('FS');
    expect(edge.lag_minutes).toBe(0);
  });

  it('attributes each spawned node + edge with rule_id, slot, and both versions (§10.2, S3-F4)', () => {
    const out = runAutomations(lectureInput());
    const preBrief = out.nodes.find((n) => n.title.startsWith('Pre-brief'))!;
    const study = out.nodes.find((n) => n.title.startsWith('Study'))!;
    const edge = out.edges[0]!;

    // every spawned row has a provenance entry; none carries an undefined version
    // (the pre-R4 bug: template_version was read by the UI but never written).
    expect(out.provenance).toHaveLength(3); // 2 nodes + 1 edge
    for (const p of out.provenance) {
      expect(p.rule_id).toBe(LECTURE_RULE_ID);
      expect(p.rule_version).toBe(1); // makeAutomationRule default
      expect(p.template_version).toBe(1); // TEMPLATE_VERSION
    }
    expect(out.provenance.find((p) => p.id === preBrief.id)!.slot).toBe(0);
    expect(out.provenance.find((p) => p.id === study.id)!.slot).toBe(1);
    expect(out.provenance.find((p) => p.id === edge.id)!.slot).toBe(1);
  });

  it('uses §9.4 deterministic ids and reads timestamps from the trigger', () => {
    const out = runAutomations(lectureInput());
    expect(out.nodes[0]!.id).toBe(spawnedTaskId(LECTURE_RULE_ID, lectureTask.id, 0));
    expect(out.nodes[1]!.id).toBe(spawnedTaskId(LECTURE_RULE_ID, lectureTask.id, 1));
    // created_at copied from the trigger's completed_at (wall clock untouched)
    expect(out.nodes[0]!.created_at).toBe('2026-06-12T14:00:00.000Z');
  });

  it('does not fire when conditions fail (non-lecture task)', () => {
    const other = makeNode({
      id: idOf(1),
      node_type: 'task',
      title: 'Grocery run',
      completed_at: '2026-06-12T14:00:00.000Z',
    });
    const out = runAutomations({
      trigger: { kind: 'task_completed', node: other },
      rules: [lectureRule],
      rows: { nodes: [other] },
    });
    expect(out.nodes).toEqual([]);
    expect(out.firedRuleIds).toEqual([]);
  });
});

describe('determinism (§2.7 DoD: duplicate server runs, byte-for-byte)', () => {
  it('produces identical output regardless of rule input order', () => {
    const ruleA = makeAutomationRule({
      id: idOf(510),
      trigger: 'task_completed',
      conditions: { all: [] },
      actions: [{ action: 'spawn_task', slot: 0, template: { title: 'A1' } }],
    });
    const ruleB = makeAutomationRule({
      id: idOf(511),
      trigger: 'task_completed',
      conditions: { all: [] },
      actions: [{ action: 'spawn_task', slot: 0, template: { title: 'B1' } }],
    });
    const task = makeNode({
      id: idOf(1),
      node_type: 'task',
      completed_at: '2026-06-12T14:00:00.000Z',
    });

    // One run reads [A, B]; a duplicate/retry reads [B, A].
    const run1 = runAutomations({
      trigger: { kind: 'task_completed', node: task },
      rules: [ruleA, ruleB],
      rows: { nodes: [task] },
    });
    const run2 = runAutomations({
      trigger: { kind: 'task_completed', node: task },
      rules: [ruleB, ruleA],
      rows: { nodes: [task] },
    });
    expect(JSON.stringify(run2)).toBe(JSON.stringify(run1));
  });
});

describe('fixpoint cascade + depth guard (DoD)', () => {
  // a chain: completing "step-N" spawns "step-(N+1)" via distinct rules
  function chainRules(length: number): AutomationRule[] {
    return Array.from({ length }, (_, i) =>
      makeAutomationRule({
        id: idOf(600 + i),
        trigger: i === 0 ? 'task_completed' : 'task_created',
        conditions: { all: [{ fact: 'node.title', op: 'matches', value: `^step-${i}$` }] },
        actions: [{ action: 'spawn_task', slot: 0, template: { title: `step-${i + 1}` } }],
      }),
    );
  }

  it('spawned tasks trigger further rules to fixpoint', () => {
    const seed = makeNode({
      id: idOf(1),
      node_type: 'task',
      title: 'step-0',
      completed_at: '2026-06-12T14:00:00.000Z',
    });
    // 3 rules: step-0→1 (completed), 1→2, 2→3 (created). All within depth.
    const out = runAutomations({
      trigger: { kind: 'task_completed', node: seed },
      rules: chainRules(3),
      rows: { nodes: [seed] },
    });
    expect(out.nodes.map((n) => n.title)).toEqual(['step-1', 'step-2', 'step-3']);
    expect(out.depthLimited).toBe(false);
  });

  it('cuts the cascade at MAX_DEPTH and flags depthLimited', () => {
    const seed = makeNode({
      id: idOf(1),
      node_type: 'task',
      title: 'step-0',
      completed_at: '2026-06-12T14:00:00.000Z',
    });
    // more rules than depth allows ⇒ truncated
    const out = runAutomations({
      trigger: { kind: 'task_completed', node: seed },
      rules: chainRules(MAX_DEPTH + 3),
      rows: { nodes: [seed] },
    });
    expect(out.nodes).toHaveLength(MAX_DEPTH);
    expect(out.nodes.at(-1)!.title).toBe(`step-${MAX_DEPTH}`);
    expect(out.depthLimited).toBe(true);
  });
});

describe('replay = no-op (DoD)', () => {
  it('re-running with the spawned rows already present produces nothing new', () => {
    const first = runAutomations(lectureInput());

    // simulate the rows having been committed and synced back
    const withSpawned: Node[] = [lectureTask, ...first.nodes];
    const replay = runAutomations({
      trigger: { kind: 'task_completed', node: lectureTask },
      rules: [lectureRule],
      rows: { nodes: withSpawned, edges: first.edges },
    });

    expect(replay.nodes).toEqual([]);
    expect(replay.edges).toEqual([]);
  });

  it('a partially-synced replay fills only the missing rows', () => {
    const first = runAutomations(lectureInput());
    // only slot 0 made it to the server; slot 1 + the edge were lost
    const partial: Node[] = [lectureTask, first.nodes[0]!];
    const replay = runAutomations({
      trigger: { kind: 'task_completed', node: lectureTask },
      rules: [lectureRule],
      rows: { nodes: partial },
    });
    expect(replay.nodes).toHaveLength(1);
    expect(replay.nodes[0]!.id).toBe(first.nodes[1]!.id);
    expect(replay.edges).toHaveLength(1);
    // the refilled edge matches the original deterministically
    expect(replay.edges[0]!.id).toBe(first.edges[0]!.id);

    // and the union is now complete + consistent
    const index = buildEdgeIndex([...replay.edges]);
    expect(
      findEdgeBetween(index, first.nodes[0]!.id, first.nodes[1]!.id),
    ).toBeDefined();
  });
});
