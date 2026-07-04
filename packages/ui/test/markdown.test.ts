/**
 * J4 — the pure markdown toolbar transform + code-point-safe truncation (D2/D6).
 */
import { describe, expect, it } from 'vitest';

import { applyMarkdownEdit, truncatePlain, type MarkdownAction } from '../src/index';

const ZWJ = '👨‍👩‍👧‍👦'; // 11 UTF-16 code units, 7 code points

describe('applyMarkdownEdit — inline wraps', () => {
  it('bold wraps the selection and leaves the caret after it', () => {
    const r = applyMarkdownEdit('hello world', { start: 0, end: 5 }, 'bold');
    expect(r.value).toBe('**hello** world');
    expect(r.selection).toEqual({ start: 9, end: 9 });
  });

  it('empty selection inserts an empty pair with the caret BETWEEN the markers', () => {
    const r = applyMarkdownEdit('', { start: 0, end: 0 }, 'italic');
    expect(r.value).toBe('__');
    expect(r.selection).toEqual({ start: 1, end: 1 });
  });

  it('wraps a ZWJ-emoji selection VERBATIM (no re-encoding, no split)', () => {
    const value = `${ZWJ} family`;
    const r = applyMarkdownEdit(value, { start: 0, end: ZWJ.length }, 'bold');
    expect(r.value).toBe(`**${ZWJ}** family`);
  });

  it.each<[MarkdownAction, string]>([
    ['strikethrough', '~~x~~'],
    ['code', '`x`'],
  ])('%s wraps', (action, expected) => {
    expect(applyMarkdownEdit('x', { start: 0, end: 1 }, action).value).toBe(expected);
  });
});

describe('applyMarkdownEdit — line prefixes', () => {
  it('h2 prefixes the line', () => {
    expect(applyMarkdownEdit('title', { start: 0, end: 5 }, 'h2').value).toBe('## title');
  });

  it('bullet/number/task/quote prefix each selected line', () => {
    const value = 'a\nb';
    expect(applyMarkdownEdit(value, { start: 0, end: 3 }, 'bulletList').value).toBe('- a\n- b');
    expect(applyMarkdownEdit(value, { start: 0, end: 3 }, 'numberList').value).toBe('1. a\n1. b');
    expect(applyMarkdownEdit(value, { start: 0, end: 3 }, 'taskList').value).toBe('- [ ] a\n- [ ] b');
    expect(applyMarkdownEdit(value, { start: 0, end: 3 }, 'quote').value).toBe('> a\n> b');
  });

  it('prefixes from the START of the first selected line even if the caret is mid-line', () => {
    const r = applyMarkdownEdit('hello', { start: 2, end: 5 }, 'h1');
    expect(r.value).toBe('# hello');
  });
});

describe('applyMarkdownEdit — link + code block', () => {
  it('link inserts [text](url) with url selected', () => {
    const r = applyMarkdownEdit('see here', { start: 4, end: 8 }, 'link');
    expect(r.value).toBe('see [here](url)');
    expect(r.value.slice(r.selection.start, r.selection.end)).toBe('url');
  });

  it('code block fences the selection', () => {
    const r = applyMarkdownEdit('x = 1', { start: 0, end: 5 }, 'codeBlock');
    expect(r.value).toBe('```\nx = 1\n```');
  });
});

describe('truncatePlain — code-point safe (D6)', () => {
  it('returns short text unchanged', () => {
    expect(truncatePlain('hi', 10)).toBe('hi');
  });

  it('never splits a surrogate pair', () => {
    // '😀' is one code point / two UTF-16 units; a naive slice(0,3) would sever it.
    const out = truncatePlain('ab😀cd', 3);
    expect(out).toBe('ab😀…');
    expect(Array.from(out).slice(0, 3).join('')).toBe('ab😀'); // no lone surrogate
  });

  it('truncates multi-emoji at code-point boundaries', () => {
    expect(truncatePlain('👍🏽❤️🇫🇷', 2)).toBe('👍🏽…'); // skin-tone = 2 cps, kept whole
  });
});
