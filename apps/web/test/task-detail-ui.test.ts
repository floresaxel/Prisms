// @vitest-environment jsdom
/**
 * Task details as a user meets them: a row opens the card when clicked anywhere
 * but its controls, and its title renames in place when the title itself is
 * clicked. In the card every field saves through its own verb — details,
 * dates, hours budget (minutes), location (spread into the attributes bag),
 * project (move, or promote for an Inbox capture), steps and dependencies.
 * `@prisms/ui` data hooks are mocked (no PowerSync runtime).
 */
import { createElement } from 'react';

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildFactContext, sortOrderBetween, SYNC_ROW_DEFAULTS, type Edge, type FactContext, type Node, type NodeType, type TaskStep } from '@prisms/core';
import type { PromoteTarget } from '@prisms/ui';

const T0 = '2026-11-01T00:00:00.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

let seq = 0;
function node(type: NodeType, title: string, parent: Node | null, extra: Partial<Node> = {}): Node {
  seq += 1;
  return {
    id: uuid(seq),
    user_id: uuid(0),
    created_at: T0,
    updated_at: T0,
    deleted_at: null,
    ...SYNC_ROW_DEFAULTS,
    parent_id: parent?.id ?? null,
    node_type: type,
    title,
    description: '',
    sort_order: `a${seq.toString().padStart(3, '0')}`,
    start_date: null,
    due_date: null,
    estimate_minutes: null,
    completed_at: null,
    completion_disposition: null,
    completed_in_block_id: null,
    habit_id: null,
    attributes: {},
    ...extra,
  };
}
function edge(pred: Node, succ: Node): Edge {
  seq += 1;
  return { id: uuid(seq), user_id: uuid(0), created_at: T0, updated_at: T0, deleted_at: null, ...SYNC_ROW_DEFAULTS, predecessor_id: pred.id, successor_id: succ.id, edge_type: 'FS', lag_minutes: 0 };
}
function step(task: Node, title: string, sortOrder: string, done = false): TaskStep {
  seq += 1;
  return { id: uuid(seq), user_id: uuid(0), created_at: T0, updated_at: T0, deleted_at: null, ...SYNC_ROW_DEFAULTS, task_id: task.id, title, done, sort_order: sortOrder };
}

const state = {
  facts: null as unknown as FactContext,
  targets: [] as PromoteTarget[],
  steps: [] as TaskStep[],
};
const commandFns = new Map<string, ReturnType<typeof vi.fn>>();
const command = (name: string) => {
  if (!commandFns.has(name)) commandFns.set(name, vi.fn(async () => undefined));
  return commandFns.get(name)!;
};
const commands = new Proxy({} as Record<string, unknown>, { get: (_t, p: string) => command(p) });

vi.mock('@prisms/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@prisms/ui')>();
  return {
    ...actual,
    useCommands: () => commands,
    useFactContext: () => state.facts,
    usePromoteTargets: () => state.targets,
    useTaskSteps: (taskId: string) => state.steps.filter((s) => s.task_id === taskId),
    useTaskProgress: () => ({ consumedMinutes: 45, estimateMinutes: 60, ratio: 0.75, percent: 75 }),
  };
});

const { EditableTitle, TaskDetailProvider, useTaskDetail, hoursText, parseHours } = await import('../src/components/TaskDetail');

// ── a small world: one vision › roadmap › two projects ──
let v: Node, r: Node, p1: Node, p2: Node, ms: Node, task: Node, other: Node, waitsFor: Node, finished: Node, capture: Node;
let link: Edge;

function world(extraTask: Partial<Node> = {}) {
  seq = 0;
  v = node('vision', 'Work', null);
  r = node('roadmap', 'Plan', v);
  p1 = node('project', 'Launch', r);
  p2 = node('project', 'Garden', r);
  ms = node('milestone', 'Beds', p2);
  task = node('task', 'Write the press release', p1, { estimate_minutes: 60, attributes: { color: 'teal' }, ...extraTask });
  other = node('task', 'Book the venue', p1);
  waitsFor = node('task', 'Pick a date', p1);
  finished = node('task', 'Old chore', p2, { completed_at: T0, completion_disposition: 'completed' });
  capture = node('activity', 'Buy stamps', null);
  link = edge(waitsFor, task); // the press release waits on picking a date
  state.facts = buildFactContext({ nodes: [v, r, p1, p2, ms, task, other, waitsFor, finished, capture], edges: [link] });
  state.targets = [
    { id: p1.id, title: p1.title, type: 'project' },
    { id: p2.id, title: p2.title, type: 'project' },
    { id: ms.id, title: ms.title, type: 'milestone' },
  ];
}

function Rows({ nodes }: { nodes: Node[] }) {
  const detail = useTaskDetail();
  return createElement(
    'ul',
    null,
    nodes.map((n) =>
      createElement(
        'li',
        { key: n.id, 'data-testid': `row-${n.id}`, ...detail.rowProps(n.id) },
        createElement('button', { 'data-testid': `check-${n.id}` }, '✓'),
        createElement('span', { 'data-testid': `meta-${n.id}` }, 'meta'),
        createElement(EditableTitle, { node: n, commands: commands as never }),
      ),
    ),
  );
}

const mount = (nodes: Node[] = [task]) =>
  render(createElement(TaskDetailProvider, { ctx: { userId: uuid(0), deviceId: 'd' } }, createElement(Rows, { nodes })));
const card = () => screen.queryByTestId('td-dialog');
const openCard = (n: Node = task) => fireEvent.click(screen.getByTestId(`meta-${n.id}`));
const input = (testId: string) => screen.getByTestId(testId) as HTMLInputElement;

beforeEach(() => {
  commandFns.clear();
  world();
});
afterEach(cleanup);

describe('rows', () => {
  it('clicking the title renames in place — Enter saves, and no card opens', () => {
    mount();
    fireEvent.click(screen.getByTestId(`title-${task.id}`));
    const field = input(`title-input-${task.id}`);
    expect(field.value).toBe('Write the press release');
    fireEvent.change(field, { target: { value: '  Write the launch note ' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(command('rename')).toHaveBeenCalledWith(task.id, 'Write the launch note');
    expect(card()).toBeNull();
    expect(screen.queryByTestId(`title-input-${task.id}`)).toBeNull();
  });

  it('Escape leaves the title as it was; an empty title is not saved', () => {
    mount();
    fireEvent.click(screen.getByTestId(`title-${task.id}`));
    fireEvent.change(input(`title-input-${task.id}`), { target: { value: 'Nope' } });
    fireEvent.keyDown(input(`title-input-${task.id}`), { key: 'Escape' });
    expect(screen.getByTestId(`title-${task.id}`).textContent).toBe('Write the press release');
    fireEvent.click(screen.getByTestId(`title-${task.id}`));
    fireEvent.change(input(`title-input-${task.id}`), { target: { value: '   ' } });
    fireEvent.blur(input(`title-input-${task.id}`));
    expect(command('rename')).not.toHaveBeenCalled();
  });

  it('a click anywhere else on the row opens the card; the row’s own buttons do not', () => {
    mount();
    fireEvent.click(screen.getByTestId(`check-${task.id}`));
    expect(card()).toBeNull();
    openCard();
    expect(card()?.dataset.task).toBe(task.id);
    expect(input('td-title').value).toBe('Write the press release');
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('Task details: Write the press release');
  });

  it('a drag that ends on the row — off the title, or across its text — does not open the card', () => {
    mount();
    const row = screen.getByTestId(`row-${task.id}`);
    // pressed on the title, released on the row: the click lands on the row
    fireEvent.mouseDown(screen.getByTestId(`title-${task.id}`), { clientX: 10, clientY: 10 });
    fireEvent.click(row, { clientX: 60, clientY: 10 });
    expect(card()).toBeNull();
    // pressed and released on the row's text, but moved in between
    fireEvent.mouseDown(screen.getByTestId(`meta-${task.id}`), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByTestId(`meta-${task.id}`), { clientX: 30, clientY: 12 });
    expect(card()).toBeNull();
    // a click that leaves text selected in the row
    const range = document.createRange();
    range.selectNodeContents(screen.getByTestId(`meta-${task.id}`));
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.mouseDown(screen.getByTestId(`meta-${task.id}`), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByTestId(`meta-${task.id}`), { clientX: 10, clientY: 10 });
    expect(card()).toBeNull();
    // …and a plain click still opens it
    window.getSelection()!.removeAllRanges();
    fireEvent.mouseDown(screen.getByTestId(`meta-${task.id}`), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByTestId(`meta-${task.id}`), { clientX: 11, clientY: 10 });
    expect(card()).not.toBeNull();
  });

  it('Enter on a focused row opens the card too', () => {
    mount();
    const row = screen.getByTestId(`row-${task.id}`);
    expect(row.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(card()).not.toBeNull();
  });
});

describe('the card’s fields', () => {
  it('shows where the task lives, its budget and the time logged against it', () => {
    mount();
    openCard();
    const dlg = card()!;
    expect(dlg.textContent).toContain('Work › Plan › Launch');
    expect(screen.getByTestId('td-project').getAttribute('data-value')).toBe(p1.id);
    expect(input('td-hours').value).toBe('1');
    expect(screen.getByTestId('td-logged').textContent).toBe('45m logged · 75% of budget');
  });

  it('is compact: only fields with a value show, the rest are "+" chips that add and focus them', () => {
    world({ estimate_minutes: null });
    mount([other]);
    openCard(other);
    for (const id of ['td-start', 'td-due', 'td-location', 'td-details', 'td-steps', 'td-deps']) expect(screen.queryByTestId(id)).toBeNull();
    // the budget row shows anyway: time is logged against the task (the mock logs 45m)
    expect(screen.getByTestId('td-logged').textContent).toContain('45m logged');
    const chips = within(screen.getByTestId('td-adds')).getAllByRole('button').map((b) => b.textContent);
    expect(chips).toEqual(['Start date', 'Expected completion', 'Location', 'Details', 'Steps', 'Dependencies']);

    fireEvent.click(screen.getByTestId('td-add-location'));
    expect(document.activeElement).toBe(screen.getByTestId('td-location'));
    expect(screen.queryByTestId('td-add-location')).toBeNull();
    fireEvent.click(screen.getByTestId('td-add-steps'));
    expect(document.activeElement).toBe(screen.getByTestId('td-step-add'));
  });

  it('shows the fields a task already has, with no chip for them', () => {
    world({ start_date: '2026-11-20', description: 'Quote the mayor.', attributes: { location: 'Studio B' } });
    mount();
    openCard();
    expect(input('td-start').value).toBe('2026-11-20');
    expect(input('td-details').value).toBe('Quote the mayor.');
    expect(input('td-location').value).toBe('Studio B');
    expect(screen.getByTestId('td-deps')).toBeTruthy(); // it waits on "Pick a date"
    const chips = within(screen.getByTestId('td-adds')).getAllByRole('button').map((b) => b.textContent);
    expect(chips).toEqual(['Expected completion', 'Steps']);
  });

  it('title, details, dates, budget and location save through their verbs', () => {
    mount();
    openCard();
    for (const k of ['details', 'due', 'start', 'location']) fireEvent.click(screen.getByTestId(`td-add-${k}`));

    fireEvent.change(input('td-title'), { target: { value: 'Press release v2' } });
    fireEvent.keyDown(input('td-title'), { key: 'Enter' });
    fireEvent.blur(input('td-title'));
    expect(command('rename')).toHaveBeenCalledWith(task.id, 'Press release v2');

    fireEvent.focus(input('td-details'));
    fireEvent.change(input('td-details'), { target: { value: 'Quote the mayor.\n\n' } });
    fireEvent.blur(input('td-details'));
    expect(command('setDescription')).toHaveBeenCalledWith(task.id, 'Quote the mayor.');

    fireEvent.change(input('td-due'), { target: { value: '2026-12-01' } });
    expect(command('setDates')).toHaveBeenCalledWith(task.id, { dueDate: '2026-12-01' });
    fireEvent.change(input('td-start'), { target: { value: '2026-11-20' } });
    expect(command('setDates')).toHaveBeenCalledWith(task.id, { startDate: '2026-11-20' });

    fireEvent.change(input('td-hours'), { target: { value: '2.5' } });
    fireEvent.blur(input('td-hours'));
    expect(command('setEstimate')).toHaveBeenCalledWith(task.id, 150);

    // location rides in the attributes bag — the other keys are carried over
    fireEvent.change(input('td-location'), { target: { value: ' Studio B ' } });
    fireEvent.blur(input('td-location'));
    expect(command('setNodeAttributes')).toHaveBeenCalledWith(task.id, { color: 'teal', location: 'Studio B' });
  });

  it('a budget that is not a number puts the stored hours back', () => {
    mount();
    openCard();
    fireEvent.change(input('td-hours'), { target: { value: 'lots' } });
    fireEvent.blur(input('td-hours'));
    expect(command('setEstimate')).not.toHaveBeenCalled();
    expect(input('td-hours').value).toBe('1');
  });

  it('clearing a set location removes the key; clearing a date sends null', () => {
    world({ attributes: { color: 'teal', location: 'Studio B' }, due_date: '2026-12-01' });
    mount();
    openCard();
    expect(input('td-location').value).toBe('Studio B');
    fireEvent.change(input('td-location'), { target: { value: '' } });
    fireEvent.blur(input('td-location'));
    expect(command('setNodeAttributes')).toHaveBeenCalledWith(task.id, { color: 'teal' });
    fireEvent.click(screen.getByTestId('td-due-clear'));
    expect(command('setDates')).toHaveBeenCalledWith(task.id, { dueDate: null });
  });

  it('warns when the expected completion comes before the start', () => {
    world({ start_date: '2026-12-05', due_date: '2026-12-01' });
    mount();
    openCard();
    expect(screen.getByTestId('td-dates-warn').textContent).toBe('ends before it starts');
  });
});

describe('details mark', () => {
  it('a notebook icon follows the title only when the task has details', () => {
    const plain = node('task', 'No notes here', p1);
    const noted = node('task', 'Has notes', p1, { description: 'Quote the mayor.' });
    const blank = node('task', 'Whitespace only', p1, { description: '   \n ' });
    mount([plain, noted, blank]);
    expect(screen.queryByTestId(`has-details-${plain.id}`)).toBeNull();
    expect(screen.queryByTestId(`has-details-${blank.id}`)).toBeNull();
    const mark = screen.getByTestId(`has-details-${noted.id}`);
    // right after the title button, in the same row
    expect(screen.getByTestId(`title-${noted.id}`).nextElementSibling).toBe(mark);
  });
});

describe('project', () => {
  /** Opens the project picker and clicks one of its bubbles. */
  const choose = (id: string) => {
    fireEvent.click(screen.getByTestId('td-project'));
    fireEvent.click(screen.getByTestId(`td-project-opt-${id}`));
  };

  it('a task moves to the end of the chosen project', () => {
    mount();
    openCard();
    const last = state.facts.tree.childrenByParent.get(p2.id)!.at(-1)!;
    choose(p2.id);
    expect(command('moveNode')).toHaveBeenCalledWith(task.id, p2.id, sortOrderBetween(last.sort_order, null));
  });

  it('milestones are named with their project', () => {
    mount();
    openCard();
    fireEvent.click(screen.getByTestId('td-project'));
    const options = within(screen.getByRole('listbox', { name: 'Project' }))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(['Garden', 'Garden › Beds', 'Launch']);
  });

  it('offers a new project under a roadmap, and a task moves into it', async () => {
    mount();
    openCard();
    command('createProject').mockResolvedValue(uuid(999));
    fireEvent.click(screen.getByTestId('td-project'));
    fireEvent.click(screen.getByTestId('td-project-new-open'));
    fireEvent.change(screen.getByTestId('td-project-new-name'), { target: { value: 'Brand refresh' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('td-project-new-create'));
    });
    const last = state.facts.tree.childrenByParent.get(r.id)!.at(-1)!;
    expect(command('createProject')).toHaveBeenCalledWith({ roadmapId: r.id, title: 'Brand refresh', sortOrder: sortOrderBetween(last.sort_order, null) });
    expect(command('moveNode')).toHaveBeenCalledWith(task.id, uuid(999), expect.any(String));
  });

  it('an Inbox capture is promoted into it, and has no steps or dependencies until then', () => {
    mount([capture]);
    openCard(capture);
    expect(card()!.textContent).toContain('Inbox capture');
    expect(screen.getByTestId('td-capture-hint')).toBeTruthy();
    expect(screen.queryByTestId('td-steps')).toBeNull();
    expect(screen.queryByTestId('td-deps')).toBeNull();
    expect(screen.queryByTestId('td-add-steps')).toBeNull();
    expect(screen.queryByTestId('td-add-deps')).toBeNull();
    choose(p1.id);
    expect(command('promoteActivity')).toHaveBeenCalledWith(capture.id, { parentId: p1.id });
  });
});

describe('steps', () => {
  it('add on Enter, toggle, rename, reorder and remove', () => {
    const s1 = step(task, 'Outline', 'a1');
    const s2 = step(task, 'Draft', 'a2', true);
    state.steps = [s1, s2];
    mount();
    openCard();
    const steps = screen.getByTestId('td-steps');
    expect(steps.textContent).toContain('1/2');

    fireEvent.change(input('td-step-add'), { target: { value: 'Proofread' } });
    fireEvent.keyDown(input('td-step-add'), { key: 'Enter' });
    expect(command('addStep')).toHaveBeenCalledWith({ taskId: task.id, title: 'Proofread', sortOrder: sortOrderBetween('a2', null) });
    expect(input('td-step-add').value).toBe('');

    const row1 = within(screen.getByTestId(`td-step-${s1.id}`));
    fireEvent.click(row1.getByRole('button', { name: 'Mark “Outline” done' }));
    expect(command('toggleStep')).toHaveBeenCalledWith(s1.id, true);

    fireEvent.click(row1.getByRole('button', { name: 'Move step down' }));
    expect(command('reorderStep')).toHaveBeenCalledWith(s1.id, sortOrderBetween('a2', null));
    expect((row1.getByRole('button', { name: 'Move step up' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(row1.getByRole('button', { name: 'Outline' }));
    const rename = row1.getByRole('textbox', { name: 'Step title' });
    fireEvent.change(rename, { target: { value: 'Outline it' } });
    fireEvent.keyDown(rename, { key: 'Enter' });
    expect(command('renameStep')).toHaveBeenCalledWith(s1.id, 'Outline it');

    fireEvent.click(within(screen.getByTestId(`td-step-${s2.id}`)).getByRole('button', { name: 'Remove step “Draft”' }));
    expect(command('removeStep')).toHaveBeenCalledWith(s2.id);
  });

  it('a done task’s steps are frozen', () => {
    world({ completed_at: T0, completion_disposition: 'completed' });
    state.steps = [step(task, 'Outline', 'a1')];
    mount();
    openCard();
    expect(screen.queryByTestId('td-step-add')).toBeNull();
    expect(screen.getByTestId('td-steps').textContent).toContain('frozen');
    expect(screen.getByTestId('td-status').textContent).toContain('done');
  });
});

describe('dependencies', () => {
  const optionIds = (testId: string) => [...(screen.getByTestId(testId) as HTMLSelectElement).options].map((o) => o.value).filter((v) => v !== '');

  it('lists what the task waits on, and offers only links that keep the graph acyclic', () => {
    mount();
    openCard();
    expect(screen.getByTestId(`td-dep-${link.id}`).textContent).toContain('Pick a date');
    // waits on: not itself, not the already-linked task, not a done task
    expect(optionIds('td-dep-add-before')).toEqual([other.id]);
    // blocks: "Pick a date" would close a cycle (it already comes first)
    expect(optionIds('td-dep-add-after')).toEqual([other.id]);
  });

  it('links and unlinks', () => {
    mount();
    openCard();
    fireEvent.change(input('td-dep-add-before'), { target: { value: other.id } });
    expect(command('createEdge')).toHaveBeenCalledWith({ predecessorId: other.id, successorId: task.id });
    fireEvent.change(input('td-dep-add-after'), { target: { value: other.id } });
    expect(command('createEdge')).toHaveBeenCalledWith({ predecessorId: task.id, successorId: other.id });
    fireEvent.click(screen.getByRole('button', { name: 'Remove dependency on “Pick a date”' }));
    expect(command('deleteEdge')).toHaveBeenCalledWith(link.id);
  });

  it('a linked task opens in the same card', () => {
    mount();
    openCard();
    fireEvent.click(within(screen.getByTestId(`td-dep-${link.id}`)).getByRole('button', { name: 'Pick a date' }));
    expect(card()?.dataset.task).toBe(waitsFor.id);
    expect(input('td-title').value).toBe('Pick a date');
    // and from there, the press release is what it blocks
    expect(card()!.textContent).toContain('Write the press release');
  });
});

describe('closing', () => {
  it('Done keeps an edit that is still in its field', () => {
    mount();
    openCard();
    fireEvent.click(screen.getByTestId('td-add-location'));
    const loc = input('td-location');
    act(() => loc.focus());
    fireEvent.change(loc, { target: { value: 'Studio C' } });
    fireEvent.click(screen.getByTestId('td-done'));
    expect(command('setNodeAttributes')).toHaveBeenCalledWith(task.id, { color: 'teal', location: 'Studio C' });
    expect(card()).toBeNull();
  });

  it('Escape in a field with unsaved text reverts it and keeps the card; Escape again closes', () => {
    mount();
    openCard();
    fireEvent.click(screen.getByTestId('td-add-location'));
    const loc = input('td-location');
    act(() => loc.focus());
    fireEvent.change(loc, { target: { value: 'Studio C' } });
    fireEvent.keyDown(loc, { key: 'Escape' });
    expect(card()).not.toBeNull();
    expect(loc.value).toBe('');
    fireEvent.keyDown(loc, { key: 'Escape' });
    expect(card()).toBeNull();
    expect(command('setNodeAttributes')).not.toHaveBeenCalled();
  });

  it('Delete asks once, then soft-deletes and closes', async () => {
    mount();
    openCard();
    fireEvent.click(screen.getByTestId('td-delete'));
    expect(command('softDelete')).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByTestId('td-delete-confirm')));
    expect(command('softDelete')).toHaveBeenCalledWith(task.id);
    expect(card()).toBeNull();
  });

  it('a refused save shows in the card', async () => {
    command('setEstimate').mockRejectedValueOnce(Object.assign(new Error('nope'), { code: 'E_DONE_IMMUTABLE' }));
    mount();
    openCard();
    fireEvent.change(input('td-hours'), { target: { value: '3' } });
    await act(async () => fireEvent.blur(input('td-hours')));
    expect(screen.getByTestId('td-error').textContent).toContain('already done');
  });
});

describe('hours ↔ minutes', () => {
  it('formats and parses the budget', () => {
    expect(hoursText(null)).toBe('');
    expect(hoursText(90)).toBe('1.5');
    expect(hoursText(100)).toBe('1.67');
    expect(parseHours('')).toBeNull();
    expect(parseHours('1,5')).toBe(90);
    expect(parseHours('0')).toBeNull();
    expect(parseHours('-1')).toBeUndefined();
    expect(parseHours('soon')).toBeUndefined();
  });
});
