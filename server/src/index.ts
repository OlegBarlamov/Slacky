import { buildApp } from './app';
import { LOCAL_DATABASE_URL, openDb } from './repositories/db';

// Migrations are a separate release step (`npm run migrate`), run before this starts.
const db = openDb();
const { app } = await buildApp(db, {
  // Events are durable jobs; the listeners' workers run in this process for now.
  jobs: { connectionString: process.env.DATABASE_URL ?? LOCAL_DATABASE_URL },
  sessionSecret: process.env.SESSION_SECRET,
  clientOrigins: process.env.CLIENT_ORIGIN?.split(','),
  logger: true,
  // External systems are slow and flaky by default, so retries and isolation get exercised.
  chaos: {
    notifications: { latencyMs: 200, failureRate: 0.1, offline: false },
    realtime: { latencyMs: 20, failureRate: 0, offline: false },
  },
});
app.addHook('onClose', () => db.close());
await app.listen({ port: Number(process.env.PORT ?? 3001) });
