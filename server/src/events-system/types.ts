// The event system's contract. Producers publish typed events; each listener receives them
// through its own queue, so a slow or failing listener never affects the others.
//
//   producer ── publish(type) ──► listener_1 ─► queue ─► handler
//                              └► listener_2 ─► queue ─► handler

/** Event type -> payload, e.g. `{ 'message.created': MessageCreated }`. */
export type EventMap = Record<string, unknown>;

/** A published event. Discriminated by `type`, so handlers can switch on it. */
export type EventOf<M extends EventMap, K extends keyof M = keyof M> = {
  [P in K]: {
    id: number; // publish order, unique per bus
    type: P;
    payload: M[P];
    publishedAt: number;
  };
}[K];

export type Handler<E> = (event: E) => void | Promise<void>;

export interface QueueOptions {
  /** Attempts before an event goes to the dead-letter queue. Default 5. */
  maxAttempts?: number;
  /** First retry delay; doubles on every attempt, with jitter. Default 200. */
  baseDelayMs?: number;
  /** Cap on the retry delay. Default 10 000. */
  maxDelayMs?: number;
  /** A handler call that takes longer counts as failed. Default 10 000. */
  timeoutMs?: number;
}

export interface QueueStats {
  name: string;
  pending: number; // waiting, including the one being handled or retried
  delivered: number;
  retries: number;
  deadLetters: number;
  oldestPendingMs: number | null; // how far behind this listener is
}

export interface DeadLetter<E> {
  event: E;
  attempts: number;
  error: string;
  failedAt: number;
}

/** One listener's queue: FIFO, at-least-once, retries with backoff, then dead-letters. */
export interface Queue<E> {
  readonly name: string;
  enqueue(event: E): void;
  stats(): QueueStats;
  deadLetters(): readonly DeadLetter<E>[];
  /** Moves dead letters back to the end of the queue. Returns how many. */
  replayDeadLetters(): number;
  /** Resolves once nothing is pending. */
  idle(): Promise<void>;
  stop(): void;
}

export interface Listener {
  readonly name: string;
  readonly types: readonly string[];
  unsubscribe(): void;
}

/** A listener on the in-memory bus, whose queue can be inspected directly. */
export interface Subscription<E> extends Listener {
  readonly queue: Queue<E>;
}

export interface EventPublisher<M extends EventMap> {
  /** Hands the event to every listener of its type. Returns immediately; delivery is async. */
  publish<K extends keyof M & string>(type: K, payload: M[K]): void;
}

/** An event waiting for its transaction to commit. */
export interface PendingEvent<M extends EventMap, K extends keyof M & string = keyof M & string> {
  type: K;
  payload: M[K];
  publishedAt: number;
}

/** Where a transactional publisher hands a transaction's events. Implement one or both. */
export interface EventSink<M extends EventMap> {
  /** Inside the transaction, just before commit: a durable sink writes here, so the events commit with the change. */
  write?(events: PendingEvent<M>[]): Promise<void>;
  /** After commit: an in-memory sink hands events over here, so a rollback publishes nothing. */
  committed?(events: PendingEvent<M>[]): void;
}

/** What a transactional publisher needs from the database layer. */
export interface TransactionHooks {
  /** Identifies the transaction in progress; undefined outside one. */
  readonly transactionInProgress: object | undefined;
  beforeCommit(hook: () => Promise<void>): void;
  afterCommit(hook: () => void): void;
}

/**
 * Names each listener and the event types it takes. The publisher routes with it, so a
 * process can enqueue jobs for listeners that run in another process.
 */
export type Routes<M extends EventMap> = Record<string, readonly (keyof M & string)[]>;

export interface EventSubscriber<M extends EventMap> {
  /**
   * Registers a listener with its own queue. One listener can take several types; they
   * arrive in publish order through the same queue.
   */
  subscribe<K extends keyof M & string>(name: string, types: K[], handler: Handler<EventOf<M, K>>, options?: QueueOptions): Listener;
}

export interface EventBus<M extends EventMap> extends EventPublisher<M>, EventSubscriber<M> {
  subscribe<K extends keyof M & string>(name: string, types: K[], handler: Handler<EventOf<M, K>>, options?: QueueOptions): Subscription<EventOf<M, K>>;
  subscriptions(): readonly Subscription<EventOf<M>>[];
  /** Resolves once every queue is idle. */
  idle(): Promise<void>;
  close(): void;
}
