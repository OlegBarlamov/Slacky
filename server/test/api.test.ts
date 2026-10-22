import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActivityItem, Bootstrap, Message, MessagePage, SearchResult, ThreadView } from '../../shared/types';
import { buildApp } from '../src/app';
import { createTestDb, type TestDb } from './db';

// End to end through HTTP: routes, cookie sessions, services and the DB.
let t: TestDb;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let bus: Awaited<ReturnType<typeof buildApp>>['bus'];

beforeEach(async () => {
  t = await createTestDb();
  ({ app, bus } = await buildApp(t.db, { sessionSecret: 'test' }));
});
afterEach(async () => {
  await bus.idle(); // listeners read the DB, so let them finish before the schema goes
  await app.close();
  await t.drop();
});

async function signIn(name: string, mode: 'register' | 'login' = 'register') {
  const res = await app.inject({ method: 'POST', url: `/api/auth/${mode}`, payload: { name } });
  expect(res.statusCode).toBe(200);
  const cookie = res.cookies.find((c) => c.name === 'sid')!;
  const call = async <T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) => {
    const r = await app.inject({ method, url: `/api${url}`, payload, cookies: { sid: cookie.value } });
    return { status: r.statusCode, body: (r.body ? r.json() : undefined) as T };
  };
  return { user: res.json() as { id: string }, call };
}

describe('auth', () => {
  it('needs a session for everything but auth', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/bootstrap' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/bootstrap', cookies: { sid: 'u_forged' } })).statusCode).toBe(401);
  });

  it('looks up a user who registered after bootstrap', async () => {
    const { call } = await signIn('ann');
    const { user: bob } = await signIn('bob');
    expect((await call<{ name: string }>('GET', `/users/${bob.id}`)).body.name).toBe('bob');
    expect((await call('GET', '/users/u_nobody')).status).toBe(404);
  });

  it('registers once per name, then logs in', async () => {
    await signIn('ann');
    expect((await app.inject({ method: 'POST', url: '/api/auth/register', payload: { name: 'Ann' } })).statusCode).toBe(409);
    const { call } = await signIn('ann', 'login');
    expect((await call<Bootstrap>('GET', '/bootstrap')).body.me.name).toBe('ann');
  });
});

describe('messaging', () => {
  it('posts, pages, threads, reads and searches', async () => {
    const ann = await signIn('ann');
    const bob = await signIn('bob');
    const { body: view } = await ann.call<{ conversation: { id: string } }>('POST', '/conversations', { name: 'General Talk' });
    const conv = view.conversation.id;
    expect((await bob.call('POST', `/conversations/${conv}/join`)).status).toBe(200);

    const { body: root } = await ann.call<Message>('POST', `/conversations/${conv}/messages`, { clientMsgId: 'a1', text: 'deploy plan @bob' });
    await bob.call('POST', `/conversations/${conv}/messages`, { clientMsgId: 'b1', text: 'looks good', threadRootId: root.id });

    const { body: page } = await bob.call<MessagePage>('GET', `/conversations/${conv}/messages`);
    expect(page.messages.map((m) => m.text)).toEqual(['deploy plan @bob']);
    expect(page.messages[0].thread?.replyCount).toBe(1);
    expect((await bob.call<ThreadView>('GET', `/threads/${root.id}`)).body.replies.map((r) => r.text)).toEqual(['looks good']);

    const boot = (await bob.call<Bootstrap>('GET', '/bootstrap')).body;
    const inConv = (b: Bootstrap) => b.conversations.find((v) => v.conversation.id === conv);
    expect(inConv(boot)).toMatchObject({ unreadCount: 1, mentionCount: 1 });
    await bob.call('POST', `/conversations/${conv}/read`, { seq: root.seq });
    expect(inConv((await bob.call<Bootstrap>('GET', '/bootstrap')).body)).toMatchObject({ unreadCount: 0, mentionCount: 0 });

    const found = (await bob.call<SearchResult>('GET', '/search?q=depl')).body;
    expect(found.messages.map((m) => m.id)).toEqual([root.id]);
    expect((await bob.call<SearchResult>('GET', '/search?q=depl%20from:bob')).body.total).toBe(0);
  });

  it('refuses non-members and bad input', async () => {
    const ann = await signIn('ann');
    const eve = await signIn('eve');
    const { body: view } = await ann.call<{ conversation: { id: string } }>('POST', '/conversations', { name: 'secret' });
    expect((await eve.call('POST', `/conversations/${view.conversation.id}/messages`, { clientMsgId: 'x', text: 'hi' })).status).toBe(403);
    expect((await ann.call('POST', `/conversations/${view.conversation.id}/read`, { seq: 'abc' })).status).toBe(400);
    expect((await ann.call('POST', '/conversations', { name: 'secret' })).status).toBe(409);
  });
});

describe('activity', () => {
  it('shows mentions, DMs and threads, and marks them read', async () => {
    const ann = await signIn('ann');
    const bob = await signIn('bob');
    const { body: ch } = await ann.call<{ conversation: { id: string } }>('POST', '/conversations', { name: 'eng' });
    await bob.call('POST', `/conversations/${ch.conversation.id}/join`);
    const { body: root } = await ann.call<Message>('POST', `/conversations/${ch.conversation.id}/messages`, { clientMsgId: 'r', text: 'question' });
    await bob.call('POST', `/conversations/${ch.conversation.id}/messages`, { clientMsgId: 'm', text: 'ping @ann' });
    await bob.call('POST', `/conversations/${ch.conversation.id}/messages`, { clientMsgId: 't', text: 'answer', threadRootId: root.id });
    const { body: dm } = await bob.call<{ conversation: { id: string } }>('POST', '/dms', { userId: ann.user.id });
    await bob.call('POST', `/conversations/${dm.conversation.id}/messages`, { clientMsgId: 'd', text: 'got a minute?' });

    const items = (await ann.call<{ items: ActivityItem[] }>('GET', '/activity')).body.items;
    expect(items.map((i) => [i.kind, i.read, i.entries.map((e) => e.text)])).toEqual([
      ['dm', false, ['got a minute?']],
      ['thread', false, ['answer']],
      ['mention', false, ['ping @ann']],
    ]);

    expect((await ann.call('POST', '/activity/read', { ids: items.map((i) => i.id) })).status).toBe(204);
    const after = (await ann.call<{ items: ActivityItem[] }>('GET', '/activity')).body.items;
    expect(after.every((i) => i.read)).toBe(true);
    expect(after.find((i) => i.kind === 'dm')!.entries.map((e) => e.text)).toEqual(['got a minute?']); // last one stays visible
  });
});

describe('threads tab', () => {
  it("shows a thread I replied to, even when nobody else has replied", async () => {
    const ann = await signIn('ann');
    const bob = await signIn('bob');
    const { body: ch } = await ann.call<{ conversation: { id: string } }>('POST', '/conversations', { name: 'eng' });
    await bob.call('POST', `/conversations/${ch.conversation.id}/join`);
    const { body: root } = await ann.call<Message>('POST', `/conversations/${ch.conversation.id}/messages`, { clientMsgId: 'r', text: 'question' });
    await bob.call('POST', `/conversations/${ch.conversation.id}/messages`, { clientMsgId: 't', text: 'my answer', threadRootId: root.id });

    const items = (await bob.call<{ items: ActivityItem[] }>('GET', '/activity')).body.items;
    expect(items.map((i) => [i.id, i.read, i.entries.map((e) => e.text)])).toEqual([[`thread:${root.id}`, true, ['my answer']]]);
  });
});

describe('new users', () => {
  it('start in #general with a DM to themselves', async () => {
    const ann = await signIn('ann');
    const bob = await signIn('bob');
    const boot = (await bob.call<Bootstrap>('GET', '/bootstrap')).body;
    const general = boot.conversations.find((v) => v.conversation.name === 'general')!;
    expect(general.conversation.memberIds.sort()).toEqual([ann.user.id, bob.user.id].sort());
    expect(general).toMatchObject({ unreadCount: 0 });
    const dms = boot.conversations.filter((v) => v.conversation.kind === 'dm');
    expect(dms.map((v) => v.conversation.memberIds)).toEqual([[bob.user.id]]);
    expect(boot.conversations).toHaveLength(2);
  });

  it('can post in their self-DM, and nobody else can read it', async () => {
    const ann = await signIn('ann');
    const eve = await signIn('eve');
    const boot = (await ann.call<Bootstrap>('GET', '/bootstrap')).body;
    const notes = boot.conversations.find((v) => v.conversation.kind === 'dm')!.conversation.id;
    expect((await ann.call('POST', `/conversations/${notes}/messages`, { clientMsgId: 'n', text: 'todo: ship it' })).status).toBe(200);
    expect((await eve.call('GET', `/conversations/${notes}/messages`)).status).toBe(403);
  });
});
