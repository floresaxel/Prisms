/**
 * S5 DoD: golden table covering every status × precedence collision, and
 * every edge-type gate (FS/SS/FF/SF + lag).
 */
import { describe, expect, it } from 'vitest';

import { buildFactContext, type FactRows } from '../../src/status/context';
import {
  dependencyBlocked,
  isBlocked,
  isBlockedForAcceptance,
  taskStatus,
  type TaskStatus,
} from '../../src/status/status';
import { isoToEpochMillis } from '../../src/time/instant';
import {
  idOf,
  makeBlock,
  makeEdge,
  makeEntry,
  makeMembership,
  makeNode,
  makeSprint,
  makeWeatherFact,
  makeBlockerRule,
} from '../helpers/fixtures';

const NOW = isoToEpochMillis('2026-06-12T16:00:00.000Z');
const TODAY = '2026-06-12'; // default settings: reset 4, America/New_York

// ids: task under test = 1; helpers allocate from 100 upward
const TASK = idOf(1);
const PRED = idOf(2);

/**
 * Builds a fact set where the given status *conditions* hold simultaneously
 * for TASK; taskStatus must pick the highest-precedence one.
 */
function rowsWith(conditions: readonly TaskStatus[]): FactRows {
  const task = makeNode({
    id: TASK,
    node_type: 'task',
    completed_at: conditions.includes('done') ? '2026-06-12T12:00:00.000Z' : null,
  });
  const rows: Required<Omit<FactRows, 'user_settings' | 'external_facts'>> & FactRows = {
    nodes: [task],
    edges: [],
    time_entries: [],
    schedule_blocks: [],
    sprints: [],
    sprint_memberships: [],
    blocker_rules: [],
  };

  if (conditions.includes('ongoing')) {
    rows.time_entries = [
      ...rows.time_entries,
      makeEntry({ id: idOf(100), task_id: TASK, started_at: '2026-06-12T15:00:00.000Z' }),
    ];
  }
  if (conditions.includes('blocked')) {
    rows.nodes = [...rows.nodes, makeNode({ id: PRED, node_type: 'task' })];
    rows.edges = [
      ...rows.edges,
      makeEdge({ id: idOf(101), predecessor_id: PRED, successor_id: TASK }),
    ];
  }
  if (conditions.includes('scheduled')) {
    rows.schedule_blocks = [
      ...rows.schedule_blocks,
      makeBlock({
        id: idOf(102),
        task_id: TASK,
        starts_at: '2026-06-13T09:00:00.000Z',
        ends_at: '2026-06-13T10:00:00.000Z',
      }),
    ];
  }
  if (conditions.includes('prioritized')) {
    rows.sprints = [
      ...rows.sprints,
      makeSprint({ id: idOf(103), starts_on: '2026-06-08', ends_on: '2026-06-14' }),
    ];
    rows.sprint_memberships = [
      ...rows.sprint_memberships,
      makeMembership({ id: idOf(104), sprint_id: idOf(103), node_id: TASK }),
    ];
  }
  return rows;
}

function statusFor(conditions: readonly TaskStatus[]): TaskStatus {
  const rows = rowsWith(conditions);
  const ctx = buildFactContext(rows);
  const task = rows.nodes.find((n) => n.id === TASK)!;
  return taskStatus(task, ctx, NOW);
}

describe('taskStatus precedence (§7.1): done > ongoing > blocked > scheduled > prioritized > available', () => {
  const ORDER: TaskStatus[] = ['done', 'ongoing', 'blocked', 'scheduled', 'prioritized'];

  it.each(
    ORDER.flatMap((a, i) => ORDER.slice(i + 1).map((b): [TaskStatus, TaskStatus] => [a, b])),
  )('%s beats %s when both hold', (winner, loser) => {
    expect(statusFor([winner, loser])).toBe(winner);
  });

  it('all conditions at once ⇒ done', () => {
    expect(statusFor(['done', 'ongoing', 'blocked', 'scheduled', 'prioritized'])).toBe('done');
  });

  it.each(ORDER.map((s): [TaskStatus] => [s]))('%s alone holds', (status) => {
    expect(statusFor([status])).toBe(status);
  });

  it('nothing holds ⇒ available', () => {
    expect(statusFor([])).toBe('available');
  });

  it('blocker-rule blocked also loses to ongoing (e.g. rainy ongoing run keeps running)', () => {
    const task = makeNode({ id: TASK, node_type: 'task' });
    const ctx = buildFactContext({
      nodes: [task],
      time_entries: [
        makeEntry({ id: idOf(100), task_id: TASK, started_at: '2026-06-12T15:00:00.000Z' }),
      ],
      blocker_rules: [
        makeBlockerRule({
          id: idOf(105),
          predicate: { fact: 'weather.precip_prob', op: 'gt', value: 0.6 },
        }),
      ],
      external_facts: [
        makeWeatherFact({ id: idOf(106), key: TODAY, payload: { precip_prob: 0.9 } }),
      ],
    });
    expect(taskStatus(task, ctx, NOW)).toBe('ongoing');
  });
});

describe('scheduled details (§7.1)', () => {
  it('a currently-running committed block counts; a fully past one does not', () => {
    const task = makeNode({ id: TASK, node_type: 'task' });
    const running = buildFactContext({
      nodes: [task],
      schedule_blocks: [
        makeBlock({
          id: idOf(102),
          task_id: TASK,
          starts_at: '2026-06-12T15:30:00.000Z',
          ends_at: '2026-06-12T16:30:00.000Z',
        }),
      ],
    });
    expect(taskStatus(task, running, NOW)).toBe('scheduled');

    const past = buildFactContext({
      nodes: [task],
      schedule_blocks: [
        makeBlock({
          id: idOf(102),
          task_id: TASK,
          starts_at: '2026-06-12T09:00:00.000Z',
          ends_at: '2026-06-12T10:00:00.000Z',
        }),
      ],
    });
    expect(taskStatus(task, past, NOW)).toBe('available');
  });

  it('suggested blocks never make a task scheduled (§2.6)', () => {
    const task = makeNode({ id: TASK, node_type: 'task' });
    const ctx = buildFactContext({
      nodes: [task],
      schedule_blocks: [
        makeBlock({
          id: idOf(102),
          task_id: TASK,
          starts_at: '2026-06-13T09:00:00.000Z',
          ends_at: '2026-06-13T10:00:00.000Z',
          status: 'suggested',
          suggestion_reason: 'nightly_optimization',
        }),
      ],
    });
    expect(taskStatus(task, ctx, NOW)).toBe('available');
  });
});

describe('prioritized details (§7.1)', () => {
  it('membership via an ancestor (project in sprint) prioritizes the task', () => {
    const project = makeNode({ id: idOf(10), node_type: 'project' });
    const task = makeNode({ id: TASK, node_type: 'task', parent_id: project.id });
    const ctx = buildFactContext({
      nodes: [project, task],
      sprints: [makeSprint({ id: idOf(103), starts_on: '2026-06-08', ends_on: '2026-06-14' })],
      sprint_memberships: [
        makeMembership({ id: idOf(104), sprint_id: idOf(103), node_id: project.id }),
      ],
    });
    expect(taskStatus(task, ctx, NOW)).toBe('prioritized');
  });

  it('sprint dates respect the day-reset bucket: still active at 3am after end date', () => {
    const task = makeNode({ id: TASK, node_type: 'task' });
    const ctx = buildFactContext({
      nodes: [task],
      sprints: [makeSprint({ id: idOf(103), starts_on: '2026-06-08', ends_on: '2026-06-12' })],
      sprint_memberships: [
        makeMembership({ id: idOf(104), sprint_id: idOf(103), node_id: TASK }),
      ],
    });
    // 2026-06-13T03:00 New York (07:00Z) is before the 4am reset ⇒ bucket 2026-06-12
    expect(taskStatus(task, ctx, isoToEpochMillis('2026-06-13T07:00:00.000Z'))).toBe(
      'prioritized',
    );
    // 04:30 local ⇒ bucket 2026-06-13 ⇒ sprint over
    expect(taskStatus(task, ctx, isoToEpochMillis('2026-06-13T08:30:00.000Z'))).toBe(
      'available',
    );
  });
});

describe('edge-type gates (§7.1 isBlocked part a)', () => {
  function gateRows(edgeType: 'FS' | 'SS' | 'FF' | 'SF', lag = 0) {
    const pred = makeNode({ id: PRED, node_type: 'task' });
    const task = makeNode({ id: TASK, node_type: 'task' });
    return {
      pred,
      task,
      build: (predOverrides: Partial<typeof pred>, entries: FactRows['time_entries'] = []) =>
        buildFactContext({
          nodes: [{ ...pred, ...predOverrides }, task],
          edges: [
            makeEdge({
              id: idOf(101),
              predecessor_id: PRED,
              successor_id: TASK,
              edge_type: edgeType,
              lag_minutes: lag,
            }),
          ],
          time_entries: entries,
        }),
    };
  }

  it('FS: blocked until the predecessor completes', () => {
    const { task, build } = gateRows('FS');
    expect(taskStatus(task, build({}), NOW)).toBe('blocked');
    expect(taskStatus(task, build({ completed_at: '2026-06-12T12:00:00.000Z' }), NOW)).toBe(
      'available',
    );
  });

  it('SS: blocked until the predecessor starts (any entry) or completes', () => {
    const { task, build } = gateRows('SS');
    expect(taskStatus(task, build({}), NOW)).toBe('blocked');
    const started = build({}, [
      makeEntry({
        id: idOf(100),
        task_id: PRED,
        started_at: '2026-06-12T10:00:00.000Z',
        ended_at: '2026-06-12T10:30:00.000Z',
      }),
    ]);
    expect(taskStatus(task, started, NOW)).toBe('available');
    expect(taskStatus(task, build({ completed_at: '2026-06-12T12:00:00.000Z' }), NOW)).toBe(
      'available',
    );
  });

  it.each([['FF'], ['SF']] as const)('%s: never gates availability', (edgeType) => {
    const { task, build } = gateRows(edgeType);
    expect(taskStatus(task, build({}), NOW)).toBe('available');
  });

  it('lag: completed predecessor still blocks until completed_at + lag', () => {
    const { task, build } = gateRows('FS', 60);
    // completed 30 minutes ago, lag 60 ⇒ still blocked
    const ctx = build({ completed_at: '2026-06-12T15:30:00.000Z' });
    expect(dependencyBlocked(task, ctx, NOW)).toBe(true);
    expect(taskStatus(task, ctx, NOW)).toBe('blocked');
    // 61 minutes after completion ⇒ released
    const later = isoToEpochMillis('2026-06-12T16:31:00.000Z');
    expect(taskStatus(task, ctx, later)).toBe('available');
  });

  it('lag applies to SS edges with completed predecessors too (spec applies it uniformly)', () => {
    const { task, build } = gateRows('SS', 60);
    const ctx = build({ completed_at: '2026-06-12T15:30:00.000Z' });
    expect(taskStatus(task, ctx, NOW)).toBe('blocked');
  });

  it('SS lag: a STARTED (not completed) predecessor blocks the successor until start + lag (§7.6, S3-F5)', () => {
    const { task, build } = gateRows('SS', 60);
    // predecessor started 30 min before NOW with an open entry, lag 60 ⇒ start+lag
    // = 16:30 > NOW(16:00) ⇒ still blocked (was NOT enforced before this fix).
    const ctx = build({}, [
      makeEntry({ id: idOf(100), task_id: PRED, started_at: '2026-06-12T15:30:00.000Z' }),
    ]);
    expect(taskStatus(task, ctx, NOW)).toBe('blocked');
    // 61 min after the start ⇒ released.
    const later = isoToEpochMillis('2026-06-12T16:31:00.000Z');
    expect(taskStatus(task, ctx, later)).toBe('available');
  });

  it('zero and negative lag never block a completed dependency', () => {
    for (const lag of [0, -30]) {
      const { task, build } = gateRows('FS', lag);
      expect(taskStatus(task, build({ completed_at: '2026-06-12T15:59:00.000Z' }), NOW)).toBe(
        'available',
      );
    }
  });

  it('a deleted (dangling) predecessor cannot block', () => {
    const pred = makeNode({
      id: PRED,
      node_type: 'task',
      deleted_at: '2026-06-11T00:00:00.000Z',
    });
    const task = makeNode({ id: TASK, node_type: 'task' });
    const ctx = buildFactContext({
      nodes: [pred, task],
      edges: [makeEdge({ id: idOf(101), predecessor_id: PRED, successor_id: TASK })],
    });
    expect(taskStatus(task, ctx, NOW)).toBe('available');
  });
});

describe('obsolete disposition (Phase 2)', () => {
  it('an obsolete task is still done (completed_at set ⇒ highest precedence)', () => {
    const task = makeNode({
      id: TASK,
      node_type: 'task',
      completed_at: '2026-06-12T12:00:00.000Z',
      completion_disposition: 'obsolete',
    });
    expect(taskStatus(task, buildFactContext({ nodes: [task] }), NOW)).toBe('done');
  });

  it('an obsolete predecessor unblocks an FS successor, exactly like a completed one', () => {
    const pred = makeNode({
      id: PRED,
      node_type: 'task',
      completed_at: '2026-06-12T12:00:00.000Z',
      completion_disposition: 'obsolete',
    });
    const task = makeNode({ id: TASK, node_type: 'task' });
    const ctx = buildFactContext({
      nodes: [pred, task],
      edges: [makeEdge({ id: idOf(101), predecessor_id: PRED, successor_id: TASK })],
    });
    expect(dependencyBlocked(task, ctx, NOW)).toBe(false);
    expect(taskStatus(task, ctx, NOW)).toBe('available');
  });
});

describe('isBlockedForAcceptance (§10.3, R19/V10): external facts never gate acceptance', () => {
  const weatherBlockedCtx = () =>
    buildFactContext({
      nodes: [makeNode({ id: TASK, node_type: 'task' })],
      blocker_rules: [
        makeBlockerRule({
          id: idOf(200),
          predicate: { all: [{ fact: 'weather.precip_prob', op: 'gt', value: 0.5, key: '{today}' }] },
        }),
      ],
      external_facts: [
        makeWeatherFact({ id: idOf(201), key: `town/${TODAY}`, payload: { precip_prob: 0.9 } }),
      ],
    });

  it('a weather-blocked task is blocked for DISPLAY but NOT for acceptance (clock-in needs no force)', () => {
    const ctx = weatherBlockedCtx();
    const task = makeNode({ id: TASK, node_type: 'task' });
    expect(isBlocked(task, ctx, NOW)).toBe(true); // §7.1 display path: weather blocks
    expect(taskStatus(task, ctx, NOW)).toBe('blocked');
    expect(isBlockedForAcceptance(task, ctx, NOW)).toBe(false); // acceptance excludes weather
  });

  it('a dependency-blocked task is blocked for acceptance too (force still required)', () => {
    const ctx = buildFactContext({
      nodes: [makeNode({ id: TASK, node_type: 'task' }), makeNode({ id: PRED, node_type: 'task' })],
      edges: [makeEdge({ id: idOf(202), predecessor_id: PRED, successor_id: TASK })], // FS, pred not done
    });
    const task = makeNode({ id: TASK, node_type: 'task' });
    expect(isBlockedForAcceptance(task, ctx, NOW)).toBe(true);
  });

  it('a non-external blocker rule still gates acceptance', () => {
    const ctx = buildFactContext({
      nodes: [makeNode({ id: TASK, node_type: 'task', title: 'blockme' })],
      blocker_rules: [
        makeBlockerRule({ id: idOf(203), predicate: { all: [{ fact: 'node.title', op: 'eq', value: 'blockme' }] } }),
      ],
    });
    const task = makeNode({ id: TASK, node_type: 'task', title: 'blockme' });
    expect(isBlockedForAcceptance(task, ctx, NOW)).toBe(true);
  });

  it('a rule MIXING weather with a non-weather leaf is fully excluded from acceptance', () => {
    const ctx = buildFactContext({
      nodes: [makeNode({ id: TASK, node_type: 'task', title: 'outdoor' })],
      blocker_rules: [
        makeBlockerRule({
          id: idOf(204),
          predicate: {
            all: [
              { fact: 'node.title', op: 'eq', value: 'outdoor' },
              { fact: 'weather.precip_prob', op: 'gt', value: 0.5, key: '{today}' },
            ],
          },
        }),
      ],
      external_facts: [makeWeatherFact({ id: idOf(205), key: `town/${TODAY}`, payload: { precip_prob: 0.9 } })],
    });
    const task = makeNode({ id: TASK, node_type: 'task', title: 'outdoor' });
    expect(isBlocked(task, ctx, NOW)).toBe(true); // display: both leaves true → blocked
    expect(isBlockedForAcceptance(task, ctx, NOW)).toBe(false); // weather-tainted rule skipped whole
  });
});
