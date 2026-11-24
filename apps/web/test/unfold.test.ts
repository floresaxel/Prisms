// @vitest-environment jsdom
/**
 * Unfold: content that grows open and folds shut. It stays mounted while folded
 * (so the fold can animate and its state survives); the CSS does the animating and
 * hides it once folded (theme.css, `.px-unfold`).
 */
import { createElement } from 'react';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Unfold } from '../src/components/Unfold';

afterEach(cleanup);

describe('Unfold', () => {
  it('is folded until opened, and keeps its children mounted either way', () => {
    const { rerender } = render(createElement(Unfold, { open: false, testId: 'u' }, createElement('p', { 'data-testid': 'kid' }, 'inside')));
    const shell = screen.getByTestId('u');
    expect(shell.className).toBe('px-unfold');
    expect(shell.getAttribute('data-open')).toBe('false');
    expect(screen.getByTestId('kid').textContent).toBe('inside'); // mounted while folded
    rerender(createElement(Unfold, { open: true, testId: 'u' }, createElement('p', { 'data-testid': 'kid' }, 'inside')));
    expect(shell.className).toBe('px-unfold px-unfold--open');
    expect(shell.getAttribute('data-open')).toBe('true');
  });

  it('wraps its children in the single clipped row the 0fr → 1fr collapse needs', () => {
    render(createElement(Unfold, { open: true, testId: 'u' }, createElement('span', null, 'a'), createElement('span', null, 'b')));
    expect(screen.getByTestId('u').children).toHaveLength(1);
  });
});