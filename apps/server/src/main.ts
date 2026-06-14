/**
 * Entry point: `pnpm --filter @prisms/server dev` (tsx watch) or `start`.
 * Boots pg-boss (§11 jobs) unless PRISMS_JOBS_ENABLED=false, and wires its
 * automation.backstop enqueue into the command dispatcher (§9.4).
 */
import { serve } from '@hono/node-server';

import { createApp } from './app';
import { loadConfig } from './env';
import { startJobs, type JobsHandle } from './jobs/boss';

const config = loadConfig();

let jobs: JobsHandle | null = null;
if (config.jobsEnabled) {
  jobs = await startJobs(config.databaseUrl);
  console.log(JSON.stringify({ msg: 'pg-boss jobs started' }));
}

const server = createApp({ ...config, enqueueBackstop: jobs?.enqueueBackstop });

const listener = serve({ fetch: server.app.fetch, port: config.port }, (info) => {
  console.log(JSON.stringify({ msg: 'prisms-api listening', port: info.port, baseUrl: config.baseUrl }));
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    listener.close(() => {
      void Promise.all([server.close(), jobs?.stop() ?? Promise.resolve()]).then(() => process.exit(0));
    });
  });
}
