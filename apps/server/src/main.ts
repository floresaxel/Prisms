/**
 * Entry point: `pnpm --filter @prisms/server dev` (tsx watch) or `start`.
 */
import { serve } from '@hono/node-server';

import { createApp } from './app';
import { loadConfig } from './env';

const config = loadConfig();
const server = createApp(config);

const listener = serve({ fetch: server.app.fetch, port: config.port }, (info) => {
  console.log(
    JSON.stringify({ msg: 'prisms-api listening', port: info.port, baseUrl: config.baseUrl }),
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    listener.close(() => {
      void server.close().then(() => process.exit(0));
    });
  });
}
