/**
 * The Shape card's sunburst view, without a DOM: the slices are the icicle's
 * layout bent round (so the two views can never disagree on a branch's size),
 * the ring and path geometry, label fitting, and the remembered view choice.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildShape,
  DEFAULT_SHAPE_VIEW,
  findInShape,
  fitLabel,
  labelArcPath,
  layoutShape,
  layoutSunburst,
  readShapeView,
  ringRadii,
  sectorPath,
  SHAPE_METRICS,
  SHAPE_VIEW_KEY,
  writeShapeView,
} from '../src/vision-shape';

import { shapeFixture } from './util/shape-fixture';

const { tree, ids } = shapeFixture();
const shape = buildShape(tree, ids.v.id)!;
const TAU = Math.PI * 2;

describe('laying out the sunburst', () => {
  it('turns every icicle cell into a slice: width → share of the turn, row → ring', () => {
    for (const { value: metric } of SHAPE_METRICS) {
      const cells = layoutShape(shape, metric);
      const arcs = layoutSunburst(shape, metric);
      expect(arcs.map((a) => a.item)).toEqual(cells.map((c) => c.item));
      arcs.forEach((a, i) => {
        expect(a.ring).toBe(cells[i]!.row);
        expect(a.a0).toBeCloseTo(cells[i]!.x * TAU, 9);
        expect(a.a1 - a.a0).toBeCloseTo(cells[i]!.w * TAU, 9);
      });
    }
  });

  it('puts the focus in the centre (ring 0) as the whole turn, and its children round it', () => {
    const r1 = findInShape(shape, ids.r1.id)!;
    const arcs = layoutSunburst(r1, 'open');
    expect(arcs[0]).toMatchObject({ item: r1, a0: 0, ring: 0 });
    expect(arcs[0]!.a1).toBeCloseTo(TAU, 9);
    const ring1 = arcs.filter((a) => a.ring === 1);
    expect(ring1.map((a) => a.item.node.id)).toEqual([ids.p1.id, ids.p2.id]);
    expect(ring1.reduce((s, a) => s + (a.a1 - a.a0), 0)).toBeCloseTo(TAU, 9);
    // 3 of r1's 5 open tasks sit in p1
    expect(ring1[0]!.a1 - ring1[0]!.a0).toBeCloseTo((3 / 5) * TAU, 9);
  });
});

describe('ring geometry', () => {
  const box = { inner: 70, outer: 212, gap: 3, maxBand: 72 };

  it('shares the radius evenly between the rings, gaps included', () => {
    const r = ringRadii(3, box);
    expect(r).toHaveLength(3);
    expect(r[0]!.r0).toBe(70);
    expect(r[2]!.r1).toBeCloseTo(212, 9);
    expect(r[1]!.r0 - r[0]!.r1).toBeCloseTo(3, 9);
    expect(r[0]!.r1 - r[0]!.r0).toBeCloseTo(r[2]!.r1 - r[2]!.r0, 9);
  });

  it('caps a band, so one ring does not fill the whole chart', () => {
    const [only] = ringRadii(1, box);
    expect(only).toEqual({ r0: 70, r1: 142 });
    expect(ringRadii(0, box)).toEqual([]);
  });

  it('draws a slice as a closed annular sector, and nothing for a sliver', () => {
    const d = sectorPath(220, 220, 0, Math.PI / 2, 70, 140);
    expect(d).toMatch(/^M220\.00 80\.00A140\.00 140\.00 0 0 1 360\.00 220\.00L290\.00 220\.00A70\.00 70\.00 0 0 0 220\.00 150\.00Z$/);
    expect(sectorPath(220, 220, 1, 1.0001, 70, 140)).toBe('');
    expect(sectorPath(220, 220, 0, 0, 70, 140)).toBe('');
  });

  it('draws a whole turn a hair short, since an arc whose ends meet draws nothing', () => {
    const d = sectorPath(220, 220, 0, TAU, 70, 140);
    expect(d).not.toBe('');
    expect(d).toContain(' 0 1 1 '); // the large-arc flag
  });

  it('runs a label clockwise on top and backwards underneath, so it is never upside down', () => {
    expect(labelArcPath(220, 220, -0.5, 0.5, 100)).toContain(' 0 0 1 '); // sweep 1: clockwise
    expect(labelArcPath(220, 220, Math.PI - 0.5, Math.PI + 0.5, 100)).toContain(' 0 0 0 '); // sweep 0
  });

  it('fits a label to its slice, or drops it', () => {
    expect(fitLabel('Newsletter', 20)).toBe('Newsletter');
    expect(fitLabel('Finish the novel', 8)).toBe('Finish…');
    expect(fitLabel('Finish the novel', 4)).toBe('');
  });
});

describe('the remembered view', () => {
  afterEach(() => vi.unstubAllGlobals());

  const fakeStorage = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      map: m,
    };
  };

  it('opens on the icicle until the sunburst is chosen', () => {
    const s = fakeStorage();
    vi.stubGlobal('localStorage', s);
    expect(DEFAULT_SHAPE_VIEW).toBe('icicle');
    expect(readShapeView()).toBe('icicle');
    writeShapeView('sunburst');
    expect(s.map.get(SHAPE_VIEW_KEY)).toBe('sunburst');
    expect(readShapeView()).toBe('sunburst');
  });

  it('ignores a stored value it does not know', () => {
    const s = fakeStorage();
    s.setItem(SHAPE_VIEW_KEY, 'treemap');
    vi.stubGlobal('localStorage', s);
    expect(readShapeView()).toBe('icicle');
  });

  it('falls back to the icicle when there is no storage at all', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    expect(readShapeView()).toBe('icicle');
    expect(() => writeShapeView('sunburst')).not.toThrow();
  });
});
