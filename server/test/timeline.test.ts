import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MessagePage } from '../../shared/types';
import { buildApp } from '../src/app';
import type { Services } from '../src/services';
import { createTestDb, type TestDb } from './db';

// Cursor pages over a timeline: before / after / around / first_unread.
let t: TestDb;
let svc: Services;
let bus: Awaited<ReturnType<typeof buildApp>>['bus'];
let ann: string, bob: string, conv: string;

let n = 0;
const post = (userId: string, text: string, threadRootId?: string) => svc.messages.post(userId, conv, { clientMsgId: `c${++n}`, text, threadRootId });
const seqs = (p: { messages: { seq: number }[] }) => p.messages.map((m) => m.seq);
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const edges = (p: MessagePage) => [p.hasBefore, p.hasAfter];

/** `count` top-level messages by `authorId`, straight into the tables (posting 10,000 one by one is slow). */
async function bulk(authorId: string, count: number) {
  await t.all(
    `INSERT INTO messages (id, conversation_id, seq, author_id, client_msg_id, text, created_at, updated_at)
     SELECT 'm_bulk_' || c.last_seq + g, c.id, c.last_seq + g, $2, 'bulk' || c.last_seq + g, 'message ' || c.last_seq + g, now(), now()
     FROM conversations c, generate_series(1, $3::int) g WHERE c.id = $1`,
    conv,
    authorId,
    count,
  );
  await t.all('UPDATE conversations SET last_seq = last_seq + $2, last_message_at = now() WHERE id = $1', conv, count);
}

beforeEach(async () => {
  t = await createTestDb();
  ({ services: svc, bus } = await buildApp(t.db));
  [ann, bob] = await Promise.all(['ann', 'bob'].map(async (name) => (await svc.users.register(name)).id));
  conv = (await svc.conversations.createChannel('team', [ann, bob])).id;
});
afterEach(async () => {
  await bus.idle();
  bus.close();
  await t.drop();
});

describe('channel pages', () => {
  beforeEach(() => bulk(ann, 120));

  it('defaults to the newest page', async () => {
    const page = await svc.messages.list(bob, conv);
    expect(seqs(page)).toEqual(range(71, 120));
    expect(edges(page)).toEqual([true, false]);
  });

  it('pages older with before and newer with after', async () => {
    const older = await svc.messages.list(bob, conv, { before: '71' });
    expect(seqs(older)).toEqual(range(21, 70));
    expect(edges(older)).toEqual([true, true]);
    expect(seqs(await svc.messages.list(bob, conv, { before: '21' }))).toEqual(range(1, 20));
    expect(edges(await svc.messages.list(bob, conv, { before: '21' }))).toEqual([false, true]);

    const newer = await svc.messages.list(bob, conv, { after: '100', limit: '10' });
    expect(seqs(newer)).toEqual(range(101, 110));
    expect(edges(newer)).toEqual([true, true]);
    expect(edges(await svc.messages.list(bob, conv, { after: '115' }))).toEqual([true, false]);
  });

  it('skips deleted messages, so a page can span gaps', async () => {
    await t.all(`UPDATE messages SET deleted_at = now() WHERE conversation_id = $1 AND seq BETWEEN 101 AND 110`, conv);
    expect(seqs(await svc.messages.list(bob, conv, { after: '95', limit: '10' }))).toEqual([96, 97, 98, 99, 100, 111, 112, 113, 114, 115]);
  });

  it('caps the limit and rejects mixed or malformed cursors', async () => {
    expect((await svc.messages.list(bob, conv, { limit: '1000' })).messages).toHaveLength(100);
    await expect(svc.messages.list(bob, conv, { before: '5', after: '1' })).rejects.toThrow(/one of/);
    await expect(svc.messages.list(bob, conv, { before: 'x' })).rejects.toThrow(/integer/);
    await expect(svc.messages.list(bob, conv, { anchor: 'last' })).rejects.toThrow(/first_unread/);
    await expect(svc.messages.list(bob, conv, { limit: '0' })).rejects.toThrow(/positive/);
  });
});

describe('around a message', () => {
  it('jumps 10,000 messages back in one request, then pages both ways', async () => {
    await bulk(ann, 100);
    const target = await post(ann, 'the one');
    await bulk(ann, 10_000);

    const page = await svc.messages.list(bob, conv, { around: target.id });
    expect(seqs(page)).toEqual(range(76, 125)); // 25 before it, it and 24 after
    expect(edges(page)).toEqual([true, true]);
    expect(seqs(await svc.messages.list(bob, conv, { before: '76' })).at(-1)).toBe(75);
    expect(seqs(await svc.messages.list(bob, conv, { after: '125' }))[0]).toBe(126);
  });

  it('fills from the other side near an edge', async () => {
    await bulk(ann, 60);
    const near = await svc.messages.list(bob, conv, { around: 'm_bulk_3' });
    expect(seqs(near)).toEqual(range(1, 50));
    expect(edges(near)).toEqual([false, true]);
  });

  it('lands on the root for a reply, and refuses a message from elsewhere', async () => {
    const root = await post(ann, 'question');
    await bulk(ann, 5);
    const reply = await post(bob, 'answer', root.id);
    expect(seqs(await svc.messages.list(bob, conv, { around: reply.id }))).toContain(root.seq);

    const other = (await svc.conversations.createChannel('other', [ann])).id;
    const elsewhere = await svc.messages.post(ann, other, { clientMsgId: 'x', text: 'hi' });
    await expect(svc.messages.list(bob, conv, { around: elsewhere.id })).rejects.toThrow(/not found/i);
  });
});

describe('first unread', () => {
  it('opens a channel with 500 unreads at the first one, with context above', async () => {
    await bulk(ann, 300);
    await svc.messages.markRead(bob, conv, 300);
    await bulk(ann, 500);

    const page = await svc.messages.list(bob, conv, { anchor: 'first_unread' });
    expect(seqs(page)).toEqual(range(276, 325));
    expect(edges(page)).toEqual([true, true]);
  });

  it('is the newest page when nothing is unread', async () => {
    await bulk(ann, 80);
    await svc.messages.markRead(bob, conv, 80);
    const page = await svc.messages.list(bob, conv, { anchor: 'first_unread' });
    expect(seqs(page)).toEqual(range(31, 80));
    expect(edges(page)).toEqual([true, false]);
  });

  it('opens a thread at the first unread reply, or at the start for a non-participant', async () => {
    const root = await post(ann, 'question');
    for (let i = 0; i < 30; i++) await post(i < 10 ? bob : ann, `reply ${i}`, root.id);
    const cat = (await svc.users.register('cat')).id;
    await svc.conversations.join(cat, conv);

    const forBob = await svc.messages.thread(bob, root.id, { anchor: 'first_unread', limit: '10' });
    expect(forBob.lastReadSeq).toBe(10); // his last reply
    expect(seqs({ messages: forBob.replies })).toEqual(range(6, 15));
    expect(forBob.root.id).toBe(root.id);

    const forCat = await svc.messages.thread(cat, root.id, { anchor: 'first_unread', limit: '10' });
    expect(forCat.lastReadSeq).toBeNull();
    expect(seqs({ messages: forCat.replies })).toEqual(range(1, 10));
    expect([forCat.hasBefore, forCat.hasAfter]).toEqual([false, true]);

    expect(seqs({ messages: (await svc.messages.thread(cat, root.id, { limit: '10' })).replies })).toEqual(range(21, 30));
  });
});

describe('hydration', () => {
  it('hydrates mentions and thread participants for a whole page', async () => {
    const cat = (await svc.users.register('cat')).id;
    await svc.conversations.join(cat, conv);
    const a = await post(ann, 'hi @bob and @cat');
    await post(bob, 'reply', a.id);
    await post(cat, 'reply', a.id);
    const b = await post(bob, '@channel heads up');

    const page = await svc.messages.list(ann, conv);
    expect(page.messages[0]).toEqual((await svc.messages.thread(ann, a.id)).root); // the one-row path agrees
    expect(page.messages[0].mentions).toEqual(expect.arrayContaining([{ kind: 'user', userId: bob }, { kind: 'user', userId: cat }]));
    expect(page.messages[0].thread).toMatchObject({ replyCount: 2, participantIds: [bob, cat].sort() });
    expect(page.messages[1]).toMatchObject({ id: b.id, mentions: [{ kind: 'channel' }], thread: null });
  });
});
