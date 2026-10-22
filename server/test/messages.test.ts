import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import type { Services } from '../src/services';
import { createTestDb, type TestDb } from './db';

// Actions go through the services; assertions read tables directly to check what was stored.
let t: TestDb;
let svc: Services;
let bus: Awaited<ReturnType<typeof buildApp>>['bus'];
let ann: string, bob: string, cat: string, eve: string, conv: string;

const all = <T = Record<string, unknown>>(sql: string, ...args: unknown[]) => t.all<T>(sql, ...args);
const one = (sql: string, ...args: unknown[]) => t.one(sql, ...args);
let n = 0;
const post = (userId: string, text: string, threadRootId?: string) => svc.messages.post(userId, conv, { clientMsgId: `c${++n}`, text, threadRootId });
const readSeq = (userId: string) => one('SELECT read_seq FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', conv, userId);

beforeEach(async () => {
  t = await createTestDb();
  ({ services: svc, bus } = await buildApp(t.db));
  [ann, bob, cat, eve] = await Promise.all(['ann', 'bob', 'cat', 'eve'].map(async (name) => (await svc.users.register(name)).id));
  conv = (await svc.conversations.createChannel('team', [ann, bob, cat])).id;
});
afterEach(async () => {
  await bus.idle(); // listeners read the DB, so let them finish before the schema goes
  bus.close();
  await t.drop();
});

describe('post', () => {
  it('numbers top-level messages per conversation and replies per thread', async () => {
    const root = await post(ann, 'question');
    const r1 = await post(bob, 'answer', root.id);
    const top = await post(cat, 'unrelated');
    const r2 = await post(ann, 'thanks', root.id);
    expect([root.seq, top.seq]).toEqual([1, 2]);
    expect([r1.seq, r2.seq]).toEqual([1, 2]);
    expect(await svc.conversations.get(conv)).toMatchObject({ name: 'team' });
    expect(await one('SELECT last_message_at FROM conversations WHERE id = $1', conv)).toEqual(new Date(top.createdAt));
  });

  it('updates the thread summary and the root version on reply', async () => {
    const root = await post(ann, 'question');
    const reply = await svc.messages.post(bob, conv, { clientMsgId: 'r', text: 'answer', threadRootId: root.id }, root.createdAt + 7);
    expect(await all('SELECT reply_count, last_reply_at, updated_at FROM messages WHERE id = $1', root.id)).toEqual([
      { reply_count: 1, last_reply_at: new Date(reply.createdAt), updated_at: new Date(root.createdAt + 7) },
    ]);
  });

  it('expands @channel to members, author excluded', async () => {
    const m = await post(ann, 'hi @bob @ann @channel');
    expect(m.mentions).toEqual([{ kind: 'channel' }, { kind: 'user', userId: bob }]);
    const wide = (userId: string) => one('SELECT channel_wide FROM mentions WHERE message_id = $1 AND user_id = $2', m.id, userId);
    expect([await wide(bob), await wide(cat), await wide(ann)]).toEqual([false, true, undefined]);
  });

  it('adds a mentioned non-member to the channel, with the mentioning message unread', async () => {
    await post(ann, 'earlier');
    const m = await post(ann, 'can you help, @eve?');
    expect(m.mentions).toEqual([{ kind: 'user', userId: eve }]);
    expect((await svc.conversations.get(conv)).memberIds).toContain(eve);
    expect(await svc.conversations.view(eve, conv)).toMatchObject({ lastReadSeq: m.seq - 1, unreadCount: 1, mentionCount: 1 });
    expect((await svc.feed.list(eve)).map((i) => i.id)).toEqual([`mention:${m.id}`]);
  });

  it('adds a non-member mentioned in a reply to the channel and the thread', async () => {
    const root = await post(ann, 'question');
    const reply = await post(bob, 'cc @eve', root.id);
    expect(await svc.conversations.view(eve, conv)).toMatchObject({ unreadCount: 0 }); // channel history isn't dumped on them
    expect((await svc.feed.list(eve)).map((i) => [i.id, i.read])).toEqual(
      expect.arrayContaining([
        [`mention:${reply.id}`, false],
        [`thread:${root.id}`, false],
      ]),
    );
  });

  it('adds a non-member mentioned by an edit', async () => {
    const m = await post(ann, 'hello');
    await svc.messages.edit(ann, m.id, 'hello @eve');
    expect((await svc.conversations.get(conv)).memberIds).toContain(eve);
    expect(await svc.conversations.view(eve, conv)).toMatchObject({ mentionCount: 1 });
  });

  it("doesn't pull a third person into a DM", async () => {
    const dm = await svc.conversations.openDm(ann, bob);
    const m = await svc.messages.post(ann, dm.id, { clientMsgId: 'dm-x', text: 'ask @cat' });
    expect(m.mentions).toEqual([]);
    expect((await svc.conversations.get(dm.id)).memberIds.sort()).toEqual([ann, bob].sort());
  });

  it('puts every DM member in a DM thread', async () => {
    const dm = await svc.conversations.openDm(ann, bob);
    const root = await svc.messages.post(ann, dm.id, { clientMsgId: 'dm-r', text: 'note' });
    await svc.messages.post(ann, dm.id, { clientMsgId: 'dm-t', text: 'adding to my own note', threadRootId: root.id });
    expect((await svc.feed.list(bob)).find((i) => i.id === `thread:${root.id}`)).toMatchObject({ read: false, entries: [{ text: 'adding to my own note' }] });
  });

  it('is idempotent on clientMsgId', async () => {
    const a = await svc.messages.post(ann, conv, { clientMsgId: 'x', text: 'hello' });
    const b = await svc.messages.post(ann, conv, { clientMsgId: 'x', text: 'hello' });
    expect(b.id).toBe(a.id);
    expect(await one('SELECT count(*) FROM messages')).toBe(1);
  });

  it('rolls everything back when any write fails', async () => {
    await t.exec('DROP TABLE mentions');
    await expect(post(ann, 'hello')).rejects.toThrow();
    expect(await one('SELECT count(*) FROM messages')).toBe(0);
    expect(await one('SELECT last_seq FROM conversations')).toBe(0);
  });

  it('marks your own message read for you', async () => {
    const root = await post(ann, 'question');
    expect(await readSeq(ann)).toBe(1);
    expect(await readSeq(bob)).toBe(0);
    await post(bob, 'answer', root.id);
    expect(await one('SELECT read_seq FROM thread_participants WHERE user_id = $1 AND root_id = $2', bob, root.id)).toBe(1);
  });

  it('rejects non-members', async () => {
    await expect(post(eve, 'hi')).rejects.toThrow('Not a member');
  });
});

describe('special mentions', () => {
  it('ignores @here everywhere', async () => {
    const m = await post(ann, 'standup @here');
    expect(m.mentions).toEqual([]);
    expect(await one('SELECT count(*) FROM mentions')).toBe(0);
  });

  it('reserves the names channel and here', async () => {
    await expect(svc.users.register('channel')).rejects.toThrow('reserved');
    await expect(svc.users.register('@here')).rejects.toThrow('reserved');
  });
});

describe('edit', () => {
  it('replaces text and mentions, bumps version', async () => {
    const m = await post(ann, 'hi @bob');
    const e = await svc.messages.edit(ann, m.id, 'hi @cat', m.createdAt + 5);
    expect(e).toMatchObject({ text: 'hi @cat', version: m.version + 1, mentions: [{ kind: 'user', userId: cat }] });
    expect(e.editedAt).not.toBeNull();
    expect(await all('SELECT user_id FROM mentions')).toEqual([{ user_id: cat }]);
  });

  it('only lets the author edit', async () => {
    const m = await post(ann, 'hi');
    await expect(svc.messages.edit(bob, m.id, 'nope')).rejects.toThrow('your own');
  });
});

describe('delete', () => {
  it('wipes content and mentions, keeps a tombstone, refreshes the thread', async () => {
    const root = await post(ann, 'question');
    const reply = await post(bob, 'secret @ann', root.id);
    const d = await svc.messages.delete(bob, reply.id);
    expect(d).toMatchObject({ text: '', mentions: [] });
    expect(d.deletedAt).not.toBeNull();
    expect(await one('SELECT count(*) FROM mentions')).toBe(0);
    expect(await one('SELECT count(*) FROM messages WHERE id = $1', reply.id)).toBe(1);
    expect(await one('SELECT reply_count FROM messages WHERE id = $1', root.id)).toBe(0);
    await expect(svc.messages.edit(bob, reply.id, 'back')).rejects.toThrow('deleted');
  });

  it('refuses to delete a root with live replies', async () => {
    const root = await post(ann, 'question');
    const reply = await post(bob, 'answer', root.id);
    await expect(svc.messages.delete(ann, root.id)).rejects.toThrow("can't be deleted");
    await svc.messages.delete(bob, reply.id);
    expect((await svc.messages.delete(ann, root.id)).deletedAt).not.toBeNull();
  });
});

describe('reads', () => {
  it('moves read positions forward only', async () => {
    await post(ann, 'one');
    await post(ann, 'two');
    await svc.messages.markRead(bob, conv, 2);
    await svc.messages.markRead(bob, conv, 1);
    expect(await readSeq(bob)).toBe(2);
  });
});

describe('thread participants', () => {
  const participants = (rootId: string) => all<{ u: string; r: number }>('SELECT user_id AS u, read_seq AS r FROM thread_participants WHERE root_id = $1 ORDER BY user_id', rootId);
  const sorted = (rows: { u: string; r: number }[]) => [...rows].sort((a, b) => a.u.localeCompare(b.u));

  it('starts with the root author and users the root mentions directly', async () => {
    const root = await post(ann, 'plan @bob @channel'); // @channel in a root doesn't pull everyone in
    await post(cat, 'thoughts', root.id);
    expect(await participants(root.id)).toEqual(sorted([{ u: ann, r: 0 }, { u: bob, r: 0 }, { u: cat, r: 1 }]));
  });

  it('adds repliers and users mentioned in replies, including by edit', async () => {
    const root = await post(ann, 'question');
    const r1 = await post(bob, 'answer', root.id);
    expect((await participants(root.id)).map((p) => p.u).sort()).toEqual([ann, bob].sort());
    await svc.messages.edit(bob, r1.id, 'answer, cc @cat');
    expect((await participants(root.id)).map((p) => p.u).sort()).toEqual([ann, bob, cat].sort());
  });

  it('reading a thread does not make you a participant', async () => {
    const root = await post(ann, 'question');
    await post(bob, 'answer', root.id);
    await svc.messages.markThreadRead(cat, root.id, 1);
    expect((await participants(root.id)).map((p) => p.u)).not.toContain(cat);
  });

  it('treats @channel in replies as plain text', async () => {
    const root = await post(ann, 'question');
    const r = await post(bob, 'hey @channel', root.id);
    expect(r).toMatchObject({ text: 'hey @channel', mentions: [] });
    const e = await svc.messages.edit(bob, r.id, 'hey @channel @cat');
    expect(e.mentions).toEqual([{ kind: 'user', userId: cat }]);
    expect(await one('SELECT count(*) FROM mentions WHERE message_id = $1', r.id)).toBe(1);
    expect((await participants(root.id)).map((p) => p.u).sort()).toEqual([ann, bob, cat].sort());
  });
});

describe('membership', () => {
  it('joins with nothing unread and is idempotent', async () => {
    await post(ann, 'one');
    await post(ann, 'two');
    await svc.conversations.join(eve, conv);
    await svc.conversations.join(eve, conv);
    expect(await readSeq(eve)).toBe(2);
    expect((await svc.conversations.get(conv)).memberIds).toContain(eve);
  });

  it('leaves idempotently and loses access', async () => {
    await svc.conversations.leave(cat, conv);
    await svc.conversations.leave(cat, conv);
    expect((await svc.conversations.get(conv)).memberIds).not.toContain(cat);
    await expect(post(cat, 'hi')).rejects.toThrow('Not a member');
  });

  it("doesn't join or leave DMs", async () => {
    const dm = await svc.conversations.openDm(ann, bob);
    await expect(svc.conversations.join(cat, dm.id)).rejects.toThrow('Channel not found');
    await expect(svc.conversations.leave(bob, dm.id)).rejects.toThrow('Channel not found');
  });
});

describe('mention reads', () => {
  it("marks only the caller's unread mentions and keeps the first read_at", async () => {
    const m = await post(ann, 'hi @bob @cat');
    await svc.messages.markMentionsRead(bob, [m.id], 100);
    await svc.messages.markMentionsRead(bob, [m.id], 200);
    const readAt = (userId: string) => one('SELECT read_at FROM mentions WHERE message_id = $1 AND user_id = $2', m.id, userId);
    expect([await readAt(bob), await readAt(cat)]).toEqual([new Date(100), null]);
  });
});

describe('DMs', () => {
  it('reuses the same conversation for a pair, whoever opens it', async () => {
    const a = await svc.conversations.openDm(ann, bob);
    const b = await svc.conversations.openDm(bob, ann);
    expect(b.id).toBe(a.id);
    expect(a).toMatchObject({ kind: 'dm', name: null });
    expect(await one('SELECT count(*) FROM conversations WHERE id = $1', a.id)).toBe(1);
    expect(a.memberIds.sort()).toEqual([ann, bob].sort());
  });

  it('rejects unknown users without leaving a conversation behind', async () => {
    const before = await one("SELECT count(*) FROM conversations WHERE kind = 'dm'");
    await expect(svc.conversations.openDm(ann, 'u_nobody')).rejects.toThrow('User not found');
    expect(await one("SELECT count(*) FROM conversations WHERE kind = 'dm'")).toBe(before);
  });
});

describe('channels', () => {
  it('relies on UNIQUE(name) for taken names', async () => {
    await expect(svc.conversations.createChannel('team', [bob])).rejects.toThrow('already exists');
    expect(await one("SELECT count(*) FROM conversations WHERE kind = 'channel'")).toBe(2); // #general and #team
  });
});

// Postgres doesn't serialise every write like SQLite's IMMEDIATE lock did; these run in parallel
// on separate connections.
describe('concurrency', () => {
  it('gives parallel posts distinct, gap-free seqs', async () => {
    const posted = await Promise.all(Array.from({ length: 10 }, (_, i) => post([ann, bob, cat][i % 3], `m${i}`)));
    expect(posted.map((m) => m.seq).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(await one('SELECT last_seq FROM conversations WHERE id = $1', conv)).toBe(10);
  });

  it('returns one message for a POST that races its own retry', async () => {
    const [a, b] = await Promise.all([1, 2].map(() => svc.messages.post(ann, conv, { clientMsgId: 'same', text: 'hello' })));
    expect(b.id).toBe(a.id);
    expect(await one('SELECT count(*) FROM messages')).toBe(1);
  });

  it('creates one DM when both sides open it at once', async () => {
    const [a, b] = await Promise.all([svc.conversations.openDm(ann, bob), svc.conversations.openDm(bob, ann)]);
    expect(b.id).toBe(a.id);
    expect(a.memberIds.sort()).toEqual([ann, bob].sort());
  });

  it('never leaves a reply under a deleted root', async () => {
    for (let i = 0; i < 5; i++) {
      const root = await post(ann, `question ${i}`);
      const [reply, del] = await Promise.allSettled([post(bob, 'answer', root.id), svc.messages.delete(ann, root.id)]);
      // Exactly one wins: the reply (and the delete is refused), or the delete (and the reply is refused).
      expect([reply.status, del.status].sort()).toEqual(['fulfilled', 'rejected']);
      const stored = await all<{ deleted: boolean; replies: number }>(
        'SELECT deleted_at IS NOT NULL AS deleted, (SELECT count(*) FROM messages r WHERE r.thread_root_id = m.id) AS replies FROM messages m WHERE id = $1',
        root.id,
      );
      expect(stored).toEqual([reply.status === 'fulfilled' ? { deleted: false, replies: 1 } : { deleted: true, replies: 0 }]);
    }
  });

  it('counts every reply when replies land in parallel', async () => {
    const root = await post(ann, 'question');
    await Promise.all([bob, cat, ann, bob, cat].map((u, i) => post(u, `r${i}`, root.id)));
    expect(await all('SELECT reply_count, last_reply_seq FROM messages WHERE id = $1', root.id)).toEqual([{ reply_count: 5, last_reply_seq: 5 }]);
  });
});
