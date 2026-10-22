import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import type { Services } from '../src/services';
import { createTestDb, type TestDb } from './db';

// Thread participation, the Threads view and its badge, plus user lookup.
let t: TestDb;
let svc: Services;
let bus: Awaited<ReturnType<typeof buildApp>>['bus'];
let ann: string, bob: string, cat: string, eve: string, conv: string;

let n = 0;
let clock = Date.now();
const post = (userId: string, text: string, threadRootId?: string, convId = conv) =>
  svc.messages.post(userId, convId, { clientMsgId: `c${++n}`, text, threadRootId }, ++clock); // distinct times keep the order exact
const participants = (rootId: string) => t.all<{ user_id: string; read_seq: number }>('SELECT user_id, read_seq FROM thread_participants WHERE root_id = $1 ORDER BY user_id', rootId);
const followed = async (userId: string, params = {}) => (await svc.threads.list(userId, params)).threads.map((x) => x.root.id);

beforeEach(async () => {
  t = await createTestDb();
  ({ services: svc, bus } = await buildApp(t.db));
  [ann, bob, cat, eve] = await Promise.all(['ann', 'bob', 'cat', 'eve'].map(async (name) => (await svc.users.register(name)).id));
  conv = (await svc.conversations.createChannel('team', [ann, bob, cat])).id;
});
afterEach(async () => {
  await bus.idle();
  bus.close();
  await t.drop();
});

describe('participation', () => {
  it('adds users @mentioned by a root edit once the thread exists', async () => {
    const root = await post(ann, 'question');
    await post(bob, 'answer', root.id);
    await svc.messages.edit(ann, root.id, 'question for @cat');
    expect(await participants(root.id)).toContainEqual({ user_id: cat, read_seq: 0 });
    expect(await followed(cat)).toEqual([root.id]);
  });

  it('leaves a root edit before any reply to the first reply', async () => {
    const root = await post(ann, 'question');
    await svc.messages.edit(ann, root.id, 'question for @cat');
    expect(await participants(root.id)).toEqual([]);
    await post(bob, 'answer', root.id);
    expect((await participants(root.id)).map((p) => p.user_id)).toEqual([ann, bob, cat].sort());
  });

  it('does not subscribe the channel on a root edit to @channel', async () => {
    const root = await post(ann, 'question');
    await post(bob, 'answer', root.id);
    await svc.messages.edit(ann, root.id, 'question @channel');
    expect((await participants(root.id)).map((p) => p.user_id)).toEqual([ann, bob].sort());
  });

  it('keeps following after the mention is edited away', async () => {
    const root = await post(ann, 'question');
    const reply = await post(bob, 'cc @cat', root.id);
    await svc.messages.edit(bob, reply.id, 'never mind');
    expect(await followed(cat)).toEqual([root.id]);
  });
});

describe('threads view', () => {
  it('lists followed threads by latest reply, with unread counts and the latest replies', async () => {
    const a = await post(ann, 'thread a');
    const b = await post(ann, 'thread b');
    await post(bob, 'b1', b.id);
    for (const text of ['a1', 'a2', 'a3', 'a4']) await post(bob, text, a.id);
    await post(ann, 'a5 (mine)', a.id);
    await post(cat, 'not followed by ann', (await post(cat, 'thread c')).id);

    const { threads, nextCursor } = await svc.threads.list(ann);
    expect(threads.map((x) => [x.root.id, x.unreadCount])).toEqual([
      [a.id, 0], // replying reads the thread up to your reply
      [b.id, 1],
    ]);
    expect(threads[0].latestReplies.map((r) => r.text)).toEqual(['a3', 'a4', 'a5 (mine)']);
    expect(threads[0].lastReadSeq).toBe(5);
    expect(nextCursor).toBeNull();

    expect(await followed(ann, { unread: '1' })).toEqual([b.id]);
  });

  it('pages with a cursor', async () => {
    const roots = [];
    for (let i = 0; i < 5; i++) {
      const root = await post(ann, `thread ${i}`);
      await post(bob, 'reply', root.id);
      roots.push(root.id);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await svc.threads.list(ann, { limit: '2', cursor });
      seen.push(...page.threads.map((x) => x.root.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(roots.reverse());
    await expect(svc.threads.list(ann, { cursor: 'nope' })).rejects.toThrow(/cursor/);
  });

  it('hides threads in channels I left, and skips deleted replies in the counts', async () => {
    const root = await post(ann, 'question');
    const reply = await post(bob, 'answer', root.id);
    await post(bob, 'more', root.id);
    await svc.messages.delete(bob, reply.id);
    expect((await svc.threads.list(ann)).threads[0].unreadCount).toBe(1);
    await svc.conversations.leave(ann, conv);
    expect(await followed(ann)).toEqual([]);
  });
});

describe('thread badge and read state', () => {
  it('bootstraps unread followed threads and clears them on read', async () => {
    const root = await post(ann, 'question');
    await post(bob, 'one', root.id);
    const two = await post(bob, 'two', root.id);
    expect((await svc.conversations.bootstrap(ann)).unreadThreadIds).toEqual([root.id]);

    expect(await svc.messages.markThreadRead(ann, root.id, 1)).toEqual({ lastReadSeq: 1, unreadCount: 1 });
    expect(await svc.messages.markThreadRead(ann, root.id, two.seq)).toEqual({ lastReadSeq: 2, unreadCount: 0 });
    expect((await svc.conversations.bootstrap(ann)).unreadThreadIds).toEqual([]);
    expect(await svc.messages.markThreadRead(cat, root.id, 2)).toEqual({ lastReadSeq: null, unreadCount: 0 });
  });

  it('returns the conversation read state after a partial read', async () => {
    await post(ann, 'one');
    await post(ann, 'two @bob');
    await post(ann, 'three');
    expect(await svc.messages.markRead(bob, conv, 1)).toEqual({ lastReadSeq: 1, unreadCount: 2, mentionCount: 1 });
    expect(await svc.messages.markRead(bob, conv, 0)).toEqual({ lastReadSeq: 1, unreadCount: 2, mentionCount: 1 }); // forward only
  });
});

describe('users', () => {
  it('bootstraps only people I share a conversation with', async () => {
    const general = (await svc.conversations.bootstrap(eve)).conversations.find((v) => v.conversation.name === 'general')!.conversation.id;
    await svc.conversations.leave(eve, general);
    const names = (await svc.conversations.bootstrap(ann)).users.map((u) => u.name);
    expect(names).toEqual(['ann', 'bob', 'cat']);
  });

  it('searches by name prefix, conversation members first', async () => {
    await svc.users.register('bea');
    await svc.users.register('cara');
    expect((await svc.users.search(ann, 'B', undefined, undefined)).map((u) => u.name)).toEqual(['bea', 'bob']);
    expect((await svc.users.search(ann, 'c', conv, undefined)).map((u) => u.name)).toEqual(['cat', 'cara']);
    expect((await svc.users.search(ann, '', undefined, '2')).map((u) => u.name)).toEqual(['ann', 'bea']);
    expect(await svc.users.search(ann, '_', undefined, undefined)).toEqual([]); // LIKE wildcards are literal
  });
});
