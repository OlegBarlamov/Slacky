import type { Db, Job, PgBoss, Queue } from 'pg-boss';
import type { EventMap, EventOf, EventSink, EventSubscriber, Handler, Listener, PendingEvent, QueueOptions, Routes } from './types';

/** Bump when the job payload changes shape: jobs can wait in a dead-letter queue across deploys. */
const PAYLOAD_VERSION = 1;

interface Payload {
  v: number;
  events: PendingEvent<EventMap>[];
}

export interface ListenerConfig {
  /** One job at a time, oldest first, so the listener sees events (nearly) in order. */
  serial?: boolean;
  queue?: QueueOptions;
}

export interface DeadLetter {
  id: string;
  listener: string;
  events: { type: string; publishedAt: number }[];
  error: string | null;
  failedAt: Date;
}

const DEFAULTS: Required<QueueOptions> = { maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 60_000, timeoutMs: 10_000 };
const dlq = (listener: string) => `${listener}.dlq`;

/**
 * Durable delivery on Postgres via pg-boss. Every listener has its own queue (and dead-letter
 * queue), so a slow or failing listener never holds up the others.
 *
 * - `sink(db)` enqueues one job per listener for a transaction's events, on that
 *   transaction's connection: the jobs commit with the change, or not at all.
 * - `subscribe` registers a handler; `start` creates the queues and starts the workers. A
 *   process that only publishes starts with no subscriptions; tooling calls `createQueues`.
 *
 * At-least-once: a job whose handler throws, times out or whose process dies runs again, so
 * handlers must be idempotent. After `maxAttempts` the job moves to the dead-letter queue.
 */
export class PgBossEventBus<M extends EventMap> implements EventSubscriber<M> {
  private handlers = new Map<string, Handler<EventOf<M>>>();
  private nextId = 1;

  constructor(
    private readonly boss: PgBoss,
    private readonly routes: Routes<M>,
    private readonly config: Record<string, ListenerConfig> = {},
    /** Overrides every listener's queue options, e.g. short delays in tests. */
    private readonly overrides: QueueOptions = {},
  ) {}

  private options(listener: string): Required<QueueOptions> {
    return { ...DEFAULTS, ...this.config[listener]?.queue, ...this.overrides };
  }

  /** The pg-boss queue settings for a listener, from its `QueueOptions`. */
  private queueSettings(listener: string): Omit<Queue, 'name'> {
    const o = this.options(listener);
    const retryDelay = Math.round(o.baseDelayMs / 1000);
    return {
      policy: this.config[listener]?.serial ? 'singleton' : 'standard',
      retryLimit: o.maxAttempts - 1,
      retryDelay,
      // pg-boss backoff starts at 1 s even from 0, so sub-second delays (tests) retry at once instead.
      ...(retryDelay > 0 ? { retryBackoff: true, retryDelayMax: Math.max(retryDelay, Math.round(o.maxDelayMs / 1000)) } : {}),
      // Well past the handler timeout: a slow handler is failed by us, not picked up twice.
      expireInSeconds: Math.max(1, Math.ceil((o.timeoutMs * 3) / 1000)),
      deleteAfterSeconds: 3 * 24 * 3600, // completed jobs double as a short event log
      deadLetter: dlq(listener),
      notify: true,
    };
  }

  /** Creates (or updates) every listener's queue and dead-letter queue. Idempotent. */
  async createQueues() {
    for (const listener of Object.keys(this.routes)) {
      await this.ensureQueue(dlq(listener), { retentionSeconds: 30 * 24 * 3600 });
      await this.ensureQueue(listener, this.queueSettings(listener));
    }
  }

  /** Creates the queues, then starts a worker for every subscribed listener. */
  async start() {
    await this.createQueues();
    for (const [listener, handler] of this.handlers) {
      const serial = this.config[listener]?.serial;
      // NOTIFY wakes a worker when a job is created, but a job that arrives while a serial
      // queue is busy is only found by the next poll, so that poll stays short.
      const polling = { pollingIntervalSeconds: 1, notifyPollingIntervalSeconds: 1 };
      await this.boss.work<Payload>(listener, { batchSize: 1, localConcurrency: serial ? 1 : 4, ...polling }, ([job]) => this.handle(listener, job, handler));
    }
  }

  private async ensureQueue(name: string, settings: Omit<Queue, 'name'>) {
    if (!(await this.boss.getQueue(name))) return this.boss.createQueue(name, settings);
    // Keeps an existing queue in line with the code. Policy and dead-letter wiring are fixed at creation.
    const { policy: _p, retryDelayMax: _m, ...updatable } = settings;
    await this.boss.updateQueue(name, updatable);
  }

  /** Per-listener queue options come from the constructor: a queue's settings are shared by every process. */
  subscribe<K extends keyof M & string>(name: string, types: K[], handler: Handler<EventOf<M, K>>): Listener {
    const route = this.routes[name];
    if (!route) throw new Error(`Listener "${name}" isn't in the routes`);
    if (types.some((t) => !route.includes(t))) throw new Error(`Listener "${name}" subscribes to types its route doesn't send`);
    if (this.handlers.has(name)) throw new Error(`Listener "${name}" already exists`);
    this.handlers.set(name, handler as Handler<EventOf<M>>);
    return { name, types, unsubscribe: () => void this.boss.offWork(name) };
  }

  /** Enqueues a transaction's events, one job per listener, through `db` (the transaction). */
  sink(db: () => Db): EventSink<M> {
    return {
      write: async (events) => {
        for (const [listener, types] of Object.entries(this.routes)) {
          const mine = events.filter((e) => types.includes(e.type));
          if (mine.length) await this.boss.send(listener, { v: PAYLOAD_VERSION, events: mine } satisfies Payload, { db: db() });
        }
      },
    };
  }

  /** Handles a job's events in order. Any failure fails the job; the retry runs them all again. */
  private async handle(listener: string, job: Job<Payload>, handler: Handler<EventOf<M>>) {
    if (job.data.v !== PAYLOAD_VERSION) throw new Error(`Unknown payload version ${job.data.v}`);
    const { timeoutMs } = this.options(listener);
    for (const e of job.data.events) {
      const event = { id: this.nextId++, type: e.type, payload: e.payload, publishedAt: e.publishedAt } as EventOf<M>;
      await withTimeout(Promise.resolve().then(() => handler(event)), timeoutMs);
    }
  }

  /** Resolves once no listener has a job waiting, retrying or running. For tests and tooling. */
  async idle(pollMs = 25) {
    const pending = new Set(['created', 'retry', 'active']);
    for (;;) {
      const jobs = (await Promise.all(Object.keys(this.routes).map((n) => this.boss.findJobs(n)))).flat();
      if (!jobs.some((j) => pending.has(j.state))) return;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  // Dead letters: what an operator lists, retries or discards.

  async deadLetters(listener?: string): Promise<DeadLetter[]> {
    const out: DeadLetter[] = [];
    for (const name of listener ? [listener] : Object.keys(this.routes)) {
      for (const job of await this.boss.findJobs<Payload>(dlq(name), { queued: true })) {
        const source = job.sourceId ? (await this.boss.findJobs(name, { id: job.sourceId }))[0] : undefined;
        out.push({
          id: job.id,
          listener: name,
          events: job.data.events.map((e) => ({ type: e.type, publishedAt: e.publishedAt })),
          error: errorOf(source?.output),
          failedAt: job.createdOn,
        });
      }
    }
    return out.sort((a, b) => a.failedAt.getTime() - b.failedAt.getTime());
  }

  /** Moves dead letters back to their listener's queue, with fresh attempts. Returns how many. */
  retryDeadLetters(listener: string, ids?: string[]) {
    return this.boss.redrive(dlq(listener), { destination: listener, ...(ids ? { ids } : {}) });
  }

  async discardDeadLetters(listener: string, ids: string[]) {
    await this.boss.deleteJob(dlq(listener), ids);
  }

  close() {
    return this.boss.stop({ graceful: true, timeout: 10_000 });
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const errorOf = (output: unknown): string | null =>
  output && typeof output === 'object' && 'message' in output ? String(output.message) : output ? JSON.stringify(output) : null;
