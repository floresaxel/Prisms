/**
 * Roadmap screen (Plan › Roadmap) — one roadmap at a time, read four ways.
 *
 * Across the top, every roadmap as a strip grouped by its VISION (I1: a
 * roadmap's only legal parent), each with its progress, and a quiet "+" at the
 * end of each vision's run that starts a new roadmap under that vision. The
 * strip leaves the whole width to the views below.
 *
 * Under it, the selected roadmap: its vision, name (renamed in place), what it
 * is for, and its totals, with a ⋯ menu to Edit… (name, description, which
 * vision owns it — moving it re-tints everything below), go to Plan › Vision,
 * or Delete. Then the views card (components/RoadmapViews): Order (default),
 * Mind map, Outline and List, all laid out for you inside the card, and a field
 * to add a project.
 *
 * The roadmap's projects, and how they depend on each other, come from
 * roadmap-model: dependency edges anywhere inside two projects roll up to
 * "this project waits on that one". Milestones, tasks and the dependencies
 * themselves are still edited in Projects.
 *
 * The selected roadmap rides in `location.hash`, so a roadmap is linkable —
 * that is how Plan › Vision hands one over.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { childrenOf, descendantsOf, initialSortOrder, sortOrderBetween, type Node, type TreeIndex } from '@prisms/core';
import {
  formatHorizon,
  Ic,
  Modal,
  readVisionHorizon,
  Skeleton,
  useCommands,
  useDependencyEdges,
  useIsHydrated,
  useNodeTree,
  visionColorOf,
  visionHex,
  type CommandContext,
  type VisionColor,
} from '@prisms/ui';

import { RoadmapViews } from '../components/RoadmapViews';
import { buildRoadmapModel } from '../roadmap-model';
import { shortMinutes } from '../vision-shape';

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const solid = (c: VisionColor) => visionHex(c);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Next sibling key for a fractional-index insert at the end of `parentId`. */
function nextSortOrder(tree: TreeIndex, parentId: string | null): string {
  const last = childrenOf(tree, parentId).at(-1)?.sort_order ?? null;
  return last === null ? initialSortOrder() : sortOrderBetween(last, null);
}

export function Roadmap({ ctx, onNavigate }: { ctx: CommandContext; onNavigate: (href: string) => void }) {
  const tree = useNodeTree();
  const edges = useDependencyEdges();
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
  /** Each roadmap's project count and % done, for the strip. */
  const totals = useMemo(
    () =>
      new Map(
        roadmaps.map((r) => {
          const m = buildRoadmapModel(tree, edges, r.id);
          return [r.id, { projects: m?.projects.length ?? 0, pct: m?.pct ?? 0 }] as const;
        }),
      ),
    [tree, edges, roadmaps],
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
  /** The vision a new roadmap is being made under; null = the form is closed. */
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [rmTitle, setRmTitle] = useState('');

  async function addRoadmap(visionId: string) {
    const t = rmTitle.trim();
    if (!t || !visionId || busy) return;
    setBusy(true);
    try {
      const id = await commands.createRoadmap({ visionId, title: t, sortOrder: nextSortOrder(tree, visionId) });
      select(id);
      setRmTitle('');
      setCreatingIn(null);
    } finally {
      setBusy(false);
    }
  }

  const formVision = creatingIn ?? visions[0]?.id ?? '';
  const roadmapForm = (
    <div className="px-rm-form" data-testid="rm-roadmap-form">
      <input
        className="px-input"
        data-testid="rm-new-roadmap-title"
        placeholder="Roadmap name…"
        autoFocus={creatingIn !== null}
        value={rmTitle}
        onChange={(e) => setRmTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void addRoadmap(formVision);
          if (e.key === 'Escape' && roadmaps.length > 0) setCreatingIn(null);
        }}
      />
      <label className="px-scope">
        <span className="px-swatch px-swatch--sm" style={{ background: solid(visionColorOf(tree.byId.get(formVision))) }} />
        <select data-testid="rm-roadmap-vision" value={formVision} onChange={(e) => setCreatingIn(e.target.value)}>
          {visions.map((v) => (
            <option key={v.id} value={v.id}>
              {v.title}
            </option>
          ))}
        </select>
      </label>
      <button
        className="px-btn px-btn--primary"
        data-testid="rm-create-roadmap"
        disabled={busy || rmTitle.trim() === ''}
        onClick={() => void addRoadmap(formVision)}
      >
        Create roadmap
      </button>
      {roadmaps.length > 0 && (
        <button className="px-btn" data-testid="rm-cancel-roadmap" onClick={() => setCreatingIn(null)}>
          Cancel
        </button>
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

  /** Every vision (an empty one still gets its "+"); orphaned roadmaps last. */
  const groups = [
    ...visions.map((v) => ({ vision: v as Node | undefined, items: roadmaps.filter((r) => r.parent_id === v.id) })),
    { vision: undefined, items: roadmaps.filter((r) => !r.parent_id || !tree.byId.get(r.parent_id)) },
  ].filter((g) => g.vision || g.items.length > 0);

  return (
    <section className="px-rm-screen">
      <div className="px-page-head">
        <h1>Roadmap</h1>
        <span className="px-page-sub" data-testid="rm-count">
          {plural(roadmaps.length, 'roadmap')} across {plural(visions.length, 'vision')}
        </span>
      </div>

      <div className="px-rm-strip" data-testid="rm-list">
        {groups.map((g) => {
          const color = visionColorOf(g.vision);
          const horizon = formatHorizon(readVisionHorizon(g.vision?.attributes));
          return (
            <div key={g.vision?.id ?? 'none'} className="px-rm-group" style={{ ['--px-rm-pc' as string]: solid(color) }}>
              <div className="px-rm-group-head" title={g.vision?.description || undefined}>
                <span className="px-swatch px-swatch--sm" style={{ background: solid(color) }} />
                {g.vision ? g.vision.title : 'No vision'}
                {horizon && <span className="px-rm-group-h"> · {horizon}</span>}
              </div>
              <div className="px-rm-group-row">
                {g.items.map((r) => {
                  const { projects, pct } = totals.get(r.id) ?? { projects: 0, pct: 0 };
                  return (
                    <button
                      key={r.id}
                      className={`px-rm-pick${r.id === activeId ? ' px-rm-pick--on' : ''}`}
                      data-testid={`rm-item-${r.id}`}
                      data-color={color}
                      aria-current={r.id === activeId}
                      onClick={() => select(r.id)}
                    >
                      <b>{r.title}</b>
                      <span>
                        {plural(projects, 'project')}
                        <span className="px-rm-pick-bar">
                          <i style={{ width: `${pct}%` }} />
                        </span>
                        {pct}%
                      </span>
                    </button>
                  );
                })}
                {g.vision && (
                  <button
                    className="px-rm-add"
                    data-testid={`rm-add-${g.vision.id}`}
                    aria-label={`New roadmap in ${g.vision.title}`}
                    title={`New roadmap in ${g.vision.title}`}
                    onClick={() => {
                      setRmTitle('');
                      setCreatingIn(creatingIn === g.vision!.id ? null : g.vision!.id);
                    }}
                  >
                    <Ic name="plus" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {creatingIn !== null && roadmapForm}

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
    </section>
  );
}

/** The selected roadmap: what it is, which vision owns it, and its projects four ways. */
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
  const edges = useDependencyEdges();
  const vision = roadmap.parent_id ? tree.byId.get(roadmap.parent_id) : undefined;
  const color = visionColorOf(vision);
  const model = useMemo(() => buildRoadmapModel(tree, edges, roadmap.id), [tree, edges, roadmap.id]);

  const [title, setTitle] = useState(roadmap.title);
  // A rename from the Edit dialog (or another device) lands here too, unless
  // the user is mid-rename in the field.
  const typing = useRef(false);
  useEffect(() => {
    if (!typing.current) setTitle(roadmap.title);
  }, [roadmap.title]);

  const [newProject, setNewProject] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);

  function commitTitle() {
    typing.current = false;
    const t = title.trim();
    if (t === '' || t === roadmap.title) {
      setTitle(roadmap.title); // an empty name is not a rename — put the old one back
      return;
    }
    void commands.rename(roadmap.id, t);
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
    const projects = model?.projects.length ?? 0;
    const tasks = descendantsOf(tree, roadmap.id).filter((n) => n.node_type === 'task').length;
    const owned = `${plural(projects, 'project')}, ${plural(tasks, 'task')}`;
    if (!window.confirm(`Delete "${roadmap.title}"? Everything under it goes with it: ${owned}.`)) return;
    void commands.softDelete(roadmap.id);
  }

  /** Write only what the Edit dialog changed, one command per field. */
  function save(values: { title: string; description: string; visionId: string }) {
    if (values.title !== roadmap.title) void commands.rename(roadmap.id, values.title);
    if (values.description !== roadmap.description) void commands.setDescription(roadmap.id, values.description);
    // Re-parent onto another vision: the whole subtree re-tints with it.
    if (values.visionId && values.visionId !== roadmap.parent_id) {
      void commands.moveNode(roadmap.id, values.visionId, nextSortOrder(tree, values.visionId));
    }
    setEditing(false);
  }

  if (!model) return null;
  const projects = model.projects.length;

  return (
    <div className="px-rm-detail" data-testid="rm-detail" data-roadmap={roadmap.id}>
      <div className="px-mgr-card px-rm-head" style={{ borderTopColor: solid(color), borderTopWidth: 3 }}>
        <div className="px-rm-head-main">
          <div className="px-rm-head-vision">
            <span className="px-swatch px-swatch--sm" data-testid="rm-vision-swatch" data-color={color} style={{ background: solid(color) }} />
            <span data-testid="rm-vision-name">{vision ? vision.title : 'No vision'}</span>
          </div>
          <input
            className="px-mgr-title-input px-rm-title"
            data-testid="rm-title"
            aria-label="roadmap name"
            value={title}
            onFocus={() => (typing.current = true)}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setTitle(roadmap.title);
            }}
          />
          {roadmap.description.trim() !== '' && (
            <p className="px-rm-desc" data-testid="rm-description">
              {roadmap.description}
            </p>
          )}
        </div>
        <div className="px-rm-head-side">
          <div className="px-mgr-stats" data-testid="rm-stats">
            <span className="px-mgr-stat">
              <b data-testid="rm-project-count">{projects}</b> project{projects === 1 ? '' : 's'}
            </span>
            <span className="px-mgr-stat">
              <b>{model.openTasks}</b> open tasks
            </span>
            <span className="px-mgr-stat">
              <b>{shortMinutes(model.openMinutes)}</b> left
            </span>
            <span className="px-mgr-stat">
              <b>{model.pct}%</b> done
            </span>
          </div>
          <RoadmapMenu
            roadmap={roadmap}
            onEdit={() => setEditing(true)}
            onVisions={() => onNavigate('/vision')}
            onDelete={remove}
          />
        </div>
      </div>

      <RoadmapViews
        model={model}
        color={solid(color)}
        onNavigate={onNavigate}
        toolbar={
          <span className="px-rm-addproj">
            <input
              className="px-input"
              data-testid="rm-new-project-title"
              placeholder="New project…"
              aria-label="new project name"
              value={newProject}
              onChange={(e) => setNewProject(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void addProject();
              }}
            />
            <button
              className="px-btn px-btn--sm px-rm-addproj-btn"
              data-testid="rm-add-project"
              aria-label="Add project"
              title="Add project"
              disabled={busy || newProject.trim() === ''}
              onClick={() => void addProject()}
            >
              <Ic name="plus" />
            </button>
          </span>
        }
      />

      <RoadmapDialog
        open={editing}
        roadmap={roadmap}
        visions={visions}
        onClose={() => setEditing(false)}
        onSave={save}
      />
    </div>
  );
}

/** The roadmap's ⋯ menu: edit it, go to its visions, delete it. */
function RoadmapMenu({
  roadmap,
  onEdit,
  onVisions,
  onDelete,
}: {
  roadmap: Node;
  onEdit: () => void;
  onVisions: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const btn = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as HTMLElement)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      btn.current?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const pick = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <div className="px-menu px-mgr-menu" ref={ref}>
      <button
        ref={btn}
        className="px-btn px-menu-btn"
        data-testid="rm-menu"
        aria-label={`Options for ${roadmap.title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Ic name="dots" />
      </button>
      {open && (
        <div className="px-menu-pop" role="menu">
          <button className="px-menu-item" role="menuitem" data-testid="rm-menu-edit" onClick={pick(onEdit)}>
            <Ic name="pen" /> Edit…
          </button>
          <button className="px-menu-item" role="menuitem" data-testid="rm-manage-vision" onClick={pick(onVisions)}>
            <Ic name="eye" /> Manage visions
          </button>
          <div className="px-menu-sep" />
          <button className="px-menu-item px-menu-item--danger" role="menuitem" data-testid="rm-delete" onClick={pick(onDelete)}>
            <Ic name="trash" /> Delete
          </button>
        </div>
      )}
    </div>
  );
}

/** Edit a roadmap: its name, what it is for, and which vision owns it. */
function RoadmapDialog({
  open,
  roadmap,
  visions,
  onClose,
  onSave,
}: {
  open: boolean;
  roadmap: Node;
  visions: readonly Node[];
  onClose: () => void;
  onSave: (values: { title: string; description: string; visionId: string }) => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [visionId, setVisionId] = useState('');
  // Re-arm on open only: the node takes a new identity on every sync tick.
  const ref = useRef(roadmap);
  ref.current = roadmap;
  const edited = useRef(new Set<'title' | 'description' | 'vision'>());
  useEffect(() => {
    if (!open) return;
    setTitle(ref.current.title);
    setDescription(ref.current.description);
    setVisionId(ref.current.parent_id ?? '');
    edited.current = new Set();
  }, [open]);
  // A field the user has not changed yet follows the stored roadmap while the
  // dialog is open: a just-written edit can read back stale for a moment as its
  // synced copy replaces the local one. A field the user has typed in is theirs.
  useEffect(() => {
    if (!open) return;
    if (!edited.current.has('title')) setTitle(roadmap.title);
    if (!edited.current.has('description')) setDescription(roadmap.description);
    if (!edited.current.has('vision')) setVisionId(roadmap.parent_id ?? '');
  }, [open, roadmap.title, roadmap.description, roadmap.parent_id]);
  const ok = title.trim() !== '';
  const color = visionColorOf(visions.find((v) => v.id === visionId));
  return (
    <Modal
      open={open}
      size="card"
      title="Edit roadmap"
      subtitle="Its name, what it is for, and the vision it belongs to. Moving it re-tints everything under it."
      onClose={onClose}
      actions={
        <>
          <button className="px-btn" data-testid="rm-dialog-cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            className="px-btn px-btn--primary"
            data-testid="rm-dialog-save"
            disabled={!ok}
            onClick={() => onSave({ title: title.trim(), description, visionId })}
          >
            Save changes
          </button>
        </>
      }
    >
      <div className="px-vd-field">
        <label className="px-vd-lbl" htmlFor="rm-d-title">
          Name
        </label>
        <input id="rm-d-title" className="px-vd-input" data-testid="rm-dialog-title" value={title} onChange={(e) => { edited.current.add('title'); setTitle(e.target.value); }} />
      </div>
      <div className="px-vd-field">
        <label className="px-vd-lbl" htmlFor="rm-d-desc">
          What this roadmap is for
        </label>
        <textarea
          id="rm-d-desc"
          className="px-vd-input"
          data-testid="rm-dialog-description"
          placeholder="What does this roadmap deliver, and when is it done?"
          value={description}
          onChange={(e) => {
            edited.current.add('description');
            setDescription(e.target.value);
          }}
        />
      </div>
      <div className="px-vd-field" style={{ marginBottom: 0 }}>
        <label className="px-vd-lbl" htmlFor="rm-d-vision">
          Vision
        </label>
        <label className="px-scope">
          <span className="px-swatch px-swatch--sm" style={{ background: solid(color) }} />
          <select
            id="rm-d-vision"
            data-testid="rm-dialog-vision"
            value={visionId}
            onChange={(e) => {
              edited.current.add('vision');
              setVisionId(e.target.value);
            }}
          >
            {/* an orphaned roadmap has to show SOMETHING selected until it is re-homed */}
            {!roadmap.parent_id && <option value="">No vision</option>}
            {visions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.title}
              </option>
            ))}
          </select>
        </label>
      </div>
    </Modal>
  );
}
