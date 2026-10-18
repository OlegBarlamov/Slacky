import { buildApp } from './app';
import { openDb } from './repositories/db';

const { app } = buildApp(openDb(process.env.DB_FILE ?? 'chat.db'), {
  sessionSecret: process.env.SESSION_SECRET,
  clientOrigins: process.env.CLIENT_ORIGIN?.split(','),
  logger: true,
  // External systems are slow and flaky by default, so retries and isolation get exercised.
  chaos: {
    search: { latencyMs: 400, failureRate: 0.1, offline: false },
    notifications: { latencyMs: 200, failureRate: 0.1, offline: false },
    realtime: { latencyMs: 20, failureRate: 0, offline: false },
  },
});
await app.listen({ port: Number(process.env.PORT ?? 3001) });
