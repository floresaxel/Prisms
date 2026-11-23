// @vitest-environment jsdom
/**
 * Plan › Roadmap › Flow as a user meets it: outcomes as rows, a details panel
 * that edits what is selected, links switched between finish → start and start
 * together, gaps, and the switch to free flow. Every write goes through the
 * `actions` prop, so the test sees exactly which commands an edit sends — and it
 * renders without a sync runtime. jsdom has no layout or pointer capture, so
 * cards are picked by keyboard-style clicks (detail 0).
 */
import { createElement } from 'react';

import { buildTreeIndex, type Node } from '@prisms/core';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RoadmapFlow, type FlowActions } from '../src/components/RoadmapFlow';
import { FLOW_LAYOUT_KEY } from '../src/roadmap-flow';
import { buildRoadmapModel } from '../src/roadmap-model';

import { installMemoryStorage } from './util/memory-storage';
import { roadmapFixture } from './util/roadmap-fixture';

const OUTCOMES = [
  { id: 'o-draft', name: 'Draft', statement: 'A full draft exists', measure: '' },
  { id: 'o-cover', name: 'Cover', statement: 'A cover people pick up', measure: '' },
];

function setup(extra: Partial<Parameters<typeof RoadmapFlow>[0]> = {}) {
  const fx = roadmapFixture();
  const { ids } = fx;
  const rows: Node[] = fx.rows.map((r) => {
    if (r.id === ids.r.id) return { ...r, attributes: { keep: 'me', outcomes: OUTCOMES } };
    if (r.id === ids.p1.id || r.id === ids.p2.id) return { ...r, attributes: { outcome_id: 'o-draft', note: 'x' } };
    return r;
  });
  const tree = buildTreeIndex(rows);
  const model = buildRoadmapModel(tree, fx.edges, ids.r.id)!;
  const actions: FlowActions = {
    createProject: vi.fn(async () => 'new-project'),
    rename: vi.fn(async () => undefined),
    setAttributes: vi.fn(async () => undefined),
    createLink: vi.fn(async () => undefined),
    deleteLink: vi.fn(async () => undefined),
    setPosition: vi.fn(async () => undefined),
    deleteProject: vi.fn(async () => undefined),
    newId: () => 'o-new',
    confirm: vi.fn(() => true),
  };
  const onNavigate = vi.fn();
  render(
    createElement(RoadmapFlow, {
      model,
      roadmap: tree.byId.get(ids.r.id)!,
      vision: tree.byId.get(ids.v.id)!,
      layouts: new Map(),
      actions,
      onNavigate,
      ...extra,
    }),
  );
  return { fx, ids, actions, onNavigate, model };
}
const body = (id: string) => within(screen.getByTestId(`rf-card-${id}`)).getAllByRole('button')[0]!;
const panel = () => screen.getByTestId('rf-inspector');
const flush = () => act(async () => {});

beforeEach(() => installMemoryStorage());
afterEach(cleanup);

describe('the screen layout', () => {
  it('heads the roadmap with its vision, what it is realized by, and where it stands', () => {
    setup({ visionColor: { name: 'blue', hex: '#2563eb' }, top: createElement('nav', { 'data-testid': 'the-picker' }) });
    const root = screen.getByTestId('rf');
    // picker, header card and builder card share the main column; details sit beside them
    expect(root.querySelector('.px-rb-main [data-testid="the-picker"]')).toBeTruthy();
    expect(root.querySelector('.px-rb-main .px-rb-hdr')).toBeTruthy();
    expect(root.querySelector('.px-rb-main [data-testid="rm-views"]')).toBeTruthy();
    expect(root.querySelector('.px-rb-main [data-testid="rf-inspector"]')).toBeNull();
    expect(screen.getByTestId('rm-vision-name').textContent).toBe('Write a novel');
    expect(screen.getByTestId('rm-vision-swatch').dataset.color).toBe('blue');
    const chips = screen.getByTestId('rf-outcomes');
    expect(chips.textContent).toContain('Realized when');
    expect(chips.textContent).toContain('A full draft exists1/2'); // Research is done, Draft act two is not
    expect(chips.textContent).toContain('A cover people pick upgap');
    expect(screen.getByTestId('rm-stats').textContent).toBe('Steps to the vision4Projects7Done1In progress2');
  });

  it('adds a project from the toolbar and hands its name to the details column', async () => {
    const { actions } = setup();
    fireEvent.click(screen.getByTestId('rf-add-project'));
    await flush();
    expect(actions.createProject).toHaveBeenCalledWith({ title: 'New project', attributes: { outcome_id: 'o-draft' } });
  });

  it('offers the other views, which pick into the same details column', () => {
    const renderView = vi.fn((view: string, ctx: { selectedId: string | null; onPick: (id: string) => void }) =>
      createElement('button', { 'data-testid': 'other-view', 'data-view': view, 'data-selected': ctx.selectedId ?? '', onClick: () => ctx.onPick(ids.p4.id) }),
    );
    const { ids } = setup({ renderView });
    const tabs = within(screen.getByRole('radiogroup', { name: 'Roadmap view' })).getAllByRole('radio');
    expect(tabs.map((t) => t.textContent)).toEqual(['Flow', 'Outline', 'List', 'Order', 'Mind map']);
    expect(screen.getByTestId('rm-views').dataset.view).toBe('flow');
    fireEvent.click(screen.getByTestId('rm-view-list'));
    expect(screen.getByTestId('rm-views').dataset.view).toBe('list');
    expect(screen.queryByTestId('rf-board')).toBeNull();
    expect(screen.queryByTestId('rf-layout-free')).toBeNull(); // the layout bar belongs to Flow
    fireEvent.click(screen.getByTestId('other-view'));
    expect((screen.getByTestId('rf-p-title') as HTMLInputElement).value).toBe('Beta readers');
    expect(screen.getByTestId('other-view').dataset.selected).toBe(ids.p4.id);
    // the choice is remembered, and Flow comes back with the selection intact
    expect(localStorage.getItem('prisms.roadmap.view')).toBe('list');
    fireEvent.click(screen.getByTestId('rm-view-flow'));
    expect(screen.getByTestId(`rf-card-${ids.p4.id}`).className).toContain('px-rf-card--sel');
  });

  it('shows Flow alone when the screen passes no other views', () => {
    setup();
    expect(screen.queryByRole('radiogroup', { name: 'Roadmap view' })).toBeNull();
    expect(screen.getByTestId('rf-board')).toBeTruthy();
  });
});

describe('Structured (the default)', () => {
  it('lays the outcomes out as rows and the projects in the columns of their steps', () => {
    const { ids } = setup();
    expect(screen.getByTestId('rf').dataset.layout).toBe('structured');
    expect(screen.getByTestId(`rf-card-${ids.p1.id}`).dataset.lane).toBe('o-draft');
    expect(screen.getByTestId(`rf-card-${ids.p2.id}`).dataset.lane).toBe('o-draft');
    expect(screen.getByTestId(`rf-card-${ids.p4.id}`).dataset.lane).toBe('none');
    expect(screen.getByTestId(`rf-card-${ids.p4.id}`).dataset.step).toBe('3');
    expect(screen.getByTestId(`rf-card-${ids.p6.id}`).dataset.step).toBe('any');
    expect(screen.getByTestId('rf-lane-none').textContent).toContain('Not delivering an outcome');
    expect(screen.getByTestId('rf-cap-o-cover').textContent).toContain('Nothing delivers this');
  });

  it('lists the gaps, and a project gap picks the project', () => {
    setup();
    const gaps = screen.getByTestId('rf-gaps');
    expect(gaps.textContent).toContain('“A cover people pick up” has nothing delivering it');
    expect(gaps.textContent).toContain('“Beta readers” doesn’t deliver an outcome');
    fireEvent.click(within(gaps).getByText('“Beta readers” doesn’t deliver an outcome'));
    expect(panel().dataset.kind).toBe('project');
    expect((screen.getByTestId('rf-p-title') as HTMLInputElement).value).toBe('Beta readers');
  });

  it('says how to start when the roadmap has no projects', () => {
    const fx = roadmapFixture();
    const model = buildRoadmapModel(fx.tree, fx.edges, fx.ids.r.id)!;
    render(
      createElement(RoadmapFlow, {
        model: { ...model, projects: [], byId: new Map(), steps: [], free: [], links: [] },
        roadmap: fx.ids.r,
        vision: fx.ids.v,
        layouts: new Map(),
        actions: {} as FlowActions,
        onNavigate: vi.fn(),
      }),
    );
    expect(screen.getByTestId('rm-no-projects').textContent).toContain('no projects yet');
    expect(screen.getByTestId('rf-lane-none').textContent).toContain('Projects'); // no outcomes: a plain row, no warning
    expect(screen.queryByTestId('rf-gaps')).toBeNull();
  });

  it('opens on the vision, with the roadmap’s outcomes', () => {
    setup();
    expect(panel().dataset.kind).toBe('roadmap');
    expect(screen.getByTestId('rf-vision-title').textContent).toBe('Write a novel');
    expect(panel().textContent).toContain('A full draft exists');
  });
});

describe('the details panel', () => {
  it('edits what a project delivers, keeping its other attributes', async () => {
    const { ids, actions } = setup();
    fireEvent.click(body(ids.p2.id));
    fireEvent.change(screen.getByTestId('rf-p-outcome'), { target: { value: 'o-cover' } });
    await flush();
    expect(actions.setAttributes).toHaveBeenCalledWith(ids.p2.id, { outcome_id: 'o-cover', note: 'x' });
    // Structured with nothing placed by hand: no free-flow spot is written
    expect(actions.setPosition).not.toHaveBeenCalled();
  });

  it('saves done-when on blur, and toggles the rough size', async () => {
    const { ids, actions } = setup();
    fireEvent.click(body(ids.p1.id));
    const done = screen.getByTestId('rf-p-done');
    fireEvent.focus(done);
    fireEvent.change(done, { target: { value: 'Notes filed' } });
    fireEvent.blur(done);
    await flush();
    expect(actions.setAttributes).toHaveBeenLastCalledWith(ids.p1.id, { outcome_id: 'o-draft', note: 'x', done_when: 'Notes filed' });
    fireEvent.click(screen.getByTestId('rf-p-size-L'));
    await flush();
    // builds on the done-when just written, though the props have not caught up
    expect(actions.setAttributes).toHaveBeenLastCalledWith(ids.p1.id, { outcome_id: 'o-draft', note: 'x', done_when: 'Notes filed', size: 'L' });
  });

  it('totals the time logged inside a project, against its duration when it has one', () => {
    // the fixture's ids are the same on every build, so the project is known before setup
    const { ids } = setup({ logged: new Map([[roadmapFixture().ids.p1.id, 95]]) });
    fireEvent.click(body(ids.p1.id));
    expect(screen.getByTestId('rf-p-logged').textContent).toBe('1h 35m logged');
    // a project nothing was logged in says so
    fireEvent.click(body(ids.p2.id));
    expect(screen.getByTestId('rf-p-logged').textContent).toBe('nothing logged yet');
  });

  it('shows it against the project’s duration budget, and follows time as it is logged', () => {
    const fx = roadmapFixture();
    const budgeted = fx.rows.map((r) => (r.id === fx.ids.p1.id ? { ...r, estimate_minutes: 240 } : r));
    const tree = buildTreeIndex(budgeted);
    const model = buildRoadmapModel(tree, fx.edges, fx.ids.r.id)!;
    const props = (logged: ReadonlyMap<string, number>) => ({
      model,
      roadmap: tree.byId.get(fx.ids.r.id)!,
      vision: tree.byId.get(fx.ids.v.id)!,
      layouts: new Map(),
      actions: {} as FlowActions,
      onNavigate: vi.fn(),
      logged,
    });
    const { rerender } = render(createElement(RoadmapFlow, props(new Map([[fx.ids.p1.id, 60]]))));
    fireEvent.click(body(fx.ids.p1.id));
    expect(screen.getByTestId('rf-p-logged').textContent).toBe('1h 0m logged · 25% of duration');
    // a session clocked out elsewhere lands: the same open panel updates
    rerender(createElement(RoadmapFlow, props(new Map([[fx.ids.p1.id, 150]]))));
    expect(screen.getByTestId('rf-p-logged').textContent).toBe('2h 30m logged · 63% of duration');
  });

  it('switches a drawn link to start-together, and only offers links that make no loop', async () => {
    const { ids, fx, actions } = setup();
    fireEvent.click(body(ids.p3.id)); // Revise act one waits on Research by a project edge
    fireEvent.click(screen.getByTestId(`rf-dep-kind-${ids.p1.id}-${ids.p3.id}`));
    await flush();
    expect(actions.deleteLink).toHaveBeenCalledWith(fx.edges[1]!.id);
    expect(actions.createLink).toHaveBeenCalledWith(ids.p1.id, ids.p3.id, 'SS');

    fireEvent.click(body(ids.p1.id));
    const before = screen.getByTestId('rf-add-before') as HTMLSelectElement;
    const offered = [...before.options].map((o) => o.textContent);
    expect(offered).not.toContain('Final draft'); // Research already leads to it: a loop
    expect(offered).toContain('Writing habit');
    fireEvent.change(before, { target: { value: ids.p6.id } });
    await flush();
    expect(actions.createLink).toHaveBeenLastCalledWith(ids.p6.id, ids.p1.id, 'FS');
  });

  it('cannot remove a link that only exists through tasks', () => {
    const { ids } = setup();
    fireEvent.click(body(ids.p2.id));
    const row = screen.getByTestId(`rf-dep-${ids.p1.id}-${ids.p2.id}`);
    expect(row.textContent).toContain('via tasks');
    expect(screen.queryByTestId(`rf-dep-remove-${ids.p1.id}-${ids.p2.id}`)).toBeNull();
  });

  it('adds an outcome to the roadmap’s attributes and opens it', async () => {
    const { ids, actions } = setup();
    fireEvent.click(screen.getByTestId('rf-add-outcome'));
    await flush();
    expect(actions.setAttributes).toHaveBeenCalledWith(ids.r.id, {
      keep: 'me',
      outcomes: [...OUTCOMES, { id: 'o-new', name: 'New outcome', statement: '', measure: '' }],
    });
  });

  it('builds quick edits on each other, so a second save never undoes the first', async () => {
    // set_attributes replaces the whole bag; the props here never catch up (no sync
    // runtime), which is exactly the window a fast typist hits on the real stack.
    const { ids, actions } = setup();
    fireEvent.click(screen.getByTestId('rf-cap-o-cover'));
    const name = screen.getByTestId('rf-o-name');
    fireEvent.focus(name);
    fireEvent.change(name, { target: { value: 'Brand' } });
    fireEvent.blur(name);
    const statement = screen.getByTestId('rf-o-statement');
    fireEvent.focus(statement);
    fireEvent.change(statement, { target: { value: 'People recognise it' } });
    fireEvent.blur(statement);
    await flush();
    expect(actions.setAttributes).toHaveBeenLastCalledWith(ids.r.id, {
      keep: 'me',
      outcomes: [OUTCOMES[0], { id: 'o-cover', name: 'Brand', statement: 'People recognise it', measure: '' }],
    });
  });

  it('deletes a project after asking', async () => {
    const { ids, actions } = setup();
    fireEvent.click(body(ids.p6.id));
    fireEvent.click(screen.getByTestId('rf-p-delete'));
    await flush();
    expect(actions.confirm).toHaveBeenCalled();
    expect(actions.deleteProject).toHaveBeenCalledWith(ids.p6.id);
  });

  it('adds a project to an outcome from its panel', async () => {
    const { actions } = setup();
    fireEvent.click(screen.getByTestId('rf-cap-o-cover'));
    expect(panel().dataset.kind).toBe('outcome');
    expect((screen.getByTestId('rf-o-name') as HTMLInputElement).value).toBe('Cover');
    fireEvent.click(screen.getByTestId('rf-o-add-project'));
    await flush();
    expect(actions.createProject).toHaveBeenCalledWith({ title: 'New project', attributes: { outcome_id: 'o-cover' } });
  });
});

describe('free flow', () => {
  it('switches in place, shows outcomes as groups, and remembers the choice', () => {
    const { ids } = setup();
    fireEvent.click(screen.getByTestId('rf-layout-free'));
    expect(screen.getByTestId('rf').dataset.layout).toBe('free');
    expect(screen.getByTestId('rf-group-o-draft')).toBeTruthy();
    expect(screen.getByTestId('rf-group-o-cover').textContent).toContain('Nothing delivers this yet');
    expect(screen.getByTestId(`rf-fcard-${ids.p1.id}`).dataset.outcome).toBe('o-draft');
    expect(localStorage.getItem(FLOW_LAYOUT_KEY)).toBe('free');
    // the details panel and the selection carry across
    fireEvent.click(within(screen.getByTestId(`rf-fcard-${ids.p4.id}`)).getAllByRole('button')[0]!);
    expect((screen.getByTestId('rf-p-title') as HTMLInputElement).value).toBe('Beta readers');
    fireEvent.click(screen.getByTestId('rf-layout-structured'));
    expect((screen.getByTestId('rf-p-title') as HTMLInputElement).value).toBe('Beta readers');
  });

  it('moving a card in free flow writes down every spot first, so nothing else shifts', async () => {
    const { ids, actions } = setup();
    fireEvent.click(screen.getByTestId('rf-layout-free'));
    fireEvent.click(within(screen.getByTestId(`rf-fcard-${ids.p6.id}`)).getAllByRole('button')[0]!);
    fireEvent.change(screen.getByTestId('rf-p-outcome'), { target: { value: 'o-cover' } });
    await flush();
    const placed = (actions.setPosition as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(new Set(placed)).toEqual(new Set([ids.p1.id, ids.p2.id, ids.p3.id, ids.p4.id, ids.p5.id, ids.p6.id, ids.p7.id]));
  });
});
