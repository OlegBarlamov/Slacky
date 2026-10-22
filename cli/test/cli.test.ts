import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActivityItem, Message, SearchResult } from '../../shared/types';
import { buildApp } from '../../server/src/app';
import { createTestDb, type TestDb } from '../../server/test/db';
import { run } from '../src/cli';

// The CLI against a real server on a random port: HTTP, cookies, services and the DB.
let t: TestDb;
let built: Awaited<ReturnType<typeof buildApp>>;
let url: string;

beforeEach(async () => {
  t = await createTestDb();
  built = await buildApp(t.db, { sessionSecret: 'test' });
  url = await built.app.listen({ port: 0, host: '127.0.0.1' });
});
afterEach(async () => {
  await built.bus.idle(); // listeners read the DB, so let them finish before the schema goes
  await built.app.close();
  await t.drop();
});

async function slacky(as: string | null, argv: string[], stdin = '') {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { SLACKY_URL: url, SLACKY_USER: as ?? undefined }, { stdout: (s) => out.push(s), stderr: (s) => err.push(s), stdin: async () => stdin });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const json = async <T>(as: string, argv: string[]) => {
  const r = await slacky(as, [...argv, '--json']);
  expect(r.err).toBe('');
  return JSON.parse(r.out) as T;
};

beforeEach(async () => {
  for (const name of ['ann', 'bob']) expect((await slacky(null, ['register', name])).code).toBe(0);
});

describe('help', () => {
  it('lists every command and explains each one', async () => {
    const all = await slacky(null, ['help']);
    expect(all.code).toBe(0);
    expect(all.out).toContain('read <#channel|@user|id>');
    expect(all.out).toContain('show messages; marks what it shows as read');
    expect(all.out).toContain('Exit codes:');
    expect((await slacky(null, [])).code).toBe(1); // no command: help, but it's still a usage error

    const read = await slacky(null, ['read', '--help']);
    expect(read).toMatchObject({ code: 0, out: expect.stringMatching(/^slacky read [\s\S]*--unread[\s\S]*Examples:/) });
    expect((await slacky(null, ['help', 'read'])).out).toBe(read.out);
    expect(await slacky(null, ['help', 'nope'])).toMatchObject({ code: 1, err: expect.stringContaining('Unknown command') });
  });

  it('points to the command help when an argument is missing', async () => {
    expect((await slacky('ann', ['thread'])).err).toContain('more: slacky help thread');
  });
});

describe('sessions', () => {
  it('signs in by name and explains what to do otherwise', async () => {
    expect((await slacky('ann', ['whoami'])).out).toMatch(/^@ann {2}u_/);
    expect(await slacky('zed', ['whoami'])).toMatchObject({ code: 2, err: expect.stringContaining('slacky register zed') });
    expect(await slacky(null, ['whoami'])).toMatchObject({ code: 1, err: expect.stringContaining('SLACKY_USER') });
    expect((await slacky('ann', ['nope'])).code).toBe(1);
  });

  it('reports an unreachable server', async () => {
    await built.app.close();
    expect((await slacky('ann', ['whoami'])).code).toBe(5);
  });
});

describe('channels and messages', () => {
  it('creates, joins, posts, replies and reads', async () => {
    expect((await slacky('ann', ['create', '#ops'])).out).toMatch(/^Created #ops/);
    expect((await slacky('bob', ['channels', '--joinable'])).out).toMatch(/^#ops/);

    // Not a member yet: the error says how to fix it.
    expect(await slacky('bob', ['send', '#ops', 'hi'])).toMatchObject({ code: 3, err: expect.stringContaining('slacky join #ops') });
    expect((await slacky('bob', ['join', '#ops'])).out).toBe('Joined #ops');

    const root = await json<Message>('ann', ['send', '#ops', 'deploying 1.4 @bob']);
    expect((await slacky('bob', ['reply', root.id, 'watching it'])).code).toBe(0);

    const read = await slacky('bob', ['read', '#ops']);
    expect(read.out).toContain('deploying 1.4 @bob');
    expect(read.out).toContain('1 reply');
    const thread = await slacky('ann', ['thread', root.id]);
    expect(thread.out).toMatch(/#ops {2}m_.*\n {2}deploying[\s\S]*@bob.*\n {6}watching it/);
  });

  it('posts once when a send is retried', async () => {
    await slacky('ann', ['create', 'ops']);
    const a = await json<Message>('ann', ['send', '#ops', 'same']);
    const b = await json<Message>('ann', ['send', '#ops', 'same']);
    expect(b.id).toBe(a.id);
    const c = await json<Message>('ann', ['send', '#ops', 'same', '--key', 'k2']);
    expect(c.id).not.toBe(a.id);
  });

  it('reads text from stdin', async () => {
    await slacky('ann', ['create', 'ops']);
    await slacky('ann', ['send', '#ops', '-'], 'line one\nline two\n');
    expect((await slacky('ann', ['read', '#ops'])).out).toContain('  line one\n  line two');
  });

  it('only lets authors edit and delete', async () => {
    await slacky('ann', ['create', 'ops']);
    await slacky('bob', ['join', 'ops']);
    const m = await json<Message>('ann', ['send', '#ops', 'tpyo']);
    expect((await slacky('bob', ['edit', m.id, 'nope'])).code).toBe(3);
    expect((await slacky('ann', ['edit', m.id, 'typo'])).out).toBe(`Edited ${m.id}`);
    expect((await slacky('ann', ['read', '#ops'])).out).toContain('(edited)');
    expect((await slacky('ann', ['delete', m.id])).code).toBe(0);
    expect((await slacky('ann', ['read', '#ops'])).out).toBe('No messages in #ops');
  });

  it('opens a DM on first send', async () => {
    expect((await slacky('ann', ['read', '@bob'])).code).toBe(2);
    expect((await slacky('ann', ['send', '@bob', 'psst'])).out).toMatch(/^Sent m_\w+ to @bob/);
    expect((await slacky('bob', ['dms'])).out).toMatch(/^@ann {2}d_\w+ {2}1 unread$/m);
    expect((await slacky('bob', ['read', '@ann', '--unread'])).out).toContain('psst');
  });
});

describe('unread state and activity', () => {
  it('reading a conversation marks what it showed as read', async () => {
    await slacky('ann', ['create', 'ops']);
    await slacky('bob', ['join', 'ops']);
    const m = await json<Message>('ann', ['send', '#ops', 'can you look @bob?']);
    await built.bus.idle();

    const items = await json<ActivityItem[]>('bob', ['activity', '--unread']);
    expect(items.map((i) => i.id)).toEqual([`mention:${m.id}`]);
    expect((await slacky('bob', ['activity', '--unread'])).out).toMatch(new RegExp(`^mention:${m.id} {2}mention {2}#ops {2}unread`));
    expect((await slacky('bob', ['channels'])).out).toContain('1 unread  1 mention');

    expect((await slacky('bob', ['read', '#ops', '--unread'])).out).toContain('can you look @bob?');
    expect((await slacky('bob', ['activity', '--unread'])).out).toBe('Nothing unread');
    expect((await slacky('bob', ['read', '#ops', '--unread'])).out).toBe('No unread messages in #ops');
    expect((await slacky('bob', ['channels'])).out).not.toContain('unread');

    // Only what was shown: a later message is still unread.
    await slacky('ann', ['send', '#ops', 'one more thing']);
    expect((await slacky('bob', ['read', '#ops', '--unread'])).out).toContain('one more thing');
  });

  it('reading a DM clears its activity item', async () => {
    await slacky('ann', ['send', '@bob', 'psst']);
    await built.bus.idle();
    expect((await json<ActivityItem[]>('bob', ['activity', '--unread'])).map((i) => i.kind)).toEqual(['dm']);
    await slacky('bob', ['read', '@ann']);
    expect(await json<ActivityItem[]>('bob', ['activity', '--unread'])).toEqual([]);
  });

  it('reading a thread marks its replies read', async () => {
    await slacky('ann', ['create', 'ops']);
    await slacky('bob', ['join', 'ops']);
    const root = await json<Message>('ann', ['send', '#ops', 'question']);
    await slacky('bob', ['reply', root.id, 'answer']);
    await built.bus.idle();
    expect((await json<ActivityItem[]>('ann', ['activity', '--unread'])).map((i) => i.id)).toEqual([`thread:${root.id}`]);
    // Reading the channel doesn't cover the thread, as in the web client.
    await slacky('ann', ['read', '#ops']);
    expect((await json<ActivityItem[]>('ann', ['activity', '--unread'])).map((i) => i.id)).toEqual([`thread:${root.id}`]);
    await slacky('ann', ['thread', root.id]);
    expect(await json<ActivityItem[]>('ann', ['activity', '--unread'])).toEqual([]);
  });

  it('dismisses activity items', async () => {
    await slacky('ann', ['create', 'ops']);
    await slacky('bob', ['join', 'ops']);
    const m = await json<Message>('ann', ['send', '#ops', 'fyi @bob']);
    await built.bus.idle();
    expect((await slacky('bob', ['activity', 'read', `mention:${m.id}`])).code).toBe(0);
    expect((await slacky('bob', ['activity', '--unread'])).out).toBe('Nothing unread');
  });
});

describe('search', () => {
  it('finds messages in my conversations', async () => {
    await slacky('ann', ['create', 'ops']);
    await slacky('ann', ['send', '#ops', 'rollback finished']);
    await built.bus.idle();
    const r = await json<SearchResult>('ann', ['search', 'rollback', 'in:#ops']);
    expect(r.messages.map((m) => m.text)).toEqual(['rollback finished']);
    expect((await slacky('bob', ['search', 'rollback'])).out).toBe('No matches');
  });
});
