import type { EventMap, EventPublisher, EventSink, PendingEvent, TransactionHooks } from './types';

/**
 * Publishes as part of the caller's transaction. Events collect per transaction and reach the
 * sink together, in publish order: a durable sink writes them before commit, an in-memory one
 * gets them after. A rolled-back transaction, including one a caller retries, publishes nothing.
 */
export class TransactionalPublisher<M extends EventMap> implements EventPublisher<M> {
  private pending = new WeakMap<object, PendingEvent<M>[]>();

  constructor(
    private readonly tx: TransactionHooks,
    private readonly sink: EventSink<M>,
  ) {}

  publish<K extends keyof M & string>(type: K, payload: M[K]) {
    const tx = this.tx.transactionInProgress;
    if (!tx) throw new Error(`publish('${type}') must be called inside a transaction`);
    let events = this.pending.get(tx);
    if (!events) {
      const batch: PendingEvent<M>[] = [];
      events = batch;
      this.pending.set(tx, batch);
      const { write, committed } = this.sink;
      if (write) this.tx.beforeCommit(() => write.call(this.sink, batch));
      if (committed) this.tx.afterCommit(() => committed.call(this.sink, batch));
    }
    events.push({ type, payload, publishedAt: Date.now() });
  }
}

/** Hands committed events to an in-memory bus (tests, single process). */
export const inMemorySink = <M extends EventMap>(bus: EventPublisher<M>): EventSink<M> => ({
  committed: (events) => {
    for (const e of events) bus.publish(e.type, e.payload);
  },
});
