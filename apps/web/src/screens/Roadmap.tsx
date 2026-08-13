/**
 * Roadmap screen (Plan › Roadmap) — where a roadmap is managed ONE AT A TIME,
 * and where its projects are laid out.
 *
 * The picker on the left is grouped by VISION (I1: a roadmap's only legal
 * parent) and painted in that vision's colour, so which vision you are working
 * inside is readable at a glance; `visionColorOf` falls back to a stable
 * id-derived colour for visions made before colours existed.
 *
 * The right-hand side is the selected roadmap itself: its name, what it is for,
 * which vision it belongs under (moving it re-tints everything below), and its
 * projects — as a top-to-bottom graph, deliberately one level deep, because a
 * roadmap's elements ARE projects (I1). The layout is derived, not stored:
 * unlike Projects › Graph there is no `layout.set_position` here, so nodes are
 * not draggable and there is nothing to persist. Milestone/task structure and
 * dependency editing stay in Projects › Graph.
 *
 * Visions themselves are managed one level up, in Plan › Vision; this screen
 * only points there, so there is exactly one place to create or correct one.
 *
 * The selected roadmap rides in `location.hash`, so a roadmap is linkable —
 * that is how Plan › Vision hands one over.
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

import { childrenOf, descendantsOf, initialSortOrder, sortOrderBetween, type Node, type TreeIndex } from '@prisms/core';
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
function nextSortOrder(tree: TreeIndex, parentId: string | null): string {
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

export function Roadmap({ ctx, onNavigate }: { ctx: CommandContext; onNavigate: (href: string) => void }) {
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

  // The URL names the roadmap being managed (Plan › Vision links straight here).
  const [selected, setSelected] = useState(() => window.location.hash.replace(/^#/, ''));
  const activeId = roadmaps.some((r) => r.id === selected) ? selected : (roadmaps[0]?.id ?? '');
  const active = activeId ? tree.byId.get(activeId) : undefined;

  function select(id: string) {
    setSelected(id);
    // replace, not push: switching roadmaps is not a browser-history step.
    if (window.location.hash !== `#${id}`) window.history.replaceState({}, '', `${window.location.pathname}#${id}`);
  }

  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(false);
  const [rmTitle, setRmTitle] = useState('');
  const [rmVision, setRmVision] = useState('');

  async function addRoadmap() {
    const t = rmTitle.trim();
    const visionId = rmVision || visions[0]?.id;
    if (!t || !visionId || busy) return;
    setBusy(true);
    try {
      const id = await commands.createRoadmap({ visionId, title: t, sortOrder: nextSortOrder(tree, visionId) });
      select(id);
      setRmTitle('');
      setForm(false);
    } finally {
      setBusy(false);
    }
  }

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
        <span
          className="px-swatch px-swatch--sm"
          style={{ background: solid(visionColorOf(tree.byId.get(rmVision || visions[0]?.id || ''))) }}
        />
        <select data-testid="rm-roadmap-vision" value={rmVision || visions[0]?.id || ''} onChange={(e) => setRmVision(e.target.value)}>
          {visions.map((v) => (
            <option key={v.id} value={v.id}>{v.title}</option>
          ))}
        </select>
      </label>
      <button
        className="px-btn px-btn--primary"
        data-testid="rm-create-roadmap"
        disabled={busy || rmTitle.trim() === ''}
        onClick={() => void addRoadmap()}
      >
        Create roadmap
      </button>
      {roadmaps.length > 0 && (
        <button className="px-btn" data-testid="rm-cancel-roadmap" onClick={() => setForm(false)}>Cancel</button>
      )}
    </div>
  );

  // Nothing to manage yet: send the user to the level that is missing rather
  // than dead-ending them here.
  if (roadmaps.length === 0) {
    if (!hydrated) return <Skeleton testId="roadmap-skeleton" rows={4} />;
    return (
      <section>
        <div className="px-page-head">
          <h1>Roadmap</h1>
        </div>
        <div className="px-rm-empty" data-testid="roadmap-empty">
          <p>
            {visions.length === 0
              ? 'A roadmap belongs to a vision, and there is no vision yet. Start one in Plan › Vision — every roadmap under it carries its colour.'
              : 'No roadmaps yet. A roadmap holds your projects; it takes the colour of the vision you put it under.'}
          </p>
          {visions.length === 0 ? (
            <button className="px-btn px-btn--primary" data-testid="rm-go-vision" onClick={() => onNavigate('/vision')}>
              <Ic name="eye" /> Go to Vision
            </button>
          ) : (
            roadmapForm
          )}
        </div>
      </section>
    );
  }

  /** Roadmaps under each vision, in vision order; orphans last under "No vision". */
  const groups = [
    ...visions.map((v) => ({ vision: v as Node | undefined, items: roadmaps.filter((r) => r.parent_id === v.id) })),
    { vision: undefined, items: roadmaps.filter((r) => !r.parent_id || !tree.byId.get(r.parent_id)) },
  ].filter((g) => g.items.length > 0);

  return (
    <section>
      <div className="px-page-head">
        <h1>Roadmap</h1>
        <span className="px-page-sub" data-testid="rm-count">
          {roadmaps.length} roadmap{roadmaps.length === 1 ? '' : 's'} across {visions.length} vision
          {visions.length === 1 ? '' : 's'}
        </span>
        <div className="px-head-actions">
          <button className="px-btn px-btn--primary" data-testid="rm-new-roadmap" onClick={() => setForm((f) => !f)}>
            <Ic name="plus" /> New roadmap
          </button>
        </div>
      </div>

      {form && roadmapForm}

      <div className="px-mgr">
        <div className="px-mgr-list" data-testid="rm-list">
          {groups.map((g) => {
            const color = visionColorOf(g.vision);
            const horizon = formatHorizon(readVisionHorizon(g.vision?.attributes));
            return (
              <div key={g.vision?.id ?? 'none'}>
                <div className="px-mgr-group" title={g.vision?.description || undefined}>
                  <span className="px-swatch px-swatch--sm" style={{ background: solid(color) }} />
                  {g.vision ? g.vision.title : 'No vision'}
                  {horizon && ` · ${horizon}`}
                </div>
                {g.items.map((r) => (
                  <div
                    key={r.id}
                    className={`px-mgr-item${r.id === activeId ? ' px-mgr-item--on' : ''}`}
                    data-testid={`rm-item-${r.id}`}
                    data-color={color}
                    style={r.id === activeId ? { borderColor: solid(color), background: soft(color) } : undefined}
                  >
                    <button className="px-mgr-pick" onClick={() => select(r.id)} aria-current={r.id === activeId}>
                      <span className="px-mgr-item-main">
                        <span className="px-mgr-item-title">{r.title}</span>
                        <span className="px-mgr-item-sub">
                          {childrenOf(tree, r.id).filter((n) => n.node_type === 'project').length} project
                          {childrenOf(tree, r.id).filter((n) => n.node_type === 'project').length === 1 ? '' : 's'}
                        </span>
                      </span>
                    </button>
                  </div>
                ))}
              </div>
            );
          })}
        </div>

        {/* keyed by id: the draft fields re-arm from the node whenever the
            selection changes, instead of carrying the last roadmap's text over. */}
        {active && (
          <RoadmapDetail
            key={active.id}
            roadmap={active}
            tree={tree}
            visions={visions}
            commands={commands}
            onNavigate={onNavigate}
          />
        )}
      </div>
    </section>
  );
}

/** The selected roadmap: what it is, which vision owns it, and its projects. */
function RoadmapDetail({
  roadmap,
  tree,
  visions,
  commands,
  onNavigate,
}: {
  roadmap: Node;
  tree: TreeIndex;
  visions: readonly Node[];
  commands: ReturnType<typeof useCommands>;
  onNavigate: (href: string) => void;
}) {
  const vision = roadmap.parent_id ? tree.byId.get(roadmap.parent_id) : undefined;
  const color = visionColorOf(vision);
  const projects = useMemo(
    () => childrenOf(tree, roadmap.id).filter((n) => n.node_type === 'project'),
    [tree, roadmap.id],
  );

  const [title, setTitle] = useState(roadmap.title);
  const [description, setDescription] = useState(roadmap.description);
  const [newProject, setNewProject] = useState('');
  const [busy, setBusy] = useState(false);

  const [rfNodes, setRfNodes] = useNodesState<RFNode<RoadmapNodeData>>([]);
  const [rfEdges, setRfEdges] = useEdgesState<RFEdge>([]);

  // Re-derive the whole graph whenever the roadmap, its projects, or the colour change.
  useEffect(() => {
    const width = Math.max(1, projects.length) * (NODE_W + COL_GAP) - COL_GAP;
    setRfNodes([
      {
        id: roadmap.id,
        type: 'roadmap',
        draggable: false,
        position: { x: (width - NODE_W) / 2, y: 0 },
        data: {
          label: roadmap.title,
          kind: 'roadmap',
          childCount: projects.length,
          color,
          visionTitle: vision?.title ?? 'no vision',
          nodeId: roadmap.id,
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
        id: `${roadmap.id}->${p.id}`,
        source: roadmap.id,
        target: p.id,
        style: { stroke: solid(color) },
      })),
    );
  }, [roadmap, projects, tree, color, vision, setRfNodes, setRfEdges]);

  function commitTitle() {
    const t = title.trim();
    if (t === '' || t === roadmap.title) {
      setTitle(roadmap.title); // an empty name is not a rename — put the old one back
      return;
    }
    void commands.rename(roadmap.id, t);
  }

  function commitDescription() {
    if (description === roadmap.description) return;
    void commands.setDescription(roadmap.id, description);
  }

  /** Re-parent onto another vision — the whole subtree re-tints with it. */
  function moveToVision(visionId: string) {
    if (visionId === roadmap.parent_id) return;
    void commands.moveNode(roadmap.id, visionId, nextSortOrder(tree, visionId));
  }

  async function addProject() {
    const t = newProject.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      await commands.createProject({ roadmapId: roadmap.id, title: t, sortOrder: nextSortOrder(tree, roadmap.id) });
      setNewProject('');
    } finally {
      setBusy(false);
    }
  }

  function remove() {
    const tasks = descendantsOf(tree, roadmap.id).filter((n) => n.node_type === 'task').length;
    const owned = `${projects.length} project${projects.length === 1 ? '' : 's'}, ${tasks} task${tasks === 1 ? '' : 's'}`;
    if (!window.confirm(`Delete "${roadmap.title}"? Everything under it goes with it: ${owned}.`)) return;
    void commands.softDelete(roadmap.id);
  }

  return (
    <div className="px-mgr-detail" data-testid="rm-detail" data-roadmap={roadmap.id}>
      <div className="px-mgr-card" style={{ borderTopColor: solid(color), borderTopWidth: 3 }}>
        <div className="px-mgr-head">
          <span className="px-swatch px-swatch--sm" data-testid="rm-vision-swatch" data-color={color} style={{ background: solid(color) }} />
          <input
            className="px-mgr-title-input"
            data-testid="rm-title"
            aria-label="roadmap name"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setTitle(roadmap.title);
            }}
          />
          <button className="px-btn px-btn--sm px-btn--danger" data-testid="rm-delete" onClick={remove}>
            <Ic name="trash" /> Delete
          </button>
        </div>

        <div className="px-mgr-row">
          <label className="px-scope" style={{ borderColor: tint(color) }}>
            <Ic name="eye" />
            <select
              data-testid="rm-vision"
              aria-label="owning vision"
              value={roadmap.parent_id ?? ''}
              onChange={(e) => moveToVision(e.target.value)}
            >
              {/* an orphaned roadmap has to show SOMETHING selected until it is re-homed */}
              {!roadmap.parent_id && <option value="">No vision</option>}
              {visions.map((v) => (
                <option key={v.id} value={v.id}>{v.title}</option>
              ))}
            </select>
          </label>
          <button className="px-btn px-btn--sm" data-testid="rm-manage-vision" onClick={() => onNavigate('/vision')}>
            Manage visions
          </button>
        </div>

        <div className="px-vd-field" style={{ margin: '14px 0 0' }}>
          <label className="px-vd-lbl" htmlFor="rm-desc">What this roadmap is for</label>
          <textarea
            id="rm-desc"
            className="px-vd-input"
            data-testid="rm-description"
            placeholder="What does this roadmap deliver, and when is it done?"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={commitDescription}
          />
          <p className="px-vd-hint">Saved when you click away.</p>
        </div>
      </div>

      <div className="px-mgr-card">
        <div className="px-mgr-head" style={{ marginBottom: 10 }}>
          <b style={{ fontSize: 13 }} data-testid="rm-project-count">
            {projects.length} project{projects.length === 1 ? '' : 's'}
          </b>
          <div className="px-head-actions">
            <input
              className="px-input"
              data-testid="rm-new-project-title"
              placeholder="New project…"
              value={newProject}
              onChange={(e) => setNewProject(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void addProject();
              }}
            />
            <button
              className="px-btn px-btn--primary px-btn--sm"
              data-testid="rm-add-project"
              disabled={busy || newProject.trim() === ''}
              onClick={() => void addProject()}
            >
              <Ic name="plus" /> Add project
            </button>
          </div>
        </div>

        <div className="px-flow-canvas px-flow-canvas--tall" data-testid="roadmap-canvas">
          <ReactFlow nodes={rfNodes} edges={rfEdges} nodeTypes={nodeTypes} nodesDraggable={false} nodesConnectable={false} fitView>
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>

        {projects.length === 0 ? (
          <p className="px-muted" data-testid="rm-no-projects" style={{ marginTop: 12, fontSize: 12.5 }}>
            This roadmap has no projects yet — add one above and it appears under the roadmap.
          </p>
        ) : (
          <p className="px-muted" style={{ marginTop: 12, fontSize: 12.5 }}>
            Milestones, tasks and dependencies live in{' '}
            <button className="px-linklike" data-testid="rm-open-projects" onClick={() => onNavigate('/projects')}>
              Projects
            </button>
            .
          </p>
        )}
      </div>
    </div>
  );
}
