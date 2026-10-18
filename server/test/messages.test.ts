import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { openDb, type DB } from '../src/repositories/db';
import type { Services } from '../src/services';

// Actions go through the services; assertions read tables directly to check what was stored.
let db: DB;
let svc: Services;
let ann: string, bob: string, cat: string, eve: string, conv: string;

const all = (sql: string, ...args: unknown[]) => db.prepare(sql).all(...args);
const one = (sql: string, ...args: unknown[]) => db.prepare(sql).pluck().get(...args);
let n = 0;
const post = (userId: string, text: string, threadRootId?: string) => svc.messages.post(userId, conv, { clientMsgId: `c${++n}`, text, threadRootId });
const readSeq = (userId: string) => one('SELECT read_seq FROM conversation_members WHERE conversation_id = ? AND user_id = ?', conv, userId);

beforeEach(() => {
  db = openDb();
  ({ services: svc } = buildApp(db));
  [ann, bob, cat, eve] = ['ann', 'bob', 'cat', 'eve'].map((name) => svc.users.register(name).id);
  conv = svc.conversations.createChannel('team', [ann, bob, cat]).id;
});

describe('post', () => {
  it('numbers top-level messages per conversation and replies per thread', () => {
    const root = post(ann, 'question');
    const r1 = post(bob, 'answer', root.id);
    const top = post(cat, 'unrelated');
    const r2 = post(ann, 'thanks', root.id);
    expect([root.seq, top.seq]).toEqual([1, 2]);
    expect([r1.seq, r2.seq]).toEqual([1, 2]);
    expect(svc.conversations.get(conv)).toMatchObject({ name: 'team' });
    expect(one('SELECT last_message_at FROM conversations WHERE id = ?', conv)).toBe(top.createdAt);
  });

  it('updates the thread summary and the root version on reply', () => {
    const root = post(ann, 'question');
    const reply = svc.messages.post(bob, conv, { clientMsgId: 'r', text: 'answer', threadRootId: root.id }, root.createdAt + 7);
    expect(all('SELECT reply_count, last_reply_at, updated_at FROM messages WHERE id = ?', root.id)).toEqual([
      { reply_count: 1, last_reply_at: reply.createdAt, updated_at: root.createdAt + 7 },
    ]);
  });

  it('expands @channel to members, author excluded', () => {
    const m = post(ann, 'hi @bob @ann @channel');
    expect(m.mentions).toEqual([{ kind: 'channel' }, { kind: 'user', userId: bob }]);
    const wide = (userId: string) => one('SELECT channel_wide FROM mentions WHERE message_id = ? AND user_id = ?', m.id, userId);
    expect([wide(bob), wide(cat), wide(ann)]).toEqual([0, 1, undefined]);
  });

  it('adds a mentioned non-member to the channel, with the mentioning message unread', () => {
    post(ann, 'earlier');
    const m = post(ann, 'can you help, @eve?');
    expect(m.mentions).toEqual([{ kind: 'user', userId: eve }]);
    expect(svc.conversations.get(conv).memberIds).toContain(eve);
    expect(svc.conversations.view(eve, conv)).toMatchObject({ lastReadSeq: m.seq - 1, unreadCount: 1, mentionCount: 1 });
    expect(svc.feed.list(eve).map((i) => i.id)).toEqual([`mention:${m.id}`]);
  });

  it('adds a non-member mentioned in a reply to the channel and the thread', () => {
    const root = post(ann, 'question');
    const reply = post(bob, 'cc @eve', root.id);
    expect(svc.conversations.view(eve, conv)).toMatchObject({ unreadCount: 0 }); // channel history isn't dumped on them
    expect(svc.feed.list(eve).map((i) => [i.id, i.read])).toEqual(
      expect.arrayContaining([
        [`mention:${reply.id}`, false],
        [`thread:${root.id}`, false],
      ]),
    );
  });

  it('adds a non-member mentioned by an edit', () => {
    const m = post(ann, 'hello');
    svc.messages.edit(ann, m.id, 'hello @eve');
    expect(svc.conversations.get(conv).memberIds).toContain(eve);
    expect(svc.conversations.view(eve, conv)).toMatchObject({ mentionCount: 1 });
  });

  it("doesn't pull a third person into a DM", () => {
    const dm = svc.conversations.openDm(ann, bob);
    const m = svc.messages.post(ann, dm.id, { clientMsgId: 'dm-x', text: 'ask @cat' });
    expect(m.mentions).toEqual([]);
    expect(svc.conversations.get(dm.id).memberIds.sort()).toEqual([ann, bob].sort());
  });

  it('puts every DM member in a DM thread', () => {
    const dm = svc.conversations.openDm(ann, bob);
    const root = svc.messages.post(ann, dm.id, { clientMsgId: 'dm-r', text: 'note' });
    svc.messages.post(ann, dm.id, { clientMsgId: 'dm-t', text: 'adding to my own note', threadRootId: root.id });
    expect(svc.feed.list(bob).find((i) => i.id === `thread:${root.id}`)).toMatchObject({ read: false, entries: [{ text: 'adding to my own note' }] });
  });

  it('is idempotent on clientMsgId', () => {
    const a = svc.messages.post(ann, conv, { clientMsgId: 'x', text: 'hello' });
    const b = svc.messages.post(ann, conv, { clientMsgId: 'x', text: 'hello' });
    expect(b.id).toBe(a.id);
    expect(one('SELECT count(*) FROM messages')).toBe(1);
  });

  it('rolls everything back when any write fails', () => {
    db.exec('DROP TABLE mentions');
    expect(() => post(ann, 'hello')).toThrow();
    expect(one('SELECT count(*) FROM messages')).toBe(0);
    expect(one('SELECT last_seq FROM conversations')).toBe(0);
  });

  it('marks your own message read for you', () => {
    const root = post(ann, 'question');
    expect(readSeq(ann)).toBe(1);
    expect(readSeq(bob)).toBe(0);
    post(bob, 'answer', root.id);
    expect(one('SELECT read_seq FROM thread_participants WHERE user_id = ? AND root_id = ?', bob, root.id)).toBe(1);
  });

  it('rejects non-members', () => {
    expect(() => post(eve, 'hi')).toThrow('Not a member');
  });
});

describe('special mentions', () => {
  it('ignores @here everywhere', () => {
    const m = post(ann, 'standup @here');
    expect(m.mentions).toEqual([]);
    expect(one('SELECT count(*) FROM mentions')).toBe(0);
  });

  it('reserves the names channel and here', () => {
    expect(() => svc.users.register('channel')).toThrow('reserved');
    expect(() => svc.users.register('@here')).toThrow('reserved');
  });
});

describe('edit', () => {
  it('replaces text and mentions, bumps version', () => {
    const m = post(ann, 'hi @bob');
    const e = svc.messages.edit(ann, m.id, 'hi @cat', m.createdAt + 5);
    expect(e).toMatchObject({ text: 'hi @cat', version: m.version + 5, mentions: [{ kind: 'user', userId: cat }] });
    expect(e.editedAt).not.toBeNull();
    expect(all('SELECT user_id FROM mentions')).toEqual([{ user_id: cat }]);
  });

  it('only lets the author edit', () => {
    const m = post(ann, 'hi');
    expect(() => svc.messages.edit(bob, m.id, 'nope')).toThrow('your own');
  });
});

describe('delete', () => {
  it('wipes content and mentions, keeps a tombstone, refreshes the thread', () => {
    const root = post(ann, 'question');
    const reply = post(bob, 'secret @ann', root.id);
    const d = svc.messages.delete(bob, reply.id);
    expect(d).toMatchObject({ text: '', mentions: [] });
    expect(d.deletedAt).not.toBeNull();
    expect(one('SELECT count(*) FROM mentions')).toBe(0);
    expect(one('SELECT count(*) FROM messages WHERE id = ?', reply.id)).toBe(1);
    expect(one('SELECT reply_count FROM messages WHERE id = ?', root.id)).toBe(0);
    expect(() => svc.messages.edit(bob, reply.id, 'back')).toThrow('deleted');
  });

  it('refuses to delete a root with live replies', () => {
    const root = post(ann, 'question');
    const reply = post(bob, 'answer', root.id);
    expect(() => svc.messages.delete(ann, root.id)).toThrow("can't be deleted");
    svc.messages.delete(bob, reply.id);
    expect(svc.messages.delete(ann, root.id).deletedAt).not.toBeNull();
  });
});

describe('reads', () => {
  it('moves read positions forward only', () => {
    post(ann, 'one');
    post(ann, 'two');
    svc.messages.markRead(bob, conv, 2);
    svc.messages.markRead(bob, conv, 1);
    expect(readSeq(bob)).toBe(2);
  });
});

describe('thread participants', () => {
  const participants = (rootId: string) => all('SELECT user_id AS u, read_seq AS r FROM thread_participants WHERE root_id = ? ORDER BY user_id', rootId) as { u: string; r: number }[];
  const sorted = (rows: { u: string; r: number }[]) => [...rows].sort((a, b) => a.u.localeCompare(b.u));

  it('starts with the root author and users the root mentions directly', () => {
    const root = post(ann, 'plan @bob @channel'); // @channel in a root doesn't pull everyone in
    post(cat, 'thoughts', root.id);
    expect(participants(root.id)).toEqual(sorted([{ u: ann, r: 0 }, { u: bob, r: 0 }, { u: cat, r: 1 }]));
  });

  it('adds repliers and users mentioned in replies, including by edit', () => {
    const root = post(ann, 'question');
    const r1 = post(bob, 'answer', root.id);
    expect(participants(root.id).map((p) => p.u).sort()).toEqual([ann, bob].sort());
    svc.messages.edit(bob, r1.id, 'answer, cc @cat');
    expect(participants(root.id).map((p) => p.u).sort()).toEqual([ann, bob, cat].sort());
  });

  it('reading a thread does not make you a participant', () => {
    const root = post(ann, 'question');
    post(bob, 'answer', root.id);
    svc.messages.markThreadRead(cat, root.id, 1);
    expect(participants(root.id).map((p) => p.u)).not.toContain(cat);
  });

  it('treats @channel in replies as plain text', () => {
    const root = post(ann, 'question');
    const r = post(bob, 'hey @channel', root.id);
    expect(r).toMatchObject({ text: 'hey @channel', mentions: [] });
    const e = svc.messages.edit(bob, r.id, 'hey @channel @cat');
    expect(e.mentions).toEqual([{ kind: 'user', userId: cat }]);
    expect(one('SELECT count(*) FROM mentions WHERE message_id = ?', r.id)).toBe(1);
    expect(participants(root.id).map((p) => p.u).sort()).toEqual([ann, bob, cat].sort());
  });
});

describe('membership', () => {
  it('joins with nothing unread and is idempotent', () => {
    post(ann, 'one');
    post(ann, 'two');
    svc.conversations.join(eve, conv);
    svc.conversations.join(eve, conv);
    expect(readSeq(eve)).toBe(2);
    expect(svc.conversations.get(conv).memberIds).toContain(eve);
  });

  it('leaves idempotently and loses access', () => {
    svc.conversations.leave(cat, conv);
    svc.conversations.leave(cat, conv);
    expect(svc.conversations.get(conv).memberIds).not.toContain(cat);
    expect(() => post(cat, 'hi')).toThrow('Not a member');
  });

  it("doesn't join or leave DMs", () => {
    const dm = svc.conversations.openDm(ann, bob);
    expect(() => svc.conversations.join(cat, dm.id)).toThrow('Channel not found');
    expect(() => svc.conversations.leave(bob, dm.id)).toThrow('Channel not found');
  });
});

describe('mention reads', () => {
  it("marks only the caller's unread mentions and keeps the first read_at", () => {
    const m = post(ann, 'hi @bob @cat');
    svc.messages.markMentionsRead(bob, [m.id], 100);
    svc.messages.markMentionsRead(bob, [m.id], 200);
    const readAt = (userId: string) => one('SELECT read_at FROM mentions WHERE message_id = ? AND user_id = ?', m.id, userId);
    expect([readAt(bob), readAt(cat)]).toEqual([100, null]);
  });
});

describe('DMs', () => {
  it('reuses the same conversation for a pair, whoever opens it', () => {
    const a = svc.conversations.openDm(ann, bob);
    const b = svc.conversations.openDm(bob, ann);
    expect(b.id).toBe(a.id);
    expect(a).toMatchObject({ kind: 'dm', name: null });
    expect(one('SELECT count(*) FROM conversations WHERE id = ?', a.id)).toBe(1);
    expect(a.memberIds.sort()).toEqual([ann, bob].sort());
  });

  it('rejects unknown users without leaving a conversation behind', () => {
    const before = one("SELECT count(*) FROM conversations WHERE kind = 'dm'");
    expect(() => svc.conversations.openDm(ann, 'u_nobody')).toThrow('User not found');
    expect(one("SELECT count(*) FROM conversations WHERE kind = 'dm'")).toBe(before);
  });
});

describe('channels', () => {
  it('relies on UNIQUE(name) for taken names', () => {
    expect(() => svc.conversations.createChannel('team', [bob])).toThrow('already exists');
    expect(one("SELECT count(*) FROM conversations WHERE kind = 'channel'")).toBe(2); // #general and #team
  });
});
