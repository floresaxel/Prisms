/**
 * Annex L — the derived journal day log.
 *
 * What these tests pin, in the order the design leans on it:
 * - day assignment is `bucketDate` and nothing else (reset-hour edges, DST, a
 *   block crossing midnight);
 * - the done/planned/disposition matrix;
 * - DETERMINISM: shuffled input rows produce a deep-equal result, ordering and
 *   the 100-cap truncation included;
 * - EQUIVALENCE: `computeDayLog(D)` === `computeDayLogsByDate(...).get(D)`, so
 *   the client path and the export path cannot drift;
 * - TOTALITY: dirty rows filter instead of throwing;
 * - the markdown golden + the compose property (`content` is a verbatim prefix).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  composeDayMarkdown,
  computeDayLog,
  computeDayLogsByDate,
  DAY_LOG_MAX_ENTRIES,
  dayLogEntriesSchema,
  formatDayLogTime,
  isDayLogEmpty,
  renderDayLogMarkdown,
  type DayLogEntries,
} from '../../src/journal/day-log';
import type { Node, ScheduleBlock } from '../../src/domain/entities';
import { idOf, makeBlock, makeNode } from '../helpers/fixtures';

const NY = 'America/New_York';

/** A completed task. `at` is an absolute instant; bucketing is the test's subject. */
function task(n: number, over: Partial<Node> = {}): Node {
  return makeNode({ id: idOf(n), node_type: 'task', title: `task ${n}`, ...over });
}

function block(n: number, taskId: string, starts: string, ends: string, over: Partial<ScheduleBlock> = {}): ScheduleBlock {
  return makeBlock({ id: idOf(1000 + n), task_id: taskId, starts_at: starts, ends_at: ends, ...over });
}

const settings = { dayResetHour: 4, timezone: NY };

describe('computeDayLog — day assignment goes through bucketDate (D3)', () => {
  it('buckets a completion before the reset hour to the PREVIOUS day', () => {
    // 03:59 EDT on the 9th → still the 8th's day; 04:00 flips it.
    const before = task(1, { completed_at: '2026-05-09T07:59:00.000Z' }); // 03:59 EDT
    const after = task(2, { completed_at: '2026-05-09T08:00:00.000Z' }); // 04:00 EDT
    const facts = { nodes: [before, after], blocks: [] };
    expect(computeDayLog({ date: '2026-05-08', ...facts, ...settings })?.completed.map((c) => c.task_id))
      .toEqual([before.id]);
    expect(computeDayLog({ date: '2026-05-09', ...facts, ...settings })?.completed.map((c) => c.task_id))
      .toEqual([after.id]);
  });

  it('day_reset_hour 0 puts both sides of 04:00 on the same day', () => {
    const before = task(1, { completed_at: '2026-05-09T07:59:00.000Z' });
    const after = task(2, { completed_at: '2026-05-09T08:00:00.000Z' });
    const log = computeDayLog({
      date: '2026-05-09',
      nodes: [before, after],
      blocks: [],
      dayResetHour: 0,
      timezone: NY,
    });
    expect(log?.completed).toHaveLength(2);
  });

  it('keeps the boundary at 04:00 LOCAL on a DST spring-forward day', () => {
    // 2026-03-08 is the US spring-forward: 02:00 EST (07:00 UTC) jumps to 03:00
    // EDT, so this day is 23 h long. The boundary must still sit at 04:00 on the
    // WALL clock — subtracting 4 absolute hours from the instant would move it.
    const early = task(1, { completed_at: '2026-03-08T07:30:00.000Z' }); // 03:30 EDT → prev day
    const late = task(2, { completed_at: '2026-03-08T08:00:00.000Z' }); // 04:00 EDT → same day
    const facts = { nodes: [early, late], blocks: [] };
    expect(computeDayLog({ date: '2026-03-07', ...facts, ...settings })?.completed.map((c) => c.task_id))
      .toEqual([early.id]);
    expect(computeDayLog({ date: '2026-03-08', ...facts, ...settings })?.completed.map((c) => c.task_id))
      .toEqual([late.id]);
  });

  it('a block running 23:00–01:30 stays on its START day', () => {
    const t = task(1);
    // 23:00 EDT on the 8th → 01:30 EDT on the 9th.
    const b = block(1, t.id, '2026-05-09T03:00:00.000Z', '2026-05-09T05:30:00.000Z');
    const facts = { nodes: [t], blocks: [b] };
    expect(computeDayLog({ date: '2026-05-08', ...facts, ...settings })?.scheduled).toHaveLength(1);
    expect(computeDayLog({ date: '2026-05-09', ...facts, ...settings })).toBeNull();
  });

  it('re-buckets under a different timezone (the D3 "history moves" behaviour)', () => {
    const t = task(1, { completed_at: '2026-05-09T05:00:00.000Z' }); // 01:00 EDT / 05:00 UTC
    const facts = { nodes: [t], blocks: [] };
    expect(computeDayLog({ date: '2026-05-08', ...facts, ...settings })).not.toBeNull();
    expect(computeDayLog({ date: '2026-05-09', ...facts, dayResetHour: 4, timezone: 'UTC' })).not.toBeNull();
  });

  it('falls back to the DDL defaults for absent or nonsense settings', () => {
    const t = task(1, { completed_at: '2026-05-09T05:00:00.000Z' }); // 01:00 EDT → the 8th at reset 4
    const nodes = [t];
    expect(computeDayLog({ date: '2026-05-08', nodes, blocks: [] })).not.toBeNull();
    expect(
      computeDayLog({ date: '2026-05-08', nodes, blocks: [], dayResetHour: 99, timezone: 'Mars/Olympus' }),
    ).not.toBeNull();
  });
});

describe('computeDayLog — membership (D2)', () => {
  const day = '2026-05-08';
  const noon = '2026-05-08T16:00:00.000Z'; // 12:00 EDT
  const one = '2026-05-08T17:00:00.000Z';

  it('returns null for a day with nothing on it', () => {
    expect(computeDayLog({ date: day, nodes: [task(1)], blocks: [], ...settings })).toBeNull();
  });

  it('excludes suggested, superseded, and soft-deleted blocks', () => {
    const t = task(1);
    const blocks = [
      block(1, t.id, noon, one, { status: 'suggested' }),
      block(2, t.id, noon, one, { superseded_at: '2026-05-08T18:00:00.000Z' }),
      block(3, t.id, noon, one, { deleted_at: '2026-05-08T18:00:00.000Z' }),
    ];
    expect(computeDayLog({ date: day, nodes: [t], blocks, ...settings })).toBeNull();
  });

  it('excludes a block whose task is deleted or absent (no title to render)', () => {
    const deleted = task(1, { deleted_at: '2026-05-08T18:00:00.000Z' });
    const blocks = [block(1, deleted.id, noon, one), block(2, idOf(99), noon, one)];
    expect(computeDayLog({ date: day, nodes: [deleted], blocks, ...settings })).toBeNull();
  });

  it('excludes soft-deleted completions', () => {
    const t = task(1, { completed_at: noon, deleted_at: one });
    expect(computeDayLog({ date: day, nodes: [t], blocks: [], ...settings })).toBeNull();
  });

  it('marks a scheduled task done when it is complete NOW, on any day', () => {
    const t = task(1, { completed_at: '2026-06-01T16:00:00.000Z' }); // weeks later
    const log = computeDayLog({ date: day, nodes: [t], blocks: [block(1, t.id, noon, one)], ...settings });
    expect(log?.scheduled[0]!.done).toBe(true);
  });

  it('carries planned / unplanned and the obsolete disposition', () => {
    const planned = task(1, { completed_at: one, title: 'planned work' });
    const adhoc = task(2, { completed_at: one, title: 'ad-hoc work' });
    const descoped = task(3, { completed_at: one, completion_disposition: 'obsolete', title: 'dead idea' });
    const log = computeDayLog({
      date: day,
      nodes: [planned, adhoc, descoped],
      blocks: [block(1, planned.id, noon, one)],
      ...settings,
    });
    const byId = new Map(log!.completed.map((c) => [c.task_id, c]));
    expect(byId.get(planned.id)!.planned).toBe(true);
    expect(byId.get(adhoc.id)!.planned).toBe(false);
    expect(byId.get(descoped.id)!.disposition).toBe('obsolete');
    expect(byId.get(planned.id)!.disposition).toBe('completed');
  });

  it('planned is per-DAY: a block on another day does not mark it planned', () => {
    const t = task(1, { completed_at: one });
    const log = computeDayLog({
      date: day,
      nodes: [t],
      blocks: [block(1, t.id, '2026-05-07T16:00:00.000Z', '2026-05-07T17:00:00.000Z')],
      ...settings,
    });
    expect(log!.completed[0]!.planned).toBe(false);
  });

  it('logs a completed activity, not only tasks', () => {
    const a = makeNode({ id: idOf(5), node_type: 'activity', title: 'Renew passport', completed_at: one });
    const log = computeDayLog({ date: day, nodes: [a], blocks: [], ...settings });
    expect(log?.completed.map((c) => c.title)).toEqual(['Renew passport']);
  });

  it('produces a schema-valid envelope', () => {
    const t = task(1, { completed_at: one });
    const log = computeDayLog({ date: day, nodes: [t], blocks: [block(1, t.id, noon, one)], ...settings });
    expect(dayLogEntriesSchema.parse(log)).toEqual(log);
    expect(log!.v).toBe(1);
  });
});

describe('computeDayLog — determinism and truncation', () => {
  const day = '2026-05-08';
  const at = (minute: number) => `2026-05-08T${String(12 + Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00.000Z`;

  /** 120 blocks + 120 completions, all on the same day, all at the SAME instant. */
  function crowd(): { nodes: Node[]; blocks: ScheduleBlock[] } {
    const nodes: Node[] = [];
    const blocks: ScheduleBlock[] = [];
    for (let i = 0; i < 120; i += 1) {
      const t = task(i, { completed_at: at(30) });
      nodes.push(t);
      blocks.push(block(i, t.id, at(0), at(60)));
    }
    return { nodes, blocks };
  }

  it('caps each list at 100 and records the DROPPED count', () => {
    const log = computeDayLog({ date: day, ...crowd(), ...settings })!;
    expect(log.scheduled).toHaveLength(DAY_LOG_MAX_ENTRIES);
    expect(log.completed).toHaveLength(DAY_LOG_MAX_ENTRIES);
    expect(log.truncated).toEqual({ scheduled: 20, completed: 20 });
  });

  it('omits `truncated` when nothing overflowed', () => {
    const t = task(1, { completed_at: at(10) });
    const log = computeDayLog({ date: day, nodes: [t], blocks: [], ...settings })!;
    expect(log.truncated).toBeUndefined();
  });

  it('is deep-equal under shuffled input, ordering and the cap included', () => {
    const { nodes, blocks } = crowd();
    const reference = computeDayLog({ date: day, nodes, blocks, ...settings });
    fc.assert(
      fc.property(fc.shuffledSubarray(nodes, { minLength: nodes.length }), fc.shuffledSubarray(blocks, { minLength: blocks.length }), (n, b) => {
        expect(computeDayLog({ date: day, nodes: n, blocks: b, ...settings })).toEqual(reference);
      }),
      { numRuns: 25 },
    );
  });

  it('orders scheduled by (starts_at, block_id) and completed by (completed_at, task_id)', () => {
    const early = task(1, { completed_at: at(5) });
    const late = task(2, { completed_at: at(50) });
    const log = computeDayLog({
      date: day,
      nodes: [late, early],
      blocks: [block(2, late.id, at(40), at(60)), block(1, early.id, at(0), at(30))],
      ...settings,
    })!;
    expect(log.scheduled.map((s) => s.task_id)).toEqual([early.id, late.id]);
    expect(log.completed.map((c) => c.task_id)).toEqual([early.id, late.id]);
  });

  it('breaks an exact tie by id, not by input order', () => {
    const a = task(1, { completed_at: at(10) });
    const b = task(2, { completed_at: at(10) });
    const forward = computeDayLog({ date: day, nodes: [a, b], blocks: [], ...settings })!;
    const reverse = computeDayLog({ date: day, nodes: [b, a], blocks: [], ...settings })!;
    expect(forward.completed.map((c) => c.task_id)).toEqual([a.id, b.id]);
    expect(reverse).toEqual(forward);
  });
});

describe('computeDayLogsByDate — the export path equals the client path', () => {
  it('agrees with computeDayLog on every day it produced', () => {
    const nodes = [
      task(1, { completed_at: '2026-05-08T16:00:00.000Z' }),
      task(2, { completed_at: '2026-05-09T16:00:00.000Z' }),
      task(3, { completed_at: '2026-05-09T02:00:00.000Z' }), // 22:00 EDT on the 8th
      task(4),
    ];
    const blocks = [
      block(1, nodes[0]!.id, '2026-05-08T13:00:00.000Z', '2026-05-08T14:00:00.000Z'),
      block(2, nodes[3]!.id, '2026-05-10T13:00:00.000Z', '2026-05-10T14:00:00.000Z'),
    ];
    const byDate = computeDayLogsByDate({ nodes, blocks }, settings);
    expect([...byDate.keys()].sort()).toEqual(['2026-05-08', '2026-05-09', '2026-05-10']);
    for (const [date, entries] of byDate) {
      expect(computeDayLog({ date, nodes, blocks, ...settings })).toEqual(entries);
    }
    // …and days it did NOT produce are empty for the single-day path too.
    expect(computeDayLog({ date: '2026-05-11', nodes, blocks, ...settings })).toBeNull();
  });

  it('never stores an empty day', () => {
    expect(computeDayLogsByDate({ nodes: [task(1)], blocks: [] }, settings).size).toBe(0);
  });

  it('walks a one-shot iterator exactly once', () => {
    const t = task(1, { completed_at: '2026-05-08T16:00:00.000Z' });
    const b = block(1, t.id, '2026-05-08T13:00:00.000Z', '2026-05-08T14:00:00.000Z');
    const once = <T,>(items: T[]): Iterable<T> => items[Symbol.iterator]() as unknown as Iterable<T>;
    const log = computeDayLog({ date: '2026-05-08', nodes: once([t]), blocks: once([b]), ...settings });
    expect(log?.scheduled).toHaveLength(1);
    expect(log?.completed).toHaveLength(1);
  });
});

describe('totality over dirty rows', () => {
  const day = '2026-05-08';
  const good = '2026-05-08T16:00:00.000Z';

  it('filters unusable timestamps instead of throwing', () => {
    const dirty = [
      task(1, { completed_at: 'not a date' }),
      task(2, { completed_at: '' }),
      task(3, { completed_at: '9999999-01-01T00:00:00.000Z' }),
      task(4, { completed_at: null }),
    ];
    expect(computeDayLog({ date: day, nodes: dirty, blocks: [], ...settings })).toBeNull();
  });

  it('filters blocks with unusable or missing fields', () => {
    const t = task(1);
    const blocks = [
      block(1, t.id, 'garbage', good),
      block(2, t.id, good, 'garbage'),
      { ...block(3, t.id, good, good), id: '' } as ScheduleBlock,
      { ...block(4, t.id, good, good), task_id: '' } as ScheduleBlock,
    ];
    expect(computeDayLog({ date: day, nodes: [t], blocks, ...settings })).toBeNull();
  });

  it('survives null-ish rows and non-string titles', () => {
    const weird = { ...task(1, { completed_at: good }), title: undefined } as unknown as Node;
    const nodes = [weird, null as unknown as Node];
    const log = computeDayLog({ date: day, nodes, blocks: [null as unknown as ScheduleBlock], ...settings });
    expect(log!.completed[0]!.title).toBe('');
  });

  it('treats a null completion_disposition as `completed`', () => {
    const t = task(1, { completed_at: good, completion_disposition: null });
    expect(computeDayLog({ date: day, nodes: [t], blocks: [], ...settings })!.completed[0]!.disposition)
      .toBe('completed');
  });

  it('fuzz: arbitrary junk rows never throw', () => {
    const junk = fc.record({
      id: fc.oneof(fc.string(), fc.constant(null), fc.integer()),
      deleted_at: fc.oneof(fc.constant(null), fc.string()),
      completed_at: fc.oneof(fc.constant(null), fc.string(), fc.integer()),
      completion_disposition: fc.oneof(fc.constant(null), fc.string()),
      title: fc.oneof(fc.string(), fc.constant(null), fc.integer()),
      status: fc.oneof(fc.constant('committed'), fc.string()),
      superseded_at: fc.oneof(fc.constant(null), fc.string()),
      task_id: fc.oneof(fc.string(), fc.constant(null)),
      starts_at: fc.oneof(fc.string(), fc.constant(null), fc.integer()),
      ends_at: fc.oneof(fc.string(), fc.constant(null), fc.integer()),
    });
    fc.assert(
      fc.property(fc.array(junk, { maxLength: 12 }), (rows) => {
        const nodes = rows as unknown as Node[];
        const blocks = rows as unknown as ScheduleBlock[];
        expect(() => computeDayLog({ date: '2026-05-08', nodes, blocks, ...settings })).not.toThrow();
        expect(() => computeDayLogsByDate({ nodes, blocks }, settings)).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });
});

describe('rendering (D7)', () => {
  const day = '2026-05-08';

  const entries = (): DayLogEntries => {
    const planned = task(1, { title: 'Write the April retro 📝', completed_at: '2026-05-08T18:20:00.000Z' });
    const adhoc = task(2, { title: 'Fix the flaky test', completed_at: '2026-05-08T19:05:00.000Z' });
    const descoped = task(3, { title: 'Old idea', completed_at: '2026-05-08T20:00:00.000Z', completion_disposition: 'obsolete' });
    const upcoming = task(4, { title: 'Review PRs' });
    return computeDayLog({
      date: day,
      nodes: [planned, adhoc, descoped, upcoming],
      blocks: [
        block(1, planned.id, '2026-05-08T17:00:00.000Z', '2026-05-08T18:30:00.000Z'),
        block(2, upcoming.id, '2026-05-08T21:00:00.000Z', '2026-05-08T22:00:00.000Z'),
      ],
      ...settings,
    })!;
  };

  it('formats HH:mm in the user timezone without Intl.Segmenter', () => {
    expect(formatDayLogTime('2026-05-08T17:00:00.000Z', NY)).toBe('13:00');
    expect(formatDayLogTime('2026-05-08T17:00:00.000Z', 'UTC')).toBe('17:00');
    expect(formatDayLogTime('2026-05-08T17:00:00.000Z', 'Mars/Olympus')).toBe('13:00'); // default zone
    expect(formatDayLogTime('nope', NY)).toBe('--:--');
  });

  it('renders the markdown golden', () => {
    expect(renderDayLogMarkdown(entries(), { timezone: NY })).toBe(
      [
        '### Day log',
        '',
        '**Scheduled**',
        '',
        '- [x] 13:00–14:30 Write the April retro 📝',
        '- [ ] 17:00–18:00 Review PRs',
        '',
        '**Completed**',
        '',
        '- 14:20 Write the April retro 📝',
        '- 15:05 Fix the flaky test (unplanned)',
        '- 16:00 Old idea (unplanned) (descoped)',
        '',
      ].join('\n'),
    );
  });

  it('renders "+N more" for a truncated list', () => {
    const many: DayLogEntries = { v: 1, scheduled: [], completed: [], truncated: { scheduled: 0, completed: 7 } };
    many.completed.push({
      task_id: idOf(1),
      title: 'One of many',
      completed_at: '2026-05-08T17:00:00.000Z',
      disposition: 'completed',
      planned: true,
    });
    expect(renderDayLogMarkdown(many, { timezone: NY })).toContain('- +7 more');
  });

  it('omits a section that has no lines', () => {
    const t = task(1, { completed_at: '2026-05-08T17:00:00.000Z' });
    const md = renderDayLogMarkdown(computeDayLog({ date: day, nodes: [t], blocks: [], ...settings })!, { timezone: NY });
    expect(md).not.toContain('**Scheduled**');
    expect(md).toContain('**Completed**');
  });

  it('flattens a multi-line title so it cannot break out of the list', () => {
    const t = task(1, { title: 'line one\nline two', completed_at: '2026-05-08T17:00:00.000Z' });
    const md = renderDayLogMarkdown(computeDayLog({ date: day, nodes: [t], blocks: [], ...settings })!, { timezone: NY });
    expect(md).toContain('- 13:00 line one line two');
    expect(md.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(1);
  });

  it('renders a blank title as (untitled)', () => {
    const t = task(1, { title: '   ', completed_at: '2026-05-08T17:00:00.000Z' });
    const md = renderDayLogMarkdown(computeDayLog({ date: day, nodes: [t], blocks: [], ...settings })!, { timezone: NY });
    expect(md).toContain('(untitled)');
  });
});

describe('composeDayMarkdown (D7) — content is verbatim', () => {
  const log = computeDayLog({
    date: '2026-05-08',
    nodes: [task(1, { title: 'Ship it 🚀', completed_at: '2026-05-08T17:00:00.000Z' })],
    blocks: [],
    ...settings,
  })!;

  it('appends after a deterministic separator and keeps content byte-exact', () => {
    const content = '# Kickoff\n\nStarted the **build** 🚀\n\n- [ ] one';
    const composed = composeDayMarkdown(content, log, { timezone: NY });
    expect(composed.startsWith(content)).toBe(true);
    expect(composed.slice(content.length)).toBe(`\n\n---\n\n${renderDayLogMarkdown(log, { timezone: NY })}`);
  });

  it('returns the section alone for a log-only day (empty note)', () => {
    expect(composeDayMarkdown('', log, { timezone: NY })).toBe(renderDayLogMarkdown(log, { timezone: NY }));
  });

  it('returns content untouched when there is no log', () => {
    expect(composeDayMarkdown('just a note', null)).toBe('just a note');
    expect(composeDayMarkdown('just a note', undefined)).toBe('just a note');
    expect(composeDayMarkdown('just a note', { v: 1, scheduled: [], completed: [] })).toBe('just a note');
    expect(isDayLogEmpty({ v: 1, scheduled: [], completed: [] })).toBe(true);
  });

  it('property: content is always a verbatim prefix of the composed file', () => {
    fc.assert(
      fc.property(fc.string(), fc.option(fc.constant(log), { nil: null }), (content, entries) => {
        expect(composeDayMarkdown(content, entries, { timezone: NY }).startsWith(content)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
