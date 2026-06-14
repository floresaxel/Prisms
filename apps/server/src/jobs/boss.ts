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
import { runRetentionPurge } from './retention-purge';
import { runWeatherPoll, type ForecastFetcher } from './weather-poll';

export const QUEUES = {
  weatherPoll: 'weather.poll',
  aggregatesRecompute: 'aggregates.recompute',
  automationBackstop: 'automation.backstop',
  retentionPurge: 'retention.purge',
} as const;

export interface JobsHandle {
  enqueueBackstop: (job: BackstopJob) => void;
  stop: () => Promise<void>;
}

export interface StartJobsOptions {
  clock?: JobClock;
  fetchForecast?: ForecastFetcher;
}

export async function startJobs(connectionString: string, options: StartJobsOptions = {}): Promise<JobsHandle> {
  const clock = options.clock ?? systemClock;
  const client = postgres(connectionString, { max: 4, onnotice: () => undefined });
  const db = drizzle(client);

  const boss = new PgBoss({ connectionString });
  boss.on('error', (error: unknown) => console.error(JSON.stringify({ msg: 'pg-boss error', error: String(error) })));
  await boss.start();
  for (const queue of Object.values(QUEUES)) await boss.createQueue(queue);

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

  // §11 cadences. aggregates.recompute runs hourly and recomputes every user
  // (per-user day-reset gating is a refinement; canonical values are
  // idempotent so an extra recompute is harmless).
  await boss.schedule(QUEUES.weatherPoll, '*/30 * * * *');
  await boss.schedule(QUEUES.aggregatesRecompute, '0 * * * *');
  await boss.schedule(QUEUES.retentionPurge, '0 3 * * 0');

  return {
    enqueueBackstop: (job) => {
      void boss.send(QUEUES.automationBackstop, job);
    },
    stop: async () => {
      await boss.stop({ graceful: false });
      await client.end();
    },
  };
}
