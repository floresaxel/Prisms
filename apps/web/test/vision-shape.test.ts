/**
 * The Vision screen's Shape chart, without a DOM: how a vision's branch rolls
 * up, how the blocks are placed, and the words the card says about them.
 *
 * The load-bearing property is AGREEMENT: a project's "% done" here has to equal
 * the Dashboard's project completion (aggregates/completion), or the two screens
 * would tell the user different stories about the same project.
 */
import { canonicalCompletion } from '@prisms/core';
import { describe, expect, it } from 'vitest';

import {
  buildShape,
  cellStat,
  donePercent,
  donePercentLabel,
  findInShape,
  layoutShape,
  leadingBranch,
  roadmapOf,
  rowLabels,
  SHAPE_METRICS,
  shapeValue,
  shortMinutes,
  trailOf,
  type ShapeNode,
} from '../src/vision-shape';

import { shapeFixture } from './util/shape-fixture';

const { tree, ids } = shapeFixture();
const shape = buildShape(tree, ids.v.id)!;
const at = (id: string) => findInShape(shape, id)!;

describe('rolling a vision up', () => {
  it('counts every live task under it, open ones and their estimates', () => {
    expect(shape.tasks).toBe(9); // t1–t7, t9, t10; t8 is obsolete
    expect(shape.openTasks).toBe(6); // t2 t3 t4 t6 t7 t9
    expect(shape.openMinutes).toBe(360 + 360 + 120 + 30 + 60);
    expect(shape.openUnestimated).toBe(1); // t4
  });

  it('leaves an obsolete task out entirely, not even as done', () => {
    const p2 = at(ids.p2.id);
    expect(p2.children.map((c) => c.node.id)).toEqual([ids.m1.id, ids.t7.id]);
    expect(p2.tasks).toBe(3);
    expect(findInShape(shape, ids.t8.id)).toBeNull();
  });

  it("agrees with the Dashboard's project completion on every project", () => {
    for (const p of [ids.p1, ids.p2, ids.p3]) {
      expect(donePercent(at(p.id))).toBeCloseTo(canonicalCompletion(p.id, tree).percent, 10);
    }
  });

  it('weights "% done" by estimate, an unestimated task weighing 1', () => {
    // done: t1 180 + t5 60 + t10 1; total adds t2 360 t3 360 t4 1 t6 120 t7 30 t9 60
    expect(donePercent(shape)).toBeCloseTo((241 / 1172) * 100, 10);
  });

  it('is null for a vision that is not there', () => {
    expect(buildShape(tree, '00000000-0000-4000-8000-999999999999')).toBeNull();
  });

  it('has nothing to count under an empty vision', () => {
    const empty = buildShape(tree, ids.empty.id)!;
    expect(empty.tasks).toBe(0);
    expect(donePercent(empty)).toBe(0);
  });
});

describe('placing the blocks', () => {
  it('puts the focus across the whole width on the top row', () => {
    const [top] = layoutShape(shape, 'open');
    expect(top).toMatchObject({ x: 0, w: 1, row: 0 });
    expect(top!.item).toBe(shape);
  });

  it('splits a parent by the chosen measure', () => {
    const w = (metric: Parameters<typeof layoutShape>[1], id: string) =>
      layoutShape(shape, metric).find((c) => c.item.node.id === id)!.w;
    // open tasks: novel 5, audience 1, published 0
    expect(w('open', ids.r1.id)).toBeCloseTo(5 / 6, 10);
    expect(w('open', ids.r2.id)).toBeCloseTo(1 / 6, 10);
    // time left: novel 870m of 930m
    expect(w('time', ids.r1.id)).toBeCloseTo(870 / 930, 10);
    // all tasks: novel 7 of 9
    expect(w('all', ids.r1.id)).toBeCloseTo(7 / 9, 10);
  });

  it('keeps a branch worth nothing, at zero width, so a metric switch can animate it', () => {
    const r3 = layoutShape(shape, 'open').find((c) => c.item.node.id === ids.r3.id);
    expect(r3).toMatchObject({ w: 0, row: 1 });
  });

  it("tiles every parent exactly with its children, for every measure and focus", () => {
    const focuses: ShapeNode[] = [shape, at(ids.r1.id), at(ids.p2.id)];
    for (const { value: metric } of SHAPE_METRICS) {
      for (const focus of focuses) {
        const cells = layoutShape(focus, metric);
        const byId = new Map(cells.map((c) => [c.item.node.id, c]));
        for (const cell of cells) {
          const kids = cell.item.children.map((k) => byId.get(k.node.id)!);
          if (kids.length === 0 || shapeValue(cell.item, metric) === 0) continue;
          expect(kids[0]!.x).toBeCloseTo(cell.x, 10);
          expect(kids.reduce((s, k) => s + k.w, 0)).toBeCloseTo(cell.w, 10);
          for (const k of kids) expect(k.row).toBe(cell.row + 1);
        }
      }
    }
  });

  it('starts a zoomed-in focus on row 0', () => {
    const cells = layoutShape(at(ids.p2.id), 'all');
    const row = (id: string) => cells.find((c) => c.item.node.id === id)!.row;
    expect(row(ids.p2.id)).toBe(0);
    expect(row(ids.m1.id)).toBe(1);
    expect(row(ids.t7.id)).toBe(1);
    expect(row(ids.t6.id)).toBe(2);
    expect(cells.some((c) => c.item.node.id === ids.r2.id)).toBe(false);
  });
});

describe('naming the rows', () => {
  it('names a row for both types when milestones sit beside tasks', () => {
    expect(rowLabels(layoutShape(shape, 'open'))).toEqual([
      'Vision',
      'Roadmaps',
      'Projects',
      'Milestones · Tasks',
      'Tasks',
    ]);
  });

  it('calls the focus by its singular name', () => {
    expect(rowLabels(layoutShape(at(ids.p1.id), 'open'))).toEqual(['Project', 'Tasks']);
  });

  it('drops a row when nothing in it is visible', () => {
    // t6 is the milestone's only open task; flatten it and its row has nothing to show
    const cells = layoutShape(at(ids.m1.id), 'open').map((c) =>
      c.item.node.id === ids.t6.id ? { ...c, w: 0 } : c,
    );
    expect(rowLabels(cells)).toEqual(['Milestone']);
  });
});

describe('what the card says', () => {
  it('names the branch holding the most, with its share', () => {
    const lead = leadingBranch(shape, 'open')!;
    expect(lead.item.node.id).toBe(ids.r1.id);
    expect(lead.share).toBeCloseTo(5 / 6, 10);
  });

  it('has no lead when there is nothing of the measure left', () => {
    expect(leadingBranch(at(ids.t10.id), 'open')).toBeNull(); // a done task
    expect(leadingBranch(at(ids.r3.id), 'all')).toBeNull(); // an empty roadmap
  });

  it('walks from the vision down to a block', () => {
    expect(trailOf(at(ids.t6.id)).map((n) => n.node.title)).toEqual([
      'Become an author',
      'Finish the novel',
      'Revise act one',
      'Opening',
      'Rewrite opening',
    ]);
  });

  it('finds the roadmap a block sits under', () => {
    expect(roadmapOf(at(ids.t6.id))?.node.id).toBe(ids.r1.id);
    expect(roadmapOf(at(ids.r2.id))?.node.id).toBe(ids.r2.id);
    expect(roadmapOf(shape)).toBeNull();
  });

  it('writes a task line from its own state', () => {
    expect(cellStat(at(ids.t1.id), 'open')).toBe('done');
    expect(cellStat(at(ids.t2.id), 'open')).toBe('6h est.');
    expect(cellStat(at(ids.t4.id), 'time')).toBe('no estimate');
  });

  it('writes a branch line for the chosen measure', () => {
    const p1 = at(ids.p1.id); // done 180 of 181+720 weight → 20%
    expect(cellStat(p1, 'open')).toBe('20% done · 3 open');
    expect(cellStat(p1, 'time')).toBe('20% done · 12h left');
    expect(cellStat(p1, 'all')).toBe('20% done · 4 tasks');
    expect(cellStat(at(ids.p3.id), 'all')).toMatch(/· 2 tasks$/);
  });

  it('never says 100% while a task is still open', () => {
    // one unestimated task (weight 1) left open beside hours of finished work
    const p2 = at(ids.p2.id);
    const sliver = { ...p2, doneWeight: 999, totalWeight: 1000, openTasks: 1 };
    expect(donePercent(sliver)).toBeCloseTo(99.9, 10);
    expect(donePercentLabel(sliver)).toBe(99);
    expect(donePercentLabel({ ...sliver, openTasks: 0, doneWeight: 1000 })).toBe(100);
    expect(cellStat(sliver, 'open')).toBe('99% done · 1 open');
  });

  it('shortens minutes to fit a small block', () => {
    expect(shortMinutes(45)).toBe('45m');
    expect(shortMinutes(90)).toBe('1.5h');
    expect(shortMinutes(2040)).toBe('34h');
  });
});
