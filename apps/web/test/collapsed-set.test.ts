// @vitest-environment jsdom
/**
 * The folded-project memory behind Tasks › By project: everything starts open,
 * a toggle folds and unfolds, only folded ids are stored (so a new project is
 * open), a reload keeps the folds, and missing / broken storage never breaks it.
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCollapsedSet } from '../src/components/useCollapsedSet';
import { installMemoryStorage } from './util/memory-storage';

const KEY = 'test.collapsed';

let storage: Storage;
beforeEach(() => {
  storage = installMemoryStorage(); // Node 26 has no jsdom localStorage (see the helper)
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useCollapsedSet', () => {
  it('starts with nothing collapsed', () => {
    const { result } = renderHook(() => useCollapsedSet(KEY));
    expect(result.current.isCollapsed('p1')).toBe(false);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('toggle folds then unfolds, storing only the folded ids', () => {
    const { result } = renderHook(() => useCollapsedSet(KEY));
    act(() => result.current.toggle('p1'));
    act(() => result.current.toggle('p2'));
    expect(result.current.isCollapsed('p1')).toBe(true);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(['p1', 'p2']);
    act(() => result.current.toggle('p1'));
    expect(result.current.isCollapsed('p1')).toBe(false);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(['p2']);
    act(() => result.current.toggle('p2'));
    expect(localStorage.getItem(KEY)).toBeNull(); // nothing folded → nothing stored
  });

  it('expand opens a folded id and is a no-op on an open one', () => {
    const { result } = renderHook(() => useCollapsedSet(KEY));
    act(() => result.current.toggle('p1'));
    act(() => result.current.expand('p1'));
    expect(result.current.isCollapsed('p1')).toBe(false);
    const setItem = vi.spyOn(storage, 'setItem');
    act(() => result.current.expand('p1'));
    expect(setItem).not.toHaveBeenCalled();
  });

  it('a reload (a fresh mount) keeps the folds', () => {
    const first = renderHook(() => useCollapsedSet(KEY));
    act(() => first.result.current.toggle('p1'));
    first.unmount();
    const second = renderHook(() => useCollapsedSet(KEY));
    expect(second.result.current.isCollapsed('p1')).toBe(true);
    expect(second.result.current.isCollapsed('p2')).toBe(false);
  });

  it('ignores junk in storage', () => {
    localStorage.setItem(KEY, '{"not":"an array"}');
    expect(renderHook(() => useCollapsedSet(KEY)).result.current.isCollapsed('p1')).toBe(false);
    localStorage.setItem(KEY, 'not json');
    expect(renderHook(() => useCollapsedSet(KEY)).result.current.isCollapsed('p1')).toBe(false);
    localStorage.setItem(KEY, '["p1", 7, null]');
    const { result } = renderHook(() => useCollapsedSet(KEY));
    expect(result.current.isCollapsed('p1')).toBe(true);
  });

  it('still works in memory when storage throws', () => {
    vi.spyOn(storage, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useCollapsedSet(KEY));
    act(() => result.current.toggle('p1'));
    expect(result.current.isCollapsed('p1')).toBe(true);
  });
});
