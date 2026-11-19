// @vitest-environment jsdom
/**
 * The brand's rules, as the shared components draw them (docs/brand/README.md):
 * which form of the Threshold mark appears at which size, the filled door
 * standing flush on the floor, and the lockup's proportions.
 */
import { createElement } from 'react';

import { LOCKUP, ThresholdLockup, ThresholdMark, markStroke } from '@prisms/ui';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(cleanup);

function polygons(el: Element): SVGPolygonElement[] {
  return [...el.querySelectorAll('polygon')];
}

/** Lowest point of a polygon's outline, plus half its line: where its ink ends. */
function inkBottom(p: SVGPolygonElement): number {
  const ys = (p.getAttribute('points') ?? '').split(' ').map((xy) => Number(xy.split(',')[1]));
  return Math.max(...ys) + Number(p.getAttribute('stroke-width')) / 2;
}

describe('ThresholdMark', () => {
  it('is the simple, three-door mark by default', () => {
    const { container } = render(createElement(ThresholdMark, { size: 24 }));
    expect(polygons(container)).toHaveLength(3);
  });

  it('draws four doors when asked for the full mark', () => {
    const { container } = render(createElement(ThresholdMark, { size: 64, variant: 'full' }));
    expect(polygons(container)).toHaveLength(4);
  });

  it('drops to the two-door compact form under 20 px, whichever variant', () => {
    for (const variant of ['simple', 'full'] as const) {
      const { container } = render(createElement(ThresholdMark, { size: 16, variant }));
      expect(polygons(container)).toHaveLength(2);
      cleanup();
    }
  });

  it.each([
    ['simple', 22],
    ['full', 64],
    ['simple', 14],
  ] as const)('stands the %s door flush on the floor at %i px', (variant, size) => {
    const { container } = render(createElement(ThresholdMark, { size, variant }));
    const ps = polygons(container);
    const frame = ps[0]!;
    const door = ps[ps.length - 1]!;
    expect(door.getAttribute('fill')).not.toBe('none');
    // its ink ends where the floor line's does, give or take the 0.1 rounding
    expect(Math.abs(inkBottom(door) - inkBottom(frame))).toBeLessThanOrEqual(0.1);
  });

  it('draws the simple mark a little heavier than the full one', () => {
    const { container } = render(createElement(ThresholdMark, { size: 40 }));
    expect(Number(polygons(container)[0]!.getAttribute('stroke-width'))).toBeCloseTo(markStroke(40) * 1.1);
  });
});

describe('ThresholdLockup', () => {
  it('sets the wordmark at 0.8x the mark with a 0.36x gap, as real text', () => {
    render(createElement(ThresholdLockup, { size: 30, tone: 'reversed' }));
    const word = screen.getByText('Prisms');
    expect(word.style.fontSize).toBe(`${30 * LOCKUP.horizontal.word}px`);
    const lockup = word.parentElement!;
    expect(lockup.className).toContain('px-lockup--horizontal');
    expect(lockup.className).toContain('px-lockup--reversed');
    expect(lockup.style.gap).toBe('10.8px');
    // the mark is decoration beside the word, not a second name
    expect(lockup.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('stacks with the smaller word and gap, and passes the mark variant through', () => {
    const { container } = render(createElement(ThresholdLockup, { size: 92, layout: 'stacked', variant: 'full' }));
    expect(screen.getByText('Prisms').style.fontSize).toBe('34px');
    expect(polygons(container)).toHaveLength(4);
  });
});
