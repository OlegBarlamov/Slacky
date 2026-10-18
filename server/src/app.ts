// Composition root: builds the core, the event bus, the fake external systems and their
// listeners, and the HTTP API, and wires them together.
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import { randomBytes } from 'node:crypto';
import { api } from './api';
import type { DomainEvents } from './events';
import { InMemoryEventBus, type QueueOptions } from './events-system';
import { type ChaosSettings, Network } from './externals/chaos';
import { FakeNotificationSender } from './externals/notification-sender';
import { InMemorySearchIndex } from './externals/search-index';
import { subscribeListeners } from './listeners';
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
  /** Simulated latency / failures per external system: search, notifications, realtime. */
  chaos?: ChaosSettings;
  queue?: QueueOptions;
}

export function buildApp(db: DB, opts: AppOptions = {}) {
  const network = new Network(structuredClone(opts.chaos ?? {}));
  const bus = new InMemoryEventBus<DomainEvents>();
  const hub = new RealtimeHub();
  const searchIndex = new InMemorySearchIndex(network);
  const notifications = new FakeNotificationSender(network);
  const repos = createRepositories(db);
  const services = createServices(repos, {
    events: bus,
    searchIndex,
    searchPending: () => bus.subscriptions().find((s) => s.name === 'search')?.queue.stats().pending ?? 0,
    streamCursor: () => hub.cursor,
  });

  services.conversations.ensureChannel(GENERAL_CHANNEL);
  subscribeListeners(bus, { searchIndex, notifications, hub, feed: services.feed, network }, opts.queue);
  // The search index lives in memory, so it starts empty: rebuild it from the DB.
  const ready = services.search.rebuild();

  const app = Fastify({ logger: opts.logger ?? false });
  app.register(cors, { origin: opts.clientOrigins ?? [/^http:\/\/localhost:\d+$/], credentials: true });
  app.register(cookie, { secret: opts.sessionSecret ?? randomBytes(32).toString('hex') });
  app.register(api, { prefix: '/api', services, hub });
  app.addHook('onReady', () => ready);
  app.addHook('onClose', async () => bus.close());
  return { app, services, bus, hub, notifications, network };
}
