/**
 * Plan › Roadmap › Flow, without a DOM: the roadmap as the projects that have
 * to happen, in order, for its outcomes — and through them the vision — to come
 * true. Two layouts over ONE roadmap:
 *
 *   Structured  one row per outcome, one column per step (worked out from the
 *               links), every row ending in its outcome and all of them in the
 *               vision.
 *   Free flow   the same projects and links, placed by hand. A group IS an
 *               outcome: dropping a card into one sets what the project delivers.
 *
 * Nothing here needs a new table:
 *   - outcomes live on the roadmap node, `attributes.outcomes`;
 *   - what a project delivers, its "done when" and rough size live on the
 *     project node, `attributes.outcome_id | done_when | size`;
 *   - free-flow spots are `diagram_layouts` rows with the roadmap as the diagram
 *     (and, for an outcome no project delivers yet, its own `x`/`y`);
 *   - links are dependency edges (FS / SS) straight from project to project.
 *
 * Status, steps and "waits on" come from roadmap-model, so they agree with the
 * Order / Mind map / Outline / List views and with Plan › Vision.
 */
import type { RoadmapLink, RoadmapModel, RoadmapProject } from './roadmap-model';

// --- what lives in attributes ----------------------------------------------------

export type DoorState = 'done' | 'now' | 'ready' | 'wait';
export type ProjectSize = 'S' | 'M' | 'L';
export const PROJECT_SIZES: readonly { value: ProjectSize; label: string }[] = [
  { value: 'S', label: 'Small' },
  { value: 'M', label: 'Medium' },
  { value: 'L', label: 'Large' },
];

export interface FlowOutcome {
  readonly id: string;
  /** Short name: the row / group label. */
  readonly name: string;
  /** What has to be true. */
  readonly statement: string;
  /** How you'll know it is. */
  readonly measure: string;
  /** Free-flow spot of its empty group (only used while nothing delivers it). */
  readonly x?: number;
  readonly y?: number;
}

export interface ProjectExtras {
  readonly outcomeId: string | null;
  readonly doneWhen: string;
  readonly size: ProjectSize | null;
}

type Attrs = Readonly<Record<string, unknown>>;
const MAX_OUTCOMES = 24;
const MAX_TEXT = 2000;

const str = (v: unknown, max = MAX_TEXT): string => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** The roadmap's outcomes, in order. Anything malformed is dropped, never thrown. */
export function readOutcomes(attributes: unknown): FlowOutcome[] {
  const raw = attributes && typeof attributes === 'object' ? (attributes as Attrs)['outcomes'] : undefined;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: FlowOutcome[] = [];
  for (const item of raw.slice(0, MAX_OUTCOMES)) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Attrs;
    const id = str(o['id'], 64);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const x = num(o['x']);
    const y = num(o['y']);
    out.push({
      id,
      name: str(o['name'], 80),
      statement: str(o['statement']),
      measure: str(o['measure']),
      ...(x !== undefined && y !== undefined ? { x, y } : {}),
    });
  }
  return out;
}

/** The roadmap's attributes with `outcomes` replaced; every other key is kept. */
export function withOutcomes(attributes: Attrs, outcomes: readonly FlowOutcome[]): Record<string, unknown> {
  return {
    ...attributes,
    outcomes: outcomes.map((o) => ({
      id: o.id,
      name: o.name,
      statement: o.statement,
      measure: o.measure,
      ...(o.x !== undefined && o.y !== undefined ? { x: Math.round(o.x), y: Math.round(o.y) } : {}),
    })),
  };
}

export function readExtras(attributes: unknown): ProjectExtras {
  const a = attributes && typeof attributes === 'object' ? (attributes as Attrs) : {};
  const size = a['size'];
  const outcome = str(a['outcome_id'], 64);
  return {
    outcomeId: outcome || null,
    doneWhen: str(a['done_when']),
    size: size === 'S' || size === 'M' || size === 'L' ? size : null,
  };
}

/** A project's attributes with the given extras changed; every other key is kept. */
export function withExtras(attributes: Attrs, patch: Partial<ProjectExtras>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...attributes };
  if ('outcomeId' in patch) {
    if (patch.outcomeId) next['outcome_id'] = patch.outcomeId;
    else delete next['outcome_id'];
  }
  if ('doneWhen' in patch) {
    if (patch.doneWhen) next['done_when'] = patch.doneWhen.slice(0, MAX_TEXT);
    else delete next['done_when'];
  }
  if ('size' in patch) {
    if (patch.size) next['size'] = patch.size;
    else delete next['size'];
  }
  return next;
}

// --- geometry -----------------------------------------------------------------------

/** Structured layout: card, column pitch, rows, outcome caps, the vision bar. */
export const S = { W: 136, H: 76, PITCH: 164, X0: 14, TOP: 40, ROW: 88, CAPW: 128, THW: 28 } as const;
/** Free flow: card, column pitch, row pitch, the vision door. */
export const F = { W: 164, H: 60, COLP: 224, X0: 40, ROW: 76, VW: 120, VY: 24, MIN_VX: 1196 } as const;

export interface Point {
  readonly x: number;
  readonly y: number;
}
export interface Box extends Point {
  readonly w: number;
  readonly h: number;
}

export const snap = (v: number): number => Math.round(v / 8) * 8;

/** Orthogonal path through `pts` with rounded corners. */
export function roundPath(pts: readonly (readonly [number, number])[], r: number): string {
  const p: [number, number][] = [];
  for (const q of pts) {
    const l = p[p.length - 1];
    if (!l || l[0] !== q[0] || l[1] !== q[1]) p.push([q[0], q[1]]);
  }
  for (let i = p.length - 2; i > 0; i--) {
    const a = p[i - 1]!, b = p[i]!, c = p[i + 1]!;
    if ((a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1])) p.splice(i, 1);
  }
  let d = `M ${p[0]![0]} ${p[0]![1]}`;
  for (let i = 1; i < p.length - 1; i++) {
    const a = p[i - 1]!, b = p[i]!, c = p[i + 1]!;
    const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const ax = b[0] + ((a[0] - b[0]) / l1) * rr, ay = b[1] + ((a[1] - b[1]) / l1) * rr;
    const cx = b[0] + ((c[0] - b[0]) / l2) * rr, cy = b[1] + ((c[1] - b[1]) / l2) * rr;
    d += ` L ${ax} ${ay} Q ${b[0]} ${b[1]} ${cx} ${cy}`;
  }
  const z = p[p.length - 1]!;
  return `${d} L ${z[0]} ${z[1]}`;
}

/** A right-pointing arrowhead whose tip sits 1px short of (x, y). */
export const headAt = (x: number, y: number): string => `M ${x - 1} ${y} L ${x - 8} ${y - 4.5} L ${x - 8} ${y + 4.5} Z`;

/** A smooth link from a card's right edge to another's left edge, with its midpoint. */
export function curve(sx: number, sy: number, tx: number, ty: number): { d: string; head: string; mx: number; my: number } {
  const back = tx < sx + 24;
  const dx = back ? 90 : Math.max(36, (tx - sx) * 0.5);
  const ex = tx - 8;
  return {
    d: `M ${sx} ${sy} C ${sx + dx} ${sy}, ${ex - dx} ${ty}, ${ex} ${ty}`,
    head: `M ${tx - 1} ${ty} L ${tx - 9} ${ty - 4.5} L ${tx - 9} ${ty + 4.5} Z`,
    mx: 0.125 * sx + 0.375 * (sx + dx) + 0.375 * (ex - dx) + 0.125 * ex,
    my: (sy + ty) / 2,
  };
}

/** A free-flow group's box around its cards' spots. */
export function boxOf(spots: readonly Point[]): Box | null {
  if (spots.length === 0) return null;
  const x0 = Math.min(...spots.map((c) => c.x)) - 16;
  const y0 = Math.min(...spots.map((c) => c.y)) - 34;
  const x1 = Math.max(...spots.map((c) => c.x)) + F.W + 16;
  const y1 = Math.max(...spots.map((c) => c.y)) + F.H + 14;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
/** The box of an outcome nothing delivers yet, from its (virtual) card spot. */
export const emptyBox = (p: Point): Box => ({ x: p.x - 16, y: p.y - 34, w: F.COLP + F.W + 32, h: 34 + F.H + 14 });
export const inBox = (b: Box | null, p: Point, margin = 0): boolean =>
  !!b && p.x >= b.x - margin && p.x <= b.x + b.w + margin && p.y >= b.y - margin && p.y <= b.y + b.h + margin;

/** Does `from` reach `to` along links (from → to)? */
export function reaches(links: readonly Pick<RoadmapLink, 'from' | 'to'>[], from: string, to: string): boolean {
  const adj = new Map<string, string[]>();
  for (const l of links) (adj.get(l.from) ?? adj.set(l.from, []).get(l.from)!).push(l.to);
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const n = stack.pop()!;
    if (n === to) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const m of adj.get(n) ?? []) stack.push(m);
  }
  return false;
}

// --- the flow model -------------------------------------------------------------------

export interface FlowCard {
  readonly id: string;
  readonly title: string;
  readonly project: RoadmapProject;
  readonly state: DoorState;
  readonly pct: number;
  /** 1-based step, or null when nothing links it ("any time"). */
  readonly step: number | null;
  readonly col: number;
  readonly extras: ProjectExtras;
  /** The outcome it delivers, if that outcome still exists. */
  readonly outcomeId: string | null;
  /** Delivers an outcome, or leads (along links) to a project that does. */
  readonly leads: boolean;
  readonly meta: string;
  // structured geometry
  readonly lane: string;
  readonly row: number;
  readonly x: number;
  readonly y: number;
  readonly cy: number;
}

export interface FlowLane {
  readonly id: string; // outcome id, or NONE_LANE
  readonly outcome: FlowOutcome | null;
  readonly members: readonly FlowCard[];
  readonly rows: number;
  readonly top: number;
  readonly h: number;
  readonly index: number;
}

export interface FlowCap {
  readonly outcome: FlowOutcome;
  readonly x: number;
  readonly y: number;
  readonly cy: number;
  readonly count: number;
  readonly done: number;
}

export interface RoutedLink {
  readonly key: string;
  readonly link: RoadmapLink;
  readonly d: string;
  readonly head: string;
}

export interface FlowGap {
  readonly key: string;
  readonly kind: 'outcome' | 'project';
  readonly id: string;
  readonly text: string;
}

export interface FlowModel {
  readonly cards: readonly FlowCard[];
  readonly byId: ReadonlyMap<string, FlowCard>;
  readonly outcomes: readonly FlowOutcome[];
  readonly links: readonly RoadmapLink[];
  readonly lanes: readonly FlowLane[];
  readonly caps: readonly FlowCap[];
  readonly routed: readonly RoutedLink[];
  /** Dashed lane-to-outcome lines and outcome → vision arrows. */
  readonly decor: readonly { key: string; d: string; head?: string; dashed: boolean; capId?: string }[];
  readonly maxStep: number;
  readonly capX: number;
  readonly thX: number;
  readonly thTop: number;
  readonly thH: number;
  readonly boardW: number;
  readonly boardH: number;
  readonly onChain: ReadonlySet<string>;
  readonly chainLinks: ReadonlySet<string>;
  readonly gaps: readonly FlowGap[];
}

export const NONE_LANE = 'none';
export const linkKey = (l: Pick<RoadmapLink, 'from' | 'to'>): string => `${l.from}>${l.to}`;

const doorOf = (p: RoadmapProject): DoorState =>
  p.state === 'done' ? 'done' : p.state === 'progress' ? 'now' : p.state === 'blocked' ? 'wait' : 'ready';

export function cardMeta(card: Pick<FlowCard, 'state' | 'pct' | 'step' | 'project'>): string {
  if (card.state === 'done') return 'Done';
  if (card.state === 'now') return `${card.pct}%`;
  if (card.state === 'ready') return card.step === null ? 'Any time' : 'Ready';
  return `Waits on ${card.project.blockedBy.length}`;
}

export function buildFlow(model: RoadmapModel, outcomes: readonly FlowOutcome[]): FlowModel {
  const known = new Set(outcomes.map((o) => o.id));
  const projects = model.projects;

  // Who leads to an outcome: everything upstream of a project that delivers one.
  const delivers = new Map(projects.map((p) => [p.node.id, readExtras(p.node.attributes)]));
  const leads = new Set<string>();
  const stack = projects.filter((p) => known.has(delivers.get(p.node.id)!.outcomeId ?? '')).map((p) => p.node.id);
  for (const id of stack) leads.add(id);
  while (stack.length) {
    const id = stack.pop()!;
    for (const a of model.byId.get(id)?.waitsOn ?? []) {
      if (leads.has(a)) continue;
      leads.add(a);
      stack.push(a);
    }
  }

  const maxStep = projects.reduce((m, p) => (p.step === null ? m : Math.max(m, p.step + 1)), 0);
  const nCols = Math.max(3, maxStep);

  // Lanes: one per outcome, then the projects that deliver none.
  type Draft = { -readonly [K in keyof FlowCard]: FlowCard[K] };
  const drafts: Draft[] = projects.map((p) => {
    const extras = delivers.get(p.node.id)!;
    const outcomeId = extras.outcomeId && known.has(extras.outcomeId) ? extras.outcomeId : null;
    const step = p.step === null ? null : p.step + 1;
    const state = doorOf(p);
    const card = { id: p.node.id, title: p.node.title, project: p, state, pct: p.pct, step, col: step === null ? 0 : step - 1 };
    return {
      ...card,
      extras,
      outcomeId,
      leads: leads.has(p.node.id),
      meta: cardMeta(card),
      lane: outcomeId ?? NONE_LANE,
      row: 0,
      x: 0,
      y: 0,
      cy: 0,
    };
  });
  const laneDefs: { id: string; outcome: FlowOutcome | null }[] = outcomes.map((o) => ({ id: o.id, outcome: o }));
  if (outcomes.length === 0 || drafts.some((c) => c.outcomeId === null)) laneDefs.push({ id: NONE_LANE, outcome: null });
  let y: number = S.TOP;
  const lanes: FlowLane[] = laneDefs.map((l, index) => {
    const members = drafts.filter((c) => c.lane === l.id);
    const cols = new Map<number, Draft[]>();
    for (const c of members) (cols.get(c.col) ?? cols.set(c.col, []).get(c.col)!).push(c);
    let rows = 1;
    for (const list of cols.values()) {
      list.forEach((c, r) => (c.row = r));
      rows = Math.max(rows, list.length);
    }
    const top = y;
    for (const c of members) {
      c.x = S.X0 + c.col * S.PITCH;
      c.y = top + 24 + c.row * S.ROW;
      c.cy = c.y + S.H / 2;
    }
    const h = rows * S.ROW + 24;
    y += h;
    return { id: l.id, outcome: l.outcome, members, rows, top, h, index };
  });
  const cards: FlowCard[] = drafts;
  const byId = new Map(cards.map((c) => [c.id, c]));
  const boardH = Math.max(y + 12, 320);
  const capX = S.X0 + (nCols - 1) * S.PITCH + S.W + 28;
  const thX = capX + S.CAPW + 18;
  const boardW = thX + S.THW + 14;

  // Longest chain: walk back from the last step along the links that set each step.
  const onChain = new Set<string>();
  const chainLinks = new Set<string>();
  if (maxStep > 1) {
    const queue = cards.filter((c) => c.step === maxStep);
    for (const c of queue) onChain.add(c.id);
    while (queue.length) {
      const c = queue.pop()!;
      for (const l of model.links) {
        if (l.to !== c.id) continue;
        const q = byId.get(l.from);
        if (!q || q.step === null || c.step === null) continue;
        if ((l.kind === 'FS' && q.step === c.step - 1) || (l.kind === 'SS' && q.step === c.step)) {
          chainLinks.add(linkKey(l));
          if (!onChain.has(q.id)) {
            onChain.add(q.id);
            queue.push(q);
          }
        }
      }
    }
  }

  // Orthogonal routing: straight when the row is clear, else one bend in a column
  // gap, else a channel run under the source row. Distinct bundles in one gap get
  // their own lane; an SS link to the same column brackets round the left side.
  const occ = new Set(cards.map((c) => `${c.lane}:${c.row}:${c.col}`));
  const clear = (lane: string, row: number, c0: number, c1: number) => {
    for (let c = c0; c <= c1; c++) if (occ.has(`${lane}:${row}:${c}`)) return false;
    return true;
  };
  const gapX = (c: number) => S.X0 + c * S.PITCH + S.W + 14;
  type Vert = { gap: number; key: string };
  const plans = model.links.flatMap((l) => {
    const s = byId.get(l.from);
    const t = byId.get(l.to);
    if (!s || !t) return [];
    const fromSource: Vert = { gap: s.col, key: `s:${s.id}` };
    const intoTarget: Vert = { gap: t.col - 1, key: `t:${t.id}` };
    let kind: 'bracket' | 'straight' | 'elbow' | 'channel';
    let verts: Vert[] = [];
    if (t.col <= s.col) kind = 'bracket';
    else if (s.cy === t.cy && clear(s.lane, s.row, s.col + 1, t.col - 1)) kind = 'straight';
    else if (t.col === s.col + 1) [kind, verts] = ['elbow', [fromSource]];
    else if (clear(s.lane, s.row, s.col + 1, t.col - 1)) [kind, verts] = ['elbow', [intoTarget]];
    else if (clear(t.lane, t.row, s.col + 1, t.col - 1)) [kind, verts] = ['elbow', [fromSource]];
    else [kind, verts] = ['channel', [fromSource, intoTarget]];
    return [{ l, s, t, kind, verts }];
  });
  const slots = new Map<number, string[]>();
  for (const pl of plans)
    for (const v of pl.verts) {
      const a = slots.get(v.gap) ?? slots.set(v.gap, []).get(v.gap)!;
      if (!a.includes(v.key)) a.push(v.key);
    }
  const off = (v: Vert) => {
    const a = slots.get(v.gap)!;
    return Math.round((a.indexOf(v.key) - (a.length - 1) / 2) * 6);
  };
  const routed: RoutedLink[] = plans.map(({ l, s, t, kind, verts }) => {
    const sx = s.x + S.W, sy = s.cy, tx = t.x, ty = t.cy;
    let pts: [number, number][];
    if (kind === 'bracket') {
      const bx = Math.min(s.x, t.x) - 13;
      pts = [[s.x, sy], [bx, sy], [bx, ty], [tx - 7, ty]];
    } else if (kind === 'straight') pts = [[sx, sy], [tx - 7, ty]];
    else if (kind === 'elbow') {
      const gx = gapX(verts[0]!.gap) + off(verts[0]!);
      pts = [[sx, sy], [gx, sy], [gx, ty], [tx - 7, ty]];
    } else {
      const g1 = gapX(verts[0]!.gap) + off(verts[0]!);
      const g2 = gapX(verts[1]!.gap) + off(verts[1]!);
      const cy = s.y + S.H + 6;
      pts = [[sx, sy], [g1, sy], [g1, cy], [g2, cy], [g2, ty], [tx - 7, ty]];
    }
    return { key: linkKey(l), link: l, d: roundPath(pts, 7), head: headAt(tx, ty) };
  });

  const caps: FlowCap[] = lanes
    .filter((l) => l.outcome)
    .map((l) => ({
      outcome: l.outcome!,
      x: capX,
      y: l.top + 24,
      cy: l.top + 24 + S.H / 2,
      count: l.members.length,
      done: l.members.filter((c) => c.state === 'done').length,
    }));
  const decor: { key: string; d: string; head?: string; dashed: boolean; capId?: string }[] = [];
  for (const cap of caps) {
    const lane = lanes.find((l) => l.id === cap.outcome.id)!;
    if (lane.members.length) {
      const last = lane.members.reduce((m, c) => (c.col > m.col || (c.col === m.col && c.row < m.row) ? c : m), lane.members[0]!);
      const pts: [number, number][] =
        last.cy === cap.cy
          ? [[last.x + S.W, last.cy], [capX, cap.cy]]
          : [[last.x + S.W, last.cy], [capX - 14, last.cy], [capX - 14, cap.cy], [capX, cap.cy]];
      decor.push({ key: `lane-${cap.outcome.id}`, d: roundPath(pts, 7), dashed: true });
    }
    decor.push({
      key: `cap-${cap.outcome.id}`,
      d: `M ${capX + S.CAPW} ${cap.cy} L ${thX - 7} ${cap.cy}`,
      head: headAt(thX, cap.cy),
      dashed: false,
      capId: cap.outcome.id,
    });
  }
  const outcomeLanes = lanes.filter((l) => l.outcome);
  const thTop = outcomeLanes.length ? outcomeLanes[0]!.top + 24 : S.TOP + 24;
  const thBottom = outcomeLanes.length ? outcomeLanes[outcomeLanes.length - 1]!.top + 24 + S.H : thTop + 200;

  // Gaps between the roadmap and its vision — only once it HAS outcomes; before
  // that there is one invitation to add them, not a warning on every project.
  const gaps: FlowGap[] = [];
  if (outcomes.length > 0) {
    for (const cap of caps)
      if (cap.count === 0)
        gaps.push({ key: `o:${cap.outcome.id}`, kind: 'outcome', id: cap.outcome.id, text: `“${cap.outcome.statement || cap.outcome.name}” has nothing delivering it` });
    for (const c of cards)
      if (c.outcomeId === null) gaps.push({ key: `p:${c.id}`, kind: 'project', id: c.id, text: `“${c.title}” doesn’t deliver an outcome` });
  }

  return {
    cards,
    byId,
    outcomes,
    links: model.links,
    lanes,
    caps,
    routed,
    decor,
    maxStep,
    capX,
    thX,
    thTop,
    thH: Math.max(thBottom - thTop, 120),
    boardW,
    boardH,
    onChain,
    chainLinks,
    gaps,
  };
}

// --- free flow ------------------------------------------------------------------------------

/** Free flow lined up exactly like Structured: a band per outcome, a column per step. */
export function tidyPositions(flow: FlowModel): { proj: Map<string, Point>; empty: Map<string, Point> } {
  const proj = new Map<string, Point>();
  const empty = new Map<string, Point>();
  let y: number = F.VY;
  const band = (members: readonly FlowCard[], top: number) => {
    const cols = new Map<number, FlowCard[]>();
    for (const c of members) (cols.get(c.col) ?? cols.set(c.col, []).get(c.col)!).push(c);
    let rows = 1;
    for (const [col, list] of cols) {
      list.forEach((c, r) => proj.set(c.id, { x: F.X0 + col * F.COLP, y: top + r * F.ROW }));
      rows = Math.max(rows, list.length);
    }
    return rows;
  };
  for (const o of flow.outcomes) {
    const members = flow.cards.filter((c) => c.outcomeId === o.id);
    const t = y + 34;
    if (members.length === 0) {
      empty.set(o.id, { x: F.X0, y: t });
      y = t + F.H + 14 + 18;
      continue;
    }
    const rows = band(members, t);
    y = t + rows * F.ROW - 16 + 14 + 18;
  }
  const loose = flow.cards.filter((c) => c.outcomeId === null);
  if (loose.length) band(loose, y + 10);
  return { proj, empty };
}

export interface FreeLayout {
  /** Every card's spot: saved, else the tidy spot nudged clear of saved ones. */
  readonly proj: ReadonlyMap<string, Point>;
  /** Spots of outcomes nothing delivers yet. */
  readonly empty: ReadonlyMap<string, Point>;
  /** The Structured arrangement, for "Tidy up". */
  readonly tidy: { proj: ReadonlyMap<string, Point>; empty: ReadonlyMap<string, Point> };
  /** True when nothing has been placed by hand yet. */
  readonly pristine: boolean;
}

export function freeLayout(flow: FlowModel, saved: ReadonlyMap<string, Point>): FreeLayout {
  const tidy = tidyPositions(flow);
  const pristine = !flow.cards.some((c) => saved.has(c.id));
  const proj = new Map<string, Point>();
  if (pristine) for (const [k, v] of tidy.proj) proj.set(k, v);
  else {
    const placed: Point[] = [];
    for (const c of flow.cards) {
      const s = saved.get(c.id);
      if (!s) continue;
      proj.set(c.id, s);
      placed.push(s);
    }
    for (const c of flow.cards) {
      if (proj.has(c.id)) continue;
      const t = tidy.proj.get(c.id) ?? { x: F.X0, y: F.VY + 34 };
      let yy = t.y;
      for (let i = 0; i < 14 && placed.some((q) => Math.abs(q.x - t.x) < F.W + 8 && Math.abs(q.y - yy) < F.H + 8); i++) yy += F.ROW;
      const spot = { x: t.x, y: yy };
      proj.set(c.id, spot);
      placed.push(spot);
    }
  }
  let bottom = 0;
  for (const p of proj.values()) bottom = Math.max(bottom, p.y + F.H);
  const empty = new Map<string, Point>();
  for (const o of flow.outcomes) {
    if (flow.cards.some((c) => c.outcomeId === o.id)) continue;
    if (o.x !== undefined && o.y !== undefined) empty.set(o.id, { x: o.x, y: o.y });
    else if (pristine && tidy.empty.has(o.id)) empty.set(o.id, tidy.empty.get(o.id)!);
    else {
      const spot = { x: F.X0, y: bottom + 14 + 34 + 18 };
      empty.set(o.id, spot);
      bottom = spot.y + F.H;
    }
  }
  return { proj, empty, tidy, pristine };
}

/** A free spot for a card joining `outcomeId`: under that group's cards (or in its empty box). */
export function spotIn(flow: FlowModel, free: FreeLayout, outcomeId: string | null, exceptId: string | null): Point {
  const others = [...free.proj].filter(([k]) => k !== exceptId).map(([, v]) => v);
  const members = flow.cards.filter((c) => c.outcomeId === outcomeId && c.id !== exceptId && free.proj.has(c.id)).map((c) => free.proj.get(c.id)!);
  let x: number, y: number;
  if (outcomeId && members.length) {
    x = Math.min(...members.map((q) => q.x));
    y = Math.max(...members.map((q) => q.y)) + F.ROW;
  } else if (outcomeId && free.empty.has(outcomeId)) {
    ({ x, y } = free.empty.get(outcomeId)!);
  } else {
    x = F.X0;
    y = Math.max(F.VY, ...others.map((q) => q.y + F.H)) + 40;
  }
  for (let i = 0; i < 14 && others.some((q) => Math.abs(q.x - x) < F.W + 8 && Math.abs(q.y - y) < F.H + 8); i++) x += F.COLP;
  return { x, y };
}

// --- the remembered layout --------------------------------------------------------------------

export type FlowLayout = 'structured' | 'free';
export const FLOW_LAYOUT_KEY = 'prisms.roadmap.flowLayout';
export function readFlowLayout(): FlowLayout {
  try {
    return localStorage.getItem(FLOW_LAYOUT_KEY) === 'free' ? 'free' : 'structured';
  } catch {
    return 'structured';
  }
}
export function writeFlowLayout(layout: FlowLayout): void {
  try {
    localStorage.setItem(FLOW_LAYOUT_KEY, layout);
  } catch {
    /* best-effort */
  }
}
