/**
 * Plan › Roadmap › Flow, without a DOM: what lives in attributes, the
 * structured layout (a row per outcome, a column per step), the gaps between a
 * roadmap and its vision, the longest chain, and the free-flow layout.
 */
import { buildTreeIndex, type Node } from '@prisms/core';
import { describe, expect, it } from 'vitest';

import {
  buildFlow,
  F,
  freeLayout,
  NONE_LANE,
  reaches,
  readExtras,
  readOutcomes,
  S,
  spotIn,
  tidyPositions,
  withExtras,
  withOutcomes,
  type FlowOutcome,
} from '../src/roadmap-flow';
import { buildRoadmapModel } from '../src/roadmap-model';

import { roadmapFixture } from './util/roadmap-fixture';

const OUTCOMES: FlowOutcome[] = [
  { id: 'o-draft', name: 'Draft', statement: 'A full draft exists', measure: '' },
  { id: 'o-feedback', name: 'Feedback', statement: 'Readers have been through it', measure: '' },
  { id: 'o-cover', name: 'Cover', statement: 'A cover people pick up', measure: '' },
];

/** The novel roadmap, with Research + Draft delivering Draft, Beta + Final delivering Feedback. */
function setup(outcomes: readonly FlowOutcome[] = OUTCOMES, deliver = true) {
  const fx = roadmapFixture();
  const { ids } = fx;
  const assign = new Map<string, string>(
    deliver
      ? [
          [ids.p1.id, 'o-draft'],
          [ids.p2.id, 'o-draft'],
          [ids.p4.id, 'o-feedback'],
          [ids.p5.id, 'o-feedback'],
        ]
      : [],
  );
  const rows: Node[] = fx.rows.map((r) => (assign.has(r.id) ? { ...r, attributes: { outcome_id: assign.get(r.id)! } } : r));
  const tree = buildTreeIndex(rows);
  const model = buildRoadmapModel(tree, fx.edges, ids.r.id)!;
  return { ids, model, flow: buildFlow(model, outcomes) };
}

describe('what lives in attributes', () => {
  it('reads outcomes defensively and writes them back beside every other key', () => {
    const attrs = {
      color: 'blue',
      outcomes: [
        { id: 'a', name: 'A', statement: 'Is true', measure: 'Count', x: 40.4, y: 80 },
        { id: 'a', name: 'dup' }, // same id twice: the first wins
        { name: 'no id' },
        'junk',
        { id: 'b', name: 7, statement: null },
      ],
    };
    const read = readOutcomes(attrs);
    expect(read).toEqual([
      { id: 'a', name: 'A', statement: 'Is true', measure: 'Count', x: 40.4, y: 80 },
      { id: 'b', name: '', statement: '', measure: '' },
    ]);
    const written = withOutcomes(attrs, read);
    expect(written['color']).toBe('blue');
    expect(written['outcomes']).toEqual([
      { id: 'a', name: 'A', statement: 'Is true', measure: 'Count', x: 40, y: 80 },
      { id: 'b', name: '', statement: '', measure: '' },
    ]);
    expect(readOutcomes({})).toEqual([]);
    expect(readOutcomes(null)).toEqual([]);
  });

  it('reads and edits a project’s extras without touching anything else', () => {
    expect(readExtras({})).toEqual({ outcomeId: null, doneWhen: '', size: null });
    expect(readExtras({ outcome_id: 'o1', done_when: 'Shipped', size: 'L' })).toEqual({ outcomeId: 'o1', doneWhen: 'Shipped', size: 'L' });
    expect(readExtras({ size: 'XL' }).size).toBeNull();
    const a = withExtras({ keep: 1 }, { outcomeId: 'o1', size: 'S' });
    expect(a).toEqual({ keep: 1, outcome_id: 'o1', size: 'S' });
    expect(withExtras(a, { outcomeId: null, doneWhen: '' })).toEqual({ keep: 1, size: 'S' });
  });
});

describe('the structured layout', () => {
  it('makes a row per outcome, in order, then one for projects that deliver none', () => {
    const { flow } = setup();
    expect(flow.lanes.map((l) => l.id)).toEqual(['o-draft', 'o-feedback', 'o-cover', NONE_LANE]);
    const lane = (id: string) => flow.lanes.find((l) => l.id === id)!.members.map((c) => c.title);
    expect(lane('o-draft')).toEqual(['Research', 'Draft act two']);
    expect(lane('o-feedback')).toEqual(['Beta readers', 'Final draft']);
    expect(lane('o-cover')).toEqual([]);
    expect(lane(NONE_LANE)).toEqual(['Revise act one', 'Writing habit', 'Cover ideas']);
  });

  it('puts each project in the column of its step, worked out from the links', () => {
    const { flow, ids } = setup();
    const c = (id: string) => flow.byId.get(id)!;
    expect([c(ids.p1.id).step, c(ids.p2.id).step, c(ids.p4.id).step, c(ids.p5.id).step]).toEqual([1, 2, 3, 4]);
    expect(c(ids.p6.id).step).toBeNull(); // nothing links it: any time, first column
    expect(c(ids.p6.id).col).toBe(0);
    expect(c(ids.p2.id).x).toBe(S.X0 + S.PITCH);
    expect(flow.maxStep).toBe(4);
    // two projects in the same column of one row stack: both "any time" ones
    expect(c(ids.p6.id).row).toBe(0);
    expect(c(ids.p7.id).row).toBe(1);
    expect(c(ids.p7.id).y).toBe(c(ids.p6.id).y + S.ROW);
  });

  it('routes one path per link, and caps each outcome row', () => {
    const { flow } = setup();
    expect(flow.routed).toHaveLength(flow.links.length);
    for (const r of flow.routed) expect(r.d.startsWith('M ')).toBe(true);
    expect(flow.caps.map((c) => [c.outcome.id, c.count, c.done])).toEqual([
      ['o-draft', 2, 1],
      ['o-feedback', 2, 0],
      ['o-cover', 0, 0],
    ]);
    expect(flow.capX).toBeGreaterThan(Math.max(...flow.cards.map((c) => c.x + S.W)));
    expect(flow.thX).toBeGreaterThan(flow.capX);
  });

  it('lists the gaps between the roadmap and its vision', () => {
    const { flow } = setup();
    expect(flow.gaps.map((g) => g.text)).toEqual([
      '“A cover people pick up” has nothing delivering it',
      '“Revise act one” doesn’t deliver an outcome',
      '“Writing habit” doesn’t deliver an outcome',
      '“Cover ideas” doesn’t deliver an outcome',
    ]);
  });

  it('with no outcomes yet, shows one plain row and no gaps', () => {
    const { flow } = setup([], false);
    expect(flow.lanes.map((l) => l.id)).toEqual([NONE_LANE]);
    expect(flow.gaps).toEqual([]);
    expect(flow.caps).toEqual([]);
  });

  it('ignores an outcome a project names that no longer exists', () => {
    const { flow, ids } = setup(OUTCOMES.filter((o) => o.id !== 'o-feedback'));
    expect(flow.byId.get(ids.p4.id)!.outcomeId).toBeNull();
    expect(flow.byId.get(ids.p4.id)!.extras.outcomeId).toBe('o-feedback'); // still stored
  });

  it('knows who leads to an outcome, through the links', () => {
    const { flow, ids } = setup();
    expect(flow.byId.get(ids.p3.id)!.leads).toBe(true); // no outcome, but Beta readers waits on it
    expect(flow.byId.get(ids.p6.id)!.leads).toBe(false); // linked to nothing
  });

  it('marks the longest chain', () => {
    const { flow, ids } = setup();
    expect([...flow.onChain].sort()).toEqual([ids.p1.id, ids.p2.id, ids.p3.id, ids.p4.id, ids.p5.id].sort());
    expect(flow.chainLinks.has(`${ids.p4.id}>${ids.p5.id}`)).toBe(true);
  });
});

describe('free flow', () => {
  it('tidies like Structured: a band per outcome, an empty group where nothing delivers', () => {
    const { flow, ids } = setup();
    const t = tidyPositions(flow);
    expect(t.proj.get(ids.p1.id)).toEqual({ x: F.X0, y: F.VY + 34 });
    expect(t.proj.get(ids.p2.id)).toEqual({ x: F.X0 + F.COLP, y: F.VY + 34 });
    const beta = t.proj.get(ids.p4.id)!;
    expect(beta.y).toBeGreaterThan(t.proj.get(ids.p1.id)!.y);
    expect(t.empty.get('o-cover')!.y).toBeGreaterThan(beta.y);
    expect(t.proj.get(ids.p6.id)!.y).toBeGreaterThan(t.empty.get('o-cover')!.y); // the loose band comes last
  });

  it('uses saved spots, and fits unplaced cards round them', () => {
    const { flow, ids } = setup();
    expect(freeLayout(flow, new Map()).pristine).toBe(true);
    const tidy = tidyPositions(flow);
    // park Research where Draft act two would go
    const saved = new Map([[ids.p1.id, tidy.proj.get(ids.p2.id)!]]);
    const free = freeLayout(flow, saved);
    expect(free.pristine).toBe(false);
    expect(free.proj.get(ids.p1.id)).toEqual(tidy.proj.get(ids.p2.id));
    const draft = free.proj.get(ids.p2.id)!;
    expect(draft.x).toBe(tidy.proj.get(ids.p2.id)!.x);
    expect(draft.y).toBeGreaterThan(tidy.proj.get(ids.p2.id)!.y); // nudged down, clear of Research
  });

  it('finds a spot under a group’s cards for a card joining it', () => {
    const { flow, ids } = setup();
    const free = freeLayout(flow, new Map());
    const spot = spotIn(flow, free, 'o-draft', ids.p6.id);
    expect(spot.y).toBe(Math.max(free.proj.get(ids.p1.id)!.y, free.proj.get(ids.p2.id)!.y) + F.ROW);
    expect(spotIn(flow, free, 'o-cover', null)).toEqual(free.empty.get('o-cover'));
  });

  it('tells a loop before it is made', () => {
    const { flow, ids } = setup();
    expect(reaches(flow.links, ids.p1.id, ids.p5.id)).toBe(true);
    expect(reaches(flow.links, ids.p5.id, ids.p1.id)).toBe(false);
  });
});
