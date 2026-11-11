/**
 * Vision "Shape": the icicle chart on Plan › Vision.
 *
 * Everything under one vision, one row per level (vision → roadmaps → projects
 * → milestones/tasks), each block as wide as its share of the work, with a bar
 * along its bottom edge for how much of it is done. Pure, so the layout is unit
 * tested without a DOM; the screen only paints the cells placed here.
 *
 * Counting follows project completion (aggregates/completion, §7.2) so the chart
 * and the Dashboard can never disagree about a branch:
 * - an OBSOLETE task is descoped. It is counted nowhere, not even as done.
 * - "% done" is weighted by estimate_minutes, an unestimated task weighing 1.
 * Habit-spawned tasks are parentless (I3), so they never sit under a vision.
 */
import { childrenOf, taskWeight, type Node, type NodeType, type TreeIndex } from '@prisms/core';

/** What a block's WIDTH stands for. Its progress bar is always "% done". */
export const SHAPE_METRICS = [
  { value: 'open', label: 'Open tasks' },
  { value: 'time', label: 'Time left' },
  { value: 'all', label: 'All tasks' },
] as const;
export type ShapeMetric = (typeof SHAPE_METRICS)[number]['value'];

export interface ShapeNode {
  readonly node: Node;
  readonly parent: ShapeNode | null;
  readonly children: readonly ShapeNode[];
  /** Levels below the vision; the vision itself is 0. */
  readonly depth: number;
  /** Counted (live, not obsolete) tasks in this branch; 1 or 0 for a task itself. */
  readonly tasks: number;
  readonly openTasks: number;
  /** Estimated minutes of the open tasks. An open task with no estimate adds nothing here… */
  readonly openMinutes: number;
  /** …so it is counted here instead, and the screen says it is missing from "Time left". */
  readonly openUnestimated: number;
  /** Completion weights, as aggregates/completion defines them. */
  readonly doneWeight: number;
  readonly totalWeight: number;
}

/** Built bottom-up, so the totals are written once while the node is still private. */
type Growing = { -readonly [K in keyof ShapeNode]: ShapeNode[K] } & { children: ShapeNode[] };

/** The vision's whole branch, rolled up. null when the vision is not in the tree. */
export function buildShape(tree: TreeIndex, visionId: string): ShapeNode | null {
  const root = tree.byId.get(visionId);
  return root ? grow(tree, root, null, 0) : null;
}

function grow(tree: TreeIndex, node: Node, parent: ShapeNode | null, depth: number): ShapeNode {
  const self: Growing = {
    node,
    parent,
    children: [],
    depth,
    tasks: 0,
    openTasks: 0,
    openMinutes: 0,
    openUnestimated: 0,
    doneWeight: 0,
    totalWeight: 0,
  };
  if (node.node_type === 'task') {
    // A task is always a leaf here: its checklist lives in task_steps, not in the tree.
    const done = node.completed_at !== null;
    self.tasks = 1;
    self.totalWeight = taskWeight(node);
    if (done) {
      self.doneWeight = self.totalWeight;
    } else {
      self.openTasks = 1;
      if (node.estimate_minutes === null) self.openUnestimated = 1;
      else self.openMinutes = Math.max(0, node.estimate_minutes);
    }
    return self;
  }
  for (const child of childrenOf(tree, node.id)) {
    if (child.node_type === 'task' && child.completion_disposition === 'obsolete') continue;
    const c = grow(tree, child, self, depth + 1);
    self.children.push(c);
    self.tasks += c.tasks;
    self.openTasks += c.openTasks;
    self.openMinutes += c.openMinutes;
    self.openUnestimated += c.openUnestimated;
    self.doneWeight += c.doneWeight;
    self.totalWeight += c.totalWeight;
  }
  return self;
}

export function shapeValue(item: ShapeNode, metric: ShapeMetric): number {
  switch (metric) {
    case 'open':
      return item.openTasks;
    case 'time':
      return item.openMinutes;
    case 'all':
      return item.tasks;
  }
}

/** 0–100, weighted like project completion. 0 for a branch with no tasks. */
export function donePercent(item: ShapeNode): number {
  return item.totalWeight > 0 ? (item.doneWeight / item.totalWeight) * 100 : 0;
}

/**
 * `donePercent` as a whole number for display, which never reads 100 while
 * something is still open. An unestimated task weighs 1 minute, so one left
 * beside hours of finished work is 99.6%, and rounding that to "100% done ·
 * 1 open" contradicts itself.
 */
export function donePercentLabel(item: ShapeNode): number {
  const pct = Math.round(donePercent(item));
  return item.openTasks > 0 ? Math.min(99, pct) : pct;
}

/** One painted block: `x` and `w` are fractions of the chart's width. */
export interface ShapeCell {
  readonly item: ShapeNode;
  readonly x: number;
  readonly w: number;
  readonly row: number;
}

/**
 * Places `focus` across the full width on row 0 and every descendant beneath it,
 * each child taking its share of its parent's span. A branch worth nothing under
 * this metric is still placed, at zero width, so switching metric can animate it
 * in and out rather than popping.
 */
export function layoutShape(focus: ShapeNode, metric: ShapeMetric): ShapeCell[] {
  const cells: ShapeCell[] = [];
  const place = (item: ShapeNode, x: number, w: number, row: number) => {
    cells.push({ item, x, w, row });
    let total = 0;
    for (const c of item.children) total += shapeValue(c, metric);
    let cx = x;
    for (const c of item.children) {
      const cw = total > 0 ? (w * shapeValue(c, metric)) / total : 0;
      place(c, cx, cw, row + 1);
      cx += cw;
    }
  };
  place(focus, 0, 1, 0);
  return cells;
}

const PLURAL: Record<NodeType, string> = {
  vision: 'Visions',
  roadmap: 'Roadmaps',
  project: 'Projects',
  milestone: 'Milestones',
  task: 'Tasks',
  activity: 'Activities',
};
const SINGULAR: Record<NodeType, string> = {
  vision: 'Vision',
  roadmap: 'Roadmap',
  project: 'Project',
  milestone: 'Milestone',
  task: 'Task',
  activity: 'Activity',
};
const TYPE_ORDER: readonly NodeType[] = ['vision', 'roadmap', 'project', 'milestone', 'task', 'activity'];

export const typeLabel = (type: NodeType): string => SINGULAR[type];

/**
 * A name for each row that has something visible in it. Row 0 is the one block
 * in focus, so it is singular. A row can hold two types (a project's tasks sit
 * beside its milestones, whose own tasks are a row further down), and then it is
 * named for both.
 */
export function rowLabels(cells: readonly ShapeCell[]): string[] {
  const types: Set<NodeType>[] = [];
  for (const { item, w, row } of cells) {
    if (row > 0 && w <= 0) continue;
    (types[row] ??= new Set()).add(item.node.node_type);
  }
  return types.map((set, row) => {
    const names = TYPE_ORDER.filter((t) => set.has(t)).map((t) => (row === 0 ? SINGULAR[t] : PLURAL[t]));
    return names.join(' · ');
  });
}

/** The child of `focus` holding the most of the metric, and its share (0–1). */
export interface ShapeLead {
  readonly item: ShapeNode;
  readonly share: number;
}

export function leadingBranch(focus: ShapeNode, metric: ShapeMetric): ShapeLead | null {
  const total = shapeValue(focus, metric);
  if (total <= 0) return null;
  let best: ShapeNode | null = null;
  for (const c of focus.children) {
    if (best === null || shapeValue(c, metric) > shapeValue(best, metric)) best = c;
  }
  if (best === null || shapeValue(best, metric) <= 0) return null;
  return { item: best, share: shapeValue(best, metric) / total };
}

export function findInShape(root: ShapeNode, id: string): ShapeNode | null {
  if (root.node.id === id) return root;
  for (const c of root.children) {
    const hit = findInShape(c, id);
    if (hit) return hit;
  }
  return null;
}

/** The path from the vision down to `item`, both ends included. */
export function trailOf(item: ShapeNode): ShapeNode[] {
  const path: ShapeNode[] = [];
  for (let n: ShapeNode | null = item; n; n = n.parent) path.unshift(n);
  return path;
}

/** The roadmap `item` sits under (or is), where the Roadmap screen can open it. */
export function roadmapOf(item: ShapeNode): ShapeNode | null {
  for (let n: ShapeNode | null = item; n; n = n.parent) if (n.node.node_type === 'roadmap') return n;
  return null;
}

/** Compact minutes for a block too small for `1h 30m`: `45m`, `2.5h`, `34h`. */
export function shortMinutes(min: number): string {
  if (min < 60) return `${Math.round(min)}m`;
  const h = Math.round((min / 60) * 10) / 10;
  return `${h}h`;
}

/** The second line inside a block. */
export function cellStat(item: ShapeNode, metric: ShapeMetric): string {
  const n = item.node;
  if (n.node_type === 'task') {
    if (n.completed_at !== null) return 'done';
    return n.estimate_minutes === null ? 'no estimate' : `${shortMinutes(n.estimate_minutes)} est.`;
  }
  const pct = `${donePercentLabel(item)}% done`;
  switch (metric) {
    case 'open':
      return `${pct} · ${item.openTasks} open`;
    case 'time':
      return `${pct} · ${shortMinutes(item.openMinutes)} left`;
    case 'all':
      return `${pct} · ${item.tasks} task${item.tasks === 1 ? '' : 's'}`;
  }
}
