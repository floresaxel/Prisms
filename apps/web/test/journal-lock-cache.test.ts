// @vitest-environment jsdom
/**
 * The remembered lock state behind the journal panel.
 *
 * `journal_entries.locked` is synced, so a day's row is not there on the frame
 * the panel mounts — measured on the Agenda, the panel arrives ~78ms before its
 * own row does. For that gap the panel used to assume "not locked" and draw the
 * full editing chrome on a note that could not be edited, folding it away once
 * the row landed. This is what it consults instead.
 *
 * It is a HINT: the panel only reads it while the row is absent, and only for a
 * bounded window, so nothing here can outrank what the row eventually says.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { __resetJournalLockCache, readJournalLocked, writeJournalLocked } from '../src/journal-lock-cache';

import { installMemoryStorage } from './util/memory-storage';

const KEY = 'prisms.journal.locked';

beforeEach(() => {
  installMemoryStorage();
  __resetJournalLockCache();
});
afterEach(() => __resetJournalLockCache());

describe('remembering how a day opened', () => {
  it('gives back what was written, either way round', () => {
    writeJournalLocked('2026-08-16', true);
    writeJournalLocked('2026-08-17', false);
    expect(readJournalLocked('2026-08-16')).toBe(true);
    expect(readJournalLocked('2026-08-17')).toBe(false);
  });

  it('says UNDEFINED for a day it has never seen — not false', () => {
    // The difference matters: false is a claim that the note is unlocked, and the
    // panel would act on it. Undefined means "no opinion", so it falls back to
    // the row exactly as it did before this cache existed.
    expect(readJournalLocked('2026-01-01')).toBeUndefined();
  });

  it('writes through to storage, and reads back from it with no memory of its own', () => {
    // Two halves of the reload path. First: what a session leaves behind.
    writeJournalLocked('2026-08-16', true);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ '2026-08-16': true });
    // Then: a fresh module (no in-memory map) picking that up, which is what
    // makes the first switch after a reload as smooth as the rest.
    __resetJournalLockCache();
    localStorage.setItem(KEY, JSON.stringify({ '2026-08-16': true }));
    expect(readJournalLocked('2026-08-16')).toBe(true);
  });

  it('overwrites rather than accumulating when a day changes', () => {
    writeJournalLocked('2026-08-16', true);
    writeJournalLocked('2026-08-16', false);
    expect(readJournalLocked('2026-08-16')).toBe(false);
    expect(Object.keys(JSON.parse(localStorage.getItem(KEY)!))).toEqual(['2026-08-16']);
  });
});

describe('what it refuses to trust', () => {
  it('ignores a stored value that is not a boolean', () => {
    // It seeds a RENDERING decision, so a junk value would paint. Anything not
    // shaped like what we wrote is dropped rather than coerced.
    localStorage.setItem(KEY, JSON.stringify({ '2026-08-16': 'yes', '2026-08-17': true }));
    __resetJournalLockCache();
    localStorage.setItem(KEY, JSON.stringify({ '2026-08-16': 'yes', '2026-08-17': true }));
    expect(readJournalLocked('2026-08-16')).toBeUndefined();
    expect(readJournalLocked('2026-08-17')).toBe(true);
  });

  it('starts empty on unparseable storage instead of throwing', () => {
    localStorage.setItem(KEY, '{not json');
    expect(readJournalLocked('2026-08-16')).toBeUndefined();
  });

  it('starts empty when the stored value is not a record', () => {
    localStorage.setItem(KEY, JSON.stringify(['2026-08-16']));
    expect(readJournalLocked('2026-08-16')).toBeUndefined();
  });
});

describe('bounded growth', () => {
  it('keeps the most recently written days and drops the oldest', () => {
    // A journal kept for years must not grow this without limit.
    for (let i = 0; i < 420; i++) writeJournalLocked(`day-${String(i).padStart(4, '0')}`, i % 2 === 0);
    const stored = JSON.parse(localStorage.getItem(KEY)!) as Record<string, boolean>;
    expect(Object.keys(stored)).toHaveLength(400);
    // 420 written, 400 kept — so the first 20 are gone and the boundary sits
    // exactly between day-0019 and day-0020.
    expect(readJournalLocked('day-0419')).toBe(false); // newest kept
    expect(readJournalLocked('day-0020')).toBe(true); // oldest still kept
    expect(readJournalLocked('day-0019')).toBeUndefined(); // first one dropped
    expect(readJournalLocked('day-0000')).toBeUndefined();
  });

  it('counts a rewrite as recent use, so an actively-read day is not trimmed away', () => {
    writeJournalLocked('keeper', true);
    for (let i = 0; i < 399; i++) writeJournalLocked(`filler-${i}`, false);
    writeJournalLocked('keeper', false); // touched again — moves to the newest end
    for (let i = 0; i < 50; i++) writeJournalLocked(`later-${i}`, false);
    expect(readJournalLocked('keeper')).toBe(false);
  });
});
