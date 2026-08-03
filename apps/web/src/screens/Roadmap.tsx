/**
 * Roadmap tab — a roadmap and its PROJECTS as a top-to-bottom graph.
 *
 * A roadmap's elements are projects (I1: `project`'s only legal parent is a
 * roadmap), so this view is deliberately one level deep: the roadmap sits at the
 * top, its projects hang below it, and new projects are created from here. The
 * layout is derived, not stored — unlike the Graph tab there is no
 * `layout.set_position` here, so nodes are not draggable and nothing to persist.
 * Milestone/task structure and dependency editing stay in Projects › Graph.
 */
import { useEffect, useMemo, useState } from 'react';

import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge as RFEdge,
  type Node as RFNode,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { childrenOf, initialSortOrder, sortOrderBetween, type Node } from '@prisms/core';
import { Ic, Skeleton, useCommands, useIsHydrated, useNodeTree, type CommandContext } from '@prisms/ui';

/** Derived layout: the roadmap on one row, its projects on the next. */
const NODE_W = 190;
const COL_GAP = 34;
const ROW_Y = 190;

interface RoadmapNodeData extends Record<string, unknown> {
  label: string;
  kind: 'roadmap' | 'project';
  /** Live children of a project (milestones + tasks) — a rough size signal. */
  childCount: number;
  nodeId: string;
}

function RoadmapNode({ data }: { data: RoadmapNodeData }) {
  const isRoot = data.kind === 'roadmap';
  return (
    <div
      className={`px-flow-node px-flow-node--${data.kind}${isRoot ? ' px-flow-node--root' : ''}`}
      data-testid={`rm-node-${data.nodeId}`}
    >
      {!isRoot && <Handle type="target" position={Position.Top} />}
      <div className="px-flow-node-title">{data.label}</div>
      <div className="px-flow-node-type">
        {data.kind}
        {isRoot ? '' : ` · ${data.childCount} item${data.childCount === 1 ? '' : 's'}`}
      </div>
      {isRoot && <Handle type="source" position={Position.Bottom} />}
    </div>
  );
}

const nodeTypes = { roadmap: RoadmapNode };

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function Roadmap({ ctx }: { ctx: CommandContext }) {
  const tree = useNodeTree();
  const commands = useCommands(ctx);
  const hydrated = useIsHydrated();

  const roadmaps = useMemo(
    () =>
      [...tree.byId.values()]
        .filter((n) => n.node_type === 'roadmap')
        .sort((a, b) => cmp(a.sort_order, b.sort_order) || cmp(a.id, b.id)),
    [tree],
  );
  const visions = useMemo(() => [...tree.byId.values()].filter((n) => n.node_type === 'vision'), [tree]);

  const [selected, setSelected] = useState('');
  // Follow the tree when the chosen roadmap disappears (or none is chosen yet).
  const activeId = roadmaps.some((r) => r.id === selected) ? selected : (roadmaps[0]?.id ?? '');
  const active = activeId ? tree.byId.get(activeId) : undefined;

  const projects: Node[] = useMemo(
    () => (activeId ? childrenOf(tree, activeId).filter((n) => n.node_type === 'project') : []),
    [tree, activeId],
  );

  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const [rfNodes, setRfNodes] = useNodesState<RFNode<RoadmapNodeData>>([]);
  const [rfEdges, setRfEdges] = useEdgesState<RFEdge>([]);

  // Re-derive the whole graph whenever the roadmap or its projects change.
  useEffect(() => {
    if (!active) {
      setRfNodes([]);
      setRfEdges([]);
      return;
    }
    const width = Math.max(1, projects.length) * (NODE_W + COL_GAP) - COL_GAP;
    const nodes: RFNode<RoadmapNodeData>[] = [
      {
        id: active.id,
        type: 'roadmap',
        draggable: false,
        position: { x: (width - NODE_W) / 2, y: 0 },
        data: { label: active.title, kind: 'roadmap', childCount: projects.length, nodeId: active.id },
      },
      ...projects.map((p, i) => ({
        id: p.id,
        type: 'roadmap',
        draggable: false,
        position: { x: i * (NODE_W + COL_GAP), y: ROW_Y },
        data: {
          label: p.title,
          kind: 'project' as const,
          childCount: childrenOf(tree, p.id).length,
          nodeId: p.id,
        },
      })),
    ];
    setRfNodes(nodes);
    setRfEdges(projects.map((p) => ({ id: `${active.id}->${p.id}`, source: active.id, target: p.id })));
  }, [active, projects, tree, setRfNodes, setRfEdges]);

  async function addProject() {
    const t = title.trim();
    if (!t || !activeId || busy) return;
    setBusy(true);
    try {
      const last = childrenOf(tree, activeId).at(-1)?.sort_order ?? null;
      await commands.createProject({
        roadmapId: activeId,
        title: t,
        sortOrder: last === null ? initialSortOrder() : sortOrderBetween(last, null),
      });
      setTitle('');
    } finally {
      setBusy(false);
    }
  }

  async function addRoadmap() {
    const vision = visions[0];
    if (!vision || busy) return;
    setBusy(true);
    try {
      const last = childrenOf(tree, vision.id).at(-1)?.sort_order ?? null;
      const id = await commands.createRoadmap({
        visionId: vision.id,
        title: 'New roadmap',
        sortOrder: last === null ? initialSortOrder() : sortOrderBetween(last, null),
      });
      setSelected(id);
    } finally {
      setBusy(false);
    }
  }

  if (roadmaps.length === 0) {
    if (!hydrated) return <Skeleton testId="roadmap-skeleton" rows={4} />;
    return (
      <div className="px-rm-empty" data-testid="roadmap-empty">
        <p>
          {visions.length === 0
            ? 'A roadmap belongs to a vision, and there is no vision yet — create one under Habits & Skills first.'
            : 'No roadmaps yet. A roadmap holds your projects.'}
        </p>
        {visions.length > 0 && (
          <button className="px-btn px-btn--primary" data-testid="rm-new-roadmap" disabled={busy} onClick={() => void addRoadmap()}>
            <Ic name="plus" /> New roadmap
          </button>
        )}
      </div>
    );
  }

  return (
    <section>
      <div className="px-rm-bar">
        <label className="px-scope">
          <Ic name="route" />
          <select data-testid="roadmap-scope" value={activeId} onChange={(e) => setSelected(e.target.value)}>
            {roadmaps.map((r) => (
              <option key={r.id} value={r.id}>{r.title}</option>
            ))}
          </select>
        </label>
        <span className="px-muted" data-testid="rm-project-count">
          {projects.length} project{projects.length === 1 ? '' : 's'}
        </span>
        <div className="px-head-actions">
          <input
            className="px-input"
            data-testid="rm-new-project-title"
            placeholder="New project…"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addProject();
            }}
          />
          <button
            className="px-btn px-btn--primary"
            data-testid="rm-add-project"
            disabled={busy || title.trim() === ''}
            onClick={() => void addProject()}
          >
            <Ic name="plus" /> Add project
          </button>
        </div>
      </div>

      <div className="px-flow-canvas px-flow-canvas--tall" data-testid="roadmap-canvas">
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          fitView
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>

      {projects.length === 0 && (
        <p className="px-muted" data-testid="rm-no-projects" style={{ marginTop: 12 }}>
          This roadmap has no projects yet — add one above and it appears under the roadmap.
        </p>
      )}
    </section>
  );
}
