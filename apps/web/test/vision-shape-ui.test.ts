// @vitest-environment jsdom
/**
 * The Shape card as a user meets it: what it says, zooming in and back out,
 * switching what width stands for, and pinning a task to open its roadmap.
 *
 * The component takes the tree as a prop and reads no hooks of its own, so it
 * renders here without a PowerSync runtime or any mocks. jsdom has no layout,
 * so the chart is never measured and every block keeps its label (the "tight"
 * rule is a pixel rule, covered by looking at the real page).
 */
import { createElement } from 'react';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VisionShape } from '../src/components/VisionShape';

import { installMemoryStorage } from './util/memory-storage';
import { shapeFixture } from './util/shape-fixture';

const { tree, ids } = shapeFixture();

function mount(visionId = ids.v.id) {
  const onNavigate = vi.fn();
  render(createElement(VisionShape, { tree, visionId, color: '#4f46e5', onNavigate }));
  return { onNavigate };
}

const cell = (id: string) => screen.queryByTestId(`shape-cell-${id}`);
const insight = () => screen.getByTestId('shape-insight').textContent;
const detail = () => screen.getByTestId('shape-detail').textContent;

// The view choice is remembered per device: each test starts with empty storage.
beforeEach(() => installMemoryStorage());
afterEach(cleanup);

describe('the Shape card', () => {
  it('opens on the whole vision, sized by open tasks', () => {
    mount();
    expect(screen.getByTestId('shape-metric-open').getAttribute('aria-checked')).toBe('true');
    expect(insight()).toBe('83% of the open tasks sit in one roadmap: Finish the novel (5 of 6).');
    expect(detail()).toContain('Become an author');
    expect(detail()).toContain('9 tasks · 3 done');
    // no trail at the top: it would only repeat the top row
    expect(screen.queryByTestId('shape-trail')).toBeNull();
    expect(screen.queryByTestId('shape-up')).toBeNull();
  });

  it('hides a branch with nothing open, from sight and from the keyboard', () => {
    mount();
    const r3 = cell(ids.r3.id)!;
    expect(r3.className).toContain('px-shape-cell--off');
    expect(r3.getAttribute('tabindex')).toBe('-1');
    expect(r3.getAttribute('aria-hidden')).toBe('true');
    // and a done task is drawn but has no width to be seen at
    expect(cell(ids.t1.id)!.className).toContain('px-shape-cell--off');
  });

  it('never draws an obsolete task', () => {
    mount();
    expect(cell(ids.t8.id)).toBeNull();
  });

  it('zooms into a block and back out by the button, the trail and Esc', () => {
    mount();
    fireEvent.click(cell(ids.r1.id)!);
    expect(cell(ids.r1.id)!.dataset.row).toBe('0');
    expect(cell(ids.r2.id)).toBeNull(); // a sibling leaves with the zoom
    expect(screen.getByTestId('shape-trail').textContent).toContain('Become an author›Finish the novel');
    expect(insight()).toMatch(/^60% of the open tasks sit in one project: Draft act two \(3 of 5\)/);

    fireEvent.click(cell(ids.p2.id)!);
    expect(cell(ids.p2.id)!.dataset.row).toBe('0');

    fireEvent.keyDown(cell(ids.p2.id)!, { key: 'Escape' });
    expect(cell(ids.r1.id)!.dataset.row).toBe('0');

    fireEvent.click(screen.getByTestId('shape-up'));
    expect(cell(ids.v.id)!.dataset.row).toBe('0');

    fireEvent.click(cell(ids.p1.id)!);
    fireEvent.click(screen.getByRole('button', { name: 'Become an author' })); // the trail's first step
    expect(cell(ids.v.id)!.dataset.row).toBe('0');
  });

  it('goes up a level when the top block is clicked', () => {
    mount();
    fireEvent.click(cell(ids.r2.id)!);
    fireEvent.click(cell(ids.r2.id)!);
    expect(cell(ids.v.id)!.dataset.row).toBe('0');
  });

  it('says which open tasks "Time left" cannot show', () => {
    mount();
    fireEvent.click(screen.getByTestId('shape-metric-time'));
    expect(screen.getByTestId('shape-metric-time').getAttribute('aria-checked')).toBe('true');
    expect(insight()).toBe(
      '94% of the time left sits in one roadmap: Finish the novel (14.5h of 15.5h). ' +
        '1 open task has no estimate, so it is not shown at this width.',
    );
  });

  it('says "All" when one branch holds everything', () => {
    mount();
    fireEvent.click(cell(ids.r2.id)!);
    expect(insight()).toBe('All of the open tasks sit in one project: Newsletter (1 of 1).');
  });

  it('pins a task and opens the roadmap it sits under', () => {
    const { onNavigate } = mount();
    fireEvent.click(cell(ids.t2.id)!);
    expect(cell(ids.t2.id)!.className).toContain('px-shape-cell--pinned');
    expect(detail()).toContain('Write ch. 11');
    expect(detail()).toContain('Open · 6h 0m estimated');
    fireEvent.click(screen.getByTestId('shape-open-roadmap'));
    expect(onNavigate).toHaveBeenCalledWith(`/roadmap#${ids.r1.id}`);
  });

  it('shows what is hovered over the pinned task, and falls back when it leaves', () => {
    mount();
    fireEvent.click(cell(ids.t2.id)!);
    fireEvent.mouseEnter(cell(ids.p3.id)!);
    expect(detail()).toContain('Newsletter');
    fireEvent.mouseLeave(cell(ids.p3.id)!);
    expect(detail()).toContain('Write ch. 11');
  });

  it('explains itself instead of drawing an empty chart', () => {
    mount(ids.empty.id);
    expect(screen.getByTestId('shape-empty').textContent).toContain('Nothing to chart yet');
    expect(screen.queryByTestId('shape-insight')).toBeNull();
  });

  it('draws nothing for a vision that is not in the tree', () => {
    mount('00000000-0000-4000-8000-999999999999');
    expect(screen.queryByTestId('vis-shape')).toBeNull();
  });
});

describe('the sunburst view', () => {
  const arc = (id: string) => screen.queryByTestId(`shape-arc-${id}`);
  const center = () => screen.getByTestId('shape-center');
  const toSunburst = () => fireEvent.click(screen.getByTestId('shape-view-sunburst'));

  it('is off by default, and remembered once chosen', () => {
    mount();
    expect(screen.getByTestId('shape-view-icicle').getAttribute('aria-checked')).toBe('true');
    expect(cell(ids.r1.id)).not.toBeNull();
    expect(arc(ids.r1.id)).toBeNull();

    toSunburst();
    expect(screen.getByTestId('shape-view-sunburst').getAttribute('aria-checked')).toBe('true');
    expect(cell(ids.r1.id)).toBeNull();
    expect(arc(ids.r1.id)).not.toBeNull();

    cleanup();
    mount(); // a fresh mount (another visit) opens on the sunburst
    expect(arc(ids.r1.id)).not.toBeNull();
    fireEvent.click(screen.getByTestId('shape-view-icicle'));
    expect(cell(ids.r1.id)).not.toBeNull();
  });

  it('puts the vision in the centre, and leaves out what is worth nothing', () => {
    mount();
    toSunburst();
    expect(center().textContent).toContain('Vision');
    expect(center().textContent).toContain('21%'); // 241 of 1172 weighted, as the detail line says
    expect((center() as HTMLButtonElement).disabled).toBe(true); // nowhere to go up to
    expect(arc(ids.r1.id)!.dataset.ring).toBe('1');
    expect(arc(ids.p1.id)!.dataset.ring).toBe('2');
    expect(arc(ids.r3.id)).toBeNull(); // nothing open
    expect(arc(ids.t1.id)).toBeNull(); // done: no open-task share
    expect(arc(ids.t8.id)).toBeNull(); // obsolete, never drawn
    // "All tasks" gives the done task its slice back
    fireEvent.click(screen.getByTestId('shape-metric-all'));
    expect(arc(ids.t1.id)).not.toBeNull();
  });

  it('keeps the same summary, and says "size" where the icicle says "width"', () => {
    mount();
    toSunburst();
    expect(insight()).toBe('83% of the open tasks sit in one roadmap: Finish the novel (5 of 6).');
    fireEvent.click(screen.getByTestId('shape-metric-time'));
    expect(insight()).toContain('1 open task has no estimate, so it is not shown at this size.');
  });

  it('lists the children of the centre beside the chart', () => {
    mount();
    toSunburst();
    expect(screen.getByTestId(`shape-row-${ids.r1.id}`).textContent).toContain('Finish the novel');
    expect(screen.getByTestId(`shape-row-${ids.r1.id}`).textContent).toContain('5 open');
    expect(screen.getByTestId(`shape-row-${ids.r3.id}`).className).toContain('px-sun-row--zero');
  });

  it('zooms by slice or by row, and goes back up by the centre, the trail and Esc', () => {
    mount();
    toSunburst();
    fireEvent.click(arc(ids.r1.id)!);
    expect(center().textContent).toContain('Roadmap');
    expect(arc(ids.r1.id)).toBeNull(); // it is the centre now
    expect(arc(ids.p1.id)!.dataset.ring).toBe('1');
    expect(screen.getByTestId('shape-trail').textContent).toContain('Become an author›Finish the novel');

    fireEvent.click(screen.getByTestId(`shape-row-${ids.p2.id}`));
    expect(center().textContent).toContain('Project');
    expect(arc(ids.m1.id)!.dataset.ring).toBe('1');

    fireEvent.keyDown(arc(ids.m1.id)!, { key: 'Escape' });
    expect(center().textContent).toContain('Roadmap');

    fireEvent.click(center());
    expect(center().textContent).toContain('Vision');

    fireEvent.click(arc(ids.r2.id)!);
    fireEvent.click(screen.getByTestId('shape-up'));
    expect(center().textContent).toContain('Vision');
  });

  it('pins a task slice, and opens it from the keyboard too', () => {
    const { onNavigate } = mount();
    toSunburst();
    fireEvent.keyDown(arc(ids.t2.id)!, { key: 'Enter' });
    expect(arc(ids.t2.id)!.parentElement!.getAttribute('class')).toContain('px-sun-node--pinned');
    expect(detail()).toContain('Write ch. 11');
    fireEvent.click(screen.getByTestId('shape-open-roadmap'));
    expect(onNavigate).toHaveBeenCalledWith(`/roadmap#${ids.r1.id}`);
  });

  it('lights the row of the branch a hovered slice sits in', () => {
    mount();
    toSunburst();
    fireEvent.mouseEnter(arc(ids.t9.id)!);
    expect(screen.getByTestId(`shape-row-${ids.r2.id}`).className).toContain('px-sun-row--hot');
    expect(detail()).toContain('Write issue');
    fireEvent.mouseLeave(arc(ids.t9.id)!);
    expect(screen.getByTestId(`shape-row-${ids.r2.id}`).className).not.toContain('px-sun-row--hot');
  });
});
