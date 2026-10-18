import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Id, StreamEvent } from '../../shared/types';
import { buildApp } from '../src/app';
import { openDb } from '../src/repositories/db';

// Producers (services) -> bus -> per-listener queues -> search / notifications / realtime.
let built: ReturnType<typeof buildApp>;
let ann: Id, bob: Id, cat: Id, conv: Id;
let n = 0;

beforeEach(async () => {
  built = buildApp(openDb(), { queue: { baseDelayMs: 1, maxDelayMs: 2, maxAttempts: 3 } });
  const { users, conversations } = built.services;
  [ann, bob, cat] = ['ann', 'bob', 'cat'].map((name) => users.register(name).id);
  conv = conversations.createChannel('team', [ann, bob, cat]).id;
  await built.bus.idle(); // setup's own events are delivered before each test starts
});
afterEach(() => built.bus.close());

const post = (userId: Id, text: string, threadRootId?: Id) => built.services.messages.post(userId, conv, { clientMsgId: `c${++n}`, text, threadRootId });
const search = (userId: Id, q: string) => built.services.search.search(userId, q, 50);
/** Collects what a user's open stream would receive. */
const listen = (userId: Id) => {
  const got: StreamEvent[] = [];
  built.hub.connect(userId, built.hub.cursor, (_id, e) => got.push(e));
  return got;
};

describe('search listener', () => {
  it('follows creates, edits and deletes', async () => {
    const m = post(ann, 'deploy friday');
    await built.bus.idle();
    expect((await search(bob, 'deploy')).messages.map((x) => x.id)).toEqual([m.id]);

    built.services.messages.edit(ann, m.id, 'release friday');
    await built.bus.idle();
    expect((await search(bob, 'deploy')).total).toBe(0);
    expect((await search(bob, 'release')).total).toBe(1);

    built.services.messages.delete(ann, m.id);
    await built.bus.idle();
    expect((await search(bob, 'release')).total).toBe(0);
  });

  it('survives an outage: writes still succeed, the backlog is replayed later', async () => {
    built.network.set('search', { offline: true });
    post(ann, 'incident report');
    await built.bus.idle();
    const sub = built.bus.subscriptions().find((s) => s.name === 'search')!;
    expect(sub.queue.stats().deadLetters).toBe(1);
    await expect(search(bob, 'incident')).rejects.toThrow('temporarily unavailable');

    built.network.set('search', { offline: false });
    sub.queue.replayDeadLetters();
    await built.bus.idle();
    expect((await search(bob, 'incident')).total).toBe(1);
  });

  it('re-checks hits against the core, so a lagging index never shows deleted messages', async () => {
    const m = post(ann, 'secret plan');
    await built.bus.idle();
    built.network.set('search', { offline: true });
    built.services.messages.delete(ann, m.id); // the index won't hear about this yet
    built.network.set('search', { offline: false }); // the queue is still retrying the delete
    const result = await search(bob, 'secret');
    expect(result.messages).toEqual([]);
    await built.bus.idle();
  });
});

describe('notifications listener', () => {
  it('pings mentions and DMs once, and only new mentions on edit', async () => {
    const m = post(ann, 'hi @bob');
    built.services.messages.edit(ann, m.id, 'hi @bob @cat');
    built.services.messages.edit(ann, m.id, 'hi @bob @cat!');
    const dm = built.services.conversations.openDm(cat, ann);
    built.services.messages.post(cat, dm.id, { clientMsgId: 'dm1', text: 'got a minute?' });
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
    post(ann, 'hello @bob');
    await built.bus.idle();
    expect(got.map((e) => e.type)).toContain('message.created');
    expect(built.notifications.recent(10)).toEqual([]);
  });
});

describe('realtime listener', () => {
  it('pushes the change to members and refreshes affected feed items', async () => {
    const got = listen(bob);
    const m = post(ann, 'review this @bob');
    await built.bus.idle();
    expect(got.map((e) => e.type)).toEqual(['message.created', 'activity.upserted']);
    expect(got[1]).toMatchObject({ item: { id: `mention:${m.id}`, read: false } });

    built.services.messages.edit(ann, m.id, 'review this');
    await built.bus.idle();
    expect(got.slice(2)).toEqual([expect.objectContaining({ type: 'message.edited' }), { type: 'activity.removed', itemId: `mention:${m.id}` }]);
  });

  it('updates the thread item of the root author when someone replies', async () => {
    const root = post(ann, 'question');
    await built.bus.idle();
    const got = listen(ann);
    post(bob, 'answer', root.id);
    await built.bus.idle();
    expect(got.map((e) => e.type)).toEqual(['message.created', 'activity.upserted']);
    expect(got[0]).toMatchObject({ root: { id: root.id, thread: { replyCount: 1 } } });
    expect(got[1]).toMatchObject({ item: { id: `thread:${root.id}`, entries: [{ text: 'answer' }] } });
  });

  it("refreshes a replier's thread item when someone else replies", async () => {
    const root = post(ann, 'question');
    post(cat, 'me too', root.id); // cat takes part
    await built.bus.idle();
    const got = listen(cat);
    post(bob, 'answer', root.id);
    await built.bus.idle();
    expect(got.find((e) => e.type === 'activity.upserted')).toMatchObject({ item: { id: `thread:${root.id}`, read: false, entries: [{ text: 'answer' }] } });
  });

  it("pushes the replier's own thread item, as read", async () => {
    const root = post(ann, 'question');
    await built.bus.idle();
    const got = listen(bob);
    post(bob, 'my answer', root.id);
    await built.bus.idle();
    expect(got.find((e) => e.type === 'activity.upserted')).toMatchObject({ item: { id: `thread:${root.id}`, read: true } });
  });

  it('tells a newly mentioned user about the channel before the message', async () => {
    const dan = built.services.users.register('dan').id;
    await built.bus.idle();
    const got = listen(dan);
    post(ann, 'welcome @dan');
    await built.bus.idle();
    expect(got.map((e) => e.type)).toEqual(['conversation.upserted', 'message.created', 'activity.upserted']);
  });

  it('replays missed events on reconnect, or asks for a resync', async () => {
    const before = built.hub.cursor;
    post(ann, 'one');
    post(ann, 'two');
    await built.bus.idle();
    const replayed: StreamEvent[] = [];
    built.hub.connect(bob, before, (_id, e) => replayed.push(e));
    expect(replayed.map((e) => e.type === 'message.created' && e.message.text)).toEqual(['one', 'two']);

    const stale: StreamEvent[] = [];
    built.hub.connect(bob, built.hub.cursor + 10, (_id, e) => stale.push(e));
    expect(stale).toEqual([{ type: 'resync' }]);
  });
});
