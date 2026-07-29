/**
 * Demo seed (BUILD_PLAN.md S3): one realistic user — 4 vision angles, habits
 * (incl. a skill), a project tree, dependency edges, and time entries.
 *
 * Fully deterministic: fixed user id, fixed timestamps, and UUIDv7 ids drawn
 * from core's seeded Rng — re-running the seed produces byte-identical rows.
 * It wipes the demo user's rows first, so it is safe to run repeatedly.
 */
import { createSeededRng, sortOrdersBetween, uuidV7From } from '@prisms/core';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';

import {
  automation_rules,
  blocker_rules,
  computed_aggregates,
  decision_boards,
  decision_criteria,
  decision_scores,
  diagram_groups,
  diagram_layouts,
  edges,
  external_facts,
  habit_completions,
  habits,
  journal_entries,
  nodes,
  schedule_blocks,
  sprint_memberships,
  sprints,
  time_entries,
  user_settings,
} from './schema';

export const DEMO_USER_ID = '01900000-0000-7000-8000-000000000001';

export interface SeedSummary {
  nodes: number;
  habits: number;
  habit_completions: number;
  edges: number;
  schedule_blocks: number;
  time_entries: number;
  journal_entries: number;
}

type NodeInsert = typeof nodes.$inferInsert;

/** Single fixed creation instant — keeps re-runs byte-identical. */
const T0 = '2026-06-01T12:00:00.000Z';

export async function seedDemoUser(databaseUrl: string): Promise<SeedSummary> {
  const rng = createSeededRng(0x5eed);
  let tick = 0;
  const nextId = () => uuidV7From(1_780_000_000_000 + tick++ * 1000, rng.randomBytes(16));

  const stamp = { created_at: T0, updated_at: T0, deleted_at: null };
  const base = () => ({ id: nextId(), user_id: DEMO_USER_ID, ...stamp });

  const makeNode = (
    over: Partial<NodeInsert> & Pick<NodeInsert, 'node_type' | 'title' | 'sort_order'>,
  ): NodeInsert => ({
    ...base(),
    parent_id: null,
    description: '',
    start_date: null,
    due_date: null,
    estimate_minutes: null,
    completed_at: null,
    habit_id: null,
    attributes: {},
    ...over,
  });

  // --- the tree -------------------------------------------------------------
  const visionOrders = sortOrdersBetween(null, null, 4);
  const [wellness, work, knowledge, expression] = [
    makeNode({ node_type: 'vision', title: 'Wellness', sort_order: visionOrders[0]! }),
    makeNode({ node_type: 'vision', title: 'Work', sort_order: visionOrders[1]! }),
    makeNode({ node_type: 'vision', title: 'Knowledge', sort_order: visionOrders[2]! }),
    makeNode({ node_type: 'vision', title: 'Expression', sort_order: visionOrders[3]! }),
  ];

  const prismsRoadmap = makeNode({
    node_type: 'roadmap',
    title: 'Prisms v1',
    parent_id: work.id,
    sort_order: 'a0',
  });
  const mathRoadmap = makeNode({
    node_type: 'roadmap',
    title: 'Mathematics',
    parent_id: knowledge.id,
    sort_order: 'a0',
  });

  const buildPrisms = makeNode({
    node_type: 'project',
    title: 'Build Prisms',
    parent_id: prismsRoadmap.id,
    sort_order: 'a0',
    start_date: '2026-06-01',
    due_date: '2026-09-30',
  });
  const portfolio = makeNode({
    node_type: 'project',
    title: 'Portfolio site refresh',
    parent_id: prismsRoadmap.id,
    sort_order: 'a1',
    due_date: '2026-10-31',
  });
  const linearAlgebra = makeNode({
    node_type: 'project',
    title: 'Linear Algebra course',
    parent_id: mathRoadmap.id,
    sort_order: 'a0',
  });

  const foundations = makeNode({
    node_type: 'milestone',
    title: 'Foundations',
    parent_id: buildPrisms.id,
    sort_order: 'a0',
    due_date: '2026-06-30',
  });
  const engines = makeNode({
    node_type: 'milestone',
    title: 'Core engines',
    parent_id: buildPrisms.id,
    sort_order: 'a1',
    due_date: '2026-07-31',
  });

  const taskOrders = sortOrdersBetween(null, null, 6);
  const monorepo = makeNode({
    node_type: 'task',
    title: 'Monorepo scaffold',
    parent_id: foundations.id,
    sort_order: taskOrders[0]!,
    estimate_minutes: 240,
    completed_at: '2026-06-03T18:00:00.000Z',
  });
  const domainTypes = makeNode({
    node_type: 'task',
    title: 'Define domain schemas',
    parent_id: foundations.id,
    sort_order: taskOrders[1]!,
    estimate_minutes: 300,
    completed_at: '2026-06-09T11:00:00.000Z',
  });
  const dbPackage = makeNode({
    node_type: 'task',
    title: 'Database package + migrations',
    parent_id: foundations.id,
    sort_order: taskOrders[2]!,
    estimate_minutes: 360,
    due_date: '2026-06-20',
  });
  const statusEngine = makeNode({
    node_type: 'task',
    title: 'Status engine',
    parent_id: engines.id,
    sort_order: taskOrders[3]!,
    estimate_minutes: 420,
  });
  const scheduler = makeNode({
    node_type: 'task',
    title: 'Greedy scheduler',
    parent_id: engines.id,
    sort_order: taskOrders[4]!,
    estimate_minutes: 480,
    due_date: '2026-07-15',
  });
  const research = makeNode({
    node_type: 'task',
    title: 'Research design references',
    parent_id: portfolio.id,
    sort_order: 'a0',
    estimate_minutes: 120,
  });
  const draft = makeNode({
    node_type: 'task',
    title: 'Draft new landing page',
    parent_id: portfolio.id,
    sort_order: 'a1',
    estimate_minutes: 180,
  });
  const vectorsTask = makeNode({
    node_type: 'task',
    title: 'Work through ch. 3: vector spaces',
    parent_id: linearAlgebra.id,
    sort_order: 'a0',
    estimate_minutes: 200,
  });

  const inboxActivity = makeNode({
    node_type: 'activity',
    title: 'Renew passport',
    sort_order: 'a0',
  });

  // Annex L — the LOG-ONLY past-month day (2026-05-08): a committed block plus a
  // completed task on a day that has NO journal note, in a month before T0. The
  // V5 archive e2e proves the export is server-sourced by finding this day in the
  // zip although its month was never subscribed on the device. Bucketed with
  // day_reset_hour 4 in America/New_York (EDT = UTC-4 in May).
  const retroNotes = makeNode({
    node_type: 'task',
    title: 'Write the April retro 📝',
    parent_id: portfolio.id,
    sort_order: 'a2',
    estimate_minutes: 90,
    completed_at: '2026-05-08T18:20:00.000Z',
  });

  // --- habits & skills --------------------------------------------------------
  const habitBase = () => ({
    ...base(),
    daily_target_minutes: null as number | null,
    mastery_target_hours: null as number | null,
    level_thresholds_hours: [] as number[],
  });
  const morningRun = {
    ...habitBase(),
    vision_id: wellness.id,
    title: 'Morning run',
    rrule: 'FREQ=DAILY',
    streak_mode: 'daily' as const,
    daily_target_minutes: 30,
  };
  const guitar = {
    ...habitBase(),
    vision_id: expression.id,
    title: 'Guitar practice',
    rrule: 'FREQ=DAILY',
    streak_mode: 'perfect_planned' as const,
    daily_target_minutes: 60,
    mastery_target_hours: 10_000,
    level_thresholds_hours: [25, 250, 2_500, 10_000],
  };
  const weeklyReview = {
    ...habitBase(),
    vision_id: work.id,
    title: 'Weekly review',
    rrule: 'FREQ=WEEKLY;BYDAY=SU',
    streak_mode: 'weekly' as const,
  };

  // habit-spawned tasks: parent_id NULL xor habit_id (§6.7 I1/I3)
  const runToday = makeNode({
    node_type: 'task',
    title: 'Run 5k',
    habit_id: morningRun.id,
    sort_order: 'a0',
    estimate_minutes: 35,
    completed_at: '2026-06-10T12:05:00.000Z',
  });
  const practiceScales = makeNode({
    node_type: 'task',
    title: 'Practice: scales & arpeggios',
    habit_id: guitar.id,
    sort_order: 'a1',
    estimate_minutes: 60,
  });

  const allNodes: NodeInsert[] = [
    wellness, work, knowledge, expression,
    prismsRoadmap, mathRoadmap,
    buildPrisms, portfolio, linearAlgebra,
    foundations, engines,
    monorepo, domainTypes, dbPackage, statusEngine, scheduler,
    research, draft, vectorsTask,
    inboxActivity, retroNotes, runToday, practiceScales,
  ];

  // --- schedule blocks (committed agenda) --------------------------------------
  // Explicit schema_version — rows built in JS must carry it or the dispatcher
  // rejects them as E_CLIENT_TOO_OLD far from the cause (0f6b95d lesson).
  const blockRows = [
    {
      ...base(),
      task_id: retroNotes.id,
      starts_at: '2026-05-08T17:00:00.000Z',
      ends_at: '2026-05-08T18:30:00.000Z',
      status: 'committed' as const,
      schema_version: 1,
    },
  ];

  // --- dependency edges (same node_type, DAG — §6.7 I4) ------------------------
  const edgeRows = [
    { ...base(), predecessor_id: monorepo.id, successor_id: domainTypes.id, edge_type: 'FS' as const, lag_minutes: 0 },
    { ...base(), predecessor_id: domainTypes.id, successor_id: dbPackage.id, edge_type: 'FS' as const, lag_minutes: 0 },
    { ...base(), predecessor_id: dbPackage.id, successor_id: statusEngine.id, edge_type: 'FS' as const, lag_minutes: 120 },
    { ...base(), predecessor_id: statusEngine.id, successor_id: scheduler.id, edge_type: 'FS' as const, lag_minutes: 0 },
    { ...base(), predecessor_id: research.id, successor_id: draft.id, edge_type: 'SS' as const, lag_minutes: 60 },
    // project-level dependency (project↔project is valid per I4)
    { ...base(), predecessor_id: buildPrisms.id, successor_id: portfolio.id, edge_type: 'FS' as const, lag_minutes: 0 },
  ];

  // --- time entries (closed facts; §7.2 effective hours = duration × focus) ----
  const entry = (
    task_id: string,
    started_at: string,
    ended_at: string,
    focus: number | null,
    completed: boolean | null,
    planned = true,
  ) => ({
    ...base(),
    task_id,
    started_at,
    ended_at,
    focus_factor: focus,
    completed_session: completed,
    planned,
    device_id: 'seed-device',
  });

  const entryRows = [
    entry(monorepo.id, '2026-06-02T14:00:00.000Z', '2026-06-02T16:30:00.000Z', 0.9, false),
    entry(monorepo.id, '2026-06-03T15:00:00.000Z', '2026-06-03T18:00:00.000Z', 1.0, true),
    entry(domainTypes.id, '2026-06-08T14:00:00.000Z', '2026-06-08T15:30:00.000Z', 0.9, false),
    entry(domainTypes.id, '2026-06-09T09:00:00.000Z', '2026-06-09T11:00:00.000Z', 1.0, true),
    entry(dbPackage.id, '2026-06-10T13:00:00.000Z', '2026-06-10T14:10:00.000Z', 0.8, false),
    entry(runToday.id, '2026-06-10T11:30:00.000Z', '2026-06-10T12:05:00.000Z', 0.8, true),
    entry(practiceScales.id, '2026-06-10T22:00:00.000Z', '2026-06-10T23:00:00.000Z', 0.7, false),
    // unplanned ad-hoc work
    entry(vectorsTask.id, '2026-06-07T19:00:00.000Z', '2026-06-07T20:15:00.000Z', null, null, false),
  ];

  // --- journal notes (a note on a day) -----------------------------------------
  // Two PAST months (before T0's June) so the J6 e2e can prove lazy month-bucketed
  // sync: a fresh device holds zero journal rows until it navigates to each month.
  // Explicit schema_version — rows built in JS must carry it (0f6b95d lesson).
  const journalNote = (entry_date: string, content: string) => ({
    ...base(),
    entry_date,
    month_key: entry_date.slice(0, 7),
    content,
    schema_version: 1,
  });
  const journalRows = [
    journalNote(
      '2026-04-15',
      '# Kickoff\n\nStarted the **Prisms** build. Next up:\n\n- [ ] domain schemas\n- [ ] migrations\n\nFeeling good 🚀',
    ),
    journalNote(
      '2026-05-20',
      'Shipped the scheduler — long day, celebrated with the family 👨‍👩‍👧‍👦\n\n> _ship it_',
    ),
  ];

  // --- habit completions (bucketed dates, §7.2) --------------------------------
  const completion = (habit_id: string, occurrence_date: string, completed_at: string) => ({
    ...base(),
    habit_id,
    occurrence_date,
    completed_at,
  });
  const completionRows = [
    completion(morningRun.id, '2026-06-06', '2026-06-06T12:01:00.000Z'),
    completion(morningRun.id, '2026-06-07', '2026-06-07T11:48:00.000Z'),
    completion(morningRun.id, '2026-06-08', '2026-06-08T12:10:00.000Z'),
    completion(morningRun.id, '2026-06-09', '2026-06-09T11:55:00.000Z'),
    completion(morningRun.id, '2026-06-10', '2026-06-10T12:05:00.000Z'),
    completion(guitar.id, '2026-06-09', '2026-06-10T02:30:00.000Z'),
    completion(guitar.id, '2026-06-10', '2026-06-10T23:00:00.000Z'),
    completion(weeklyReview.id, '2026-06-07', '2026-06-07T21:00:00.000Z'),
  ];

  const client = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    const db = drizzle(client);
    await wipeDemoUser(db);

    await db.insert(user_settings).values({
      user_id: DEMO_USER_ID,
      day_reset_hour: 4,
      timezone: 'America/New_York',
      weather_location: { lat: 28.36, lon: -80.69, label: 'Merritt Island, FL' },
      updated_at: T0,
    });
    await db.insert(nodes).values(allNodes);
    await db.insert(habits).values([morningRun, guitar, weeklyReview]);
    await db.insert(edges).values(edgeRows);
    await db.insert(schedule_blocks).values(blockRows);
    await db.insert(time_entries).values(entryRows);
    await db.insert(habit_completions).values(completionRows);
    await db.insert(journal_entries).values(journalRows);

    return {
      nodes: allNodes.length,
      habits: 3,
      habit_completions: completionRows.length,
      edges: edgeRows.length,
      schedule_blocks: blockRows.length,
      time_entries: entryRows.length,
      journal_entries: journalRows.length,
    };
  } finally {
    await client.end();
  }
}

/** Children/referencing rows first; NO ACTION FKs are checked per statement. */
async function wipeDemoUser(db: PostgresJsDatabase): Promise<void> {
  const uid = DEMO_USER_ID;
  await db.delete(journal_entries).where(eq(journal_entries.user_id, uid));
  await db.delete(time_entries).where(eq(time_entries.user_id, uid));
  await db.delete(habit_completions).where(eq(habit_completions.user_id, uid));
  await db.delete(habits).where(eq(habits.user_id, uid));
  await db.delete(edges).where(eq(edges.user_id, uid));
  await db.delete(schedule_blocks).where(eq(schedule_blocks.user_id, uid));
  await db.delete(decision_scores).where(eq(decision_scores.user_id, uid));
  await db.delete(decision_criteria).where(eq(decision_criteria.user_id, uid));
  await db.delete(decision_boards).where(eq(decision_boards.user_id, uid));
  await db.delete(sprint_memberships).where(eq(sprint_memberships.user_id, uid));
  await db.delete(sprints).where(eq(sprints.user_id, uid));
  await db.delete(diagram_layouts).where(eq(diagram_layouts.user_id, uid));
  await db.delete(diagram_groups).where(eq(diagram_groups.user_id, uid));
  await db.delete(automation_rules).where(eq(automation_rules.user_id, uid));
  await db.delete(blocker_rules).where(eq(blocker_rules.user_id, uid));
  await db.delete(external_facts).where(eq(external_facts.user_id, uid));
  await db.delete(computed_aggregates).where(eq(computed_aggregates.user_id, uid));
  await db.delete(nodes).where(eq(nodes.user_id, uid));
  await db.delete(user_settings).where(eq(user_settings.user_id, uid));
}
