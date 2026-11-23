/**
 * Time counted in a project = the sum, over every live task under it, of what
 * `canonicalProgress` reports for that task — milestones' tasks and finished
 * tasks included, split-focus shares respected (no minute counted twice).
 */
import { describe, expect, it } from 'vitest';

import { canonicalProgress, loggedMinutesByProject } from '../../src/aggregates/progress';
import { buildTreeIndex } from '../../src/graph/tree';
import { idOf, makeEntry, makeNode } from '../helpers/fixtures';

const at = (min: number) => new Date(Date.UTC(2026, 5, 13, 10, min)).toISOString();
let n = 100;
const entry = (task: string, from: number, to: number | null, extra: object = {}) =>
  makeEntry({ id: idOf(n++), task_id: task, started_at: at(from), ended_at: to === null ? null : at(to), ...extra });

const ROADMAP = idOf(1);
const P1 = idOf(2);
const P2 = idOf(3);
const MS = idOf(4);
const DIRECT = idOf(5); // task directly under P1
const NESTED = idOf(6); // task inside a milestone of P1
const DONE = idOf(7); // finished task under P1
const OTHER = idOf(8); // task under P2
const GONE = idOf(9); // deleted task under P1

const rows = [
  makeNode({ id: ROADMAP, node_type: 'roadmap' }),
  makeNode({ id: P1, node_type: 'project', parent_id: ROADMAP }),
  makeNode({ id: P2, node_type: 'project', parent_id: ROADMAP }),
  makeNode({ id: MS, node_type: 'milestone', parent_id: P1 }),
  makeNode({ id: DIRECT, node_type: 'task', parent_id: P1 }),
  makeNode({ id: NESTED, node_type: 'task', parent_id: MS }),
  makeNode({ id: DONE, node_type: 'task', parent_id: P1, completed_at: at(0), completion_disposition: 'completed' }),
  makeNode({ id: OTHER, node_type: 'task', parent_id: P2 }),
  makeNode({ id: GONE, node_type: 'task', parent_id: P1, deleted_at: at(0) }),
];
const tree = buildTreeIndex(rows);

describe('loggedMinutesByProject', () => {
  it('adds up the tasks under a project: direct, inside a milestone, and finished ones', () => {
    const entries = [entry(DIRECT, 0, 30), entry(NESTED, 40, 100), entry(DONE, 110, 125)];
    expect(loggedMinutesByProject(tree, entries).get(P1)).toBe(30 + 60 + 15);
  });

  it('keeps each project to its own tasks, and leaves a project with nothing logged out', () => {
    const totals = loggedMinutesByProject(tree, [entry(DIRECT, 0, 20), entry(OTHER, 30, 75)]);
    expect(totals.get(P1)).toBe(20);
    expect(totals.get(P2)).toBe(45);
    expect(loggedMinutesByProject(tree, [entry(DIRECT, 0, 20)]).has(P2)).toBe(false);
    expect(loggedMinutesByProject(tree, []).size).toBe(0);
  });

  it('is the sum of canonicalProgress over the project’s tasks', () => {
    const entries = [entry(DIRECT, 0, 30), entry(NESTED, 10, 50), entry(OTHER, 20, 40), entry(DIRECT, 60, 70)];
    const sum = [DIRECT, NESTED, DONE].reduce((s, id) => s + canonicalProgress(tree.byId.get(id)!, entries).consumedMinutes, 0);
    expect(loggedMinutesByProject(tree, entries).get(P1)).toBeCloseTo(sum);
  });

  it('counts overlapping timers once: tasks of one project share the wall-clock time', () => {
    // DIRECT and NESTED both run 0–30 → 15 minutes each, 30 minutes of the project's day
    expect(loggedMinutesByProject(tree, [entry(DIRECT, 0, 30), entry(NESTED, 0, 30)]).get(P1)).toBeCloseTo(30);
    // …and a timer on another project's task takes its half from this one
    const totals = loggedMinutesByProject(tree, [entry(DIRECT, 0, 30), entry(OTHER, 0, 30)]);
    expect(totals.get(P1)).toBeCloseTo(15);
    expect(totals.get(P2)).toBeCloseTo(15);
  });

  it('ignores time on deleted or unknown tasks, and on tasks outside any project', () => {
    const loose = idOf(50);
    const withLoose = buildTreeIndex([...rows, makeNode({ id: loose, node_type: 'task' })]);
    const entries = [entry(GONE, 0, 30), entry(idOf(99), 0, 30), entry(loose, 0, 30)];
    expect(loggedMinutesByProject(withLoose, entries).size).toBe(0);
  });

  it('counts an unfocused or low-focus session by its raw time, like the task does', () => {
    const entries = [entry(DIRECT, 0, 60, { focus_factor: 0.5 })];
    expect(loggedMinutesByProject(tree, entries).get(P1)).toBe(canonicalProgress(tree.byId.get(DIRECT)!, entries).consumedMinutes);
  });
});
