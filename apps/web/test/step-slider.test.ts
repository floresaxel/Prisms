// @vitest-environment jsdom
/**
 * StepSlider: still a real range input (so keyboard / fill() / screen readers
 * work), with a tick for every step, captions under the chosen steps, and a fill
 * that tracks the value from 0 to 1 — full at the maximum.
 */
import { createElement } from 'react';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StepSlider } from '../src/components/StepSlider';

afterEach(cleanup);

const fillOf = (container: HTMLElement) => (container.querySelector('.px-steps') as HTMLElement).style.getPropertyValue('--px-steps-pct');

describe('StepSlider', () => {
  it('is a range input with the given bounds, and draws a tick at every step (ends included)', () => {
    const { container } = render(createElement(StepSlider, { min: 5, max: 30, step: 5, value: 15, onChange: () => undefined, testId: 's', ariaLabel: 'Break length' }));
    const input = screen.getByTestId('s') as HTMLInputElement;
    expect(input.type).toBe('range');
    expect([input.min, input.max, input.step, input.value]).toEqual(['5', '30', '5', '15']);
    expect(input.getAttribute('aria-label')).toBe('Break length');
    expect(container.querySelectorAll('.px-steps-ticks > i')).toHaveLength(6); // 5 10 15 20 25 30
  });

  it('handles fractional steps without drifting (0.5 … 1.0 by 0.1 is five steps, six ticks)', () => {
    const { container } = render(createElement(StepSlider, { min: 0.5, max: 1.0, step: 0.1, value: 1.0, onChange: () => undefined }));
    expect(container.querySelectorAll('.px-steps-ticks > i')).toHaveLength(6);
  });

  it('the fill runs from 0 at the minimum to 1 (the whole way) at the maximum', () => {
    const at = (value: number) => {
      const { container, unmount } = render(createElement(StepSlider, { min: 5, max: 30, step: 5, value, onChange: () => undefined }));
      const pct = fillOf(container);
      unmount();
      return Number(pct);
    };
    expect(at(5)).toBe(0);
    expect(at(15)).toBeCloseTo(0.4);
    expect(at(30)).toBe(1);
  });

  it('reports the new value as a number', () => {
    const onChange = vi.fn();
    render(createElement(StepSlider, { min: 5, max: 30, step: 5, value: 15, onChange, testId: 's' }));
    fireEvent.change(screen.getByTestId('s'), { target: { value: '25' } });
    expect(onChange).toHaveBeenCalledWith(25);
  });

  it('prints captions only where one is given, in step order', () => {
    const { container } = render(createElement(StepSlider, { min: 5, max: 30, step: 5, value: 15, onChange: () => undefined, labels: ['5', '', '15', '', '', '30'] }));
    expect([...container.querySelectorAll('.px-steps-labels > span')].map((s) => s.textContent)).toEqual(['5', '15', '30']);
  });
});
