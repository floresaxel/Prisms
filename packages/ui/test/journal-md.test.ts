/**
 * J3 — the per-day `.md` archive (D7). Structure/paths, the D6 emoji corpus
 * byte-identical through zip→unzip, and the empty-content edge.
 */
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { buildJournalArchive, journalArchiveFilename, journalDayFilename } from '../src/index';

/** §D6 canonical corpus — must survive the archive byte-identical. */
const D6_CORPUS = ['👍🏽', '👨‍👩‍👧‍👦', '🇫🇷', '❤️', 'café', 'שלום 🌍 hello'];

describe('journal .md archive (D7)', () => {
  it('filenames: YYYY-MM-DD.md and prisms-journal_<stamp>.zip', () => {
    expect(journalDayFilename('2026-06-11')).toBe('2026-06-11.md');
    expect(journalArchiveFilename('2026-07-04T03:05:09.123Z')).toBe('prisms-journal_2026-07-04_03-05-09-123.zip');
  });

  it('one journal/YYYY/YYYY-MM-DD.md per entry, written in date order', () => {
    const files = unzipSync(
      buildJournalArchive([
        { entry_date: '2026-05-20', content: 'may' },
        { entry_date: '2026-04-15', content: 'apr' },
      ]),
    );
    expect(Object.keys(files)).toEqual(['journal/2026/2026-04-15.md', 'journal/2026/2026-05-20.md']);
    expect(strFromU8(files['journal/2026/2026-04-15.md']!)).toBe('apr');
  });

  it('D6 emoji corpus round-trips byte-identical through zip → unzip', () => {
    const entries = D6_CORPUS.map((content, i) => ({ entry_date: `2026-07-0${i + 1}`, content: `# Day\n\n${content}` }));
    const files = unzipSync(buildJournalArchive(entries));
    for (const e of entries) {
      const bytes = files[`journal/2026/${e.entry_date}.md`]!;
      expect(strFromU8(bytes)).toBe(e.content);
      // byte-exact: stored bytes equal the UTF-8 encoding (surrogate pairs intact)
      expect([...bytes]).toEqual([...new TextEncoder().encode(e.content)]);
    }
  });

  it('an empty-content day still emits its (empty) file', () => {
    const files = unzipSync(buildJournalArchive([{ entry_date: '2026-08-01', content: '' }]));
    expect(Object.keys(files)).toEqual(['journal/2026/2026-08-01.md']);
    expect(strFromU8(files['journal/2026/2026-08-01.md']!)).toBe('');
  });
});
