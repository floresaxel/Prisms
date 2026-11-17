import { describe, expect, it } from 'vitest';

import { MAX_JOURNAL_TAG_LENGTH, MAX_JOURNAL_TAGS, normalizeJournalTag, normalizeJournalTags } from '../../src/journal/tags';

describe('normalizeJournalTag', () => {
  it('trims, drops a leading #, collapses spaces and lower-cases', () => {
    expect(normalizeJournalTag('  #Deep   Work ')).toBe('deep work');
    expect(normalizeJournalTag('##health')).toBe('health');
  });
  it('returns null when nothing is left', () => {
    for (const bad of ['', '   ', '#', '# ', null, undefined, 4, {}]) expect(normalizeJournalTag(bad)).toBeNull();
  });
  it('caps the length', () => {
    expect(normalizeJournalTag('x'.repeat(200))).toHaveLength(MAX_JOURNAL_TAG_LENGTH);
  });
});

describe('normalizeJournalTags', () => {
  it('de-duplicates case-insensitively, keeping first-seen order', () => {
    expect(normalizeJournalTags(['Work', 'health', 'work', '#WORK', 'Health'])).toEqual(['work', 'health']);
  });
  it('drops junk and tolerates a non-array', () => {
    expect(normalizeJournalTags(['a', '', null, 3, 'b'])).toEqual(['a', 'b']);
    expect(normalizeJournalTags('nope')).toEqual([]);
    expect(normalizeJournalTags(undefined)).toEqual([]);
  });
  it('caps the count', () => {
    const many = Array.from({ length: 50 }, (_, i) => `t${i}`);
    expect(normalizeJournalTags(many)).toHaveLength(MAX_JOURNAL_TAGS);
  });
  it('is idempotent', () => {
    const once = normalizeJournalTags(['  A ', '#b', 'A']);
    expect(normalizeJournalTags(once)).toEqual(once);
  });
});