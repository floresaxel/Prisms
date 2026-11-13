// @vitest-environment jsdom
/**
 * Plan › Roadmap's views card as a user meets it: it opens on Order, shows what
 * blocks what, partitions the List, opens the Outline, folds the Mind map, and
 * remembers the chosen view. It takes the model as a prop, so it renders here
 * without a PowerSync runtime. jsdom has no layout: arrows are measured at 0,
 * and the mind map lays out at its pre-measure width (balanced).
 */
import { createElement } from 'react';

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RoadmapViews } from '../src/components/RoadmapViews';
import { buildRoadmapModel } from '../src/roadmap-model';

import { installMemoryStorage } from './util/memory-storage';
import { roadmapFixture } from './util/roadmap-fixture';

const fx = roadmapFixture();
const { ids } = fx;
const model = buildRoadmapModel(fx.tree, fx.edges, ids.r.id)!;

function mount(m = model) {
  const onNavigate = vi.fn();
  render(createElement(RoadmapViews, { model: m, color: '#2563eb', onNavigate }));
  return { onNavigate };
}
const view = () => screen.getByTestId('rm-views').dataset.view;
const strip = () => screen.getByTestId('rm-strip').textContent;

beforeEach(() => installMemoryStorage());
afterEach(cleanup);

describe('Order (the default)', () => {
  it('opens on Order, with the toggle in its order', () => {
    mount();
    expect(view()).toBe('order');
    const toggles = within(screen.getByRole('radiogroup', { name: 'Roadmap view' })).getAllByRole('radio');
    expect(toggles.map((t) => t.textContent?.trim())).toEqual(['Order', 'Mind map', 'Outline', 'List']);
    expect(toggles[0]!.getAttribute('aria-checked')).toBe('true');
  });

  it('lays the linked projects out in steps, and the rest as any time', () => {
    mount();
    const step = (n: number) => within(screen.getByTestId(`rm-step-${n}`)).getAllByRole('button').map((b) => b.textContent);
    expect(step(1)).toEqual([expect.stringContaining('Research')]);
    expect(step(2)).toEqual([expect.stringContaining('Draft act two'), expect.stringContaining('Revise act one')]);
    expect(step(3)).toEqual([expect.stringContaining('Beta readers')]);
    expect(step(4)).toEqual([expect.stringContaining('Final draft')]);
    expect(screen.getByTestId('rm-step-1').textContent).toContain('Step 1 First');
    expect(screen.getByTestId('rm-step-4').textContent).toContain('Step 4 Last');
    const free = screen.getByTestId('rm-order-free');
    expect(free.textContent).toContain('Any time');
    expect(free.textContent).toContain('Writing habit');
    expect(free.textContent).toContain('Cover ideas');
  });

  it('says where each project stands', () => {
    mount();
    const card = (id: string) => screen.getByTestId(`rm-order-${id}`);
    expect(card(ids.p1.id).textContent).toContain('✓ finished');
    expect(card(ids.p4.id).textContent).toContain('blocked by Draft act two, Revise act one');
    expect(card(ids.p4.id).dataset.state).toBe('blocked');
    expect(card(ids.p2.id).textContent).toContain('2 open · 3h left');
    expect(card(ids.p7.id).textContent).toContain('no tasks yet');
  });

  it('dims everything off the hovered project’s chain', () => {
    mount();
    fireEvent.mouseEnter(screen.getByTestId(`rm-order-${ids.p2.id}`));
    const dim = (id: string) => screen.getByTestId(`rm-order-${id}`).className.includes('px-rm-card--dim');
    expect(dim(ids.p1.id)).toBe(false); // before it
    expect(dim(ids.p4.id)).toBe(false); // after it
    expect(dim(ids.p3.id)).toBe(true); // its sibling, not on its chain
    expect(dim(ids.p6.id)).toBe(true);
  });

  it('picks a project into the strip, which opens Projects', () => {
    const { onNavigate } = mount();
    expect(strip()).toContain('Pick a project');
    fireEvent.click(screen.getByTestId(`rm-order-${ids.p4.id}`));
    expect(strip()).toContain('Beta readers');
    expect(strip()).toContain('0 of 1 task done');
    expect(strip()).toContain('blocked by Draft act two, Revise act one');
    fireEvent.click(screen.getByTestId('rm-open-projects'));
    expect(onNavigate).toHaveBeenCalledWith('/projects');
    // a second click puts it back
    fireEvent.click(screen.getByTestId(`rm-order-${ids.p4.id}`));
    expect(strip()).toContain('Pick a project');
  });
});

describe('List', () => {
  it('partitions projects into can move now, blocked and finished', () => {
    mount();
    fireEvent.click(screen.getByTestId('rm-view-list'));
    const names = (key: string) =>
      within(screen.getByTestId(`rm-list-${key}`)).queryAllByRole('button').map((b) => b.querySelector('b')!.textContent);
    expect(names('open')).toEqual(['Draft act two', 'Revise act one', 'Writing habit', 'Cover ideas']);
    expect(names('blocked')).toEqual(['Beta readers', 'Final draft']);
    expect(names('done')).toEqual(['Research']);
    expect(screen.getByTestId(`rm-row-${ids.p2.id}`).textContent).toContain('unblocks Beta readers');
    expect(screen.getByTestId(`rm-row-${ids.p5.id}`).textContent).toContain('blocked by Beta readers');
    expect(screen.getByTestId(`rm-row-${ids.p1.id}`).textContent).toContain('all tasks done');
  });
});

describe('Outline', () => {
  it('opens a project into its milestones and tasks', () => {
    mount();
    fireEvent.click(screen.getByTestId('rm-view-outline'));
    expect(screen.queryByTestId(`rm-outline-${ids.m1.id}`)).toBeNull();
    fireEvent.click(screen.getByTestId(`rm-outline-toggle-${ids.p3.id}`));
    expect(screen.getByTestId(`rm-outline-${ids.m1.id}`).textContent).toContain('Opening');
    expect(screen.getByTestId(`rm-outline-${ids.m1.id}`).textContent).toContain('1/2');
    expect(screen.getByTestId(`rm-outline-${ids.t6.id}`)).toBeTruthy(); // the milestone's own task, a level down
    expect(screen.getByTestId(`rm-outline-${ids.t5.id}`).className).toContain('--done');
    // a project with nothing in it has nothing to open
    expect((screen.getByTestId(`rm-outline-toggle-${ids.p7.id}`) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId(`rm-outline-${ids.p4.id}`).textContent).toContain('Draft act two, Revise act one');
  });
});

describe('Mind map', () => {
  it('puts the roadmap in the middle and every project round it, with its twigs', () => {
    mount();
    fireEvent.click(screen.getByTestId('rm-view-map'));
    expect(screen.getByTestId('rm-map').dataset.mode).toBe('balanced');
    expect(screen.getByTestId('rm-map-root').textContent).toContain('Finish the novel');
    expect(screen.getByTestId(`rm-map-${ids.p1.id}`).dataset.side).toBe('right');
    expect(screen.getByTestId(`rm-map-${ids.p2.id}`).dataset.side).toBe('left');
    expect(screen.getByTestId(`rm-twig-${ids.t3.id}`)).toBeTruthy();
    expect(screen.getByTestId(`rm-twig-${ids.m1.id}`).textContent).toContain('1/2');
  });

  it('folds a branch, and folds or unfolds them all', () => {
    mount();
    fireEvent.click(screen.getByTestId('rm-view-map'));
    fireEvent.click(screen.getByTestId(`rm-fold-${ids.p2.id}`));
    expect(screen.queryByTestId(`rm-twig-${ids.t3.id}`)).toBeNull();
    expect(screen.getByTestId(`rm-fold-${ids.p2.id}`).textContent).toBe('3'); // how many are folded away
    fireEvent.click(screen.getByTestId('rm-unfold-all'));
    expect(screen.getByTestId(`rm-twig-${ids.t3.id}`)).toBeTruthy();
    fireEvent.click(screen.getByTestId('rm-fold-all'));
    expect(screen.queryByTestId(`rm-twig-${ids.t8.id}`)).toBeNull();
    // a project with nothing in it has nothing to fold
    expect(screen.queryByTestId(`rm-fold-${ids.p7.id}`)).toBeNull();
  });
});

describe('the card', () => {
  it('remembers the chosen view on this device', () => {
    mount();
    fireEvent.click(screen.getByTestId('rm-view-list'));
    cleanup();
    mount();
    expect(view()).toBe('list');
  });

  it('says what to do when the roadmap has no projects', () => {
    const f = roadmapFixture();
    const empty = buildRoadmapModel(f.tree, f.edges, f.ids.r2.id)!; // one project…
    mount({ ...empty, projects: [], byId: new Map(), steps: [], free: [] }); // …emptied
    expect(screen.getByTestId('rm-no-projects').textContent).toContain('no projects yet');
    expect(screen.queryByTestId('rm-fold-all')).toBeNull();
  });
});
