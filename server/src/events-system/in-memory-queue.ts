import type { DeadLetter, Handler, Queue, QueueOptions, QueueStats } from './types';

interface Item<E> {
  event: E;
  attempts: number;
  enqueuedAt: number;
}

const DEFAULTS: Required<QueueOptions> = { maxAttempts: 5, baseDelayMs: 200, maxDelayMs: 10_000, timeoutMs: 10_000 };

/**
 * Strict FIFO: one event is handled at a time, and a failing event is retried before the
 * ones behind it. That keeps per-listener order (created before edited before deleted) at
 * the cost of head-of-line blocking, which only ever stalls this listener. After
 * `maxAttempts` the event is dead-lettered and the queue moves on.
 */
export class InMemoryQueue<E> implements Queue<E> {
  private readonly opts: Required<QueueOptions>;
  private items: Item<E>[] = [];
  private dead: DeadLetter<E>[] = [];
  private working = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private delivered = 0;
  private retries = 0;
  private waiters: (() => void)[] = [];

  constructor(
    readonly name: string,
    private readonly handler: Handler<E>,
    options: QueueOptions = {},
  ) {
    this.opts = { ...DEFAULTS, ...options };
  }

  enqueue(event: E) {
    if (this.stopped) throw new Error(`Queue ${this.name} is stopped`);
    this.items.push({ event, attempts: 0, enqueuedAt: Date.now() });
    this.kick();
  }

  stats(): QueueStats {
    return {
      name: this.name,
      pending: this.items.length,
      delivered: this.delivered,
      retries: this.retries,
      deadLetters: this.dead.length,
      oldestPendingMs: this.items.length ? Date.now() - this.items[0].enqueuedAt : null,
    };
  }

  deadLetters(): readonly DeadLetter<E>[] {
    return this.dead;
  }

  replayDeadLetters() {
    const replay = this.dead;
    this.dead = [];
    for (const d of replay) this.items.push({ event: d.event, attempts: 0, enqueuedAt: Date.now() });
    this.kick();
    return replay.length;
  }

  idle() {
    return this.items.length === 0 && !this.working ? Promise.resolve() : new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private kick() {
    if (!this.working && !this.retryTimer && !this.stopped) void this.work();
  }

  private async work() {
    this.working = true;
    while (this.items.length && !this.stopped) {
      const item = this.items[0];
      try {
        await this.call(item.event);
        this.items.shift();
        this.delivered++;
      } catch (err) {
        item.attempts++;
        if (item.attempts >= this.opts.maxAttempts) {
          this.items.shift();
          this.dead.push({ event: item.event, attempts: item.attempts, error: String((err as Error)?.message ?? err), failedAt: Date.now() });
          continue;
        }
        this.retries++;
        this.working = false;
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.kick();
        }, this.backoff(item.attempts));
        return;
      }
    }
    this.working = false;
    if (!this.items.length) for (const resolve of this.waiters.splice(0)) resolve();
  }

  /** Runs the handler with a timeout; sync throws and rejections both count as failures. */
  private call(event: E) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${this.opts.timeoutMs}ms`)), this.opts.timeoutMs);
    });
    return Promise.race([Promise.resolve().then(() => this.handler(event)), timeout]).finally(() => clearTimeout(timer));
  }

  /** Exponential with jitter, so retries from many listeners don't line up. */
  private backoff(attempt: number) {
    const delay = Math.min(this.opts.maxDelayMs, this.opts.baseDelayMs * 2 ** (attempt - 1));
    return delay * (0.5 + Math.random() / 2);
  }
}
