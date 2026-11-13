/**
 * Plan › Roadmap's model, without a DOM: projects rolled up the Shape card's way,
 * "waits on" rolled up from dependency edges anywhere inside two projects, the
 * steps of work they make, and where the mind map puts everything.
 */
import { buildTreeIndex } from '@prisms/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildRoadmapModel,
  chainOf,
  DEFAULT_ROADMAP_VIEW,
  layoutMindMap,
  MAP,
  readRoadmapView,
  ROADMAP_VIEW_KEY,
  ROADMAP_VIEWS,
  twigsOf,
  writeRoadmapView,
} from '../src/roadmap-model';
import { buildShape, donePercentLabel } from '../src/vision-shape';

import { roadmapFixture } from './util/roadmap-fixture';

const fx = roadmapFixture();
const { ids } = fx;
const model = buildRoadmapModel(fx.tree, fx.edges, ids.r.id)!;
const at = (id: string) => model.byId.get(id)!;
const titles = (list: readonly string[]) => list.map((id) => at(id).node.title);

describe('rolling a roadmap up', () => {
  it('lists its projects in order, counted like the Shape card', () => {
    expect(model.projects.map((p) => p.node.title)).toEqual([
      'Research',
      'Draft act two',
      'Revise act one',
      'Beta readers',
      'Final draft',
      'Writing habit',
      'Cover ideas',
    ]);
    for (const p of model.projects) expect(p.pct).toBe(donePercentLabel(buildShape(fx.tree, p.node.id)!));
    expect(model.tasks).toBe(10); // t1–t10
    expect(model.openTasks).toBe(7);
    expect(model.openMinutes).toBe(180 + 30 + 60 + 60 + 120 + 30);
  });

  it('is null for a roadmap that is not in the tree', () => {
    expect(buildRoadmapModel(fx.tree, fx.edges, '00000000-0000-4000-8000-999999999999')).toBeNull();
  });
});

describe('who waits on whom', () => {
  it('rolls edges up from tasks, milestones and the projects themselves', () => {
    expect(titles(at(ids.p2.id).waitsOn)).toEqual(['Research']); // t1 → t2
    expect(titles(at(ids.p3.id).waitsOn)).toEqual(['Research']); // p1 → p3, project to project
    expect(titles(at(ids.p4.id).waitsOn)).toEqual(['Draft act two', 'Revise act one']); // t3 → t8, and t6 (in a milestone) → t8
    expect(titles(at(ids.p5.id).waitsOn)).toEqual(['Beta readers']); // p4 → t9
    expect(titles(at(ids.p1.id).unblocks)).toEqual(['Draft act two', 'Revise act one']);
  });

  it('ignores an edge inside one project, and one from another roadmap', () => {
    expect(at(ids.p2.id).waitsOn).not.toContain(ids.p2.id); // t3 → t4
    expect(at(ids.p6.id).waitsOn).toEqual([]); // q1 → t10 crosses roadmaps
  });

  it('is blocked only by what is still unfinished', () => {
    expect(at(ids.p2.id).blockedBy).toEqual([]); // Research is finished
    expect(titles(at(ids.p4.id).blockedBy)).toEqual(['Draft act two', 'Revise act one']);
    expect(titles(at(ids.p5.id).blockedBy)).toEqual(['Beta readers']);
  });

  it('gives each project a state', () => {
    expect(model.projects.map((p) => [p.node.title, p.state])).toEqual([
      ['Research', 'done'],
      ['Draft act two', 'progress'],
      ['Revise act one', 'progress'],
      ['Beta readers', 'blocked'],
      ['Final draft', 'blocked'],
      ['Writing habit', 'todo'],
      ['Cover ideas', 'todo'], // no tasks: not finished, and nothing to block
    ]);
  });
});

describe('the order of work', () => {
  it('puts linked projects in steps by their longest chain of prerequisites', () => {
    expect(model.steps.map((s) => s.map((p) => p.node.title))).toEqual([
      ['Research'],
      ['Draft act two', 'Revise act one'],
      ['Beta readers'],
      ['Final draft'],
    ]);
    expect(model.free.map((p) => p.node.title)).toEqual(['Writing habit', 'Cover ideas']);
  });

  it('traces a project’s whole chain, before and after', () => {
    expect(titles([...chainOf(model, ids.p4.id)]).sort()).toEqual(
      ['Beta readers', 'Draft act two', 'Final draft', 'Research', 'Revise act one'].sort(),
    );
    expect([...chainOf(model, ids.p6.id)]).toEqual([ids.p6.id]); // unlinked: just itself
    // Draft's chain does not pull in its sibling Revise
    expect(chainOf(model, ids.p2.id).has(ids.p3.id)).toBe(false);
  });

  it('survives a rolled-up cycle, cutting it where it closes', () => {
    // Writing habit's task waits on Cover ideas' new task, and Cover ideas on Writing habit
    const f = roadmapFixture();
    const c1 = f.node('task', 'Sketch', f.ids.p7);
    const tree = buildTreeIndex(f.rows);
    const m = buildRoadmapModel(tree, [...f.edges, f.edge(c1, f.ids.t10), f.edge(f.ids.t10, c1)], f.ids.r.id)!;
    const habit = m.byId.get(f.ids.p6.id)!;
    const cover = m.byId.get(f.ids.p7.id)!;
    expect(habit.waitsOn).toEqual([cover.node.id]);
    expect(cover.waitsOn).toEqual([habit.node.id]);
    expect([habit.step, cover.step].sort()).toEqual([0, 1]);
  });
});

describe('the mind map', () => {
  const flat = (p: (typeof model.projects)[number]) => twigsOf(p, { folded: false, showAll: false });

  it('lists a project’s twigs open first, and cuts a long list short', () => {
    const draft = at(ids.p2.id);
    expect(twigsOf(draft, { folded: false, showAll: false }).items.map((i) => i.node.title)).toEqual([
      'Write ch. 11',
      'Pick a title',
      'Outline', // done, last
    ]);
    expect(twigsOf(draft, { folded: true, showAll: false })).toEqual({ items: [], more: 0 });
    expect(twigsOf(draft, { folded: false, showAll: false, limit: 1 }).more).toBe(2);
    // one past the limit is shown whole rather than as "+1 more"
    expect(twigsOf(draft, { folded: false, showAll: false, limit: 2 }).more).toBe(0);
  });

  it('balances projects on both sides when wide', () => {
    const l = layoutMindMap(model.projects, flat, 1200, 0);
    expect(l.mode).toBe('balanced');
    // alternating, in roadmap order: the first on the right, the second on the left…
    const side = new Map(l.projects.map((p) => [p.id, p.side]));
    expect(model.projects.map((p) => side.get(p.node.id))).toEqual(['right', 'left', 'right', 'left', 'right', 'left', 'right']);
    expect(l.root.x).toBe(600);
    for (const p of l.projects) {
      if (p.side === 'right') expect(p.x).toBe(600 + MAP.ROOT_W / 2 + MAP.REACH);
      else expect(p.x + MAP.PROJ_W).toBe(600 - MAP.ROOT_W / 2 - MAP.REACH);
    }
  });

  it('puts every project on the right when medium, and goes top-down when narrow', () => {
    expect(layoutMindMap(model.projects, flat, 800, 0).projects.every((p) => p.side === 'right')).toBe(true);
    const col = layoutMindMap(model.projects, flat, 500, 0);
    expect(col.mode).toBe('column');
    const ys = col.projects.map((p) => p.y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys); // in order, downwards
  });

  it('keeps twigs from overlapping, and fills the height it is given', () => {
    const l = layoutMindMap(model.projects, flat, 1200, 900);
    expect(l.height).toBeGreaterThanOrEqual(900);
    for (const side of ['left', 'right'] as const) {
      const ys = l.twigs.filter((t) => t.side === side).map((t) => t.y).sort((a, b) => a - b);
      for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(MAP.TWIG_H - 0.001);
    }
    // every twig belongs to a placed project
    const placed = new Set(l.projects.map((p) => p.id));
    expect(l.twigs.every((t) => placed.has(t.projectId))).toBe(true);
  });
});

describe('the remembered view', () => {
  afterEach(() => vi.unstubAllGlobals());
  const store = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };

  it('opens on Order, in the order Order · Mind map · Outline · List', () => {
    vi.stubGlobal('localStorage', store());
    expect(DEFAULT_ROADMAP_VIEW).toBe('order');
    expect(ROADMAP_VIEWS.map((v) => v.label)).toEqual(['Order', 'Mind map', 'Outline', 'List']);
    expect(readRoadmapView()).toBe('order');
  });

  it('remembers a choice, ignores nonsense, and copes with no storage', () => {
    const s = store();
    vi.stubGlobal('localStorage', s);
    writeRoadmapView('map');
    expect(s.m.get(ROADMAP_VIEW_KEY)).toBe('map');
    expect(readRoadmapView()).toBe('map');
    s.m.set(ROADMAP_VIEW_KEY, 'board');
    expect(readRoadmapView()).toBe('order');
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    expect(readRoadmapView()).toBe('order');
    expect(() => writeRoadmapView('list')).not.toThrow();
  });
});
