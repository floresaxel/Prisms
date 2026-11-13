/**
 * Plan › Roadmap, without a DOM: one roadmap's projects rolled up, how they
 * depend on each other, and where the mind map puts them.
 *
 * Counting is the Shape card's (vision-shape → buildShape), so a project's
 * "% done" and open counts here agree with Plan › Vision and the Dashboard:
 * obsolete tasks are descoped, % done is estimate-weighted.
 *
 * "Waits on" is ROLLED UP from the dependency graph: an edge between any two
 * things inside two different projects of this roadmap (a task, a milestone,
 * the projects themselves) makes the successor's project wait on the
 * predecessor's. A project is BLOCKED while anything it waits on is unfinished,
 * and finished when it has tasks and none of them is open.
 */
import type { Edge, Node, TreeIndex } from '@prisms/core';

import { buildShape, donePercentLabel, type ShapeNode } from './vision-shape';

export type ProjectState = 'done' | 'blocked' | 'progress' | 'todo';

export interface RoadmapProject {
  readonly node: Node;
  /** The project's own roll-up, and its milestones and tasks as children. */
  readonly shape: ShapeNode;
  /** Whole-number % done that never reads 100 while a task is open. */
  readonly pct: number;
  /** Projects this one waits on, in roadmap order. */
  readonly waitsOn: readonly string[];
  /** The ones of those still unfinished. */
  readonly blockedBy: readonly string[];
  /** Projects waiting on this one. */
  readonly unblocks: readonly string[];
  readonly state: ProjectState;
  /** 0-based step in the order of work; null when nothing links it either way. */
  readonly step: number | null;
}

export interface RoadmapModel {
  readonly roadmap: Node;
  readonly projects: readonly RoadmapProject[];
  readonly byId: ReadonlyMap<string, RoadmapProject>;
  /** Linked projects by step: what has to finish before what. */
  readonly steps: readonly (readonly RoadmapProject[])[];
  /** Projects no dependency touches: they can happen any time. */
  readonly free: readonly RoadmapProject[];
  readonly tasks: number;
  readonly openTasks: number;
  readonly openMinutes: number;
  readonly pct: number;
}

/** A project is finished when it has tasks and none of them is open. */
export const isFinished = (shape: ShapeNode): boolean => shape.tasks > 0 && shape.openTasks === 0;

export function buildRoadmapModel(tree: TreeIndex, edges: readonly Edge[], roadmapId: string): RoadmapModel | null {
  const roadmap = tree.byId.get(roadmapId);
  if (!roadmap) return null;
  const root = buildShape(tree, roadmapId)!;
  const shapes = root.children.filter((c) => c.node.node_type === 'project');
  const projectIds = new Set(shapes.map((s) => s.node.id));
  const order = new Map(shapes.map((s, i) => [s.node.id, i]));

  /** The project of this roadmap that `id` sits in (or is), if any. */
  const projectOf = (id: string): string | null => {
    for (let n = tree.byId.get(id); n; n = n.parent_id ? tree.byId.get(n.parent_id) : undefined) {
      if (projectIds.has(n.id)) return n.id;
      if (n.node_type === 'project' || n.node_type === 'roadmap') return null;
    }
    return null;
  };

  const waits = new Map<string, Set<string>>();
  const unblocks = new Map<string, Set<string>>();
  for (const e of edges) {
    const from = projectOf(e.predecessor_id);
    const to = projectOf(e.successor_id);
    if (!from || !to || from === to) continue;
    (waits.get(to) ?? waits.set(to, new Set()).get(to)!).add(from);
    (unblocks.get(from) ?? unblocks.set(from, new Set()).get(from)!).add(to);
  }
  const inOrder = (ids: Set<string> | undefined) => [...(ids ?? [])].sort((a, b) => order.get(a)! - order.get(b)!);

  // Step = the longest chain of prerequisites in front of a project. A rolled-up
  // cycle (A's task waits on B's, B's on A's) is cut where it closes.
  const depth = new Map<string, number>();
  const onPath = new Set<string>();
  const stepOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    onPath.add(id);
    let d = 0;
    for (const p of waits.get(id) ?? []) if (!onPath.has(p)) d = Math.max(d, stepOf(p) + 1);
    onPath.delete(id);
    depth.set(id, d);
    return d;
  };

  const finished = new Map(shapes.map((s) => [s.node.id, isFinished(s)]));
  const projects: RoadmapProject[] = shapes.map((shape) => {
    const id = shape.node.id;
    const waitsOn = inOrder(waits.get(id));
    const blockedBy = waitsOn.filter((p) => !finished.get(p));
    const linked = waitsOn.length > 0 || (unblocks.get(id)?.size ?? 0) > 0;
    const state: ProjectState = finished.get(id)
      ? 'done'
      : blockedBy.length > 0
        ? 'blocked'
        : shape.tasks - shape.openTasks > 0
          ? 'progress'
          : 'todo';
    return {
      node: shape.node,
      shape,
      pct: donePercentLabel(shape),
      waitsOn,
      blockedBy,
      unblocks: inOrder(unblocks.get(id)),
      state,
      step: linked ? stepOf(id) : null,
    };
  });

  const steps: RoadmapProject[][] = [];
  for (const p of projects) if (p.step !== null) (steps[p.step] ??= []).push(p);

  return {
    roadmap,
    projects,
    byId: new Map(projects.map((p) => [p.node.id, p])),
    steps: steps.filter(Boolean),
    free: projects.filter((p) => p.step === null),
    tasks: root.tasks,
    openTasks: root.openTasks,
    openMinutes: root.openMinutes,
    pct: donePercentLabel(root),
  };
}

/** Everything a project's chain touches: what it waits on, all the way back, and what waits on it. */
export function chainOf(model: RoadmapModel, id: string): Set<string> {
  const walk = (from: string, next: (p: RoadmapProject) => readonly string[], seen: Set<string>) => {
    for (const q of next(model.byId.get(from)!)) {
      if (seen.has(q) || !model.byId.has(q)) continue;
      seen.add(q);
      walk(q, next, seen);
    }
  };
  if (!model.byId.has(id)) return new Set();
  const before = new Set<string>();
  const after = new Set<string>();
  walk(id, (p) => p.waitsOn, before);
  walk(id, (p) => p.unblocks, after);
  return new Set([id, ...before, ...after]);
}

// --- mind map ----------------------------------------------------------------

/** A milestone or task is done when everything in it is. */
export const itemDone = (item: ShapeNode): boolean =>
  item.node.node_type === 'task' ? item.node.completed_at !== null : isFinished(item);

/**
 * The twigs drawn off a project: its milestones and loose tasks, open ones first,
 * cut to `limit` with a count of the rest unless `showAll`. None when folded.
 */
export function twigsOf(
  project: RoadmapProject,
  { folded, showAll, limit = 4 }: { folded: boolean; showAll: boolean; limit?: number },
): { items: ShapeNode[]; more: number } {
  if (folded) return { items: [], more: 0 };
  const sorted = [...project.shape.children].sort((a, b) => Number(itemDone(a)) - Number(itemDone(b)));
  if (showAll || sorted.length <= limit + 1) return { items: sorted, more: 0 };
  return { items: sorted.slice(0, limit), more: sorted.length - limit };
}

export const MAP = {
  ROOT_W: 190,
  PROJ_W: 212,
  PROJ_H: 52,
  TWIG_H: 26,
  GAP: 14,
  /** Root edge → project, and project edge → its twigs. */
  REACH: 70,
  TWIG_REACH: 48,
  /** Below these widths the map goes one-sided, then top-down. */
  BALANCED_MIN: 1000,
  COLUMN_MAX: 640,
} as const;

export interface MapPlace {
  readonly id: string;
  readonly side: 'left' | 'right';
  /** Left edge and vertical centre, in px from the map's top-left. */
  readonly x: number;
  readonly y: number;
}

export interface MapTwig {
  readonly projectId: string;
  readonly side: 'left' | 'right';
  readonly item: ShapeNode | null; // null = the "+N more" twig
  readonly more: number;
  /** The twig's inner edge (left edge on the right, right edge on the left) and centre. */
  readonly x: number;
  readonly y: number;
}

export interface MindMapLayout {
  readonly mode: 'balanced' | 'one-sided' | 'column';
  readonly width: number;
  readonly height: number;
  /** Root centre. */
  readonly root: { readonly x: number; readonly y: number };
  readonly projects: readonly MapPlace[];
  readonly twigs: readonly MapTwig[];
}

/**
 * Places the roadmap and its projects. Wide: the roadmap in the middle, projects
 * alternating right and left, each with its twigs further out. Medium: all on
 * the right. Narrow: top-down, the roadmap first and each project with its twigs
 * under it. The map is at least `minHeight` tall and centred in it.
 */
export function layoutMindMap(
  projects: readonly RoadmapProject[],
  twigs: (p: RoadmapProject) => { items: ShapeNode[]; more: number },
  width: number,
  minHeight = 0,
): MindMapLayout {
  const T = MAP;
  const rows = (p: RoadmapProject) => {
    const t = twigs(p);
    return t.items.length + (t.more > 0 ? 1 : 0);
  };

  if (width < T.COLUMN_MAX) {
    const placed: MapPlace[] = [];
    const out: MapTwig[] = [];
    let y = 54 + 16;
    for (const p of projects) {
      const py = y + T.PROJ_H / 2;
      placed.push({ id: p.node.id, side: 'right', x: 30, y: py });
      y += T.PROJ_H + 6;
      const t = twigs(p);
      for (const item of t.items) {
        out.push({ projectId: p.node.id, side: 'right', item, more: 0, x: 48, y: y + T.TWIG_H / 2 });
        y += T.TWIG_H;
      }
      if (t.more > 0) {
        out.push({ projectId: p.node.id, side: 'right', item: null, more: t.more, x: 48, y: y + T.TWIG_H / 2 });
        y += T.TWIG_H;
      }
      y += 12;
    }
    return { mode: 'column', width, height: Math.max(y, minHeight), root: { x: 0, y: 27 }, projects: placed, twigs: out };
  }

  const balanced = width >= T.BALANCED_MIN;
  const sides: Record<'left' | 'right', RoadmapProject[]> = { left: [], right: [] };
  projects.forEach((p, i) => (balanced && i % 2 === 1 ? sides.left : sides.right).push(p));
  const blockH = (p: RoadmapProject) => Math.max(T.PROJ_H, rows(p) * T.TWIG_H);
  const sideH = (ps: RoadmapProject[]) => ps.reduce((s, p) => s + blockH(p), 0) + T.GAP * Math.max(ps.length - 1, 0);
  const height = Math.max(sideH(sides.left), sideH(sides.right), 120, minHeight) + 20;
  const cx = balanced ? width / 2 : T.ROOT_W / 2 + 4;
  const cy = height / 2;

  const placed: MapPlace[] = [];
  const out: MapTwig[] = [];
  for (const side of ['right', 'left'] as const) {
    const ps = sides[side];
    const dir = side === 'right' ? 1 : -1;
    const inner = cx + dir * (T.ROOT_W / 2 + T.REACH); // the project's edge nearest the root
    const twigX = inner + dir * (T.PROJ_W + T.TWIG_REACH);
    let y = (height - sideH(ps)) / 2;
    for (const p of ps) {
      const h = blockH(p);
      const py = y + h / 2;
      placed.push({ id: p.node.id, side, x: side === 'right' ? inner : inner - T.PROJ_W, y: py });
      const t = twigs(p);
      const n = rows(p);
      let ty = py - (n * T.TWIG_H) / 2 + T.TWIG_H / 2;
      for (const item of t.items) {
        out.push({ projectId: p.node.id, side, item, more: 0, x: twigX, y: ty });
        ty += T.TWIG_H;
      }
      if (t.more > 0) out.push({ projectId: p.node.id, side, item: null, more: t.more, x: twigX, y: ty });
      y += h + T.GAP;
    }
  }
  return { mode: balanced ? 'balanced' : 'one-sided', width, height, root: { x: cx, y: cy }, projects: placed, twigs: out };
}

// --- the remembered view -------------------------------------------------------

export const ROADMAP_VIEWS = [
  { value: 'order', label: 'Order', icon: 'order' },
  { value: 'map', label: 'Mind map', icon: 'mindmap' },
  { value: 'outline', label: 'Outline', icon: 'outline' },
  { value: 'list', label: 'List', icon: 'list' },
] as const;
export type RoadmapView = (typeof ROADMAP_VIEWS)[number]['value'];
export const DEFAULT_ROADMAP_VIEW: RoadmapView = 'order';
export const ROADMAP_VIEW_KEY = 'prisms.roadmap.view';

export function readRoadmapView(): RoadmapView {
  try {
    const v = localStorage.getItem(ROADMAP_VIEW_KEY);
    return ROADMAP_VIEWS.some((x) => x.value === v) ? (v as RoadmapView) : DEFAULT_ROADMAP_VIEW;
  } catch {
    return DEFAULT_ROADMAP_VIEW;
  }
}

export function writeRoadmapView(view: RoadmapView): void {
  try {
    localStorage.setItem(ROADMAP_VIEW_KEY, view);
  } catch {
    /* best-effort */
  }
}
