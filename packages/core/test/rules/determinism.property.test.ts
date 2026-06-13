/**
 * S7 DoD: determinism property — two simulated devices that stored the same
 * rules in any order, and process the same trigger, emit byte-identical rows
 * (§2.7, §9.4). This is what makes UUIDv5 outputs converge without a server.
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { runAutomations } from '../../src/rules/engine';
import type { AutomationRule } from '../../src/domain/entities';
import { idOf, makeAutomationRule, makeNode } from '../helpers/fixtures';

/** Random rule: task_created/completed, optional title gate, 1-2 spawn slots. */
const ruleArb = (seq: number) =>
  fc
    .record({
      trigger: fc.constantFrom('task_completed' as const, 'task_created' as const),
      gate: fc.option(fc.constantFrom('alpha', 'beta', 'task'), { nil: null }),
      slots: fc.integer({ min: 1, max: 2 }),
      estimate: fc.option(fc.integer({ min: 5, max: 240 }), { nil: null }),
      withEdge: fc.boolean(),
    })
    .map(({ trigger, gate, slots, estimate, withEdge }): AutomationRule => {
      const actions = Array.from({ length: slots }, (_, i) => ({
        action: 'spawn_task' as const,
        slot: i,
        template: {
          title: `r${seq}s${i}`,
          ...(estimate !== null ? { estimate_minutes: estimate } : {}),
          ...(withEdge && i > 0 ? { edge_from_slot: 0 } : {}),
        },
      }));
      return makeAutomationRule({
        id: idOf(800 + seq),
        trigger,
        conditions:
          gate === null ? { all: [] } : { all: [{ fact: 'node.title', op: 'matches', value: gate }] },
        actions,
      });
    });

const rulesArb = fc.integer({ min: 0, max: 5 }).chain((n) =>
  fc.tuple(...Array.from({ length: n }, (_, i) => ruleArb(i))),
);

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe('two-device determinism (§9.4 DoD)', () => {
  it('shuffled rule order yields byte-identical engine output', () => {
    fc.assert(
      fc.property(
        rulesArb,
        fc.constantFrom('task_completed' as const, 'task_created' as const),
        fc.constantFrom('alpha', 'beta', 'task', 'gamma'),
        fc.integer({ min: 1, max: 0xffffffff }),
        (rules, triggerKind, title, seed) => {
          const triggerNode = makeNode({
            id: idOf(1),
            node_type: 'task',
            title,
            parent_id: idOf(99),
            created_at: '2026-06-10T09:00:00.000Z',
            completed_at:
              triggerKind === 'task_completed' ? '2026-06-12T14:00:00.000Z' : null,
          });
          const base = {
            trigger: { kind: triggerKind, node: triggerNode },
            rows: { nodes: [triggerNode] },
          };
          const device1 = runAutomations({ ...base, rules });
          const device2 = runAutomations({ ...base, rules: shuffle(rules, seed) });
          expect(JSON.stringify(device2)).toBe(JSON.stringify(device1));
        },
      ),
      { numRuns: 200 },
    );
  });
});
