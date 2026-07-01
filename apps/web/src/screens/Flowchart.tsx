/**
 * Flowcharts (§12.1–12.2): a React Flow canvas of a diagram root's children
 * with their dependency edges. Pick a vision / roadmap / project root; nodes
 * are positioned by saved layout (a drag persists via layout.set_position) or
 * a layered fallback, with a dates / no-dates mode. Edges are created by the
 * add-dependency form or by dragging between handles — both run core
 * `validateEdge` locally first, so a cycle (E_CYCLE) or type mismatch is
 * rejected instantly with a toast (the server re-checks too). Visual groups and
 * per-node collapse persist via group.create / layout.set_collapsed.
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
  type Connection,
  type Edge as RFEdge,
  type Node as RFNode,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { validateEdge } from '@prisms/core';
import { Skeleton, useCommands, useFlowchart, useIsHydrated, useNodeTree, type CommandContext, type FlowNode } from '@prisms/ui';

interface PrismNodeData extends Record<string, unknown> {
  label: string;
  nodeType: string;
  collapsed: boolean;
  onToggle: () => void;
  nodeId: string;
}

function PrismNode({ data }: { data: PrismNodeData }) {
  return (
    <div className={`px-flow-node${data.collapsed ? ' px-flow-node--collapsed' : ''}`} data-testid={`flow-node-${data.nodeId}`}>
      <Handle type="target" position={Position.Top} />
      <div className="px-flow-node-title">{data.label}</div>
      <div className="px-flow-node-type">{data.nodeType}{data.collapsed ? ' · collapsed' : ''}</div>
      <button className="px-btn" data-testid={`collapse-${data.nodeId}`} onClick={data.onToggle}>{data.collapsed ? 'expand' : 'collapse'}</button>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const nodeTypes = { prism: PrismNode };

export function Flowchart({ ctx }: { ctx: CommandContext }) {
  const tree = useNodeTree();
  const commands = useCommands(ctx);

  const roots = useMemo(
    () =>
      [...tree.byId.values()]
        .filter((n) => n.node_type === 'vision' || n.node_type === 'roadmap' || n.node_type === 'project')
        .sort((a, b) => (a.title < b.title ? -1 : 1)),
    [tree],
  );
  const [rootId, setRootId] = useState<string>('');
  const [mode, setMode] = useState<'dates' | 'nodates'>('nodates');
  const activeRoot = rootId || roots[0]?.id || '';
  const hydrated = useIsHydrated();

  const view = useFlowchart(activeRoot || null, mode);

  const [pred, setPred] = useState('');
  const [succ, setSucc] = useState('');
  const [toast, setToast] = useState<string | null>(null);

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<RFNode<PrismNodeData>>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<RFEdge>([]);

  const titleById = useMemo(() => new Map(view.nodes.map((n) => [n.id, n.title])), [view.nodes]);

  function toggleCollapse(n: FlowNode) {
    void commands.setLayoutCollapsed({ existingId: n.layoutId, diagramId: activeRoot, nodeId: n.id, collapsed: !n.collapsed });
  }

  // sync React Flow nodes/edges from the reactive view
  useEffect(() => {
    setRfNodes(
      view.nodes.map((n) => ({
        id: n.id,
        type: 'prism',
        position: { x: n.x, y: n.y },
        data: { label: n.title, nodeType: n.nodeType, collapsed: n.collapsed, nodeId: n.id, onToggle: () => toggleCollapse(n) },
      })),
    );
  }, [view.nodes, setRfNodes]);

  useEffect(() => {
    setRfEdges(
      view.edges.map((e) => ({ id: e.id, source: e.predecessorId, target: e.successorId, label: e.edgeType, data: {} })),
    );
  }, [view.edges, setRfEdges]);

  function tryAddEdge(predecessorId: string, successorId: string) {
    if (predecessorId === '' || successorId === '') return;
    const res = validateEdge(view.tree, view.edgeIndex, { predecessor_id: predecessorId, successor_id: successorId });
    if (!res.ok) {
      setToast(res.error.code);
      return;
    }
    setToast(null);
    void commands.createEdge({ predecessorId, successorId });
  }

  return (
    <section>
      <h1>Flowchart</h1>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <select className="px-select" data-testid="diagram-root" value={activeRoot} onChange={(e) => setRootId(e.target.value)}>
          {roots.length === 0 && <option value="">{hydrated ? 'No diagrams yet' : 'Loading…'}</option>}
          {roots.map((r) => <option key={r.id} value={r.id}>{r.title} ({r.node_type})</option>)}
        </select>
        <button className="px-btn" data-testid="mode-toggle" onClick={() => setMode((m) => (m === 'dates' ? 'nodates' : 'dates'))}>
          {mode === 'dates' ? 'Dates' : 'No dates'}
        </button>
        <button className="px-btn" data-testid="new-group" onClick={() => void commands.createGroup({ diagramId: activeRoot, label: 'Group' })}>
          New group
        </button>
        <span className="px-muted" data-testid="group-count">{view.groups.length} group(s)</span>
      </div>

      {toast && (
        <div className="px-error" data-testid="flow-toast" onClick={() => setToast(null)}>
          Rejected: {toast} (click to dismiss)
        </div>
      )}

      <div className="px-flow-canvas" data-testid="flow-canvas">
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          onConnect={(c: Connection) => tryAddEdge(c.source ?? '', c.target ?? '')}
          onNodeDragStop={(_e, node) => {
            const fn = view.nodes.find((n) => n.id === node.id);
            void commands.setLayoutPosition({ existingId: fn?.layoutId, diagramId: activeRoot, nodeId: node.id, x: Math.round(node.position.x), y: Math.round(node.position.y), groupId: fn?.groupId ?? null });
          }}
          fitView
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
        <strong>Add dependency:</strong>
        <select className="px-select" data-testid="edge-pred" value={pred} onChange={(e) => setPred(e.target.value)}>
          <option value="">predecessor…</option>
          {view.nodes.map((n) => <option key={n.id} value={n.id}>{n.title}</option>)}
        </select>
        <span>→</span>
        <select className="px-select" data-testid="edge-succ" value={succ} onChange={(e) => setSucc(e.target.value)}>
          <option value="">successor…</option>
          {view.nodes.map((n) => <option key={n.id} value={n.id}>{n.title}</option>)}
        </select>
        <button className="px-btn px-btn--primary" data-testid="edge-add" onClick={() => tryAddEdge(pred, succ)}>Add</button>
      </div>

      <div data-testid="edge-list" style={{ marginTop: 12 }}>
        <h3>Dependencies ({view.edges.length})</h3>
        {view.edges.length === 0 &&
          (hydrated ? <p className="px-muted">None yet.</p> : <Skeleton testId="edge-skeleton" rows={2} />)}
        {view.edges.map((e) => (
          <div key={e.id} className="px-flow-edge-row" data-testid={`edge-row-${e.id}`}>
            <span>{titleById.get(e.predecessorId) ?? '?'} → {titleById.get(e.successorId) ?? '?'} <span className="px-muted">({e.edgeType})</span></span>
            <button className="px-btn px-btn--danger" data-testid={`edge-del-${e.id}`} onClick={() => void commands.deleteEdge(e.id)}>×</button>
          </div>
        ))}
      </div>
    </section>
  );
}
