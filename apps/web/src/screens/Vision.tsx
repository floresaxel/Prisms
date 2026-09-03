/**
 * Vision screen (Plan › Vision) — where a vision is managed ONE AT A TIME.
 *
 * A vision is the root everything else hangs from (I1: a roadmap's only legal
 * parent), and it carries more identity than a title: a description, a dateless
 * horizon, and a colour every roadmap under it wears. Until now those could only
 * be set at creation, from a tab inside Projects; this screen is their home —
 * pick a vision on the left, correct anything about it on the right.
 *
 * Everything writes immediately, one command per field, so an edit survives
 * offline and reconciles like any other (§7.2). The colour and timeline share
 * their controls with the create dialog (VisionFields), so a vision is described
 * the same way whether it is being created or corrected.
 *
 * Deleting a vision cascades (I10) to its roadmaps, projects and tasks, so the
 * confirm names what goes with it. I2 caps the workspace at MAX_VISIONS.
 */
import { useMemo, useState } from 'react';

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
  type HorizonUnit,
  type VisionColor,
} from '@prisms/ui';

import { NewVisionDialog, type NewVisionValues } from '../components/NewVisionDialog';
import { ColorField, colorLabel, HorizonField, parseHorizon } from '../components/VisionFields';

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

  const taken = useMemo(() => new Set(visions.map((v) => visionColorOf(v))), [visions]);

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

  const dialog = (
    <NewVisionDialog
      open={dialogOpen}
      busy={busy}
      existing={visions}
      onClose={() => setDialogOpen(false)}
      onCreate={(values) => void addVision(values)}
    />
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
                <span className="px-mgr-order">
                  <button
                    className="px-btn px-btn--icon px-btn--sm"
                    data-testid={`vis-up-${v.id}`}
                    aria-label={`Move ${v.title} up`}
                    disabled={i === 0 || busy}
                    onClick={() => void reorder(i, -1)}
                  >
                    <Ic name="chevd" style={{ transform: 'rotate(180deg)' }} />
                  </button>
                  <button
                    className="px-btn px-btn--icon px-btn--sm"
                    data-testid={`vis-down-${v.id}`}
                    aria-label={`Move ${v.title} down`}
                    disabled={i === visions.length - 1 || busy}
                    onClick={() => void reorder(i, 1)}
                  >
                    <Ic name="chevd" />
                  </button>
                </span>
              </div>
            );
          })}
        </div>

        {/* keyed by id: the draft fields re-arm from the node whenever the
            selection changes, instead of carrying the last vision's text over. */}
        {active && (
          <VisionDetail
            key={active.id}
            vision={active}
            counts={countsFor(tree, active.id)}
            takenColors={taken}
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
  vision,
  counts,
  takenColors,
  commands,
  onNavigate,
}: {
  vision: Node;
  counts: VisionCounts;
  takenColors: ReadonlySet<VisionColor>;
  commands: ReturnType<typeof useCommands>;
  onNavigate: (href: string) => void;
}) {
  const color = visionColorOf(vision);
  const horizon = readVisionHorizon(vision.attributes);

  const [title, setTitle] = useState(vision.title);
  const [description, setDescription] = useState(vision.description);
  const [unit, setUnit] = useState<HorizonUnit>(horizon?.unit ?? 'years');
  // TEXT, like the create dialog: a half-typed amount has to survive in the box.
  const [amount, setAmount] = useState(String(horizon?.amount ?? 1));

  /** Attributes are replaced whole (the verb's contract), so patch onto the current bag. */
  const writeAttrs = (patch: Record<string, unknown>) =>
    void commands.setNodeAttributes(vision.id, { ...vision.attributes, ...patch });

  function commitTitle() {
    const t = title.trim();
    if (t === '' || t === vision.title) {
      setTitle(vision.title); // an empty name is not a rename — put the old one back
      return;
    }
    void commands.rename(vision.id, t);
  }

  function commitDescription() {
    if (description === vision.description) return;
    void commands.setDescription(vision.id, description);
  }

  function changeHorizon(u: HorizonUnit, a: string) {
    setUnit(u);
    setAmount(a);
    const parsed = parseHorizon(u, a);
    if (parsed) writeAttrs({ horizon: { unit: parsed.unit, amount: parsed.amount } });
  }

  function remove() {
    const owned = [
      `${counts.roadmaps.length} roadmap${counts.roadmaps.length === 1 ? '' : 's'}`,
      `${counts.projects} project${counts.projects === 1 ? '' : 's'}`,
      `${counts.tasks} task${counts.tasks === 1 ? '' : 's'}`,
    ].join(', ');
    if (!window.confirm(`Delete "${vision.title}"? Everything under it goes with it: ${owned}.`)) return;
    void commands.softDelete(vision.id);
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
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setTitle(vision.title);
            }}
          />
          <button className="px-btn px-btn--sm px-btn--danger" data-testid="vis-delete" onClick={remove}>
            <Ic name="trash" /> Delete
          </button>
        </div>

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

      <div className="px-mgr-card">
        <div className="px-vd-field">
          <label className="px-vd-lbl" htmlFor="vis-desc">What this vision means</label>
          <textarea
            id="vis-desc"
            className="px-vd-input"
            data-testid="vis-description"
            placeholder="What does this vision mean, and how will you know you are living it?"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={commitDescription}
          />
          <p className="px-vd-hint">Saved when you click away.</p>
        </div>

        <div className="px-vd-field">
          <span className="px-vd-lbl">Expected timeline</span>
          <HorizonField unit={unit} amount={amount} testPrefix="vis-edit" onChange={changeHorizon} />
          <p className="px-vd-hint">No dates — a vision runs on the order of months, years or decades.</p>
        </div>

        <div className="px-vd-field" style={{ marginBottom: 0 }}>
          <span className="px-vd-lbl">
            Colour · <span className="px-swatch-name" data-testid="vis-color">{colorLabel(color)}</span>
          </span>
          <ColorField
            value={color}
            taken={takenColors}
            testPrefix="vis-edit"
            onChange={(c) => writeAttrs({ color: c })}
          />
          <p className="px-vd-hint">
            Everything under this vision re-tints the moment you pick. Struck-through swatches belong to another vision.
          </p>
        </div>
      </div>

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
