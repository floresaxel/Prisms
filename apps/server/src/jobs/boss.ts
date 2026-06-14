/**
 * pg-boss bootstrap (§11): a job queue living inside Postgres (no Redis). Owns
 * its own connection pool, registers the §11 workers, schedules the cron jobs,
 * and exposes `enqueueBackstop` for the dispatcher to fire automation.backstop
 * on completions/creations (§9.4).
 *
 * The job LOGIC lives in the sibling modules (testable with an injected clock
 * against Postgres); this file is just the plumbing.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { PgBoss, type Job } from 'pg-boss';
import postgres from 'postgres';

import { runAggregatesRecomputeAll } from './aggregates-recompute';
import { runAutomationBackstop, type BackstopJob } from './automation-backstop';
import { systemClock, type JobClock } from './clock';
import { runLayoutPrecompute, type LayoutJob } from './layout-precompute';
import { runNotifyDispatch, type NotifyJob } from './notify-dispatch';
import { runPastdueScanAll } from './pastdue-scan';
import { createPushAdapters, type PushAdapters } from './push';
import { runRetentionPurge } from './retention-purge';
import { runScheduleOptimizeAll } from './schedule-optimize';
import { runWeatherPoll, type ForecastFetcher } from './weather-poll';

export const QUEUES = {
  weatherPoll: 'weather.poll',
  aggregatesRecompute: 'aggregates.recompute',
  automationBackstop: 'automation.backstop',
  retentionPurge: 'retention.purge',
  scheduleOptimize: 'schedule.optimize',
  pastdueScan: 'pastdue.scan',
  layoutPrecompute: 'layout.precompute',
  notifyDispatch: 'notify.dispatch',
} as const;

export interface JobsHandle {
  enqueueBackstop: (job: BackstopJob) => void;
  enqueueLayout: (job: LayoutJob) => void;
  stop: () => Promise<void>;
}

export interface StartJobsOptions {
  clock?: JobClock;
  fetchForecast?: ForecastFetcher;
  pushAdapters?: PushAdapters;
}

export async function startJobs(connectionString: string, options: StartJobsOptions = {}): Promise<JobsHandle> {
  const clock = options.clock ?? systemClock;
  const client = postgres(connectionString, { max: 4, onnotice: () => undefined });
  const db = drizzle(client);

  const pushAdapters = options.pushAdapters ?? createPushAdapters();
  const boss = new PgBoss({ connectionString });
  boss.on('error', (error: unknown) => console.error(JSON.stringify({ msg: 'pg-boss error', error: String(error) })));
  await boss.start();
  for (const queue of Object.values(QUEUES)) await boss.createQueue(queue);

  const enqueueNotify = (job: NotifyJob) => void boss.send(QUEUES.notifyDispatch, job);

  await boss.work(QUEUES.weatherPoll, async () => {
    await runWeatherPoll(db, clock, options.fetchForecast);
  });
  await boss.work(QUEUES.aggregatesRecompute, async () => {
    await runAggregatesRecomputeAll(db, clock);
  });
  await boss.work<BackstopJob>(QUEUES.automationBackstop, async (jobs: Job<BackstopJob>[]) => {
    for (const job of jobs) await runAutomationBackstop(db, job.data);
  });
  await boss.work(QUEUES.retentionPurge, async () => {
    await runRetentionPurge(db, clock);
  });
  await boss.work(QUEUES.scheduleOptimize, async () => {
    await runScheduleOptimizeAll(db, clock);
  });
  await boss.work(QUEUES.pastdueScan, async () => {
    await runPastdueScanAll(db, clock, (n) =>
      enqueueNotify({ userId: n.userId, notification: { title: 'Task overdue', body: `"${n.title}" is past due — tap to reschedule`, data: { taskId: n.taskId } } }),
    );
  });
  await boss.work<LayoutJob>(QUEUES.layoutPrecompute, async (jobs: Job<LayoutJob>[]) => {
    for (const job of jobs) await runLayoutPrecompute(db, job.data, clock);
  });
  await boss.work<NotifyJob>(QUEUES.notifyDispatch, async (jobs: Job<NotifyJob>[]) => {
    for (const job of jobs) await runNotifyDispatch(db, job.data, pushAdapters);
  });

  // §11 cadences. aggregates.recompute runs hourly and recomputes every user
  // (per-user day-reset gating is a refinement; canonical values are
  // idempotent so an extra recompute is harmless). layout.precompute and
  // notify.dispatch are enqueued, not scheduled.
  await boss.schedule(QUEUES.weatherPoll, '*/30 * * * *');
  await boss.schedule(QUEUES.aggregatesRecompute, '0 * * * *');
  await boss.schedule(QUEUES.retentionPurge, '0 3 * * 0');
  await boss.schedule(QUEUES.scheduleOptimize, '0 2 * * *');
  await boss.schedule(QUEUES.pastdueScan, '*/15 * * * *');

  return {
    enqueueBackstop: (job) => void boss.send(QUEUES.automationBackstop, job),
    enqueueLayout: (job) => void boss.send(QUEUES.layoutPrecompute, job),
    stop: async () => {
      await boss.stop({ graceful: false });
      await client.end();
    },
  };
}
