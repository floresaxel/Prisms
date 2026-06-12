/**
 * S5 DoD: predicate AST evaluator — combinators with unknown propagation,
 * every op, fact resolvers, weather-absent ⇒ unknown ⇒ not-blocked, scope.
 */
import { describe, expect, it } from 'vitest';

import { buildFactContext, type FactContext } from '../../src/status/context';
import {
  evalPredicate,
  evaluateBlockerRules,
  inScope,
  predicateSchema,
} from '../../src/status/predicate';
import { taskStatus } from '../../src/status/status';
import { isoToEpochMillis } from '../../src/time/instant';
import type { Node } from '../../src/domain/entities';
import {
  idOf,
  makeBlockerRule,
  makeEdge,
  makeNode,
  makeWeatherFact,
} from '../helpers/fixtures';

const NOW = isoToEpochMillis('2026-06-12T16:00:00.000Z');
const TODAY = '2026-06-12';

/** vision → roadmap → project → milestone → task("Lecture 4: dynamics") */
function lectureWorld(extra: Parameters<typeof buildFactContext>[0] = { nodes: [] }) {
  const vision = makeNode({ id: idOf(1), node_type: 'vision' });
  const roadmap = makeNode({ id: idOf(2), node_type: 'roadmap', parent_id: vision.id });
  const project = makeNode({ id: idOf(3), node_type: 'project', parent_id: roadmap.id });
  const milestone = makeNode({ id: idOf(4), node_type: 'milestone', parent_id: project.id });
  const task = makeNode({
    id: idOf(5),
    node_type: 'task',
    parent_id: milestone.id,
    title: 'Lecture 4: dynamics',
    estimate_minutes: 90,
    due_date: '2026-06-20',
  });
  const ctx = buildFactContext({
    ...extra,
    nodes: [vision, roadmap, project, milestone, task, ...extra.nodes],
  });
  return { ctx, task, project };
}

const ev = (predicate: unknown, subject: Node, ctx: FactContext) =>
  evalPredicate(predicate, subject, ctx, NOW);

describe('combinators with tri-state logic (§9.2)', () => {
  const T = { fact: 'node.completed', op: 'eq', value: false }; // true here
  const F = { fact: 'node.completed', op: 'eq', value: true };
  const U = { fact: 'weather.precip_prob', op: 'gt', value: 0.5 }; // no fact rows

  it('truth tables', () => {
    const { ctx, task } = lectureWorld();
    expect(ev({ all: [T, T] }, task, ctx)).toBe('true');
    expect(ev({ all: [T, F] }, task, ctx)).toBe('false');
    expect(ev({ any: [F, T] }, task, ctx)).toBe('true');
    expect(ev({ any: [F, F] }, task, ctx)).toBe('false');
    expect(ev({ not: F }, task, ctx)).toBe('true');
    expect(ev({ not: T }, task, ctx)).toBe('false');
  });

  it('unknown propagates unless short-circuited', () => {
    const { ctx, task } = lectureWorld();
    expect(ev({ all: [T, U] }, task, ctx)).toBe('unknown');
    expect(ev({ all: [F, U] }, task, ctx)).toBe('false'); // false dominates
    expect(ev({ any: [T, U] }, task, ctx)).toBe('true'); // true dominates
    expect(ev({ any: [F, U] }, task, ctx)).toBe('unknown');
    expect(ev({ not: U }, task, ctx)).toBe('unknown');
  });

  it('malformed AST ⇒ unknown (fail-safe)', () => {
    const { ctx, task } = lectureWorld();
    expect(ev({ bogus: true }, task, ctx)).toBe('unknown');
    expect(ev({ fact: 'node.title', op: 'between', value: 1 }, task, ctx)).toBe('unknown');
    expect(ev(null, task, ctx)).toBe('unknown');
    expect(predicateSchema.safeParse({ all: [] }).success).toBe(false);
  });
});

describe('ops', () => {
  it('eq/ne/gt/gte/lt/lte on numbers and ISO strings', () => {
    const { ctx, task } = lectureWorld();
    expect(ev({ fact: 'node.estimate_minutes', op: 'eq', value: 90 }, task, ctx)).toBe('true');
    expect(ev({ fact: 'node.estimate_minutes', op: 'ne', value: 90 }, task, ctx)).toBe('false');
    expect(ev({ fact: 'node.estimate_minutes', op: 'gt', value: 60 }, task, ctx)).toBe('true');
    expect(ev({ fact: 'node.estimate_minutes', op: 'gte', value: 90 }, task, ctx)).toBe('true');
    expect(ev({ fact: 'node.estimate_minutes', op: 'lt', value: 90 }, task, ctx)).toBe('false');
    expect(ev({ fact: 'node.estimate_minutes', op: 'lte', value: 90 }, task, ctx)).toBe('true');
    expect(ev({ fact: 'node.due_date', op: 'gt', value: '2026-06-01' }, task, ctx)).toBe('true');
    // type mismatch ⇒ unknown
    expect(ev({ fact: 'node.estimate_minutes', op: 'gt', value: 'x' }, task, ctx)).toBe(
      'unknown',
    );
  });

  it('matches is a case-insensitive regex; invalid patterns are unknown', () => {
    const { ctx, task } = lectureWorld();
    expect(ev({ fact: 'node.title', op: 'matches', value: 'lecture' }, task, ctx)).toBe('true');
    expect(ev({ fact: 'node.title', op: 'matches', value: '^lecture \\d+' }, task, ctx)).toBe(
      'true',
    );
    expect(ev({ fact: 'node.title', op: 'matches', value: 'seminar' }, task, ctx)).toBe('false');
    expect(ev({ fact: 'node.title', op: 'matches', value: '([' }, task, ctx)).toBe('unknown');
  });

  it('inside/outside date windows (open-ended sides allowed)', () => {
    const { ctx, task } = lectureWorld();
    const window = { start: '2026-06-01', end: '2026-09-01' };
    expect(ev({ fact: 'date.window', op: 'inside', value: window }, task, ctx)).toBe('true');
    expect(ev({ fact: 'date.window', op: 'outside', value: window }, task, ctx)).toBe('false');
    expect(
      ev({ fact: 'date.window', op: 'outside', value: { end: '2026-06-11' } }, task, ctx),
    ).toBe('true');
    expect(ev({ fact: 'date.window', op: 'inside', value: 'junk' }, task, ctx)).toBe('unknown');
  });
});

describe('fact resolvers', () => {
  it('ancestor.type is existential; ne is its negation', () => {
    const { ctx, task } = lectureWorld();
    expect(ev({ fact: 'ancestor.type', op: 'eq', value: 'project' }, task, ctx)).toBe('true');
    expect(ev({ fact: 'ancestor.type', op: 'eq', value: 'activity' }, task, ctx)).toBe('false');
    expect(ev({ fact: 'ancestor.type', op: 'ne', value: 'activity' }, task, ctx)).toBe('true');
    expect(ev({ fact: 'ancestor.type', op: 'ne', value: 'vision' }, task, ctx)).toBe('false');
  });

  it('project.phase resolves the nearest ancestor project; none ⇒ unknown', () => {
    const { ctx, task } = lectureWorld();
    expect(ev({ fact: 'project.phase', op: 'eq', value: 'idle' }, task, ctx)).toBe('true');

    const orphan = makeNode({ id: idOf(50), node_type: 'activity' });
    const orphanCtx = buildFactContext({ nodes: [orphan] });
    expect(ev({ fact: 'project.phase', op: 'eq', value: 'idle' }, orphan, orphanCtx)).toBe(
      'unknown',
    );
  });

  it('graph.unfinished_predecessors counts incomplete predecessors', () => {
    const done = makeNode({
      id: idOf(20),
      node_type: 'task',
      completed_at: '2026-06-10T12:00:00.000Z',
    });
    const open = makeNode({ id: idOf(21), node_type: 'task' });
    const task = makeNode({ id: idOf(22), node_type: 'task' });
    const ctx = buildFactContext({
      nodes: [done, open, task],
      edges: [
        makeEdge({ id: idOf(30), predecessor_id: done.id, successor_id: task.id }),
        makeEdge({ id: idOf(31), predecessor_id: open.id, successor_id: task.id }),
      ],
    });
    expect(ev({ fact: 'graph.unfinished_predecessors', op: 'eq', value: 1 }, task, ctx)).toBe(
      'true',
    );
    expect(ev({ fact: 'graph.unfinished_predecessors', op: 'gt', value: 0 }, task, ctx)).toBe(
      'true',
    );
  });

  it('unknown fact paths ⇒ unknown (forward compatible)', () => {
    const { ctx, task } = lectureWorld();
    expect(ev({ fact: 'moon.phase', op: 'eq', value: 'full' }, task, ctx)).toBe('unknown');
  });
});

describe('weather facts (§9.2 graceful degradation)', () => {
  const rainRule = () =>
    makeBlockerRule({
      id: idOf(60),
      label: 'Blocked: rain forecast',
      predicate: { fact: 'weather.precip_prob', op: 'gt', value: 0.6 },
    });

  it('DoD: weather absent ⇒ unknown ⇒ NOT blocked, surfaced as unverified', () => {
    const task = makeNode({ id: idOf(5), node_type: 'task' });
    const ctx = buildFactContext({ nodes: [task], blocker_rules: [rainRule()] });
    expect(ev(rainRule().predicate, task, ctx)).toBe('unknown');

    const evaluation = evaluateBlockerRules(task, ctx, NOW);
    expect(evaluation.blocked).toBe(false);
    expect(evaluation.unverified.map((r) => r.label)).toEqual(['Blocked: rain forecast']);
    expect(taskStatus(task, ctx, NOW)).toBe('available');
  });

  it('present fact blocks above the threshold, not below', () => {
    const task = makeNode({ id: idOf(5), node_type: 'task' });
    const wet = buildFactContext({
      nodes: [task],
      blocker_rules: [rainRule()],
      external_facts: [
        makeWeatherFact({
          id: idOf(61),
          key: `merritt-island-fl/${TODAY}`, // matched by `<slug>/<date>` suffix
          payload: { precip_prob: 0.9, high_c: 31 },
        }),
      ],
    });
    expect(taskStatus(task, wet, NOW)).toBe('blocked');
    expect(evaluateBlockerRules(task, wet, NOW).blockedBy).toHaveLength(1);

    const dry = buildFactContext({
      nodes: [task],
      blocker_rules: [rainRule()],
      external_facts: [
        makeWeatherFact({ id: idOf(61), key: TODAY, payload: { precip_prob: 0.1 } }),
      ],
    });
    expect(taskStatus(task, dry, NOW)).toBe('available');
  });

  it('{block_date} keys resolve from interpolation context and are unknown without it', () => {
    const task = makeNode({ id: idOf(5), node_type: 'task' });
    const ctx = buildFactContext({
      nodes: [task],
      external_facts: [
        makeWeatherFact({ id: idOf(61), key: '2026-06-14', payload: { precip_prob: 0.8 } }),
      ],
    });
    const predicate = {
      fact: 'weather.precip_prob',
      key: '{block_date}',
      op: 'gt',
      value: 0.6,
    };
    expect(evalPredicate(predicate, task, ctx, NOW, { block_date: '2026-06-14' })).toBe('true');
    expect(evalPredicate(predicate, task, ctx, NOW)).toBe('unknown');
  });

  it('missing payload field ⇒ unknown', () => {
    const task = makeNode({ id: idOf(5), node_type: 'task' });
    const ctx = buildFactContext({
      nodes: [task],
      external_facts: [
        makeWeatherFact({ id: idOf(61), key: TODAY, payload: { high_c: 30 } }),
      ],
    });
    expect(ev({ fact: 'weather.precip_prob', op: 'gt', value: 0.5 }, task, ctx)).toBe('unknown');
  });
});

describe('blocker scope', () => {
  it('defaults to tasks; node_types and subtree_of filter; malformed scope matches nothing', () => {
    const { ctx, task, project } = lectureWorld();
    expect(inScope({}, task, ctx)).toBe(true);
    expect(inScope({}, project, ctx)).toBe(false);
    expect(inScope({ node_types: ['project'] }, project, ctx)).toBe(true);
    expect(inScope({ subtree_of: project.id }, task, ctx)).toBe(true);
    expect(inScope({ subtree_of: idOf(99) }, task, ctx)).toBe(false);
    expect(inScope({ junk: 1 }, task, ctx)).toBe(false);
  });

  it('the §9.2 composite example evaluates end to end', () => {
    const { ctx, task } = lectureWorld();
    const predicate = {
      all: [
        { fact: 'node.title', op: 'matches', value: 'lecture' },
        { fact: 'ancestor.type', op: 'eq', value: 'project' },
        {
          any: [
            { fact: 'project.phase', op: 'eq', value: 'planned' },
            { fact: 'graph.unfinished_predecessors', op: 'gt', value: 0 },
            {
              fact: 'date.window',
              op: 'outside',
              value: { start: '2026-06-01', end: '2026-09-01' },
            },
          ],
        },
      ],
    };
    // title+ancestor true; inner any: phase idle ⇒ false, 0 preds ⇒ false,
    // today inside window ⇒ outside false ⇒ any false ⇒ all false
    expect(ev(predicate, task, ctx)).toBe('false');
  });
});
