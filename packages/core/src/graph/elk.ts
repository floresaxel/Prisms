/**
 * ELK view-model builder (§5, §12.2) — pure. Produces the layout-graph JSON
 * that elkjs consumes; the actual `elk.layout()` is async/impure and runs in
 * the caller (the s14 layout.precompute job for big diagrams, the client for
 * small ones). Keeping the builder here means device and server feed ELK the
 * same graph.
 *
 * The output shape is ELK's own (`children` + `edges`), so callers pass it to
 * elkjs unchanged; only dependency edges whose BOTH endpoints are in the node
 * set are included.
 */
import type { Uuid } from '../domain/primitives';

export interface ElkLayoutNode {
  id: string;
  width: number;
  height: number;
  /** Filled by elk.layout(). */
  x?: number;
  y?: number;
}

export interface ElkLayoutEdge {
  id: string;
  sources: string[];
  targets: string[];
}

export interface ElkGraph {
  id: string;
  layoutOptions: Record<string, string>;
  children: ElkLayoutNode[];
  edges: ElkLayoutEdge[];
}

export interface DiagramEdge {
  id: Uuid;
  predecessor_id: Uuid;
  successor_id: Uuid;
}

export interface BuildElkGraphOptions {
  diagramId: Uuid;
  nodes: readonly { id: Uuid }[];
  edges: readonly DiagramEdge[];
  nodeWidth?: number;
  nodeHeight?: number;
  layoutOptions?: Record<string, string>;
}

/** Top-down layered layout with comfortable spacing — overridable. */
export const DEFAULT_ELK_LAYOUT_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.layered.spacing.nodeNodeBetweenLayers': '60',
  'elk.spacing.nodeNode': '40',
};

export function buildElkGraph(options: BuildElkGraphOptions): ElkGraph {
  const width = options.nodeWidth ?? 180;
  const height = options.nodeHeight ?? 80;
  const present = new Set(options.nodes.map((n) => n.id));

  // Stable order (by id) so identical inputs ⇒ identical ELK graph ⇒ identical layout.
  const children: ElkLayoutNode[] = [...options.nodes]
    .map((n) => n.id)
    .sort()
    .map((id) => ({ id, width, height }));

  const edges: ElkLayoutEdge[] = options.edges
    .filter((e) => present.has(e.predecessor_id) && present.has(e.successor_id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((e) => ({ id: e.id, sources: [e.predecessor_id], targets: [e.successor_id] }));

  return {
    id: options.diagramId,
    layoutOptions: options.layoutOptions ?? DEFAULT_ELK_LAYOUT_OPTIONS,
    children,
    edges,
  };
}
