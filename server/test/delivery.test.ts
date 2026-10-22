import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Id } from '../../shared/types';
import { type AppOptions, buildApp } from '../src/app';
import type { DomainEvents } from '../src/events';
import type { PgBossEventBus } from '../src/events-system';
import { createTestDb, TEST_DATABASE_URL, type TestDb } from './db';

// Durable delivery through pg-boss: events are jobs committed with the change, and they
// survive the process that published them.
let t: TestDb;
let apps: Awaited<ReturnType<typeof buildApp>>[] = [];
let ann: Id, bob: Id, conv: Id;
let n = 0;

/** One "server process". Several can share the database, as across a restart. */
async function start(opts: Partial<AppOptions> & { workers?: boolean } = {}) {
  const built = await buildApp(t.db, {
    jobs: { connectionString: TEST_DATABASE_URL, schema: t.jobsSchema, workers: opts.workers },
    queue: { maxAttempts: 3, baseDelayMs: 0, timeoutMs: 2000, ...opts.queue },
  });
  apps.push(built);
  return { ...built, bus: built.bus as PgBossEventBus<DomainEvents> };
}
async function stop(app: { app: { close(): Promise<unknown> } }) {
  await app.app.close();
  apps = apps.filter((a) => a !== app);
}

const post = (app: Awaited<ReturnType<typeof start>>, text: string) => app.services.messages.post(ann, conv, { clientMsgId: `c${++n}`, text });
const pendingJobs = async () => Number(await t.one(`SELECT count(*) FROM ${t.jobsSchema}.job WHERE name IN ('notifications', 'realtime') AND state IN ('created', 'retry', 'active')`));
const delivery = (messageId: Id) => t.all<{ status: string; attempts: number }>('SELECT status, attempts FROM notification_deliveries WHERE key = $1', `${messageId}:${bob}`);
async function until(check: () => Promise<boolean>, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(async () => {
  t = await createTestDb();
  const setup = await start({ workers: false });
  [ann, bob] = await Promise.all(['ann', 'bob'].map(async (name) => (await setup.services.users.register(name)).id));
  conv = (await setup.services.conversations.createChannel('team', [ann, bob])).id;
  await stop(setup); // its jobs wait for whichever process the test starts with workers
});
afterEach(async () => {
  for (const a of apps) await a.app.close();
  apps = [];
  await t.drop();
});

// Workers poll every second, so each test takes a few seconds.
describe('durable delivery', { timeout: 15_000 }, () => {
  it('delivers through the queue and records the notification in the ledger', async () => {
    const app = await start();
    const m = await post(app, 'hi @bob');
    await app.bus.idle();
    expect(app.notifications.recent(10).map((x) => [x.recipientId, x.reason])).toEqual([[bob, 'mention']]);
    expect(await delivery(m.id)).toEqual([{ status: 'sent', attempts: 1 }]);
  });

  it('enqueues nothing when the transaction rolls back', async () => {
    const app = await start({ workers: false });
    const before = await pendingJobs();
    await expect(
      t.db.transaction(async () => {
        await post(app, 'hi @bob');
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await pendingJobs()).toBe(before);
    expect(await t.one('SELECT count(*) FROM messages')).toBe(0);
  });

  it('keeps jobs while no worker runs, and delivers them once one starts', async () => {
    const api = await start({ workers: false });
    const m = await post(api, 'hi @bob');
    expect(await pendingJobs()).toBeGreaterThan(0);
    await stop(api);

    const worker = await start();
    await worker.bus.idle();
    expect(worker.notifications.recent(10).map((x) => x.messageId)).toEqual([m.id]);
    expect(await delivery(m.id)).toEqual([{ status: 'sent', attempts: 1 }]);
  });

  it('retries across a restart, and sends exactly once', async () => {
    const first = await start({ queue: { maxAttempts: 10, baseDelayMs: 1000, maxDelayMs: 1000 } });
    first.network.set('notifications', { offline: true });
    const m = await post(first, 'hi @bob');
    await until(async () => (await delivery(m.id))[0]?.attempts >= 1); // failed at least once
    await stop(first);

    const second = await start({ queue: { maxAttempts: 10, baseDelayMs: 1000, maxDelayMs: 1000 } });
    await second.bus.idle();
    expect(second.notifications.recent(10).map((x) => x.messageId)).toEqual([m.id]);
    expect(await delivery(m.id)).toEqual([{ status: 'sent', attempts: expect.any(Number) }]);
    expect((await delivery(m.id))[0].attempts).toBeGreaterThanOrEqual(2);
  });

  it('dead-letters after the last attempt; the dead letter survives a restart and can be retried', async () => {
    const first = await start({ queue: { maxAttempts: 2 } });
    first.network.set('notifications', { offline: true });
    const m = await post(first, 'hi @bob');
    await first.bus.idle();
    const [dead] = await first.bus.deadLetters('notifications');
    expect(dead).toMatchObject({ listener: 'notifications', events: [{ type: 'message.created' }], error: 'notifications is unavailable' });
    await stop(first);

    const second = await start();
    expect(await second.bus.deadLetters()).toHaveLength(1);
    expect(await second.bus.retryDeadLetters('notifications')).toBe(1);
    await second.bus.idle();
    expect(second.notifications.recent(10).map((x) => x.messageId)).toEqual([m.id]);
    expect(await second.bus.deadLetters()).toEqual([]);
  });

  it('skips a notification whose message was deleted before it went out', async () => {
    const api = await start({ workers: false });
    const m = await post(api, 'hi @bob');
    await api.services.messages.delete(ann, m.id);
    const worker = await start();
    await worker.bus.idle();
    expect(worker.notifications.recent(10)).toEqual([]);
    expect(await delivery(m.id)).toEqual([{ status: 'skipped', attempts: 0 }]);
  });
});
