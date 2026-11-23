/**
 * Plan › Roadmap › Flow: build and edit everything that has to happen — and in
 * what order — for the roadmap's outcomes, and so its vision, to come true.
 *
 * Two layouts over the same roadmap (see roadmap-flow.ts), switched in place:
 *
 *   Structured  one row per outcome, one column per step. Drag a card up or
 *               down to change its outcome; drag a card's dot onto another card
 *               to say which comes first. Columns follow from the links.
 *   Free flow   move anything. A group IS an outcome: drop a card into one to
 *               deliver it. Double-click to add, click a dot to add the next
 *               step, drag a dot to link (or onto empty space for a new step),
 *               drag a box to select several. "Tidy up" lines it all up again.
 *
 * It lays out the whole roadmap screen the way the builder mockup does: the
 * picker (`top`), a header card (vision, name, "Realized when" outcome chips,
 * steps / projects / done / in progress), the builder card (view switch,
 * + Project, + Outcome, Longest chain, zoom; then Structured | Free flow; then
 * the gaps and the board), and a details column down the right-hand side.
 *
 * The details column edits whatever is selected: a project (what it delivers,
 * done-when, size, its links), an outcome, a link, several projects, or — with
 * nothing selected — the roadmap's outcomes. The read-only views (Outline, List,
 * Order, Mind map) render through `renderView` and pick into the same column.
 *
 * Presentational: everything it writes goes through `actions`, so it renders in
 * tests without a sync runtime (Roadmap.tsx wires the real commands).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

import type { Node } from '@prisms/core';
import { Ic } from '@prisms/ui';

import {
  boxOf,
  buildFlow,
  curve,
  emptyBox,
  F,
  freeLayout,
  inBox,
  linkKey,
  NONE_LANE,
  PROJECT_SIZES,
  reaches,
  readFlowLayout,
  readOutcomes,
  S,
  snap,
  spotIn,
  withExtras,
  withOutcomes,
  writeFlowLayout,
  type Box,
  type DoorState,
  type FlowCard,
  type FlowLayout,
  type FlowModel,
  type FlowOutcome,
  type FreeLayout,
  type Point,
  type ProjectSize,
} from '../roadmap-flow';
import { itemDone, readRoadmapView, writeRoadmapView, type LinkKind, type RoadmapLink, type RoadmapModel, type RoadmapView } from '../roadmap-model';

import { useTabSwap } from './tabSwap';

export type OtherView = Exclude<RoadmapView, 'flow'>;
/** The view switch, in the builder's order: the builder first, then the read-only views. */
const VIEW_TABS: readonly { value: RoadmapView; label: string; icon: 'flow' | 'outline' | 'list' | 'order' | 'mindmap' }[] = [
  { value: 'flow', label: 'Flow', icon: 'flow' },
  { value: 'outline', label: 'Outline', icon: 'outline' },
  { value: 'list', label: 'List', icon: 'list' },
  { value: 'order', label: 'Order', icon: 'order' },
  { value: 'map', label: 'Mind map', icon: 'mindmap' },
];

export interface SavedSpot {
  /** The diagram_layouts row id (for an in-place update). */
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

export interface FlowActions {
  createProject(input: { title: string; attributes?: Record<string, unknown> }): Promise<string>;
  rename(id: string, title: string): Promise<void>;
  setAttributes(id: string, attributes: Record<string, unknown>): Promise<void>;
  createLink(from: string, to: string, kind: LinkKind): Promise<void>;
  deleteLink(edgeId: string): Promise<void>;
  setPosition(projectId: string, spot: Point, existingId?: string): Promise<void>;
  deleteProject(id: string): Promise<void>;
  newId(): string;
  confirm(message: string): boolean;
}

type Sel = { kind: 'roadmap' } | { kind: 'project'; id: string } | { kind: 'outcome'; id: string } | { kind: 'link'; key: string };
type Editing = { id: string; kind: 'project' | 'outcome'; draft: string };
type Drag =
  | { kind: 'scard'; id: string; start: Point; off: Point; moved: boolean; shift: boolean; x?: number; y?: number; lane?: string | null }
  | { kind: 'slink' | 'flink'; id: string; side: 'l' | 'r'; start: Point; moved: boolean; x: number; y: number; over: string | null }
  | { kind: 'fcards'; ids: string[]; start: Point; dx: number; dy: number; moved: boolean; clickId: string; over: string | null }
  | { kind: 'fgroup'; oid: string; ids: string[]; empty: boolean; start: Point; dx: number; dy: number; moved: boolean }
  | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number; base: string[]; start: Point; moved: boolean };

const DOOR = '100,18 179.9,76 149.4,170 50.6,170 20.1,76';
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const kindLabel = (k: LinkKind, side: 'after' | 'unlocks') => (k === 'SS' ? 'start together' : side === 'after' ? 'finish → start' : 'then starts');

function Door({ state, size = 11 }: { state: DoorState; size?: number }) {
  return (
    <svg className={`px-rf-door px-rf-door--${state}`} width={size} height={size} viewBox="6 0 188 188" aria-hidden="true">
      <polygon points={DOOR} />
      <path className="px-rf-tick" d="M64 106 L90 132 L138 82" />
    </svg>
  );
}
function Warn({ size = 12 }: { size?: number }) {
  return (
    <svg className="px-rf-warn" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3l10 18H2z" />
      <path d="M12 10v5" />
    </svg>
  );
}
function VisionDoor({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="6 0 188 188" aria-hidden="true" className="px-rf-mark">
      <polygon points={DOOR} className="px-rf-mark-frame" />
      <polygon points="100,97 138.4,124.9 123.7,170 76.3,170 61.6,124.9" className="px-rf-mark-door" />
    </svg>
  );
}

export function RoadmapFlow({
  model,
  roadmap,
  vision,
  layouts,
  actions,
  onNavigate,
  top,
  titleSlot,
  menuSlot,
  visionColor,
  renderView,
}: {
  model: RoadmapModel;
  roadmap: Node;
  vision?: Node;
  layouts: ReadonlyMap<string, SavedSpot>;
  actions: FlowActions;
  onNavigate: (href: string) => void;
  /** Above the header card, in the main column: the roadmap picker. */
  top?: ReactNode;
  /** The roadmap's name, editable in place (the screen owns renaming). */
  titleSlot?: ReactNode;
  /** The roadmap's ⋯ menu. */
  menuSlot?: ReactNode;
  /** The owning vision's colour: its name (for tests) and hex. */
  visionColor?: { name: string; hex: string };
  /** The other views' bodies (Outline, List, Order, Mind map). Without it, Flow is the only view. */
  renderView?: (view: OtherView, ctx: { selectedId: string | null; onPick: (id: string) => void }) => ReactNode;
}) {
  const outcomes = useMemo(() => readOutcomes(roadmap.attributes), [roadmap.attributes]);
  const flow = useMemo(() => buildFlow(model, outcomes), [model, outcomes]);

  const [storedView, setViewState] = useState<RoadmapView>(() => readRoadmapView(true));
  const view: RoadmapView = renderView ? storedView : 'flow';
  const [layout, setLayoutState] = useState<FlowLayout>(readFlowLayout);
  // The board under the view / layout switches blurs out and back in (tabSwap.ts).
  const [stageRef, swapStage] = useTabSwap();
  const [sel, setSel] = useState<Sel>({ kind: 'roadmap' });
  const [multi, setMulti] = useState<string[]>([]);
  const [chain, setChain] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  /** First placements have no optimistic row: hold them here until they sync back. */
  const [pending, setPending] = useState<ReadonlyMap<string, Point>>(new Map());

  const boardRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const editRef = useRef<Editing | null>(null);
  const lastDown = useRef<{ id: string; t: number; x: number; y: number } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A pending spot is dropped once the synced row agrees with it.
  useEffect(() => {
    if (pending.size === 0) return;
    let changed = false;
    const next = new Map(pending);
    for (const [id, p] of pending) {
      const s = layouts.get(id);
      if (!s || Math.abs(s.x - p.x) >= 1 || Math.abs(s.y - p.y) >= 1) continue;
      next.delete(id);
      changed = true;
    }
    if (changed) setPending(next);
  }, [layouts, pending]);
  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  const saved = useMemo(() => {
    const m = new Map<string, Point>();
    for (const [id, s] of layouts) if (flow.byId.has(id)) m.set(id, { x: s.x, y: s.y });
    for (const [id, p] of pending) if (flow.byId.has(id)) m.set(id, p);
    return m;
  }, [layouts, pending, flow]);
  const free = useMemo(() => freeLayout(flow, saved), [flow, saved]);

  /**
   * `node.set_attributes` replaces the whole bag, so two quick edits (a name, then
   * a statement) must build on each other, not each on the props of the render
   * they came from. The last bag written per node is kept here until the synced
   * row agrees with it (or a few seconds pass — another device may have won).
   */
  const written = useRef(new Map<string, { attrs: Record<string, unknown>; at: number }>());
  const attrsOf = (id: string, fromProps: Readonly<Record<string, unknown>>): Record<string, unknown> => {
    const w = written.current.get(id);
    return w && Date.now() - w.at < 8000 ? w.attrs : { ...fromProps };
  };
  const writeAttrs = (id: string, attrs: Record<string, unknown>) => {
    written.current.set(id, { attrs, at: Date.now() });
    return actions.setAttributes(id, attrs);
  };
  useEffect(() => {
    for (const [id, w] of written.current) {
      const now = id === roadmap.id ? roadmap.attributes : model.byId.get(id)?.node.attributes;
      if (!now || stableJson(now) === stableJson(w.attrs) || Date.now() - w.at >= 8000) written.current.delete(id);
    }
  }, [roadmap, model]);
  /** The outcomes as this view last wrote them (see `written`). */
  const outcomesNow = () => readOutcomes(attrsOf(roadmap.id, roadmap.attributes));

  const say = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3400);
  }, []);
  /** Run a write; a rejection (a loop, a sync error) becomes a message, never a crash. */
  const safe = useCallback(
    async <T,>(what: string, fn: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await fn();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        say(/E_CYCLE/.test(msg) ? 'That would make a loop.' : `Couldn’t ${what}: ${msg}`);
        return undefined;
      }
    },
    [say],
  );

  const card = (id: string) => flow.byId.get(id);
  const title = (id: string) => card(id)?.title ?? '';
  const outcomeById = (id: string | null) => (id ? outcomes.find((o) => o.id === id) : undefined);
  const selP = sel.kind === 'project' ? card(sel.id) : undefined;
  const selO = sel.kind === 'outcome' ? outcomeById(sel.id) : undefined;
  const selL = sel.kind === 'link' ? flow.links.find((l) => linkKey(l) === sel.key) : undefined;
  const multiOn = multi.length > 1;
  // A new project or outcome is named in the details panel: once its panel is up,
  // its placeholder name is focused and selected, ready to type over.
  const [focusReq, setFocusReq] = useState<{ id: string; el: 'rf-p-title' | 'rf-o-name' } | null>(null);
  const shownId = selP?.id ?? selO?.id ?? null;
  useEffect(() => {
    if (!focusReq || focusReq.id !== shownId) return;
    const el = document.getElementById(focusReq.el) as HTMLInputElement | null;
    el?.focus();
    el?.select();
    setFocusReq(null);
  }, [focusReq, shownId]);
  const setView = (v: RoadmapView) => {
    commitEdit();
    if (v === view) return;
    swapStage(() => setViewState(v));
    writeRoadmapView(v);
  };
  const pick = (id: string) => {
    setSel({ kind: 'project', id });
    setMulti([id]);
  };
  const clearSel = () => {
    setSel({ kind: 'roadmap' });
    setMulti([]);
  };

  // --- writes --------------------------------------------------------------------------
  const saveOutcomes = (next: readonly FlowOutcome[]) =>
    safe('save the outcomes', () => writeAttrs(roadmap.id, withOutcomes(attrsOf(roadmap.id, roadmap.attributes), next)));
  const setExtras = (id: string, patch: Parameters<typeof withExtras>[1]) => {
    const c = card(id);
    if (!c) return Promise.resolve(undefined);
    return safe('save the project', () => writeAttrs(id, withExtras(attrsOf(id, c.project.node.attributes), patch)));
  };
  const place = (id: string, spot: Point) => {
    const p = { x: Math.max(8, snap(spot.x)), y: Math.max(8, snap(spot.y)) };
    setPending((m) => new Map(m).set(id, p));
    return safe('move the card', () => actions.setPosition(id, p, layouts.get(id)?.id));
  };
  /** The first hand placement writes down every spot, so nothing else shifts. */
  const pinAll = async (except: readonly string[] = []) => {
    if (!free.pristine) return;
    const writes: Promise<unknown>[] = [];
    for (const c of flow.cards) if (!except.includes(c.id) && !saved.has(c.id)) writes.push(place(c.id, free.proj.get(c.id)!));
    const current = outcomesNow();
    if (current.some((o) => free.empty.has(o.id) && o.x === undefined))
      writes.push(saveOutcomes(current.map((o) => (free.empty.has(o.id) && o.x === undefined ? { ...o, ...free.empty.get(o.id)! } : o))));
    await Promise.all(writes);
  };
  const setOutcome = async (id: string, outcomeId: string | null) => {
    await setExtras(id, { outcomeId });
    // In free flow the card moves under its new group, so the group's box doesn't stretch to reach it.
    if (!free.pristine || layout === 'free') {
      await pinAll([id]);
      await place(id, spotIn(flow, free, outcomeId, id));
    }
  };
  const addLink = async (from: string, to: string, kind: LinkKind = 'FS') => {
    if (from === to) return false;
    if (flow.links.some((l) => l.from === from && l.to === to)) return (say('Those two are already linked.'), false);
    if (reaches(flow.links, to, from)) return (say(`That would make a loop: ${title(to)} already leads to ${title(from)}.`), false);
    const ok = await safe('link them', () => actions.createLink(from, to, kind));
    if (ok === undefined) return false;
    say(`${title(to)} now ${kind === 'SS' ? 'starts together with' : 'waits on'} ${title(from)}.`);
    return true;
  };
  const removeLink = async (l: RoadmapLink) => {
    if (!l.edge) return;
    await safe('remove the link', () => actions.deleteLink(l.edge!.id));
    if (sel.kind === 'link' && sel.key === linkKey(l)) clearSel();
    say(l.inner ? `Removed. ${title(l.to)} still waits on ${title(l.from)} through their tasks.` : `${title(l.to)} no longer waits on ${title(l.from)}.`);
  };
  const setLinkKind = async (l: RoadmapLink, kind: LinkKind) => {
    if (!l.edge || l.edge.edge_type === kind) return;
    await safe('change the link', async () => {
      await actions.deleteLink(l.edge!.id);
      await actions.createLink(l.from, l.to, kind);
    });
  };
  const reverseLink = async (l: RoadmapLink) => {
    if (!l.edge) return;
    const rest = flow.links.filter((x) => linkKey(x) !== linkKey(l));
    if (l.inner || reaches(rest, l.from, l.to)) return say('Reversing it would make a loop.');
    await safe('reverse the link', async () => {
      await actions.deleteLink(l.edge!.id);
      await actions.createLink(l.to, l.from, l.kind);
    });
    setSel({ kind: 'link', key: `${l.to}>${l.from}` });
  };
  const addProject = async (opts: { outcomeId?: string | null; after?: string; before?: string; at?: Point; inline?: boolean } = {}) => {
    const outcomeId = opts.outcomeId ?? null;
    const id = await safe('add the project', () =>
      actions.createProject({ title: 'New project', ...(outcomeId ? { attributes: withExtras({}, { outcomeId }) } : {}) }),
    );
    if (!id) return;
    if (opts.after) await safe('link it', () => actions.createLink(opts.after!, id, 'FS'));
    if (opts.before) await safe('link it', () => actions.createLink(id, opts.before!, 'FS'));
    if (opts.at || layout === 'free' || !free.pristine) {
      await pinAll([id]);
      await place(id, opts.at ?? spotIn(flow, free, outcomeId, null));
    }
    pick(id);
    if (opts.inline && layout === 'free' && view === 'flow') startEdit({ id, kind: 'project', draft: '' });
    else setFocusReq({ id, el: 'rf-p-title' });
  };
  const deleteProjects = async (ids: readonly string[]) => {
    if (ids.length === 0) return;
    const what = ids.length === 1 ? `“${title(ids[0]!)}”` : `${ids.length} projects`;
    if (!actions.confirm(`Delete ${what}? Everything inside ${ids.length === 1 ? 'it' : 'them'} — milestones and tasks — goes too.`)) return;
    for (const id of ids) await safe('delete the project', () => actions.deleteProject(id));
    clearSel();
  };
  const addOutcome = async (members: readonly string[] = []) => {
    const o: FlowOutcome = { id: actions.newId(), name: 'New outcome', statement: '', measure: '' };
    await saveOutcomes([...outcomesNow(), o]);
    for (const id of members) await setExtras(id, { outcomeId: o.id });
    setMulti([]);
    setSel({ kind: 'outcome', id: o.id });
    if (layout === 'free' && view === 'flow' && members.length > 0) startEdit({ id: o.id, kind: 'outcome', draft: '' });
    else setFocusReq({ id: o.id, el: 'rf-o-name' });
  };
  const patchOutcome = (id: string, patch: Partial<FlowOutcome>) => saveOutcomes(outcomesNow().map((o) => (o.id === id ? { ...o, ...patch } : o)));
  const moveOutcome = (id: string, dir: -1 | 1) => {
    const current = outcomesNow();
    const i = current.findIndex((o) => o.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= current.length) return;
    const next = [...current];
    [next[i], next[j]] = [next[j]!, next[i]!];
    void saveOutcomes(next);
  };
  const deleteOutcome = async (id: string) => {
    const o = outcomeById(id);
    const n = flow.cards.filter((c) => c.outcomeId === id).length;
    if (n > 0 && !actions.confirm(`Remove the outcome “${o?.name || 'Outcome'}”? Its ${plural(n, 'project')} stay, delivering no outcome.`)) return;
    await saveOutcomes(outcomesNow().filter((x) => x.id !== id));
    clearSel();
  };
  const chainProjects = async (ids: readonly string[]) => {
    const pos = (id: string) => (layout === 'free' ? free.proj.get(id)! : { x: card(id)!.x, y: card(id)!.y });
    const list = [...ids].sort((a, b) => pos(a).x - pos(b).x || pos(a).y - pos(b).y);
    let added = 0;
    let skipped = 0;
    const links: { from: string; to: string }[] = [...flow.links];
    for (let i = 1; i < list.length; i++) {
      const from = list[i - 1]!;
      const to = list[i]!;
      if (links.some((l) => l.from === from && l.to === to)) continue;
      if (reaches(links, to, from)) {
        skipped++;
        continue;
      }
      const ok = await safe('link them', () => actions.createLink(from, to, 'FS'));
      if (ok === undefined) continue;
      links.push({ from, to });
      added++;
    }
    say(`${plural(added, 'link')} added, left to right${skipped ? `; ${skipped} skipped because they would make a loop` : ''}.`);
  };
  const tidyUp = async () => {
    const writes: Promise<unknown>[] = [];
    for (const c of flow.cards) {
      const t = free.tidy.proj.get(c.id);
      const cur = saved.get(c.id);
      if (t && (!cur || cur.x !== t.x || cur.y !== t.y)) writes.push(place(c.id, t));
    }
    writes.push(
      saveOutcomes(
        outcomesNow().map((o) => {
          const t = free.tidy.empty.get(o.id);
          const bare: FlowOutcome = { id: o.id, name: o.name, statement: o.statement, measure: o.measure };
          return t ? { ...bare, x: t.x, y: t.y } : bare;
        }),
      ),
    );
    await Promise.all(writes);
    say('Lined up like Structured: one row per outcome, one column per step.');
  };

  // --- inline rename (free flow) ----------------------------------------------------------
  function startEdit(e: Editing) {
    editRef.current = e;
    setEditing(e);
  }
  const commitEdit = () => {
    const e = editRef.current;
    if (!e) return;
    editRef.current = null;
    setEditing(null);
    const text = e.draft.trim();
    if (e.kind === 'project') {
      if (text && text !== title(e.id)) void safe('rename it', () => actions.rename(e.id, text));
    } else {
      const o = outcomeById(e.id);
      if (o && text && text !== o.name) void patchOutcome(e.id, { name: text });
    }
  };
  const cancelEdit = () => {
    editRef.current = null;
    setEditing(null);
  };
  const setDraft = (draft: string) => {
    if (!editRef.current) return;
    editRef.current = { ...editRef.current, draft };
    setEditing(editRef.current);
  };

  const setLayout = (l: FlowLayout) => {
    if (l === layout) return;
    commitEdit();
    swapStage(() => {
      setLayoutState(l);
      setDrag(null);
    });
    writeFlowLayout(l);
    dragRef.current = null;
    say(l === 'free' ? 'Free flow: groups are your outcomes. Move anything; the order still comes from the links.' : 'Structured: one row per outcome, one column per step. Your free-flow spots are kept.');
  };

  // --- pointer plumbing -------------------------------------------------------------------
  const boardSize = layout === 'free' ? freeBoardSize(free, drag) : { w: flow.boardW, h: flow.boardH, vx: 0, vh: 0 };
  const pt = (e: { clientX: number; clientY: number }): Point => {
    const el = boardRef.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    const k = r.width / boardSize.w || 1;
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k };
  };
  const capture = (e: ReactPointerEvent) => {
    try {
      boardRef.current?.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events have no pointer to capture */
    }
  };
  const begin = (d: Drag) => {
    dragRef.current = d;
  };
  const isDouble = (id: string, p: Point) => {
    const now = Date.now();
    const last = lastDown.current;
    lastDown.current = { id, t: now, x: p.x, y: p.y };
    if (last && last.id === id && now - last.t < 380 && Math.hypot(last.x - p.x, last.y - p.y) < 8) {
      lastDown.current = null;
      return true;
    }
    return false;
  };
  const sCardAt = (p: Point) => flow.cards.find((c) => p.x >= c.x && p.x <= c.x + S.W && p.y >= c.y && p.y <= c.y + S.H);
  const sLaneAt = (p: Point) => flow.lanes.find((l) => p.y >= l.top && p.y < l.top + l.h && p.x <= flow.capX - 8);
  const fCardAt = (p: Point, except: string) =>
    [...free.proj].find(([id, q]) => id !== except && p.x >= q.x && p.x <= q.x + F.W && p.y >= q.y && p.y <= q.y + F.H)?.[0];
  const frozenBoxes = (dragIds: readonly string[]) =>
    outcomes.map((o) => {
      const members = flow.cards.filter((c) => c.outcomeId === o.id);
      const still = members.filter((c) => !dragIds.includes(c.id)).map((c) => free.proj.get(c.id)!);
      const box = still.length ? boxOf(still) : members.length === 0 && free.empty.has(o.id) ? emptyBox(free.empty.get(o.id)!) : null;
      return { id: o.id, box, whole: members.length > 0 && still.length === 0 };
    });
  const groupAt = (p: Point, dragIds: readonly string[], margin = 0) => {
    let best: { id: string; box: Box } | null = null;
    for (const f of frozenBoxes(dragIds)) if (f.box && inBox(f.box, p, margin) && (!best || f.box.w * f.box.h < best.box.w * best.box.h)) best = { id: f.id, box: f.box };
    return best?.id ?? null;
  };

  // structured
  const sCardDown = (e: ReactPointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    commitEdit();
    capture(e);
    const p = pt(e);
    const c = card(id)!;
    begin({ kind: 'scard', id, start: p, off: { x: p.x - c.x, y: p.y - c.y }, moved: false, shift: e.shiftKey });
  };
  const portDown = (e: ReactPointerEvent, id: string, side: 'l' | 'r', kind: 'slink' | 'flink') => {
    if (e.button !== 0) return;
    e.stopPropagation();
    commitEdit();
    capture(e);
    const p = pt(e);
    pick(id);
    begin({ kind, id, side, start: p, moved: false, x: p.x, y: p.y, over: null });
  };

  // free flow
  const fBoardDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    commitEdit();
    const p = pt(e);
    if (isDouble('bg', p)) {
      void addProject({ outcomeId: groupAt(p, []), at: { x: p.x - F.W / 2, y: p.y - F.H / 2 }, inline: true });
      return;
    }
    capture(e);
    begin({ kind: 'marquee', x0: p.x, y0: p.y, x1: p.x, y1: p.y, base: e.shiftKey ? multi : [], start: p, moved: false });
    if (!e.shiftKey) clearSel();
  };
  const fCardDown = (e: ReactPointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    commitEdit();
    const p = pt(e);
    if (isDouble(id, p)) {
      dragRef.current = null;
      startEdit({ id, kind: 'project', draft: title(id) });
      return;
    }
    if (e.shiftKey) {
      const ids = multi.includes(id) ? multi.filter((x) => x !== id) : [...multi, id];
      setMulti(ids);
      if (ids.length === 1) setSel({ kind: 'project', id: ids[0]! });
      else if (ids.length === 0) setSel({ kind: 'roadmap' });
      return;
    }
    const ids = multiOn && multi.includes(id) ? multi : [id];
    if (ids.length === 1) pick(id);
    capture(e);
    begin({ kind: 'fcards', ids, start: p, dx: 0, dy: 0, moved: false, clickId: id, over: null });
  };
  const fGroupDown = (e: ReactPointerEvent, oid: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    commitEdit();
    const p = pt(e);
    if (isDouble(`g${oid}`, p)) {
      dragRef.current = null;
      startEdit({ id: oid, kind: 'outcome', draft: outcomeById(oid)?.name ?? '' });
      return;
    }
    setSel({ kind: 'outcome', id: oid });
    setMulti([]);
    capture(e);
    const ids = flow.cards.filter((c) => c.outcomeId === oid).map((c) => c.id);
    begin({ kind: 'fgroup', oid, ids, empty: ids.length === 0, start: p, dx: 0, dy: 0, moved: false });
  };
  const fEdgeDown = (e: ReactPointerEvent, key: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    commitEdit();
    setSel({ kind: 'link', key });
    setMulti([]);
  };

  const onMove = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const p = pt(e);
    if (!d.moved && Math.hypot(p.x - d.start.x, p.y - d.start.y) < 5) return;
    d.moved = true;
    if (d.kind === 'scard') {
      const l = sLaneAt(p);
      d.x = p.x - d.off.x;
      d.y = p.y - d.off.y;
      d.lane = l ? l.id : null;
    } else if (d.kind === 'slink' || d.kind === 'flink') {
      d.x = p.x;
      d.y = p.y;
      d.over = (d.kind === 'slink' ? sCardAt(p)?.id : fCardAt(p, d.id)) ?? null;
      if (d.over === d.id) d.over = null;
    } else if (d.kind === 'fcards') {
      d.dx = p.x - d.start.x;
      d.dy = p.y - d.start.y;
      d.over = groupAt(p, d.ids, 28);
    } else if (d.kind === 'fgroup') {
      d.dx = p.x - d.start.x;
      d.dy = p.y - d.start.y;
    } else if (d.kind === 'marquee') {
      d.x1 = p.x;
      d.y1 = p.y;
    }
    setDrag({ ...d } as Drag);
  };

  const onUp = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!d) return;
    const p = pt(e);
    if (d.kind === 'scard') {
      if (!d.moved) {
        if (d.shift) {
          const ids = multi.includes(d.id) ? multi.filter((x) => x !== d.id) : [...multi, d.id];
          setMulti(ids);
          if (ids.length === 1) setSel({ kind: 'project', id: ids[0]! });
          return;
        }
        pick(d.id);
        return;
      }
      const lane = sLaneAt(p);
      if (!lane) return;
      const target = lane.id === NONE_LANE ? null : lane.id;
      if ((card(d.id)?.outcomeId ?? null) === target) {
        say('Columns come from the links. Drag a card’s blue dot onto another card to change the order.');
        return;
      }
      pick(d.id);
      void setOutcome(d.id, target).then(() =>
        say(target ? `“${title(d.id)}” now delivers “${outcomeById(target)?.name || 'that outcome'}”.` : `“${title(d.id)}” no longer delivers an outcome.`),
      );
      return;
    }
    if (d.kind === 'slink') {
      if (!d.moved) return;
      const over = sCardAt(p);
      if (!over || over.id === d.id) return say('Drop the dot on another project to link them.');
      void (d.side === 'r' ? addLink(d.id, over.id) : addLink(over.id, d.id));
      return;
    }
    if (d.kind === 'marquee') {
      const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1), y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
      if (x1 - x0 < 4 && y1 - y0 < 4) return;
      const hit = [...free.proj].filter(([, q]) => q.x < x1 && q.x + F.W > x0 && q.y < y1 && q.y + F.H > y0).map(([id]) => id);
      const ids = [...d.base, ...hit.filter((id) => !d.base.includes(id))];
      setMulti(ids);
      if (ids.length === 1) setSel({ kind: 'project', id: ids[0]! });
      return;
    }
    if (d.kind === 'fcards') {
      if (!d.moved) return pick(d.clickId);
      void dropCards(d);
      return;
    }
    if (d.kind === 'fgroup') {
      if (!d.moved) return;
      void (async () => {
        await pinAll(d.ids);
        if (d.empty) {
          const q = free.empty.get(d.oid)!;
          await patchOutcome(d.oid, { x: Math.max(24, snap(q.x + d.dx)), y: Math.max(40, snap(q.y + d.dy)) });
        } else for (const id of d.ids) {
          const q = free.proj.get(id)!;
          await place(id, { x: q.x + d.dx, y: q.y + d.dy });
        }
      })();
      return;
    }
    // flink
    const src = card(d.id);
    const at = free.proj.get(d.id);
    if (!src || !at) return;
    if (!d.moved) {
      const x = Math.max(8, at.x + (d.side === 'r' ? F.COLP : -F.COLP));
      let y = at.y;
      const all = [...free.proj.values()];
      for (let i = 0; i < 12 && all.some((q) => Math.abs(q.x - x) < F.W + 8 && Math.abs(q.y - y) < F.H + 8); i++) y += F.ROW;
      void addProject({ outcomeId: src.outcomeId, at: { x, y }, ...(d.side === 'r' ? { after: d.id } : { before: d.id }), inline: true });
      return;
    }
    if (d.over) {
      void (d.side === 'r' ? addLink(d.id, d.over) : addLink(d.over, d.id));
      return;
    }
    void addProject({
      outcomeId: groupAt(p, []),
      at: { x: d.side === 'r' ? p.x - 12 : p.x - F.W + 12, y: p.y - F.H / 2 },
      ...(d.side === 'r' ? { after: d.id } : { before: d.id }),
      inline: true,
    });
  };
  const onCancel = () => {
    dragRef.current = null;
    setDrag(null);
  };

  const dropCards = async (d: Extract<Drag, { kind: 'fcards' }>) => {
    const boxes = frozenBoxes(d.ids);
    await pinAll(d.ids);
    // An outcome that loses every card keeps its spot as an empty group.
    const emptied = outcomes.filter((o) => {
      const members = flow.cards.filter((c) => c.outcomeId === o.id);
      return members.length > 0 && members.every((c) => d.ids.includes(c.id)) && d.over && d.over !== o.id;
    });
    if (emptied.length) {
      const emptiedIds = new Set(emptied.map((o) => o.id));
      await saveOutcomes(
        outcomesNow().map((o) => {
          if (!emptiedIds.has(o.id)) return o;
          const b = boxOf(flow.cards.filter((c) => c.outcomeId === o.id).map((c) => free.proj.get(c.id)!))!;
          return { ...o, x: b.x + 16, y: b.y + 34 };
        }),
      );
    }
    let note: string | null = null;
    for (const id of d.ids) {
      const q = free.proj.get(id)!;
      await place(id, { x: q.x + d.dx, y: q.y + d.dy });
      const c = card(id)!;
      const own = boxes.find((f) => f.id === c.outcomeId);
      const target = d.over ?? (own?.whole ? c.outcomeId : null);
      if (target !== c.outcomeId) {
        await setExtras(id, { outcomeId: target });
        note = target ? `now delivers “${outcomeById(target)?.name || 'that outcome'}”` : `no longer delivers “${outcomeById(c.outcomeId)?.name || 'its outcome'}”`;
      }
    }
    if (note) say(`${d.ids.length === 1 ? `“${title(d.ids[0]!)}”` : `${d.ids.length} projects:`} ${note}.`);
  };

  // keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = (t?.tagName ?? '').toLowerCase();
      if (editRef.current || tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (!t?.closest?.('[data-testid="rf"]') && t !== document.body) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!multiOn && !selL?.edge && !selP) return;
        e.preventDefault();
        if (multiOn) void deleteProjects(multi);
        else if (selL?.edge) void removeLink(selL);
        else if (selP) void deleteProjects([selP.id]);
        return;
      }
      if (e.key === 'Escape') {
        onCancel();
        clearSel();
        return;
      }
      if (e.key === 'Enter' && layout === 'free' && selP && !multiOn && t?.classList.contains('px-rf-body')) {
        e.preventDefault();
        startEdit({ id: selP.id, kind: 'project', draft: selP.title });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // --- shared look --------------------------------------------------------------------------
  const inMulti = (id: string) => multiOn && multi.includes(id);
  const dimCard = (c: FlowCard) => {
    if (chain) return !flow.onChain.has(c.id);
    if (multiOn) return !inMulti(c.id);
    if (selP) return !(c.id === selP.id || selP.project.waitsOn.includes(c.id) || selP.project.unblocks.includes(c.id));
    if (selO) return c.outcomeId !== selO.id;
    if (selL) return c.id !== selL.from && c.id !== selL.to;
    return false;
  };
  const linkStyle = (key: string, l: RoadmapLink): { stroke: string; w: number; z: number } => {
    if (sel.kind === 'link' && sel.key === key) return { stroke: 'var(--px-accent)', w: 2.5, z: 4 };
    if (chain) return flow.chainLinks.has(key) ? { stroke: 'var(--px-rf-ink)', w: 2.25, z: 3 } : { stroke: 'var(--px-border)', w: 1.5, z: 1 };
    if (selP && !multiOn) return l.from === selP.id || l.to === selP.id ? { stroke: 'var(--px-rf-ink)', w: 2, z: 3 } : { stroke: 'var(--px-border)', w: 1.5, z: 1 };
    return { stroke: 'var(--px-rf-link)', w: 1.5, z: 2 };
  };
  const hasOutcomes = outcomes.length > 0;
  const cardWarn = (c: FlowCard) => hasOutcomes && c.outcomeId === null;

  // --- render: structured ---------------------------------------------------------------------
  const structured = () => {
    const d = drag;
    let preview: { d: string; head: string } | null = null;
    if (d && d.kind === 'slink' && d.moved) {
      const a = card(d.id)!;
      const b = d.over ? card(d.over) : undefined;
      const ax = d.side === 'r' ? a.x + S.W : a.x;
      const bx = b ? (d.side === 'r' ? b.x : b.x + S.W) : d.x;
      const by = b ? b.cy : d.y;
      preview = d.side === 'r' ? curve(ax, a.cy, bx, by) : curve(bx, by, ax, a.cy);
    }
    const routed = flow.routed.map((r) => ({ ...r, ...linkStyle(r.key, r.link) })).sort((a, b) => a.z - b.z);
    const lifted = d && d.kind === 'scard' && d.moved ? d : null;
    return (
      <>
        <div className="px-rf-scroll" ref={scrollRef}>
          <div className="px-rf-wrap" style={{ width: flow.boardW * zoom, height: flow.boardH * zoom }}>
            <div
              ref={boardRef}
              className={`px-rf-board${d?.moved ? ' px-rf-board--drag' : ''}${d && d.kind === 'slink' ? ' px-rf-board--linking' : ''}`}
              data-testid="rf-board"
              style={{ width: flow.boardW, height: flow.boardH, transform: `scale(${zoom})` }}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onCancel}
            >
              {flow.lanes.map((l) => (
                <div
                  key={`lane-${l.id}`}
                  className={`px-rf-lane${l.index % 2 ? ' px-rf-lane--alt' : ''}${lifted?.lane === l.id ? ' px-rf-lane--drop' : ''}`}
                  data-testid={`rf-lane-${l.id}`}
                  style={{ top: l.top, height: l.h }}
                >
                  <span className={`px-rf-lane-label${!l.outcome && hasOutcomes ? ' px-rf-lane-label--warn' : ''}`}>
                    {l.outcome ? (
                      <svg width="10" height="10" viewBox="6 0 188 188" aria-hidden="true" className="px-rf-outline-door">
                        <polygon points={DOOR} />
                      </svg>
                    ) : (
                      hasOutcomes && <Warn size={11} />
                    )}
                    {l.outcome ? l.outcome.name || 'Outcome' : hasOutcomes ? 'Not delivering an outcome' : 'Projects'}
                  </span>
                </div>
              ))}
              {Array.from({ length: flow.maxStep }, (_, i) => {
                const n = flow.cards.filter((c) => c.step !== null && c.col === i).length;
                return (
                  <div key={`st${i}`} className="px-rf-step-h" style={{ left: S.X0 + i * S.PITCH }}>
                    Step {i + 1}
                    <span>{plural(n, 'project')}</span>
                  </div>
                );
              })}
              {flow.caps.length > 0 && (
                <div className="px-rf-step-h" style={{ left: flow.capX }}>
                  Outcomes
                </div>
              )}
              <svg className="px-rf-edges" width={flow.boardW} height={flow.boardH} aria-hidden="true">
                {flow.decor.map((r) => {
                  const hot = r.capId !== undefined && ((sel.kind === 'outcome' && sel.id === r.capId) || sel.kind === 'roadmap');
                  const stroke = r.dashed ? 'var(--px-rf-lane-link)' : hot ? 'var(--px-rf-ink)' : 'var(--px-rf-link)';
                  return (
                    <g key={r.key}>
                      <path d={r.d} fill="none" stroke={stroke} strokeWidth={1.5} strokeDasharray={r.dashed ? '4 5' : undefined} strokeLinecap="round" />
                      {r.head && <path d={r.head} fill={stroke} />}
                    </g>
                  );
                })}
                {routed.map((r) => (
                  <g key={r.key} data-testid={`rf-link-${r.key}`} data-kind={r.link.kind}>
                    <path d={r.d} fill="none" stroke={r.stroke} strokeWidth={r.w} strokeDasharray={r.link.kind === 'SS' ? '5 4' : undefined} strokeLinecap="round" strokeLinejoin="round" />
                    <path d={r.head} fill={r.stroke} />
                  </g>
                ))}
                {preview && (
                  <g>
                    <path d={preview.d} fill="none" stroke="var(--px-accent)" strokeWidth={2} strokeDasharray="6 5" strokeLinecap="round" />
                    <path d={preview.head} fill="var(--px-accent)" />
                  </g>
                )}
              </svg>
              {flow.caps
                .filter((c) => c.count === 0)
                .map((c) => (
                  <button
                    key={`ghost-${c.outcome.id}`}
                    type="button"
                    className="px-rf-ghost"
                    data-testid={`rf-ghost-${c.outcome.id}`}
                    style={{ left: S.X0, top: c.y, width: S.PITCH + S.W }}
                    onClick={() => void addProject({ outcomeId: c.outcome.id })}
                  >
                    <Ic name="plus" /> Add the first project for this outcome
                  </button>
                ))}
              {flow.cards.map((c) => (
                <div
                  key={c.id}
                  className={[
                    'px-rf-card',
                    (selP?.id === c.id || inMulti(c.id)) && 'px-rf-card--sel',
                    dimCard(c) && 'px-rf-card--dim',
                    chain && flow.onChain.has(c.id) && 'px-rf-card--chain',
                    c.state === 'done' && 'px-rf-card--done',
                    d && d.kind === 'slink' && d.over === c.id && 'px-rf-card--target',
                    lifted?.id === c.id && 'px-rf-card--lifted',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  data-testid={`rf-card-${c.id}`}
                  data-state={c.state}
                  data-step={c.step ?? 'any'}
                  data-lane={c.lane}
                  style={{ left: c.x, top: c.y }}
                >
                  <button
                    type="button"
                    className="px-rf-body"
                    aria-pressed={selP?.id === c.id}
                    aria-label={`${c.title}, ${c.step === null ? 'any time' : `step ${c.step}`}, ${c.meta}`}
                    onPointerDown={(e) => sCardDown(e, c.id)}
                    onClick={(e) => {
                      if (e.detail === 0) pick(c.id); // keyboard; pointer picks on release
                    }}
                  >
                    <CardFace c={c} warn={cardWarn(c)} />
                  </button>
                  <button type="button" className="px-rf-port px-rf-port--l" data-testid={`rf-port-l-${c.id}`} aria-label={`Drag onto what has to finish before ${c.title}`} onPointerDown={(e) => portDown(e, c.id, 'l', 'slink')} />
                  <button type="button" className="px-rf-port px-rf-port--r" data-testid={`rf-port-r-${c.id}`} aria-label={`Drag onto what waits on ${c.title}`} onPointerDown={(e) => portDown(e, c.id, 'r', 'slink')} />
                </div>
              ))}
              {flow.caps.map((c) => (
                <button
                  key={`cap-${c.outcome.id}`}
                  type="button"
                  className={[
                    'px-rf-cap',
                    sel.kind === 'outcome' && sel.id === c.outcome.id && 'px-rf-cap--sel',
                    c.count === 0 && 'px-rf-cap--warn',
                    ((selP && !chain && !multiOn && selP.outcomeId !== c.outcome.id) || (selO && selO.id !== c.outcome.id)) && 'px-rf-cap--dim',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  data-testid={`rf-cap-${c.outcome.id}`}
                  style={{ left: c.x, top: c.y }}
                  onClick={() => {
                    setSel({ kind: 'outcome', id: c.outcome.id });
                    setMulti([]);
                  }}
                >
                  <span className="px-rf-cap-title">{c.outcome.statement || c.outcome.name || 'Untitled outcome'}</span>
                  <span className="px-rf-cap-meta">
                    {c.count === 0 && <Warn size={11} />}
                    {c.count ? `${c.done} of ${c.count} done` : 'Nothing delivers this'}
                  </span>
                </button>
              ))}
              <button
                type="button"
                className={`px-rf-threshold${sel.kind === 'roadmap' && !multiOn ? ' px-rf-threshold--sel' : ''}`}
                data-testid="rf-vision"
                style={{ left: flow.thX, top: flow.thTop, height: flow.thH }}
                aria-label={`The vision: ${vision?.title ?? ''}`}
                onClick={clearSel}
              >
                <VisionDoor size={16} />
                <span className="px-rf-threshold-label">Vision</span>
                <span className="px-rf-threshold-floor" />
              </button>
              {lifted && lifted.x !== undefined && (
                <div className="px-rf-card px-rf-card--ghost" style={{ left: lifted.x, top: lifted.y }}>
                  <span className="px-rf-body">
                    <CardFace c={card(lifted.id)!} warn={false} />
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="px-rf-legend">
          <span><Door state="done" />Done</span>
          <span><Door state="now" />In progress</span>
          <span><Door state="ready" />Ready to start</span>
          <span><Door state="wait" />Waiting on something unfinished</span>
          <span>
            <svg width="26" height="8" viewBox="0 0 26 8" aria-hidden="true"><path d="M1 4 H19" className="px-rf-legend-line" /><path d="M25 4 L18 0.5 L18 7.5 Z" className="px-rf-legend-head" /></svg>
            has to finish first
          </span>
          <span>
            <svg width="26" height="8" viewBox="0 0 26 8" aria-hidden="true"><path d="M1 4 H19" className="px-rf-legend-line" strokeDasharray="4 3" /><path d="M25 4 L18 0.5 L18 7.5 Z" className="px-rf-legend-head" /></svg>
            starts together
          </span>
          <span>Drag a card up or down to change its outcome. Columns come from the links. Shift-click selects several.</span>
        </div>
      </>
    );
  };

  // --- render: free flow ------------------------------------------------------------------------
  const freeBoard = () => {
    const d = drag;
    const dragIds = d && (d.kind === 'fcards' || d.kind === 'fgroup') && d.moved ? d.ids : [];
    const live = new Map<string, Point>();
    for (const [id, q] of free.proj)
      live.set(id, dragIds.includes(id) && d && 'dx' in d ? { x: Math.max(8, snap(q.x + d.dx)), y: Math.max(8, snap(q.y + d.dy)) } : q);
    const liveEmpty = new Map(free.empty);
    if (d && d.kind === 'fgroup' && d.moved && d.empty) {
      const q = free.empty.get(d.oid)!;
      liveEmpty.set(d.oid, { x: Math.max(24, snap(q.x + d.dx)), y: Math.max(40, snap(q.y + d.dy)) });
    }
    const size = boardSize;
    const frozen = d && d.kind === 'fcards' && d.moved ? d : null;
    const groups = outcomes.map((o) => {
      const members = flow.cards.filter((c) => c.outcomeId === o.id);
      const still = frozen ? members.filter((c) => !frozen.ids.includes(c.id)) : members;
      const box = members.length === 0 ? emptyBox(liveEmpty.get(o.id) ?? { x: F.X0, y: 40 }) : boxOf((still.length ? still : members).map((c) => live.get(c.id)!))!;
      return { o, box, empty: members.length === 0, count: members.length, done: members.filter((c) => c.state === 'done').length };
    });
    let chip: { x: number; y: number; link: RoadmapLink } | null = null;
    const links = flow.links
      .map((l) => {
        const a = live.get(l.from);
        const b = live.get(l.to);
        if (!a || !b) return null;
        const c = curve(a.x + F.W, a.y + F.H / 2, b.x, b.y + F.H / 2);
        const key = linkKey(l);
        if (sel.kind === 'link' && sel.key === key) chip = { x: Math.round(c.mx), y: Math.round(c.my), link: l };
        return { key, l, d: c.d, head: c.head, ...linkStyle(key, l) };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => a.z - b.z);
    const toVision = groups.map((g) => {
      const y = Math.max(F.VY + 90, Math.min(F.VY + size.vh - 20, g.box.y + 17));
      const sx = g.box.x + g.box.w;
      return { key: `v-${g.o.id}`, d: `M ${sx} ${g.box.y + 17} C ${sx + 40} ${g.box.y + 17}, ${size.vx - 48} ${y}, ${size.vx - 8} ${y}`, head: `M ${size.vx - 1} ${y} L ${size.vx - 8} ${y - 4.5} L ${size.vx - 8} ${y + 4.5} Z`, warn: g.empty };
    });
    let preview: { d: string; head: string } | null = null;
    if (d && d.kind === 'flink' && d.moved) {
      const a = live.get(d.id)!;
      let tx = d.x, ty = d.y;
      if (d.over) {
        const b = live.get(d.over)!;
        tx = d.side === 'r' ? b.x : b.x + F.W;
        ty = b.y + F.H / 2;
      }
      preview = d.side === 'r' ? curve(a.x + F.W, a.y + F.H / 2, tx, ty) : curve(tx, ty, a.x, a.y + F.H / 2);
    }
    const marquee = d && d.kind === 'marquee' && d.moved ? { left: Math.min(d.x0, d.x1), top: Math.min(d.y0, d.y1), width: Math.abs(d.x1 - d.x0), height: Math.abs(d.y1 - d.y0) } : null;
    const editInput = (id: string, kind: Editing['kind'], cls: string, label: string, placeholder: string) => (
      <input
        className={cls}
        autoFocus
        value={editing?.draft ?? ''}
        placeholder={placeholder}
        aria-label={label}
        data-testid={kind === 'project' ? `rf-edit-${id}` : `rf-edit-group-${id}`}
        onFocus={(e) => e.target.select()}
        onPointerDown={(e) => e.stopPropagation()}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== 'Escape') return;
          e.preventDefault();
          if (e.key === 'Enter') commitEdit();
          else cancelEdit();
        }}
        onBlur={commitEdit}
      />
    );
    const chipLink = chip as { x: number; y: number; link: RoadmapLink } | null;
    return (
      <>
        <div className="px-rf-scroll" ref={scrollRef}>
          <div className="px-rf-wrap" style={{ width: size.w * zoom, height: size.h * zoom }}>
            <div
              ref={boardRef}
              className={`px-rf-board px-rf-board--free${d?.moved ? ' px-rf-board--drag' : ''}${d && d.kind === 'flink' ? ' px-rf-board--linking' : ''}`}
              data-testid="rf-board"
              style={{ width: size.w, height: size.h, transform: `scale(${zoom})` }}
              onPointerDown={fBoardDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onCancel}
            >
              {groups.map((g) => {
                const isSel = sel.kind === 'outcome' && sel.id === g.o.id;
                const dim = (selP && !chain && !multiOn && selP.outcomeId !== g.o.id) || (selO && !isSel);
                return (
                  <div
                    key={g.o.id}
                    className={['px-rf-group', g.empty && 'px-rf-group--empty', isSel && 'px-rf-group--sel', frozen?.over === g.o.id && 'px-rf-group--drop', dim && 'px-rf-group--dim'].filter(Boolean).join(' ')}
                    data-testid={`rf-group-${g.o.id}`}
                    style={{ left: g.box.x, top: g.box.y, width: g.box.w, height: g.box.h }}
                  >
                    {editing?.kind === 'outcome' && editing.id === g.o.id ? (
                      editInput(g.o.id, 'outcome', 'px-rf-group-input', 'Outcome name', 'Name this outcome')
                    ) : (
                      <button
                        type="button"
                        className="px-rf-group-head"
                        aria-pressed={isSel}
                        aria-label={`Outcome ${g.o.name}. Drag to move, double-click to rename.`}
                        onPointerDown={(e) => fGroupDown(e, g.o.id)}
                        onClick={(e) => {
                          if (e.detail === 0) setSel({ kind: 'outcome', id: g.o.id });
                        }}
                      >
                        <svg width="10" height="12" viewBox="0 0 10 12" aria-hidden="true" className="px-rf-grip">
                          <circle cx="2.5" cy="2" r="1.2" /><circle cx="7.5" cy="2" r="1.2" /><circle cx="2.5" cy="6" r="1.2" /><circle cx="7.5" cy="6" r="1.2" /><circle cx="2.5" cy="10" r="1.2" /><circle cx="7.5" cy="10" r="1.2" />
                        </svg>
                        <span>{g.o.name || 'Outcome'}</span>
                        {g.o.statement && <span className="px-rf-group-t">· {g.o.statement}</span>}
                        <span className="px-rf-group-n">{g.count ? `${g.done}/${g.count}` : ''}</span>
                      </button>
                    )}
                    {g.empty && (
                      <span className="px-rf-group-empty">
                        <Warn /> Nothing delivers this yet. Drop projects here.
                      </span>
                    )}
                  </div>
                );
              })}
              <svg className="px-rf-edges" width={size.w} height={size.h} aria-hidden="true">
                {toVision.map((v) => (
                  <g key={v.key}>
                    <path d={v.d} fill="none" stroke={v.warn ? 'var(--px-rf-amber-line)' : 'var(--px-rf-lane-link)'} strokeWidth={1.5} strokeDasharray="4 5" strokeLinecap="round" />
                    <path d={v.head} fill={v.warn ? 'var(--px-rf-amber-line)' : 'var(--px-rf-lane-link)'} />
                  </g>
                ))}
                {links.map((v) => (
                  <g key={v.key} data-testid={`rf-link-${v.key}`} data-kind={v.l.kind}>
                    <path d={v.d} fill="none" stroke={v.stroke} strokeWidth={v.w} strokeDasharray={v.l.kind === 'SS' ? '6 5' : undefined} strokeLinecap="round" />
                    <path d={v.head} fill={v.stroke} />
                    <path className="px-rf-hit" d={v.d} data-testid={`rf-hit-${v.key}`} onPointerDown={(e) => fEdgeDown(e, v.key)} />
                  </g>
                ))}
                {preview && (
                  <g>
                    <path d={preview.d} fill="none" stroke="var(--px-accent)" strokeWidth={2} strokeDasharray="6 5" strokeLinecap="round" />
                    <path d={preview.head} fill="var(--px-accent)" />
                  </g>
                )}
              </svg>
              <div className={`px-rf-vdoor${sel.kind === 'roadmap' && !multiOn ? ' px-rf-vdoor--sel' : ''}`} style={{ left: size.vx, top: F.VY, width: F.VW, height: size.vh }}>
                <div className="px-rf-vdoor-frame" />
                <div className="px-rf-vdoor-fill">
                  <VisionDoor size={22} />
                  <span className="px-rf-eyebrow">Vision</span>
                  <span className="px-rf-vdoor-text">{vision?.title ?? 'No vision'}</span>
                  <span className="px-rf-vdoor-meta">{flow.maxStep ? `Reached after ${plural(flow.maxStep, 'step')}` : 'Nothing leads here yet'}</span>
                  <span style={{ flex: '1 1 auto' }} />
                  <span className="px-rf-vdoor-meta">Every outcome group feeds the vision</span>
                </div>
                <div className="px-rf-vdoor-floor" />
                <button type="button" className="px-rf-vdoor-btn" data-testid="rf-vision" aria-label={`The vision: ${vision?.title ?? ''}`} onPointerDown={(e) => e.stopPropagation()} onClick={clearSel} />
              </div>
              {flow.cards.map((c) => {
                const q = live.get(c.id);
                if (!q) return null;
                const dragging = dragIds.includes(c.id);
                return (
                  <div
                    key={c.id}
                    className={[
                      'px-rf-fcard',
                      (selP?.id === c.id || inMulti(c.id)) && 'px-rf-card--sel',
                      dragging && 'px-rf-fcard--drag',
                      dimCard(c) && !dragging && 'px-rf-card--dim',
                      chain && flow.onChain.has(c.id) && 'px-rf-card--chain',
                      c.state === 'done' && 'px-rf-card--done',
                      d && d.kind === 'flink' && d.over === c.id && 'px-rf-card--target',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    data-testid={`rf-fcard-${c.id}`}
                    data-outcome={c.outcomeId ?? ''}
                    style={{ left: q.x, top: q.y }}
                  >
                    {editing?.kind === 'project' && editing.id === c.id ? (
                      editInput(c.id, 'project', 'px-rf-finput', 'Project name', 'Name this project')
                    ) : (
                      <button
                        type="button"
                        className="px-rf-body"
                        aria-pressed={selP?.id === c.id}
                        aria-label={`${c.title}, ${c.step === null ? 'any time' : `step ${c.step}`}, ${c.meta}`}
                        onPointerDown={(e) => fCardDown(e, c.id)}
                        onClick={(e) => {
                          if (e.detail === 0) pick(c.id);
                        }}
                      >
                        <span className="px-rf-ftop">
                          <span className="px-rf-fstep" title="Step in the order of work">{c.step ?? '·'}</span>
                          <span className="px-rf-ftitle">{c.title}</span>
                        </span>
                        <span className="px-rf-meta">
                          <Door state={c.state} />
                          <span>{c.meta}</span>
                          {hasOutcomes && !c.leads && (
                            <span className="px-rf-dead" title="Doesn’t deliver an outcome or lead to one">
                              <Warn size={10} /> dead end
                            </span>
                          )}
                        </span>
                      </button>
                    )}
                    <button type="button" className="px-rf-handle px-rf-handle--l" data-testid={`rf-handle-l-${c.id}`} aria-label={`Add a step before ${c.title}, or drag to link`} onPointerDown={(e) => portDown(e, c.id, 'l', 'flink')}>
                      <Ic name="plus" />
                    </button>
                    <button type="button" className="px-rf-handle px-rf-handle--r" data-testid={`rf-handle-r-${c.id}`} aria-label={`Add a next step after ${c.title}, or drag to link`} onPointerDown={(e) => portDown(e, c.id, 'r', 'flink')}>
                      <Ic name="plus" />
                    </button>
                  </div>
                );
              })}
              {chipLink && (
                <div className="px-rf-chip" style={{ left: chipLink.x, top: chipLink.y }} onPointerDown={(e) => e.stopPropagation()}>
                  {chipLink.link.edge && (
                    <>
                      <button type="button" className="px-rf-chip-btn" aria-label="Reverse this link" title="Reverse" onClick={() => void reverseLink(chipLink.link)}>
                        <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" className="px-rf-stroke"><path d="M4 8h14l-4-4M20 16H6l4 4" /></svg>
                      </button>
                      <button type="button" className="px-rf-chip-btn px-rf-chip-btn--danger" aria-label="Remove this link" title="Remove link" onClick={() => void removeLink(chipLink.link)}>
                        <Ic name="x" />
                      </button>
                    </>
                  )}
                  {!chipLink.link.edge && <span className="px-rf-chip-note">via tasks</span>}
                </div>
              )}
              {marquee && <div className="px-rf-marquee" style={marquee} />}
            </div>
          </div>
        </div>
        <div className="px-rf-legend">
          <span><kbd>Double-click</kbd> empty space: new project (inside a group, it delivers that outcome)</span>
          <span><kbd>Drag</kbd> a card into a group to change its outcome; drag a group by its header</span>
          <span><kbd>Drag ●</kbd> onto a card to link, or onto empty space for a new step</span>
          <span><kbd>Click ●</kbd> add the next step, or one before</span>
          <span><kbd>Shift</kbd> click, or drag a box, to select several</span>
          <span><kbd>Del</kbd> delete</span>
        </div>
      </>
    );
  };

  // --- render: details panel ------------------------------------------------------------------
  const fit = () => {
    const w = scrollRef.current ? scrollRef.current.clientWidth - 4 : boardSize.w;
    setZoom(Math.max(0.5, Math.min(1.25, Math.floor((w / boardSize.w) * 20) / 20)));
  };
  const firstOutcome = outcomes[0]?.id ?? null;

  const doneCount = flow.cards.filter((c) => c.state === 'done').length;
  const nowCount = flow.cards.filter((c) => c.state === 'now').length;
  const zoomOut = () => setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(2)));
  const zoomIn = () => setZoom((z) => Math.min(1.5, +(z + 0.1).toFixed(2)));

  return (
    <div
      className={`px-rb${visionColor ? ' px-rb--vc' : ''}`}
      data-testid="rf"
      data-layout={layout}
      style={visionColor ? ({ '--px-rf-vc': visionColor.hex } as CSSProperties) : undefined}
    >
      <div className="px-rb-main">
        {top}

        {/* The roadmap: its vision, its name, what has to be true, and where it stands. */}
        <section className="px-rb-hdr" aria-label="Roadmap">
          <div className="px-rb-hdr-main">
            <div className="px-rb-vision">
              <span className="px-rf-eyebrow">Vision</span>
              {visionColor && (
                <span className="px-swatch px-swatch--sm" data-testid="rm-vision-swatch" data-color={visionColor.name} style={{ background: visionColor.hex }} />
              )}
              <button type="button" className="px-rb-vision-link" data-testid="rm-vision-name" onClick={clearSel}>
                {vision ? vision.title : 'No vision'}
              </button>
            </div>
            {titleSlot ?? <h2 className="px-rb-title">{roadmap.title}</h2>}
            {roadmap.description.trim() !== '' && (
              <p className="px-rm-desc" data-testid="rm-description">
                {roadmap.description}
              </p>
            )}
            <div className="px-rb-realized" data-testid="rf-outcomes">
              <span className="px-rb-realized-l">Realized when</span>
              {flow.caps.map((c) => (
                <button
                  key={c.outcome.id}
                  type="button"
                  className={`px-rf-ochip${sel.kind === 'outcome' && sel.id === c.outcome.id ? ' px-rf-ochip--sel' : ''}${c.count ? '' : ' px-rf-ochip--warn'}`}
                  data-testid={`rf-ochip-${c.outcome.id}`}
                  onClick={() => {
                    setSel({ kind: 'outcome', id: c.outcome.id });
                    setMulti([]);
                  }}
                >
                  <span>{c.outcome.statement || c.outcome.name || 'Untitled outcome'}</span>
                  <span className="px-rf-ochip-n">{c.count ? `${c.done}/${c.count}` : 'gap'}</span>
                </button>
              ))}
              {!hasOutcomes && <span className="px-rf-outcomes-hint">Name what has to be true for this roadmap to be done — each outcome becomes a row.</span>}
              <button type="button" className="px-rf-ochip px-rf-ochip--add" data-testid="rf-add-outcome-chip" onClick={() => void addOutcome()}>
                + Outcome
              </button>
            </div>
          </div>
          <dl className="px-rb-stats" data-testid="rm-stats">
            <div className="px-rb-stat">
              <dt>Steps to the vision</dt>
              <dd data-testid="rm-step-count">{flow.maxStep}</dd>
            </div>
            <div className="px-rb-stat">
              <dt>Projects</dt>
              <dd data-testid="rm-project-count">{flow.cards.length}</dd>
            </div>
            <div className="px-rb-stat">
              <dt>Done</dt>
              <dd>{doneCount}</dd>
            </div>
            <div className="px-rb-stat">
              <dt>In progress</dt>
              <dd>{nowCount}</dd>
            </div>
          </dl>
          {menuSlot}
        </section>

        {/* The builder: view switch and what you can add, then the layout switch, the gaps, the board. */}
        <section
          className="px-rb-builder"
          aria-label="Roadmap builder"
          data-testid="rm-views"
          data-view={view}
          style={visionColor ? ({ '--px-rm-c': visionColor.hex } as CSSProperties) : undefined}
        >
          <div className="px-rb-toolbar">
            {renderView && (
              <div className="px-rb-seg" role="radiogroup" aria-label="Roadmap view">
                {VIEW_TABS.map((v) => (
                  <button
                    key={v.value}
                    type="button"
                    role="radio"
                    aria-checked={view === v.value}
                    className={view === v.value ? 'px-rb-seg--on' : undefined}
                    data-testid={`rm-view-${v.value}`}
                    onClick={() => setView(v.value)}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              className="px-rb-btn px-rb-btn--primary"
              data-testid="rf-add-project"
              onClick={() =>
                void addProject({
                  outcomeId: selP ? selP.outcomeId : selO ? selO.id : firstOutcome,
                  ...(selP && layout === 'free' && view === 'flow' ? { after: selP.id, inline: true } : {}),
                })
              }
            >
              <Ic name="plus" /> Project
            </button>
            <button type="button" className="px-rb-btn" data-testid="rf-add-outcome" onClick={() => void addOutcome(multiOn ? multi : [])}>
              <Ic name="plus" /> {multiOn ? 'Group as outcome' : 'Outcome'}
            </button>
            {view === 'flow' && (
              <button type="button" className="px-rb-btn px-rf-toggle" data-testid="rf-chain" aria-pressed={chain} onClick={() => setChain(!chain)}>
                <span className="px-rf-sw" aria-hidden="true" /> Longest chain
              </button>
            )}
            {view === 'flow' && (
              <div className="px-rf-zoom">
                <button type="button" className="px-rb-icon" aria-label="Zoom out" onClick={zoomOut}>
                  −
                </button>
                <span className="px-rf-z">{Math.round(zoom * 100)}%</span>
                <button type="button" className="px-rb-icon" aria-label="Zoom in" onClick={zoomIn}>
                  +
                </button>
                <button type="button" className="px-rb-btn px-rb-btn--quiet" onClick={fit}>
                  Fit
                </button>
              </div>
            )}
          </div>

          {view === 'flow' && (
            <div className="px-rb-subbar">
              <div className="px-rb-seg px-rb-seg--sm" role="radiogroup" aria-label="Flow layout">
                {(
                  [
                    ['structured', 'Structured', 'flow'],
                    ['free', 'Free flow', 'freeflow'],
                  ] as const
                ).map(([value, label, icon]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={layout === value}
                    className={layout === value ? 'px-rb-seg--on' : undefined}
                    data-testid={`rf-layout-${value}`}
                    onClick={() => setLayout(value)}
                  >
                    <Ic name={icon} /> {label}
                  </button>
                ))}
              </div>
              <span className="px-rb-hint">
                <span className="px-rb-hint-dot" aria-hidden="true" />
                {layout === 'structured'
                  ? 'Rows are outcomes, columns are steps worked out from the links. Drag a card’s dot onto another card to say which comes first.'
                  : 'Groups are outcomes. Move, group and relink anything; the step numbers still come from the links.'}
              </span>
              {layout === 'free' && (
                <button type="button" className="px-rb-btn px-rb-btn--sm px-rb-tidy" data-testid="rf-tidy" onClick={() => void tidyUp()}>
                  <Ic name="list" /> Tidy up
                </button>
              )}
            </div>
          )}

          {flow.gaps.length > 0 && (
            <div className="px-rf-gaps" role="status" data-testid="rf-gaps">
              <Warn size={14} />
              <b>{plural(flow.gaps.length, 'gap')}</b> between this roadmap and its vision:
              {flow.gaps.map((g) => (
                <button
                  key={g.key}
                  type="button"
                  className="px-rf-gap"
                  onClick={() => (g.kind === 'outcome' ? void addProject({ outcomeId: g.id }) : pick(g.id))}
                >
                  <span>{g.text}</span>
                  <span className="px-rf-gap-act">{g.kind === 'outcome' ? 'Add a project' : 'Assign'}</span>
                </button>
              ))}
            </div>
          )}
          {flow.cards.length === 0 && (
            <p className="px-rf-emptystate" data-testid="rm-no-projects">
              This roadmap has no projects yet. Start with the outcomes it has to make true, then use “+ Project” to add what delivers each one.
            </p>
          )}
          <div className="px-rb-stage" ref={stageRef}>
            {view === 'flow' ? (
              layout === 'free' ? (
                freeBoard()
              ) : (
                structured()
              )
            ) : (
              <div className="px-rb-other">{renderView?.(view, { selectedId: selP?.id ?? null, onPick: pick })}</div>
            )}
          </div>
        </section>
      </div>

      <aside className="px-rb-insp" aria-label="Details" data-testid="rf-inspector" data-kind={multiOn ? 'multi' : sel.kind}>
       <div className="px-rb-insp-in">
        {multiOn ? (
          <MultiPanel
            key={multi.join()}
            cards={multi.map((id) => card(id)).filter((c): c is FlowCard => !!c)}
            outcomes={outcomes}
            onPick={pick}
            onClose={clearSel}
            onDeliver={async (oid) => {
              for (const id of multi) if (card(id)?.outcomeId !== oid) await setOutcome(id, oid);
              say(`${plural(multi.length, 'project')} now ${oid ? `deliver “${outcomeById(oid)?.name || 'that outcome'}”` : 'deliver no outcome'}.`);
            }}
            onGroup={() => void addOutcome(multi)}
            onChain={() => void chainProjects(multi)}
            onDelete={() => void deleteProjects(multi)}
          />
        ) : selP ? (
          <ProjectPanel
            key={selP.id}
            c={selP}
            flow={flow}
            outcomes={outcomes}
            maxStep={flow.maxStep}
            onPick={pick}
            onClose={clearSel}
            onRename={(t) => void safe('rename it', () => actions.rename(selP.id, t))}
            onOutcome={(oid) => void setOutcome(selP.id, oid)}
            onDoneWhen={(t) => void setExtras(selP.id, { doneWhen: t })}
            onSize={(s) => void setExtras(selP.id, { size: s })}
            onAddBefore={(id) => void addLink(id, selP.id)}
            onAddAfter={(id) => (id === '__new' ? void addProject({ outcomeId: selP.outcomeId, after: selP.id }) : void addLink(selP.id, id))}
            onKind={(l, k) => void setLinkKind(l, k)}
            onRemoveLink={(l) => void removeLink(l)}
            onOpen={() => onNavigate('/projects')}
            onDelete={() => void deleteProjects([selP.id])}
          />
        ) : selL ? (
          <LinkPanel
            key={linkKey(selL)}
            l={selL}
            flow={flow}
            onPick={pick}
            onClose={clearSel}
            onKind={(k) => void setLinkKind(selL, k)}
            onReverse={() => void reverseLink(selL)}
            onRemove={() => void removeLink(selL)}
          />
        ) : selO ? (
          <OutcomePanel
            key={selO.id}
            o={selO}
            index={outcomes.findIndex((o) => o.id === selO.id)}
            count={outcomes.length}
            cards={flow.cards.filter((c) => c.outcomeId === selO.id)}
            free={layout === 'free'}
            onPick={pick}
            onClose={clearSel}
            onPatch={(patch) => void patchOutcome(selO.id, patch)}
            onAddProject={() => void addProject({ outcomeId: selO.id })}
            onMove={(dir) => moveOutcome(selO.id, dir)}
            onDelete={() => void deleteOutcome(selO.id)}
          />
        ) : (
          <RoadmapPanel
            vision={vision}
            caps={flow.caps}
            onOutcome={(id) => setSel({ kind: 'outcome', id })}
            onAddOutcome={() => void addOutcome()}
            onEditVision={() => onNavigate('/vision')}
          />
        )}
       </div>
      </aside>
      {toast && (
        <div className="px-rf-toast" role="status" data-testid="rf-toast">
          {toast}
        </div>
      )}
    </div>
  );
}

/** JSON with sorted keys: the synced row's jsonb comes back in its own key order. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

function freeBoardSize(free: FreeLayout, drag: Drag | null) {
  let right = 0;
  let bottom = 0;
  const ids = drag && (drag.kind === 'fcards' || drag.kind === 'fgroup') && drag.moved ? drag.ids : [];
  const dx = drag && 'dx' in drag ? drag.dx : 0;
  const dy = drag && 'dy' in drag ? drag.dy : 0;
  for (const [id, q] of free.proj) {
    const x = ids.includes(id) ? q.x + dx : q.x;
    const y = ids.includes(id) ? q.y + dy : q.y;
    right = Math.max(right, x + F.W + 16);
    bottom = Math.max(bottom, y + F.H + 14);
  }
  for (const q of free.empty.values()) {
    const b = emptyBox(q);
    right = Math.max(right, b.x + b.w);
    bottom = Math.max(bottom, b.y + b.h);
  }
  const vx = Math.max(F.MIN_VX, right + 90);
  const h = Math.max(640, bottom + 70);
  return { w: vx + F.VW + 24, h, vx, vh: h - 48 };
}

function CardFace({ c, warn }: { c: FlowCard; warn: boolean }) {
  return (
    <>
      <span className="px-rf-title">{c.title}</span>
      {c.state === 'now' && (
        <span className="px-rf-bar-line">
          <i style={{ width: `${c.pct}%` } as CSSProperties} />
        </span>
      )}
      <span className="px-rf-meta">
        <Door state={c.state} />
        <span>{c.meta}</span>
        {warn && (
          <span title="Doesn’t deliver an outcome">
            <Warn />
          </span>
        )}
        {c.extras.size && <span className="px-rf-size">{c.extras.size}</span>}
      </span>
    </>
  );
}

/** A text field that writes on blur / Enter, and follows the stored value while not being edited. */
function CommitText({
  id,
  value,
  onCommit,
  multiline,
  className,
  placeholder,
  label,
  rows,
}: {
  id: string;
  value: string;
  onCommit: (v: string) => void;
  multiline?: boolean;
  className: string;
  placeholder?: string;
  label: string;
  rows?: number;
}) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  const commit = () => {
    focused.current = false;
    if (draft !== value) onCommit(draft);
  };
  const common = {
    id,
    className,
    value: draft,
    placeholder,
    'aria-label': label,
    'data-testid': id,
    onFocus: () => (focused.current = true),
    onBlur: commit,
  };
  return multiline ? (
    <textarea {...common} rows={rows ?? 3} onChange={(e) => setDraft(e.target.value)} />
  ) : (
    <input
      {...common}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setDraft(value);
          focused.current = false;
        }
      }}
    />
  );
}

function PanelHead({ eyebrow, chip, onClose }: { eyebrow: string; chip?: string; onClose: () => void }) {
  return (
    <div className="px-rf-insp-head">
      <span className="px-rf-eyebrow">{eyebrow}</span>
      {chip && <span className="px-rf-chipstep">{chip}</span>}
      <span style={{ flex: '1 1 auto' }} />
      <button type="button" className="px-btn px-btn--sm px-btn--ghost" aria-label="Close details" onClick={onClose}>
        <Ic name="x" />
      </button>
    </div>
  );
}

function DepRow({ id, flow, side, link, onPick, onKind, onRemove }: { id: string; flow: FlowModel; side: 'after' | 'unlocks'; link: RoadmapLink; onPick: (id: string) => void; onKind: (k: LinkKind) => void; onRemove: () => void }) {
  const q = flow.byId.get(id);
  if (!q) return null;
  return (
    <div className="px-rf-dep" data-testid={`rf-dep-${link.from}-${link.to}`}>
      <button type="button" className="px-rf-dep-name" onClick={() => onPick(id)}>
        <Door state={q.state} />
        <span>{q.title}</span>
      </button>
      {link.edge ? (
        <button
          type="button"
          className="px-rf-dep-kind"
          data-testid={`rf-dep-kind-${link.from}-${link.to}`}
          title="Switch between finish → start and start together"
          onClick={() => onKind(link.kind === 'SS' ? 'FS' : 'SS')}
        >
          {kindLabel(link.kind, side)}
        </button>
      ) : (
        <span className="px-rf-dep-kind px-rf-dep-kind--static" title="Linked through tasks inside the two projects — edit those in Projects">
          via tasks
        </span>
      )}
      {link.edge && (
        <button type="button" className="px-btn px-btn--sm px-btn--ghost" aria-label={`Remove the link to ${q.title}`} data-testid={`rf-dep-remove-${link.from}-${link.to}`} onClick={onRemove}>
          <Ic name="x" />
        </button>
      )}
    </div>
  );
}

function ProjectPanel({
  c,
  flow,
  outcomes,
  maxStep,
  onPick,
  onClose,
  onRename,
  onOutcome,
  onDoneWhen,
  onSize,
  onAddBefore,
  onAddAfter,
  onKind,
  onRemoveLink,
  onOpen,
  onDelete,
}: {
  c: FlowCard;
  flow: FlowModel;
  outcomes: readonly FlowOutcome[];
  maxStep: number;
  onPick: (id: string) => void;
  onClose: () => void;
  onRename: (t: string) => void;
  onOutcome: (id: string | null) => void;
  onDoneWhen: (t: string) => void;
  onSize: (s: ProjectSize | null) => void;
  onAddBefore: (id: string) => void;
  onAddAfter: (id: string) => void;
  onKind: (l: RoadmapLink, k: LinkKind) => void;
  onRemoveLink: (l: RoadmapLink) => void;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const p = c.project;
  const inLinks = flow.links.filter((l) => l.to === c.id);
  const outLinks = flow.links.filter((l) => l.from === c.id);
  const before = flow.cards.filter((q) => q.id !== c.id && !p.waitsOn.includes(q.id) && !reaches(flow.links, c.id, q.id));
  const after = flow.cards.filter((q) => q.id !== c.id && !p.unblocks.includes(q.id) && !reaches(flow.links, q.id, c.id));
  const milestones = p.shape.children.filter((x) => x.node.node_type === 'milestone');
  const stateText =
    c.state === 'done'
      ? 'Done — every task in it is finished.'
      : c.state === 'now'
        ? `In progress · ${c.pct}% done`
        : c.state === 'ready'
          ? p.waitsOn.length
            ? 'Ready to start — everything before it is done.'
            : 'Ready to start — nothing has to come first.'
          : `Waiting on ${p.blockedBy.map((b) => flow.byId.get(b)?.title ?? '').join(' and ')}`;
  const hasOutcomes = outcomes.length > 0;
  return (
    <>
      <PanelHead eyebrow="Project" chip={c.step === null ? 'Any time' : `Step ${c.step} of ${maxStep}`} onClose={onClose} />
      <div className="px-rf-stack">
        <CommitText id="rf-p-title" className="px-rf-title-input" value={c.title} label="Project name" onCommit={(t) => t.trim() && onRename(t.trim())} />
        <div className="px-rf-state" data-testid="rf-p-state">
          <Door state={c.state} size={12} />
          <span>{stateText}</span>
        </div>
      </div>
      {flow.onChain.has(c.id) && c.state !== 'done' && <div className="px-rf-note">On the longest chain. A slip here pushes back the whole roadmap.</div>}
      {hasOutcomes && !c.outcomeId && (
        <div className="px-rf-warnnote">
          <Warn size={14} />
          <span>
            This doesn’t move any outcome{c.leads ? ' itself, though it leads to projects that do.' : ', so it doesn’t move the vision. Pick the outcome it serves.'}
          </span>
        </div>
      )}
      <div className="px-rf-field">
        <label className="px-rf-label" htmlFor="rf-p-outcome">
          Delivers
        </label>
        <select id="rf-p-outcome" data-testid="rf-p-outcome" className={`px-rf-select${hasOutcomes && !c.outcomeId ? ' px-rf-select--warn' : ''}`} value={c.outcomeId ?? ''} onChange={(e) => onOutcome(e.target.value || null)}>
          <option value="">No outcome</option>
          {outcomes.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name || 'Outcome'}
              {o.statement ? ` · ${o.statement}` : ''}
            </option>
          ))}
        </select>
      </div>
      <div className="px-rf-field">
        <label className="px-rf-label" htmlFor="rf-p-done">
          Done when
        </label>
        <CommitText id="rf-p-done" multiline className="px-rf-textarea" value={c.extras.doneWhen} label="Done when" placeholder="One sentence: what is true once this project is finished?" onCommit={onDoneWhen} />
      </div>
      <div className="px-rf-field">
        <span className="px-rf-label" id="rf-p-size-l">
          Rough size
        </span>
        <div className="px-rf-seg" role="group" aria-labelledby="rf-p-size-l">
          {PROJECT_SIZES.map((s) => (
            <button key={s.value} type="button" aria-pressed={c.extras.size === s.value} data-testid={`rf-p-size-${s.value}`} onClick={() => onSize(c.extras.size === s.value ? null : s.value)}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <div className="px-rf-sec">
        <div className="px-rf-sec-head">
          <span>Has to happen first</span>
          <span className="px-rf-n">{inLinks.length}</span>
        </div>
        {inLinks.map((l) => (
          <DepRow key={linkKey(l)} id={l.from} flow={flow} side="after" link={l} onPick={onPick} onKind={(k) => onKind(l, k)} onRemove={() => onRemoveLink(l)} />
        ))}
        {inLinks.length === 0 && <p className="px-rf-empty">Nothing — it can start any time.</p>}
        <select className="px-rf-add" data-testid="rf-add-before" aria-label="Add something that must come first" value="" onChange={(e) => e.target.value && onAddBefore(e.target.value)}>
          <option value="">+ Add something that must come first…</option>
          {before.map((q) => (
            <option key={q.id} value={q.id}>
              {q.title}
            </option>
          ))}
        </select>
      </div>
      <div className="px-rf-sec">
        <div className="px-rf-sec-head">
          <span>Unlocks</span>
          <span className="px-rf-n">{outLinks.length}</span>
        </div>
        {outLinks.map((l) => (
          <DepRow key={linkKey(l)} id={l.to} flow={flow} side="unlocks" link={l} onPick={onPick} onKind={(k) => onKind(l, k)} onRemove={() => onRemoveLink(l)} />
        ))}
        {outLinks.length === 0 && <p className="px-rf-empty">Nothing waits on it yet.</p>}
        <select className="px-rf-add" data-testid="rf-add-after" aria-label="Add what this makes possible" value="" onChange={(e) => e.target.value && onAddAfter(e.target.value)}>
          <option value="">+ Add what this makes possible…</option>
          <option value="__new">A new project</option>
          {after.map((q) => (
            <option key={q.id} value={q.id}>
              {q.title}
            </option>
          ))}
        </select>
      </div>
      <div className="px-rf-sec">
        <div className="px-rf-sec-head">
          <span>Milestones</span>
          <span className="px-rf-n">{milestones.length ? `${milestones.filter(itemDone).length} of ${milestones.length}` : ''}</span>
        </div>
        {milestones.map((m) => (
          <div key={m.node.id} className={`px-rf-ms${itemDone(m) ? ' px-rf-ms--done' : ''}`}>
            <span className="px-rf-ms-box" aria-hidden="true" />
            <span>{m.node.title}</span>
          </div>
        ))}
        {milestones.length === 0 && <p className="px-rf-empty">No milestones yet.</p>}
        <p className="px-rf-hint">
          {p.shape.tasks ? `${plural(p.shape.tasks, 'task')} live inside the project — ${p.shape.openTasks} open. This view never shows them.` : 'No tasks yet. Add milestones and tasks in Projects when it gets closer.'}
        </p>
      </div>
      <div className="px-rf-foot">
        <button type="button" className="px-btn px-btn--sm" data-testid="rf-p-open" onClick={onOpen}>
          Open in Projects
        </button>
        <span style={{ flex: '1 1 auto' }} />
        <button type="button" className="px-btn px-btn--sm px-btn--danger" data-testid="rf-p-delete" onClick={onDelete}>
          <Ic name="trash" /> Delete
        </button>
      </div>
    </>
  );
}

function OutcomePanel({
  o,
  index,
  count,
  cards,
  free,
  onPick,
  onClose,
  onPatch,
  onAddProject,
  onMove,
  onDelete,
}: {
  o: FlowOutcome;
  index: number;
  count: number;
  cards: readonly FlowCard[];
  free: boolean;
  onPick: (id: string) => void;
  onClose: () => void;
  onPatch: (patch: Partial<FlowOutcome>) => void;
  onAddProject: () => void;
  onMove: (dir: -1 | 1) => void;
  onDelete: () => void;
}) {
  const sorted = [...cards].sort((a, b) => (a.step ?? 0) - (b.step ?? 0));
  return (
    <>
      <PanelHead eyebrow="Outcome" chip={free ? 'a group in free flow' : 'a row in the flow'} onClose={onClose} />
      <div className="px-rf-field">
        <label className="px-rf-label" htmlFor="rf-o-name">
          Short name
        </label>
        <CommitText id="rf-o-name" className="px-rf-input" value={o.name} label="Short name" onCommit={(v) => onPatch({ name: v.trim() || 'Outcome' })} />
      </div>
      <div className="px-rf-field">
        <label className="px-rf-label" htmlFor="rf-o-statement">
          What has to be true
        </label>
        <CommitText id="rf-o-statement" multiline rows={2} className="px-rf-textarea" value={o.statement} label="What has to be true" placeholder="For example: the studio runs without me three days a week" onCommit={(v) => onPatch({ statement: v })} />
      </div>
      {cards.length === 0 && (
        <div className="px-rf-warnnote">
          <Warn size={14} />
          <span>Nothing on this roadmap delivers this yet. Until something does, the roadmap can’t reach its vision.</span>
        </div>
      )}
      <div className="px-rf-field">
        <label className="px-rf-label" htmlFor="rf-o-measure">
          How you’ll know it’s true
        </label>
        <CommitText id="rf-o-measure" multiline className="px-rf-textarea" value={o.measure} label="How you’ll know it’s true" onCommit={(v) => onPatch({ measure: v })} />
      </div>
      <div className="px-rf-sec">
        <div className="px-rf-sec-head">
          <span>Projects that deliver it</span>
          <span className="px-rf-n">
            {cards.filter((c) => c.state === 'done').length} of {cards.length} done
          </span>
        </div>
        {sorted.map((c) => (
          <div key={c.id} className="px-rf-dep">
            <button type="button" className="px-rf-dep-name" onClick={() => onPick(c.id)}>
              <Door state={c.state} />
              <span>{c.title}</span>
            </button>
            <span className="px-rf-dep-kind px-rf-dep-kind--static">{c.step === null ? 'any time' : `step ${c.step}`}</span>
          </div>
        ))}
        <button type="button" className="px-rf-addbtn" data-testid="rf-o-add-project" onClick={onAddProject}>
          <Ic name="plus" /> Add a project for this outcome
        </button>
      </div>
      <div className="px-rf-foot">
        <button type="button" className="px-btn px-btn--sm px-btn--ghost" disabled={index <= 0} onClick={() => onMove(-1)}>
          Move up
        </button>
        <button type="button" className="px-btn px-btn--sm px-btn--ghost" disabled={index >= count - 1} onClick={() => onMove(1)}>
          Move down
        </button>
        <span style={{ flex: '1 1 auto' }} />
        <button type="button" className="px-btn px-btn--sm px-btn--danger" data-testid="rf-o-delete" onClick={onDelete}>
          {free ? 'Ungroup' : 'Remove outcome'}
        </button>
      </div>
    </>
  );
}

function LinkPanel({
  l,
  flow,
  onPick,
  onClose,
  onKind,
  onReverse,
  onRemove,
}: {
  l: RoadmapLink;
  flow: FlowModel;
  onPick: (id: string) => void;
  onClose: () => void;
  onKind: (k: LinkKind) => void;
  onReverse: () => void;
  onRemove: () => void;
}) {
  const a = flow.byId.get(l.from);
  const b = flow.byId.get(l.to);
  if (!a || !b) return null;
  return (
    <>
      <PanelHead eyebrow="Link" onClose={onClose} />
      <div className="px-rf-stack">
        <div className="px-rf-dep">
          <button type="button" className="px-rf-dep-name" onClick={() => onPick(a.id)}>
            <Door state={a.state} />
            <span>{a.title}</span>
          </button>
          <span className="px-rf-dep-kind px-rf-dep-kind--static">first</span>
        </div>
        <div className="px-rf-dep">
          <button type="button" className="px-rf-dep-name" onClick={() => onPick(b.id)}>
            <Door state={b.state} />
            <span>{b.title}</span>
          </button>
          <span className="px-rf-dep-kind px-rf-dep-kind--static">then</span>
        </div>
      </div>
      {l.edge ? (
        <>
          <div className="px-rf-field">
            <span className="px-rf-label" id="rf-link-kind-l">
              How they connect
            </span>
            <div className="px-rf-seg" role="group" aria-labelledby="rf-link-kind-l">
              <button type="button" aria-pressed={l.kind === 'FS'} data-testid="rf-link-fs" onClick={() => onKind('FS')}>
                Finish → start
              </button>
              <button type="button" aria-pressed={l.kind === 'SS'} data-testid="rf-link-ss" onClick={() => onKind('SS')}>
                Start together
              </button>
            </div>
            <p className="px-rf-hint">
              {l.kind === 'SS' ? `${b.title} can start once ${a.title} has started. They share a step.` : `${b.title} starts after ${a.title} is finished.`}
              {l.inner && ' Tasks inside the two projects link them too.'}
            </p>
          </div>
          <div className="px-rf-foot">
            <button type="button" className="px-btn px-btn--sm" data-testid="rf-link-reverse" onClick={onReverse}>
              Reverse
            </button>
            <span style={{ flex: '1 1 auto' }} />
            <button type="button" className="px-btn px-btn--sm px-btn--danger" data-testid="rf-link-remove" onClick={onRemove}>
              Remove link
            </button>
          </div>
        </>
      ) : (
        <p className="px-rf-hint">These two are linked through tasks inside them. Change those links in Projects.</p>
      )}
    </>
  );
}

function MultiPanel({
  cards,
  outcomes,
  onPick,
  onClose,
  onDeliver,
  onGroup,
  onChain,
  onDelete,
}: {
  cards: readonly FlowCard[];
  outcomes: readonly FlowOutcome[];
  onPick: (id: string) => void;
  onClose: () => void;
  onDeliver: (outcomeId: string | null) => void;
  onGroup: () => void;
  onChain: () => void;
  onDelete: () => void;
}) {
  return (
    <>
      <PanelHead eyebrow={`${cards.length} projects selected`} onClose={onClose} />
      <div className="px-rf-stack">
        {cards.map((c) => (
          <div key={c.id} className="px-rf-dep">
            <button type="button" className="px-rf-dep-name" onClick={() => onPick(c.id)}>
              <Door state={c.state} />
              <span>{c.title}</span>
            </button>
            <span className="px-rf-dep-kind px-rf-dep-kind--static">{outcomes.find((o) => o.id === c.outcomeId)?.name ?? 'no outcome'}</span>
          </div>
        ))}
      </div>
      <div className="px-rf-field">
        <label className="px-rf-label" htmlFor="rf-multi-outcome">
          Deliver one outcome
        </label>
        <select
          id="rf-multi-outcome"
          data-testid="rf-multi-outcome"
          className="px-rf-select"
          value=""
          onChange={(e) => {
            const v = e.target.value;
            if (!v) return;
            if (v === '__new') onGroup();
            else onDeliver(v === '__none' ? null : v);
          }}
        >
          <option value="">Choose…</option>
          {outcomes.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name || 'Outcome'}
            </option>
          ))}
          <option value="__new">A new outcome (group them)</option>
          <option value="__none">No outcome</option>
        </select>
        <p className="px-rf-hint">In free flow this is the same as dragging them into a group.</p>
      </div>
      <div className="px-rf-foot">
        <button type="button" className="px-btn px-btn--sm" data-testid="rf-multi-chain" onClick={onChain}>
          Link left to right
        </button>
        <span style={{ flex: '1 1 auto' }} />
        <button type="button" className="px-btn px-btn--sm px-btn--danger" data-testid="rf-multi-delete" onClick={onDelete}>
          Delete {cards.length}
        </button>
      </div>
    </>
  );
}

function RoadmapPanel({
  vision,
  caps,
  onOutcome,
  onAddOutcome,
  onEditVision,
}: {
  vision?: Node;
  caps: FlowModel['caps'];
  onOutcome: (id: string) => void;
  onAddOutcome: () => void;
  onEditVision: () => void;
}) {
  return (
    <>
      <div className="px-rf-insp-head">
        <span className="px-rf-eyebrow">Vision</span>
      </div>
      <div className="px-rf-stack">
        <div className="px-rf-vision-title" data-testid="rf-vision-title">
          {vision?.title ?? 'No vision'}
        </div>
        {vision?.description && <p className="px-rf-hint">{vision.description}</p>}
        <button type="button" className="px-rf-addbtn" onClick={onEditVision}>
          Edit in Plan › Vision
        </button>
      </div>
      <div className="px-rf-sec">
        <div className="px-rf-sec-head">
          <span>This roadmap is done when</span>
          <span className="px-rf-why">every outcome is true</span>
        </div>
        {caps.map((c) => (
          <button key={c.outcome.id} type="button" className={`px-rf-orow${c.count ? '' : ' px-rf-orow--warn'}`} onClick={() => onOutcome(c.outcome.id)}>
            <svg width="12" height="12" viewBox="6 0 188 188" aria-hidden="true" className="px-rf-outline-door">
              <polygon points={DOOR} />
            </svg>
            <span>{c.outcome.statement || c.outcome.name || 'Untitled outcome'}</span>
            <span className="px-rf-n">{c.count ? `${c.done}/${c.count}` : 'gap'}</span>
          </button>
        ))}
        {caps.length === 0 && <p className="px-rf-empty">No outcomes yet. Add the few things that have to be true — each becomes a row of the flow.</p>}
        <button type="button" className="px-rf-addbtn" data-testid="rf-panel-add-outcome" onClick={onAddOutcome}>
          <Ic name="plus" /> Add an outcome
        </button>
      </div>
      <div className="px-rf-sec">
        <div className="px-rf-sec-head">
          <span>Two ways to lay it out</span>
        </div>
        <p className="px-rf-hint">
          <b>Structured</b> puts each outcome in a row and works out the columns from the links. <b>Free flow</b> lets you move, group and relink anything by hand. Both edit the same roadmap.
        </p>
      </div>
    </>
  );
}
