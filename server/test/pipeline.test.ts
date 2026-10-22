import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Id, StreamEvent } from '../../shared/types';
import { buildApp } from '../src/app';
import { createTestDb, type TestDb } from './db';

// Producers (services) -> bus -> per-listener queues -> notifications / realtime.
let t: TestDb;
let built: Awaited<ReturnType<typeof buildApp>>;
let ann: Id, bob: Id, cat: Id, conv: Id;
let n = 0;

beforeEach(async () => {
  t = await createTestDb();
  built = await buildApp(t.db, { queue: { baseDelayMs: 1, maxDelayMs: 2, maxAttempts: 3 } });
  const { users, conversations } = built.services;
  [ann, bob, cat] = await Promise.all(['ann', 'bob', 'cat'].map(async (name) => (await users.register(name)).id));
  conv = (await conversations.createChannel('team', [ann, bob, cat])).id;
  await built.bus.idle(); // setup's own events are delivered before each test starts
});
afterEach(async () => {
  await built.bus.idle(); // listeners read the DB, so let them finish before the schema goes
  built.bus.close();
  await t.drop();
});

const post = (userId: Id, text: string, threadRootId?: Id) => built.services.messages.post(userId, conv, { clientMsgId: `c${++n}`, text, threadRootId });
/** Collects what a user's open stream would receive. */
const listen = (userId: Id) => {
  const got: StreamEvent[] = [];
  built.hub.connect(userId, built.hub.cursor, (_id, e) => got.push(e));
  return got;
};

describe('notifications listener', () => {
  it('pings mentions and DMs once, and only new mentions on edit', async () => {
    const m = await post(ann, 'hi @bob');
    await built.services.messages.edit(ann, m.id, 'hi @bob @cat');
    await built.services.messages.edit(ann, m.id, 'hi @bob @cat!');
    const dm = await built.services.conversations.openDm(cat, ann);
    await built.services.messages.post(cat, dm.id, { clientMsgId: 'dm1', text: 'got a minute?' });
    await built.bus.idle();
    expect(built.notifications.recent(10).map((x) => [x.recipientId, x.reason]).reverse()).toEqual([
      [bob, 'mention'],
      [cat, 'mention'],
      [ann, 'dm'],
    ]);
  });

  it('is isolated: a down sender holds up nobody else', async () => {
    built.network.set('notifications', { offline: true });
    const got = listen(bob);
    await post(ann, 'hello @bob');
    await built.bus.idle();
    expect(got.map((e) => e.type)).toContain('message.created');
    expect(built.notifications.recent(10)).toEqual([]);
  });
});

describe('realtime listener', () => {
  it('pushes the change to members and refreshes affected feed items', async () => {
    const got = listen(bob);
    const m = await post(ann, 'review this @bob');
    await built.bus.idle();
    expect(got.map((e) => e.type)).toEqual(['message.created', 'activity.upserted']);
    expect(got[1]).toMatchObject({ item: { id: `mention:${m.id}`, read: false } });

    await built.services.messages.edit(ann, m.id, 'review this');
    await built.bus.idle();
    expect(got.slice(2)).toEqual([expect.objectContaining({ type: 'message.edited' }), { type: 'activity.removed', itemId: `mention:${m.id}` }]);
  });

  it('updates the thread item of the root author when someone replies', async () => {
    const root = await post(ann, 'question');
    await built.bus.idle();
    const got = listen(ann);
    await post(bob, 'answer', root.id);
    await built.bus.idle();
    expect(got.map((e) => e.type)).toEqual(['message.created', 'activity.upserted']);
    expect(got[0]).toMatchObject({ root: { id: root.id, thread: { replyCount: 1 } } });
    expect(got[1]).toMatchObject({ item: { id: `thread:${root.id}`, entries: [{ text: 'answer' }] } });
  });

  it("refreshes a replier's thread item when someone else replies", async () => {
    const root = await post(ann, 'question');
    await post(cat, 'me too', root.id); // cat takes part
    await built.bus.idle();
    const got = listen(cat);
    await post(bob, 'answer', root.id);
    await built.bus.idle();
    expect(got.find((e) => e.type === 'activity.upserted')).toMatchObject({ item: { id: `thread:${root.id}`, read: false, entries: [{ text: 'answer' }] } });
  });

  it("pushes the replier's own thread item, as read", async () => {
    const root = await post(ann, 'question');
    await built.bus.idle();
    const got = listen(bob);
    await post(bob, 'my answer', root.id);
    await built.bus.idle();
    expect(got.find((e) => e.type === 'activity.upserted')).toMatchObject({ item: { id: `thread:${root.id}`, read: true } });
  });

  it('tells a newly mentioned user about the channel before the message', async () => {
    const dan = (await built.services.users.register('dan')).id;
    await built.bus.idle();
    const got = listen(dan);
    await post(ann, 'welcome @dan');
    await built.bus.idle();
    expect(got.map((e) => e.type)).toEqual(['conversation.upserted', 'message.created', 'activity.upserted']);
  });

  it('replays missed events on reconnect, or asks for a resync', async () => {
    const before = built.hub.cursor;
    await post(ann, 'one');
    await post(ann, 'two');
    await built.bus.idle();
    const replayed: StreamEvent[] = [];
    built.hub.connect(bob, before, (_id, e) => replayed.push(e));
    expect(replayed.map((e) => e.type === 'message.created' && e.message.text)).toEqual(['one', 'two']);

    const stale: StreamEvent[] = [];
    built.hub.connect(bob, built.hub.cursor + 10, (_id, e) => stale.push(e));
    expect(stale).toEqual([{ type: 'resync' }]);
  });
});
