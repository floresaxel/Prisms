/**
 * Roadmap tab — a roadmap and its PROJECTS as a top-to-bottom graph.
 *
 * A roadmap's elements are projects (I1: `project`'s only legal parent is a
 * roadmap), so this view is deliberately one level deep: the roadmap sits at the
 * top, its projects hang below it, and new projects are created from here. The
 * layout is derived, not stored — unlike the Graph tab there is no
 * `layout.set_position` here, so nodes are not draggable and nothing to persist.
 * Milestone/task structure and dependency editing stay in Projects › Graph.
 *
 * Everything here is grouped by VISION (I1: a roadmap's only legal parent). A
 * vision owns a colour, picked when it is created and stored in the node's
 * `attributes.color`; every roadmap under it — the picker's group, the sibling
 * chips, the graph's root node and its edges — is painted that one colour, so
 * which vision you are working inside is readable at a glance. `visionColorOf`
 * falls back to a stable id-derived colour for visions made before colours.
 *
 * The tab also creates the levels above it, because otherwise it is a dead end:
 * no vision ⇒ no roadmap ⇒ no project. A roadmap is a small inline form (name +
 * which vision); a vision is a full-screen dialog (NewVisionDialog) because it
 * asks for a description, a dateless timeline and a unique colour. I2 caps
 * visions at MAX_VISIONS.
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

import { childrenOf, initialSortOrder, MAX_VISIONS, sortOrderBetween, type Node } from '@prisms/core';
import {
  formatHorizon,
  Ic,
  readVisionHorizon,
  Skeleton,
  useCommands,
  useIsHydrated,
  useNodeTree,
  visionColorOf,
  visionHex,
  type CommandContext,
  type VisionColor,
} from '@prisms/ui';

import { NewVisionDialog, type NewVisionValues } from '../components/NewVisionDialog';

/** Derived layout: the roadmap on one row, its projects on the next. */
const NODE_W = 190;
const COL_GAP = 34;
const ROW_Y = 190;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The vision palette carries its own hex (a user-picked colour is content, not a
 * theme token), so the softer surfaces are mixed from it against the page rather
 * than looked up as `--px-*` tokens.
 */
const solid = (c: VisionColor) => visionHex(c);
const soft = (c: VisionColor) => `color-mix(in srgb, ${visionHex(c)} 12%, var(--px-surface))`;
const tint = (c: VisionColor) => `color-mix(in srgb, ${visionHex(c)} 38%, var(--px-surface))`;

/** Next sibling key for a fractional-index insert at the end of `parentId`. */
function nextSortOrder(tree: ReturnType<typeof useNodeTree>, parentId: string | null): string {
  const last = childrenOf(tree, parentId).at(-1)?.sort_order ?? null;
  return last === null ? initialSortOrder() : sortOrderBetween(last, null);
}

interface RoadmapNodeData extends Record<string, unknown> {
  label: string;
  kind: 'roadmap' | 'project';
  /** Live children of a project (milestones + tasks) — a rough size signal. */
  childCount: number;
  /** The owning vision's colour; the root node wears it. */
  color: VisionColor;
  visionTitle: string;
  nodeId: string;
}

function RoadmapNode({ data }: { data: RoadmapNodeData }) {
  const isRoot = data.kind === 'roadmap';
  return (
    <div
      className={`px-flow-node px-flow-node--${data.kind}${isRoot ? ' px-flow-node--root' : ''}`}
      data-testid={`rm-node-${data.nodeId}`}
      data-color={isRoot ? data.color : undefined}
      style={isRoot ? { borderColor: solid(data.color), background: soft(data.color) } : undefined}
    >
      {!isRoot && <Handle type="target" position={Position.Top} />}
      <div className="px-flow-node-title">{data.label}</div>
      <div className="px-flow-node-type">
        {isRoot ? data.visionTitle : `project · ${data.childCount} item${data.childCount === 1 ? '' : 's'}`}
      </div>
      {isRoot && <Handle type="source" position={Position.Bottom} />}
    </div>
  );
}

const nodeTypes = { roadmap: RoadmapNode };

export function Roadmap({ ctx }: { ctx: CommandContext }) {
  const tree = useNodeTree();
  const commands = useCommands(ctx);
  const hydrated = useIsHydrated();

  const visions = useMemo(
    () =>
      [...tree.byId.values()]
        .filter((n) => n.node_type === 'vision')
        .sort((a, b) => cmp(a.sort_order, b.sort_order) || cmp(a.id, b.id)),
    [tree],
  );
  const roadmaps = useMemo(
    () =>
      [...tree.byId.values()]
        .filter((n) => n.node_type === 'roadmap')
        .sort((a, b) => cmp(a.sort_order, b.sort_order) || cmp(a.id, b.id)),
    [tree],
  );

  const [selected, setSelected] = useState('');
  // Follow the tree when the chosen roadmap disappears (or none is chosen yet).
  const activeId = roadmaps.some((r) => r.id === selected) ? selected : (roadmaps[0]?.id ?? '');
  const active = activeId ? tree.byId.get(activeId) : undefined;
  const vision = active?.parent_id ? tree.byId.get(active.parent_id) : undefined;
  const color = visionColorOf(vision);
  /** The vision's dateless expected timeline ("6 months", "3 years", …). */
  const horizonLabel = formatHorizon(readVisionHorizon(vision?.attributes));
  /** The active vision's other roadmaps — the group that shares this colour. */
  const siblings = useMemo(
    () => (vision ? roadmaps.filter((r) => r.parent_id === vision.id) : []),
    [roadmaps, vision],
  );

  const projects: Node[] = useMemo(
    () => (activeId ? childrenOf(tree, activeId).filter((n) => n.node_type === 'project') : []),
    [tree, activeId],
  );

  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<'roadmap' | null>(null);
  const [visionOpen, setVisionOpen] = useState(false);
  const [rmTitle, setRmTitle] = useState('');
  const [rmVision, setRmVision] = useState('');

  const [rfNodes, setRfNodes] = useNodesState<RFNode<RoadmapNodeData>>([]);
  const [rfEdges, setRfEdges] = useEdgesState<RFEdge>([]);

  // Re-derive the whole graph whenever the roadmap, its projects, or the colour change.
  useEffect(() => {
    if (!active) {
      setRfNodes([]);
      setRfEdges([]);
      return;
    }
    const width = Math.max(1, projects.length) * (NODE_W + COL_GAP) - COL_GAP;
    setRfNodes([
      {
        id: active.id,
        type: 'roadmap',
        draggable: false,
        position: { x: (width - NODE_W) / 2, y: 0 },
        data: {
          label: active.title,
          kind: 'roadmap',
          childCount: projects.length,
          color,
          visionTitle: vision?.title ?? 'no vision',
          nodeId: active.id,
        },
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
          color,
          visionTitle: vision?.title ?? '',
          nodeId: p.id,
        },
      })),
    ]);
    setRfEdges(
      projects.map((p) => ({
        id: `${active.id}->${p.id}`,
        source: active.id,
        target: p.id,
        style: { stroke: solid(color) },
      })),
    );
  }, [active, projects, tree, color, vision, setRfNodes, setRfEdges]);

  async function addProject() {
    const t = title.trim();
    if (!t || !activeId || busy) return;
    setBusy(true);
    try {
      await commands.createProject({ roadmapId: activeId, title: t, sortOrder: nextSortOrder(tree, activeId) });
      setTitle('');
    } finally {
      setBusy(false);
    }
  }

  async function addRoadmap() {
    const t = rmTitle.trim();
    const visionId = rmVision || visions[0]?.id;
    if (!t || !visionId || busy) return;
    setBusy(true);
    try {
      const id = await commands.createRoadmap({ visionId, title: t, sortOrder: nextSortOrder(tree, visionId) });
      setSelected(id);
      setRmTitle('');
      setForm(null);
    } finally {
      setBusy(false);
    }
  }

  async function addVision(values: NewVisionValues) {
    if (busy || visions.length >= MAX_VISIONS) return;
    setBusy(true);
    try {
      const id = await commands.createVision(values.title, {
        color: values.color,
        horizon: values.horizon,
        description: values.description,
        sortOrder: nextSortOrder(tree, null),
      });
      setVisionOpen(false);
      setRmVision(id); // the new vision becomes the target for the next roadmap
      setForm('roadmap');
    } finally {
      setBusy(false);
    }
  }

  const visionDialog = (
    <NewVisionDialog
      open={visionOpen}
      busy={busy}
      existing={visions}
      onClose={() => setVisionOpen(false)}
      onCreate={(values) => void addVision(values)}
    />
  );

  const roadmapForm = (
    <div className="px-rm-form" data-testid="rm-roadmap-form">
      <input
        className="px-input"
        data-testid="rm-new-roadmap-title"
        placeholder="Roadmap name…"
        value={rmTitle}
        onChange={(e) => setRmTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void addRoadmap();
        }}
      />
      <label className="px-scope">
        <span className="px-swatch px-swatch--sm" style={{ background: solid(visionColorOf(tree.byId.get(rmVision || visions[0]?.id || ''))) }} />
        <select data-testid="rm-roadmap-vision" value={rmVision || visions[0]?.id || ''} onChange={(e) => setRmVision(e.target.value)}>
          {visions.map((v) => (
            <option key={v.id} value={v.id}>{v.title}</option>
          ))}
        </select>
      </label>
      <button className="px-btn px-btn--primary" data-testid="rm-create-roadmap" disabled={busy || rmTitle.trim() === ''} onClick={() => void addRoadmap()}>
        Create roadmap
      </button>
      {roadmaps.length > 0 && (
        <button className="px-btn" data-testid="rm-cancel-roadmap" onClick={() => setForm(null)}>Cancel</button>
      )}
    </div>
  );

  // Nothing to show yet: create the missing level instead of a dead end.
  if (roadmaps.length === 0) {
    if (!hydrated) return <Skeleton testId="roadmap-skeleton" rows={4} />;
    return (
      <>
        <div className="px-rm-empty" data-testid="roadmap-empty">
          <p>
            {visions.length === 0
              ? 'A roadmap belongs to a vision, and there is no vision yet. Start one — name it, say what it means, give it a timeline and a colour. Every roadmap under it will carry that colour.'
              : 'No roadmaps yet. A roadmap holds your projects; it takes the colour of the vision you put it under.'}
          </p>
          {visions.length === 0 ? (
            <button className="px-btn px-btn--primary" data-testid="rm-new-vision" onClick={() => setVisionOpen(true)}>
              <Ic name="plus" /> New vision
            </button>
          ) : (
            roadmapForm
          )}
        </div>
        {visionDialog}
      </>
    );
  }

  return (
    <section>
      <div className="px-rm-bar">
        <label className="px-scope" style={{ borderColor: tint(color) }}>
          <span className="px-swatch px-swatch--sm" data-testid="rm-vision-swatch" data-color={color} style={{ background: solid(color) }} />
          <select data-testid="roadmap-scope" value={activeId} onChange={(e) => setSelected(e.target.value)}>
            {visions.map((v) => {
              const owned = roadmaps.filter((r) => r.parent_id === v.id);
              return owned.length === 0 ? null : (
                <optgroup key={v.id} label={v.title}>
                  {owned.map((r) => (
                    <option key={r.id} value={r.id}>{r.title}</option>
                  ))}
                </optgroup>
              );
            })}
            {/* a roadmap whose vision is gone still has to be selectable */}
            {roadmaps.some((r) => !r.parent_id || !tree.byId.get(r.parent_id)) && (
              <optgroup label="No vision">
                {roadmaps
                  .filter((r) => !r.parent_id || !tree.byId.get(r.parent_id))
                  .map((r) => (
                    <option key={r.id} value={r.id}>{r.title}</option>
                  ))}
              </optgroup>
            )}
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

      {/* the group: every roadmap of the active vision, all in its one colour */}
      <div className="px-rm-group" data-testid="rm-vision-group">
        <span className="px-rm-group-lbl" title={vision?.description || undefined}>
          {vision ? vision.title : 'No vision'}
          {horizonLabel && ` · ${horizonLabel}`} · {siblings.length || 1} roadmap
          {(siblings.length || 1) === 1 ? '' : 's'}
        </span>
        {(siblings.length > 0 ? siblings : active ? [active] : []).map((r) => (
          <button
            key={r.id}
            className={`px-rm-chip${r.id === activeId ? ' px-rm-chip--on' : ''}`}
            data-testid={`rm-chip-${r.id}`}
            data-color={color}
            style={{ background: soft(color), borderColor: r.id === activeId ? solid(color) : tint(color), color: solid(color) }}
            onClick={() => setSelected(r.id)}
          >
            {r.title}
          </button>
        ))}
        <div className="px-head-actions">
          <button className="px-btn px-btn--sm" data-testid="rm-new-roadmap" onClick={() => setForm(form === 'roadmap' ? null : 'roadmap')}>
            <Ic name="plus" /> New roadmap
          </button>
          <button
            className="px-btn px-btn--sm"
            data-testid="rm-new-vision"
            disabled={visions.length >= MAX_VISIONS}
            title={visions.length >= MAX_VISIONS ? `At most ${MAX_VISIONS} visions (I2)` : undefined}
            onClick={() => setVisionOpen(true)}
          >
            <Ic name="plus" /> New vision
          </button>
        </div>
      </div>

      {form === 'roadmap' && roadmapForm}
      {visionDialog}

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
