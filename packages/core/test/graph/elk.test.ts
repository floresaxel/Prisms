/** S14: the pure ELK view-model builder (§12.2). */
import { describe, expect, it } from 'vitest';

import { buildElkGraph, DEFAULT_ELK_LAYOUT_OPTIONS } from '../../src/graph/elk';
import { idOf } from '../helpers/fixtures';

describe('buildElkGraph', () => {
  it('produces ELK-shaped children + edges with default sizing/options', () => {
    const graph = buildElkGraph({
      diagramId: idOf(1),
      nodes: [{ id: idOf(10) }, { id: idOf(11) }],
      edges: [{ id: idOf(20), predecessor_id: idOf(10), successor_id: idOf(11) }],
    });
    expect(graph.id).toBe(idOf(1));
    expect(graph.layoutOptions).toEqual(DEFAULT_ELK_LAYOUT_OPTIONS);
    expect(graph.children).toEqual([
      { id: idOf(10), width: 180, height: 80 },
      { id: idOf(11), width: 180, height: 80 },
    ]);
    expect(graph.edges).toEqual([{ id: idOf(20), sources: [idOf(10)], targets: [idOf(11)] }]);
  });

  it('drops edges whose endpoints are not both in the node set', () => {
    const graph = buildElkGraph({
      diagramId: idOf(1),
      nodes: [{ id: idOf(10) }],
      edges: [
        { id: idOf(20), predecessor_id: idOf(10), successor_id: idOf(99) }, // 99 absent
        { id: idOf(21), predecessor_id: idOf(10), successor_id: idOf(10) }, // both present
      ],
    });
    expect(graph.edges.map((e) => e.id)).toEqual([idOf(21)]);
  });

  it('is deterministic (stable id order) and honors size/option overrides', () => {
    const opts = {
      diagramId: idOf(1),
      nodes: [{ id: idOf(12) }, { id: idOf(10) }, { id: idOf(11) }],
      edges: [],
      nodeWidth: 100,
      nodeHeight: 40,
      layoutOptions: { 'elk.algorithm': 'force' },
    };
    const a = buildElkGraph(opts);
    const b = buildElkGraph(opts);
    expect(a).toEqual(b);
    expect(a.children.map((c) => c.id)).toEqual([idOf(10), idOf(11), idOf(12)]);
    expect(a.children[0]).toMatchObject({ width: 100, height: 40 });
    expect(a.layoutOptions).toEqual({ 'elk.algorithm': 'force' });
  });
});
