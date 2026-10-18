import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryEventBus, type EventOf } from '../src/events-system';

type Events = {
  'a.happened': { n: number };
  'b.happened': { s: string };
};
type E = EventOf<Events>;

const fast = { baseDelayMs: 1, maxDelayMs: 2 };
let bus: InMemoryEventBus<Events>;
afterEach(() => bus.close());

/** A handler that fails the first `times` calls for each event id. */
const flaky = (times: number, seen: E[]) => {
  const failures = new Map<number, number>();
  return (e: E) => {
    seen.push(e);
    const n = failures.get(e.id) ?? 0;
    if (n < times) {
      failures.set(e.id, n + 1);
      throw new Error(`fail ${n + 1}`);
    }
  };
};

describe('InMemoryEventBus', () => {
  it('fans out by type, each listener gets its own copy', async () => {
    bus = new InMemoryEventBus<Events>();
    const one: E[] = [];
    const two: E[] = [];
    const b: E[] = [];
    bus.subscribe('one', ['a.happened'], (e) => {
      one.push(e);
      (e.payload as { n: number }).n = 999; // must not leak to other listeners
    });
    bus.subscribe('two', ['a.happened'], (e) => void two.push(e));
    bus.subscribe('b-only', ['b.happened'], (e) => void b.push(e));

    const published = bus.publish('a.happened', { n: 1 });
    await bus.idle();
    expect(one).toHaveLength(1);
    expect(two.map((e) => e.payload)).toEqual([{ n: 1 }]);
    expect(published.payload).toEqual({ n: 1 });
    expect(b).toEqual([]);
  });

  it('isolates listeners: a failing one does not hold up the others', async () => {
    bus = new InMemoryEventBus<Events>();
    const ok: E[] = [];
    bus.subscribe('broken', ['a.happened'], () => Promise.reject(new Error('down')), { ...fast, maxAttempts: 3 });
    bus.subscribe('healthy', ['a.happened'], (e) => void ok.push(e));
    for (let n = 0; n < 3; n++) bus.publish('a.happened', { n });
    await bus.subscriptions()[1].queue.idle();
    expect(ok).toHaveLength(3);
    await bus.idle();
    expect(bus.subscriptions()[0].queue.stats()).toMatchObject({ pending: 0, delivered: 0, deadLetters: 3 });
  });

  it('retries with backoff, keeping FIFO order', async () => {
    bus = new InMemoryEventBus<Events>();
    const seen: E[] = [];
    const sub = bus.subscribe('flaky', ['a.happened'], flaky(2, seen), fast);
    for (let n = 1; n <= 3; n++) bus.publish('a.happened', { n });
    await bus.idle();
    // each event fails twice before succeeding, and nothing overtakes it
    expect(seen.map((e) => (e.payload as { n: number }).n)).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3]);
    expect(sub.queue.stats()).toMatchObject({ delivered: 3, retries: 6, deadLetters: 0 });
  });

  it('dead-letters after maxAttempts, moves on, and can replay', async () => {
    bus = new InMemoryEventBus<Events>();
    let healthy = false;
    const seen: E[] = [];
    const sub = bus.subscribe(
      'search',
      ['a.happened'],
      (e) => {
        seen.push(e);
        if (!healthy && (e.payload as { n: number }).n === 1) throw new Error('index unavailable');
      },
      { ...fast, maxAttempts: 2 },
    );
    bus.publish('a.happened', { n: 1 });
    bus.publish('a.happened', { n: 2 });
    await bus.idle();
    expect(sub.queue.deadLetters()).toMatchObject([{ attempts: 2, error: 'index unavailable', event: { payload: { n: 1 } } }]);
    expect(sub.queue.stats().delivered).toBe(1);

    healthy = true;
    expect(sub.queue.replayDeadLetters()).toBe(1);
    await bus.idle();
    expect(sub.queue.stats()).toMatchObject({ delivered: 2, deadLetters: 0 });
  });

  it('treats a slow handler as failed', async () => {
    bus = new InMemoryEventBus<Events>();
    const sub = bus.subscribe('slow', ['a.happened'], () => new Promise((r) => setTimeout(r, 50)), { ...fast, maxAttempts: 1, timeoutMs: 5 });
    bus.publish('a.happened', { n: 1 });
    await bus.idle();
    expect(sub.queue.deadLetters()[0].error).toMatch(/timed out/);
  });

  it('delivers several types to one listener in publish order', async () => {
    bus = new InMemoryEventBus<Events>();
    const seen: string[] = [];
    bus.subscribe('both', ['a.happened', 'b.happened'], (e) => void seen.push(`${e.type}#${e.id}`));
    bus.publish('a.happened', { n: 1 });
    bus.publish('b.happened', { s: 'x' });
    bus.publish('a.happened', { n: 2 });
    await bus.idle();
    expect(seen).toEqual(['a.happened#1', 'b.happened#2', 'a.happened#3']);
  });

  it('rejects duplicate listener names and stops delivering after unsubscribe', async () => {
    bus = new InMemoryEventBus<Events>();
    const seen: E[] = [];
    const sub = bus.subscribe('x', ['a.happened'], (e) => void seen.push(e));
    expect(() => bus.subscribe('x', ['b.happened'], () => {})).toThrow('already exists');
    sub.unsubscribe();
    bus.publish('a.happened', { n: 1 });
    expect(seen).toEqual([]);
    expect(bus.subscriptions()).toEqual([]);
  });
});
