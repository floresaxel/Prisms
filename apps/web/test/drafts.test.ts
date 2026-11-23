// @vitest-environment jsdom
/**
 * Text typed into a field outlives the screen it was typed on: leave the page
 * (the component unmounts) and it is back on return; saving or clearing drops
 * it; a different key is a different field; a sign-out forgets all of it.
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearDrafts, keepDraft, peekDraft, usePersistedText } from '../src/drafts';

beforeEach(() => clearDrafts());
afterEach(() => cleanup());

describe('usePersistedText', () => {
  it('starts empty and holds what is typed', () => {
    const { result } = renderHook(() => usePersistedText('a'));
    expect(result.current[0]).toBe('');
    act(() => result.current[1]('half a thou'));
    expect(result.current[0]).toBe('half a thou');
  });

  it('gives the text back to a fresh mount — the screen was left and returned to', () => {
    const first = renderHook(() => usePersistedText('capture'));
    act(() => first.result.current[1]('buy milk'));
    first.unmount();
    const second = renderHook(() => usePersistedText('capture'));
    expect(second.result.current[0]).toBe('buy milk');
  });

  it('clearing the text (a save) drops it, so the next mount starts empty', () => {
    const first = renderHook(() => usePersistedText('capture'));
    act(() => first.result.current[1]('buy milk'));
    act(() => first.result.current[1](''));
    first.unmount();
    expect(peekDraft('capture')).toBeUndefined();
    expect(renderHook(() => usePersistedText('capture')).result.current[0]).toBe('');
  });

  it('keeps separate keys apart', () => {
    const a = renderHook(() => usePersistedText('step.a'));
    act(() => a.result.current[1]('one'));
    expect(renderHook(() => usePersistedText('step.b')).result.current[0]).toBe('');
  });

  it('the same component moving to another key shows that key’s text', () => {
    keepDraft('step.b', 'two');
    const { result, rerender } = renderHook(({ k }) => usePersistedText(k), { initialProps: { k: 'step.a' } });
    expect(result.current[0]).toBe('');
    rerender({ k: 'step.b' });
    expect(result.current[0]).toBe('two');
    act(() => result.current[1]('three'));
    expect(peekDraft('step.b')).toBe('three');
    expect(peekDraft('step.a')).toBeUndefined();
  });

  it('a fallback is the empty value: showing it keeps nothing', () => {
    const { result } = renderHook(() => usePersistedText('x', 'default'));
    expect(result.current[0]).toBe('default');
    act(() => result.current[1]('edited'));
    expect(peekDraft('x')).toBe('edited');
    act(() => result.current[1]('default'));
    expect(peekDraft('x')).toBeUndefined();
  });

  it('clearDrafts (sign-out) forgets everything', () => {
    const first = renderHook(() => usePersistedText('capture'));
    act(() => first.result.current[1]('private'));
    first.unmount();
    clearDrafts();
    expect(renderHook(() => usePersistedText('capture')).result.current[0]).toBe('');
  });
});
