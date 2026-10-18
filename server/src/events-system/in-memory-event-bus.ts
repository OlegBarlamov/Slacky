import { InMemoryQueue } from './in-memory-queue';
import type { EventBus, EventMap, EventOf, Handler, QueueOptions, Subscription } from './types';

/**
 * Fan-out by event type to per-listener queues. Each listener gets its own copy of the
 * event, as if it had crossed the network, so one listener can't change what another sees.
 * Events with no listeners are dropped.
 */
export class InMemoryEventBus<M extends EventMap> implements EventBus<M> {
  private nextId = 1;
  private byName = new Map<string, Subscription<EventOf<M>>>();
  private byType = new Map<string, Set<Subscription<EventOf<M>>>>();

  publish<K extends keyof M & string>(type: K, payload: M[K]): EventOf<M, K> {
    const event = { id: this.nextId++, type, payload, publishedAt: Date.now() } as EventOf<M, K>;
    for (const sub of this.byType.get(type) ?? []) sub.queue.enqueue(structuredClone(event));
    return event;
  }

  subscribe<K extends keyof M & string>(name: string, types: K[], handler: Handler<EventOf<M, K>>, options?: QueueOptions): Subscription<EventOf<M, K>> {
    if (this.byName.has(name)) throw new Error(`Listener "${name}" already exists`);
    const queue = new InMemoryQueue<EventOf<M, K>>(name, handler, options);
    const sub: Subscription<EventOf<M, K>> = {
      name,
      types,
      queue,
      unsubscribe: () => {
        queue.stop();
        this.byName.delete(name);
        for (const t of types) this.byType.get(t)?.delete(sub as Subscription<EventOf<M>>);
      },
    };
    this.byName.set(name, sub as Subscription<EventOf<M>>);
    for (const t of types) {
      if (!this.byType.has(t)) this.byType.set(t, new Set());
      this.byType.get(t)!.add(sub as Subscription<EventOf<M>>);
    }
    return sub;
  }

  subscriptions() {
    return [...this.byName.values()];
  }

  async idle() {
    await Promise.all(this.subscriptions().map((s) => s.queue.idle()));
  }

  close() {
    for (const sub of this.subscriptions()) sub.unsubscribe();
  }
}
