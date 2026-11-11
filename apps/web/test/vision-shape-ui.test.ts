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
import { afterEach, describe, expect, it, vi } from 'vitest';

import { VisionShape } from '../src/components/VisionShape';

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
