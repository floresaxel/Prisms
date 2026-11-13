/**
 * Vision screen (Plan › Vision) — where a vision is managed ONE AT A TIME.
 *
 * A vision is the root everything else hangs from (I1: a roadmap's only legal
 * parent), and it carries more identity than a title: a description, a dateless
 * horizon, and a colour every roadmap under it wears. Until now those could only
 * be set at creation, from a tab inside Projects; this screen is their home —
 * pick a vision on the left, see where its work sits on the right.
 *
 * Each vision in the list has a ⋯ menu: Edit… (the create dialog, opened on that
 * vision: name, description, timeline, colour), Move up / Move down, and Delete.
 * The name can also be renamed in place on the detail card. Every save writes
 * one command per CHANGED field, so an edit survives offline and reconciles like
 * any other (§7.2).
 *
 * Deleting a vision cascades (I10) to its roadmaps, projects and tasks, so the
 * confirm names what goes with it. I2 caps the workspace at MAX_VISIONS.
 *
 * Under its name and counts sits the Shape card (components/VisionShape): an
 * icicle (or sunburst) chart of where the work under the vision is, and how
 * much is done.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  childrenOf,
  descendantsOf,
  initialSortOrder,
  MAX_VISIONS,
  sortOrderBetween,
  type Node,
  type TreeIndex,
} from '@prisms/core';
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
import { VisionShape } from '../components/VisionShape';

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const solid = (c: VisionColor) => visionHex(c);
const soft = (c: VisionColor) => `color-mix(in srgb, ${visionHex(c)} 10%, var(--px-surface))`;

/** What a vision owns, for the list line, the stats and the delete warning. */
interface VisionCounts {
  roadmaps: Node[];
  projects: number;
  tasks: number;
}

function countsFor(tree: TreeIndex, visionId: string): VisionCounts {
  const roadmaps = childrenOf(tree, visionId).filter((n) => n.node_type === 'roadmap');
  const below = descendantsOf(tree, visionId);
  return {
    roadmaps: [...roadmaps],
    projects: below.filter((n) => n.node_type === 'project').length,
    tasks: below.filter((n) => n.node_type === 'task').length,
  };
}

export function Vision({ ctx, onNavigate }: { ctx: CommandContext; onNavigate: (href: string) => void }) {
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

  const [selected, setSelected] = useState('');
  // Follow the tree when the chosen vision is deleted (or none is chosen yet).
  const activeId = visions.some((v) => v.id === selected) ? selected : (visions[0]?.id ?? '');
  const active = activeId ? tree.byId.get(activeId) : undefined;

  const [busy, setBusy] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  /** The vision open in the edit dialog; '' when it is closed (or creating). */
  const [editingId, setEditingId] = useState('');
  /** The vision whose ⋯ menu is open (kept here, so a row re-mount does not close it). */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const editing = editingId ? tree.byId.get(editingId) : undefined;

  async function addVision(values: NewVisionValues) {
    if (busy || visions.length >= MAX_VISIONS) return;
    setBusy(true);
    try {
      const last = visions.at(-1)?.sort_order ?? null;
      const id = await commands.createVision(values.title, {
        color: values.color,
        horizon: values.horizon,
        description: values.description,
        sortOrder: last === null ? initialSortOrder() : sortOrderBetween(last, null),
      });
      setSelected(id); // land on the vision that was just made
      setDialogOpen(false);
    } finally {
      setBusy(false);
    }
  }

  /** Move a vision one place in the picker order (fractional re-key, §7.10a). */
  async function reorder(index: number, delta: -1 | 1) {
    const target = visions[index];
    const swap = visions[index + delta];
    if (!target || !swap || busy) return;
    const outer = visions[index + delta * 2]?.sort_order ?? null;
    setBusy(true);
    try {
      await commands.reorderNode(
        target.id,
        delta === -1 ? sortOrderBetween(outer, swap.sort_order) : sortOrderBetween(swap.sort_order, outer),
      );
    } finally {
      setBusy(false);
    }
  }

  /** Write only what the edit dialog changed, one command per field. */
  function saveVision(v: Node, values: NewVisionValues) {
    if (values.title !== v.title) void commands.rename(v.id, values.title);
    if (values.description !== v.description) void commands.setDescription(v.id, values.description);
    const h = readVisionHorizon(v.attributes);
    const recolour = values.color !== visionColorOf(v);
    const retime = h?.unit !== values.horizon.unit || h?.amount !== values.horizon.amount;
    // Attributes are replaced whole (the verb's contract), so patch onto the current bag.
    if (recolour || retime) {
      void commands.setNodeAttributes(v.id, {
        ...v.attributes,
        color: values.color,
        horizon: { unit: values.horizon.unit, amount: values.horizon.amount },
      });
    }
    setEditingId('');
  }

  function removeVision(v: Node) {
    const counts = countsFor(tree, v.id);
    const owned = [
      `${counts.roadmaps.length} roadmap${counts.roadmaps.length === 1 ? '' : 's'}`,
      `${counts.projects} project${counts.projects === 1 ? '' : 's'}`,
      `${counts.tasks} task${counts.tasks === 1 ? '' : 's'}`,
    ].join(', ');
    if (!window.confirm(`Delete "${v.title}"? Everything under it goes with it: ${owned}.`)) return;
    void commands.softDelete(v.id);
  }

  const dialog = (
    <>
      <NewVisionDialog
        open={dialogOpen}
        busy={busy}
        existing={visions}
        onClose={() => setDialogOpen(false)}
        onCreate={(values) => void addVision(values)}
      />
      <NewVisionDialog
        open={editing !== undefined}
        existing={visions}
        editing={editing ?? null}
        onClose={() => setEditingId('')}
        onCreate={(values) => editing && saveVision(editing, values)}
      />
    </>
  );

  const newVisionBtn = (
    <button
      className="px-btn px-btn--primary"
      data-testid="vis-new"
      disabled={busy || visions.length >= MAX_VISIONS}
      title={visions.length >= MAX_VISIONS ? `At most ${MAX_VISIONS} visions (I2)` : undefined}
      onClick={() => setDialogOpen(true)}
    >
      <Ic name="plus" /> New vision
    </button>
  );

  if (visions.length === 0) {
    if (!hydrated) return <Skeleton testId="vision-skeleton" rows={4} />;
    return (
      <section>
        <div className="px-page-head">
          <h1>Vision</h1>
        </div>
        <div className="px-rm-empty" data-testid="vision-empty">
          <p>
            Nothing hangs from anything yet. A vision is the root — name it, say what it means, give it a rough timeline
            and a colour. Its roadmaps, and every project and task under them, carry that colour.
          </p>
          {newVisionBtn}
        </div>
        {dialog}
      </section>
    );
  }

  return (
    <section>
      <div className="px-page-head">
        <h1>Vision</h1>
        <span className="px-page-sub" data-testid="vis-count">
          {visions.length} of {MAX_VISIONS}
        </span>
        <div className="px-head-actions">{newVisionBtn}</div>
      </div>

      <div className="px-mgr">
        <div className="px-mgr-list" data-testid="vis-list">
          {visions.map((v, i) => {
            const color = visionColorOf(v);
            const counts = countsFor(tree, v.id);
            const horizon = formatHorizon(readVisionHorizon(v.attributes));
            return (
              <div
                key={v.id}
                className={`px-mgr-item${v.id === activeId ? ' px-mgr-item--on' : ''}`}
                data-testid={`vis-item-${v.id}`}
                data-color={color}
              >
                <button className="px-mgr-pick" onClick={() => setSelected(v.id)} aria-current={v.id === activeId}>
                  <span className="px-swatch px-swatch--sm" style={{ background: solid(color) }} />
                  <span className="px-mgr-item-main">
                    <span className="px-mgr-item-title">{v.title}</span>
                    <span className="px-mgr-item-sub">
                      {counts.roadmaps.length} roadmap{counts.roadmaps.length === 1 ? '' : 's'}
                      {horizon && ` · ${horizon}`}
                    </span>
                  </span>
                </button>
                <VisionMenu
                  vision={v}
                  open={menuFor === v.id}
                  onOpenChange={(o) => setMenuFor(o ? v.id : null)}
                  canUp={i > 0 && !busy}
                  canDown={i < visions.length - 1 && !busy}
                  onEdit={() => {
                    setSelected(v.id);
                    setEditingId(v.id);
                  }}
                  onUp={() => void reorder(i, -1)}
                  onDown={() => void reorder(i, 1)}
                  onDelete={() => removeVision(v)}
                />
              </div>
            );
          })}
        </div>

        {/* keyed by id: the draft fields re-arm from the node whenever the
            selection changes, instead of carrying the last vision's text over. */}
        {active && (
          <VisionDetail
            key={active.id}
            tree={tree}
            vision={active}
            counts={countsFor(tree, active.id)}
            commands={commands}
            onNavigate={onNavigate}
          />
        )}
      </div>

      {dialog}
    </section>
  );
}

/** The selected vision, editable field by field. Each edit is its own command. */
function VisionDetail({
  tree,
  vision,
  counts,
  commands,
  onNavigate,
}: {
  tree: TreeIndex;
  vision: Node;
  counts: VisionCounts;
  commands: ReturnType<typeof useCommands>;
  onNavigate: (href: string) => void;
}) {
  const color = visionColorOf(vision);
  const horizon = readVisionHorizon(vision.attributes);

  const [title, setTitle] = useState(vision.title);
  // The name can also change from the Edit dialog (or another device): adopt it,
  // unless the user is mid-rename here.
  const typing = useRef(false);
  useEffect(() => {
    if (!typing.current) setTitle(vision.title);
  }, [vision.title]);

  function commitTitle() {
    typing.current = false;
    const t = title.trim();
    if (t === '' || t === vision.title) {
      setTitle(vision.title); // an empty name is not a rename — put the old one back
      return;
    }
    void commands.rename(vision.id, t);
  }

  return (
    <div className="px-mgr-detail" data-testid="vis-detail" data-vision={vision.id}>
      <div className="px-mgr-card" style={{ borderTopColor: solid(color), borderTopWidth: 3 }}>
        <div className="px-mgr-head">
          <span className="px-swatch px-swatch--sm" data-testid="vis-swatch" data-color={color} style={{ background: solid(color) }} />
          <input
            className="px-mgr-title-input"
            data-testid="vis-title"
            aria-label="vision name"
            value={title}
            onFocus={() => (typing.current = true)}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setTitle(vision.title);
            }}
          />
        </div>

        {/* What it means, read-only here: it is edited from the vision's ⋯ menu. */}
        {vision.description.trim() !== '' && (
          <p className="px-mgr-desc" data-testid="vis-description">
            {vision.description}
          </p>
        )}

        <div className="px-mgr-stats" data-testid="vis-stats">
          <span className="px-mgr-stat">
            <b>{counts.roadmaps.length}</b> roadmaps
          </span>
          <span className="px-mgr-stat">
            <b>{counts.projects}</b> projects
          </span>
          <span className="px-mgr-stat">
            <b>{counts.tasks}</b> tasks
          </span>
          <span className="px-mgr-stat">
            <b>{formatHorizon(horizon) || '—'}</b> horizon
          </span>
        </div>
      </div>

      {/* Where the work under this vision sits. Read-only: edits stay on the
          screen that owns each level, which the detail line links to. */}
      <VisionShape tree={tree} visionId={vision.id} color={solid(color)} onNavigate={onNavigate} />

      <div className="px-mgr-card">
        <div className="px-mgr-head" style={{ marginBottom: 10 }}>
          <b style={{ fontSize: 13 }}>Roadmaps</b>
          <div className="px-head-actions">
            <button className="px-btn px-btn--sm" data-testid="vis-manage-roadmaps" onClick={() => onNavigate('/roadmap')}>
              <Ic name="route" /> Manage roadmaps
            </button>
          </div>
        </div>
        {counts.roadmaps.length === 0 ? (
          <p className="px-muted" data-testid="vis-no-roadmaps" style={{ margin: 0, fontSize: 12.5 }}>
            No roadmaps under this vision yet — a roadmap is what holds its projects.
          </p>
        ) : (
          <div className="px-mgr-chips">
            {counts.roadmaps.map((r) => (
              <button
                key={r.id}
                className="px-rm-chip"
                data-testid={`vis-roadmap-${r.id}`}
                style={{ background: soft(color), borderColor: solid(color), color: solid(color) }}
                onClick={() => onNavigate(`/roadmap#${r.id}`)}
              >
                {r.title}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A vision's ⋯ menu in the list: edit it, move it, delete it. Closes on an
 * outside click, on Escape (focus goes back to the button) and after any choice.
 *
 * Whether it is open is held by the SCREEN, not the row: a just-created vision's
 * row can re-mount when its synced copy replaces the local one, and a menu that
 * kept its own state closed under the user's pointer.
 */
function VisionMenu({
  vision,
  open,
  onOpenChange,
  canUp,
  canDown,
  onEdit,
  onUp,
  onDown,
  onDelete,
}: {
  vision: Node;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canUp: boolean;
  canDown: boolean;
  onEdit: () => void;
  onUp: () => void;
  onDown: () => void;
  onDelete: () => void;
}) {
  const setOpen = (next: boolean | ((o: boolean) => boolean)) =>
    onOpenChange(typeof next === 'function' ? next(open) : next);
  const ref = useRef<HTMLDivElement | null>(null);
  const btn = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDownOutside = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as HTMLElement)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      btn.current?.focus();
    };
    document.addEventListener('mousedown', onDownOutside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDownOutside);
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
        data-testid={`vis-menu-${vision.id}`}
        aria-label={`Options for ${vision.title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Ic name="dots" />
      </button>
      {open && (
        <div className="px-menu-pop" role="menu" data-testid="vis-menu-pop">
          <button className="px-menu-item" role="menuitem" data-testid="vis-menu-edit" onClick={pick(onEdit)}>
            <Ic name="pen" /> Edit…
          </button>
          <button className="px-menu-item" role="menuitem" data-testid="vis-menu-up" disabled={!canUp} onClick={pick(onUp)}>
            <Ic name="chevd" style={{ transform: 'rotate(180deg)' }} /> Move up
          </button>
          <button
            className="px-menu-item"
            role="menuitem"
            data-testid="vis-menu-down"
            disabled={!canDown}
            onClick={pick(onDown)}
          >
            <Ic name="chevd" /> Move down
          </button>
          <div className="px-menu-sep" />
          <button
            className="px-menu-item px-menu-item--danger"
            role="menuitem"
            data-testid="vis-menu-delete"
            onClick={pick(onDelete)}
          >
            <Ic name="trash" /> Delete
          </button>
        </div>
      )}
    </div>
  );
}
