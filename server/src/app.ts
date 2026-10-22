// Composition root: builds the core, the event bus, the fake external systems and their
// listeners, and the HTTP API, and wires them together.
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import { randomBytes } from 'node:crypto';
import { api } from './api';
import type { DomainEvents } from './events';
import { fromKysely, PgBoss } from 'pg-boss';
import { InMemoryEventBus, inMemorySink, PgBossEventBus, type QueueOptions, TransactionalPublisher } from './events-system';
import { type ChaosSettings, Network } from './externals/chaos';
import { FakeNotificationSender } from './externals/notification-sender';
import { LISTENER_CONFIG, ROUTES, subscribeListeners } from './listeners';
import { RealtimeHub } from './realtime/hub';
import { createRepositories } from './repositories';
import type { DB } from './repositories/db';
import { createServices } from './services';
import { GENERAL_CHANNEL } from './services/conversation.service';

export interface AppOptions {
  /** Signs session cookies. Without it a random one is used, so sessions end on restart. */
  sessionSecret?: string;
  /** Origins allowed to call the API with cookies (the Vite dev server by default). */
  clientOrigins?: (string | RegExp)[];
  logger?: boolean;
  /** Simulated latency / failures per external system: notifications, realtime. */
  chaos?: ChaosSettings;
  /** Overrides every listener's retry and timeout settings (tests use short ones). */
  queue?: QueueOptions;
  /**
   * Durable delivery: events become pg-boss jobs in the same transaction as the change, and
   * survive restarts. Without it they go through an in-memory bus, which is fine for tests but
   * loses whatever is queued when the process stops.
   */
  jobs?: JobsOptions;
}

export interface JobsOptions {
  connectionString: string;
  /** Postgres schema for pg-boss's tables. Default `pgboss`. */
  schema?: string;
  /** Run the listeners' workers in this process. Default true; false for an API-only process. */
  workers?: boolean;
}

/** In-memory or pg-boss delivery, behind the same transactional publisher. */
async function createEvents(db: DB, opts: AppOptions) {
  if (!opts.jobs) {
    const bus = new InMemoryEventBus<DomainEvents>();
    return { bus, publisher: new TransactionalPublisher<DomainEvents>(db, inMemorySink(bus)), start: async () => {} };
  }
  const boss = new PgBoss({ connectionString: opts.jobs.connectionString, schema: opts.jobs.schema, useListenNotify: true });
  boss.on('error', (err) => console.error('pg-boss:', err));
  await boss.start();
  const bus = new PgBossEventBus<DomainEvents>(boss, ROUTES, LISTENER_CONFIG, opts.queue);
  // Jobs are sent on the transaction that publishes, so they commit with the change.
  const publisher = new TransactionalPublisher<DomainEvents>(db, bus.sink(() => fromKysely(db.transactionInProgress!)));
  return { bus, publisher, start: () => bus.start() };
}

/** `db` must be migrated (see repositories/migrate.ts). Closing the app doesn't close `db`. */
export async function buildApp(db: DB, opts: AppOptions = {}) {
  const network = new Network(structuredClone(opts.chaos ?? {}));
  const { bus, publisher, start } = await createEvents(db, opts);
  const hub = new RealtimeHub();
  const notifications = new FakeNotificationSender(network);
  const repos = createRepositories(db);
  const services = createServices(repos, {
    events: publisher,
    streamCursor: () => hub.cursor,
  });

  await services.conversations.ensureChannel(GENERAL_CHANNEL);
  if (!opts.jobs || opts.jobs.workers !== false) {
    const currentMessage = (id: string) => repos.messages.get(id);
    subscribeListeners(bus, { notifications: { sender: notifications, ledger: repos.notifications, currentMessage }, hub, feed: services.feed, network }, opts.queue);
  }
  await start();

  const app = Fastify({ logger: opts.logger ?? false });
  app.register(cors, { origin: opts.clientOrigins ?? [/^http:\/\/localhost:\d+$/], credentials: true });
  app.register(cookie, { secret: opts.sessionSecret ?? randomBytes(32).toString('hex') });
  app.register(api, { prefix: '/api', services, hub });
  app.addHook('onClose', async () => bus.close());
  return { app, services, bus, hub, notifications, network };
}
