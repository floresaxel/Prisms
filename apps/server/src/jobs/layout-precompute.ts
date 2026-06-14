/**
 * layout.precompute (§11, enqueued when a diagram's node/edge set changes):
 * lay out a diagram's subtree with ELK (elkjs) and persist positions to
 * `diagram_layouts(computed_at)`. The pure graph view-model is built in core
 * (§12.2); only the async `elk.layout()` runs here. The server handles big
 * diagrams (> 60 nodes); the client lays out small ones with the same builder.
 */
import { randomUUID } from 'node:crypto';

import { buildElkGraph, buildTreeIndex, descendantsOf, type Node as CoreNode } from '@prisms/core';
import { diagram_layouts, edges, nodes } from '@prisms/db';
import { and, eq, isNull } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import ELK from 'elkjs';

import type { JobClock } from './clock';

export interface LayoutJob {
  userId: string;
  /** The node whose subtree the diagram shows (§6.0 diagram_layouts.diagram_id). */
  diagramId: string;
}

export interface LayoutResult {
  nodesLaidOut: number;
}

export async function runLayoutPrecompute(db: PostgresJsDatabase, job: LayoutJob, clock: JobClock): Promise<LayoutResult> {
  const nowIso = new Date(clock.now()).toISOString();

  const nodeRows = await db.select().from(nodes).where(and(eq(nodes.user_id, job.userId), isNull(nodes.deleted_at)));
  const tree = buildTreeIndex(nodeRows as CoreNode[]);
  const subtree = descendantsOf(tree, job.diagramId);
  if (subtree.length === 0) return { nodesLaidOut: 0 };

  const edgeRows = await db.select().from(edges).where(and(eq(edges.user_id, job.userId), isNull(edges.deleted_at)));
  const graph = buildElkGraph({
    diagramId: job.diagramId,
    nodes: subtree.map((n) => ({ id: n.id })),
    edges: edgeRows.map((e) => ({ id: e.id, predecessor_id: e.predecessor_id, successor_id: e.successor_id })),
  });

  const elk = new ELK();
  const laid = await elk.layout(graph);

  let nodesLaidOut = 0;
  for (const child of laid.children ?? []) {
    await db
      .insert(diagram_layouts)
      .values({
        id: randomUUID(),
        user_id: job.userId,
        diagram_id: job.diagramId,
        node_id: child.id,
        x: child.x ?? 0,
        y: child.y ?? 0,
        computed_at: nowIso,
        updated_at: nowIso,
      })
      .onConflictDoUpdate({
        target: [diagram_layouts.diagram_id, diagram_layouts.node_id],
        set: { x: child.x ?? 0, y: child.y ?? 0, computed_at: nowIso, updated_at: nowIso },
      });
    nodesLaidOut += 1;
  }
  return { nodesLaidOut };
}
