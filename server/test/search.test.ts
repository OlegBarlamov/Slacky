import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Id } from '../../shared/types';
import { buildApp } from '../src/app';
import type { Services } from '../src/services';
import { createTestDb, type TestDb } from './db';

// Search runs on Postgres FTS over the core tables, so it sees every commit right away:
// no test here waits for the event bus.
let t: TestDb;
let svc: Services;
let bus: Awaited<ReturnType<typeof buildApp>>['bus'];
let ann: Id, bob: Id, cat: Id, conv: Id;
let n = 0;

beforeEach(async () => {
  t = await createTestDb();
  ({ services: svc, bus } = await buildApp(t.db));
  [ann, bob, cat] = await Promise.all(['ann', 'bob', 'cat'].map(async (name) => (await svc.users.register(name)).id));
  conv = (await svc.conversations.createChannel('team', [ann, bob])).id;
});
afterEach(async () => {
  await bus.idle(); // listeners read the DB, so let them finish before the schema goes
  bus.close();
  await t.drop();
});

/** Each post a second after the previous one, so newest-first order is well defined. */
const post = (userId: Id, text: string, convId = conv) => svc.messages.post(userId, convId, { clientMsgId: `c${++n}`, text }, Date.now() + n * 1000);
const ids = async (userId: Id, q: string) => (await svc.search.search(userId, q, 50)).messages.map((m) => m.id);

describe('search', () => {
  it('sees creates, edits and deletes as soon as they commit', async () => {
    const m = await post(ann, 'deploy friday');
    expect(await ids(bob, 'deploy')).toEqual([m.id]);

    await svc.messages.edit(ann, m.id, 'release friday');
    expect(await ids(bob, 'deploy')).toEqual([]);
    expect(await ids(bob, 'release')).toEqual([m.id]);

    await svc.messages.delete(ann, m.id);
    expect(await ids(bob, 'release')).toEqual([]);
  });

  it('prefix-matches every term, folds plurals and accents, newest first', async () => {
    const a = await post(ann, 'Deploys are done');
    const b = await post(bob, 'the déploy pipeline is green');
    await post(ann, 'deploy');
    expect(await ids(cat, 'depl')).toEqual([]); // not a member
    expect((await ids(bob, 'depl')).slice(1)).toEqual([b.id, a.id]);
    expect(await ids(bob, 'depl pipe')).toEqual([b.id]);
    expect(await ids(bob, 'deploys')).toHaveLength(3);
  });

  it('matches phrases literally, wildcards included', async () => {
    const a = await post(ann, 'we rolled back at 100% load');
    await post(ann, 'rolled forward, then back at 1000 load');
    expect(await ids(bob, '"rolled back"')).toEqual([a.id]);
    expect(await ids(bob, '"100% load"')).toEqual([a.id]); // unescaped, % would also match "1000 load"
  });

  it('keeps tokenizer words whole, and one letter matches only that word', async () => {
    const a = await post(ann, 'set feature_flag x on');
    await post(ann, 'xylophone');
    expect(await ids(bob, 'feature_fl')).toEqual([a.id]);
    expect(await ids(bob, 'x')).toEqual([a.id]);
  });

  it('only searches conversations the user is in, and honours from: and in:', async () => {
    const other = (await svc.conversations.createChannel('ops', [ann, cat])).id;
    const inTeam = await post(ann, 'incident review');
    const byBob = await post(bob, 'incident notes');
    const inOps = await post(ann, 'incident timeline', other);

    expect(await ids(bob, 'incident')).toEqual([byBob.id, inTeam.id]);
    expect(await ids(ann, 'incident in:#ops')).toEqual([inOps.id]);
    expect(await ids(ann, 'incident from:@bob')).toEqual([byBob.id]);
    expect(await ids(ann, 'incident from:@nobody')).toEqual([]);

    await svc.conversations.leave(bob, conv);
    expect(await ids(bob, 'incident')).toEqual([]);
  });

  it('reports the total beyond the limit', async () => {
    for (let i = 0; i < 5; i++) await post(ann, `standup ${i}`);
    const r = await svc.search.search(bob, 'standup', 2);
    expect(r.messages).toHaveLength(2);
    expect(r.total).toBe(5);
  });

  it('stores a message with a word too long to index', async () => {
    const m = await post(ann, `${'a'.repeat(3000)} tail`);
    expect(await ids(bob, 'tail')).toEqual([m.id]);
  });
});
