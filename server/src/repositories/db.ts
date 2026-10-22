import { AsyncLocalStorage } from 'node:async_hooks';
import { Kysely, PostgresDialect, type Transaction } from 'kysely';
import pg from 'pg';
import type { Database } from './schema';

// int8 (bigint columns, count(*)) as numbers: seqs, versions and counts stay far below 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, Number);

/** The local docker-compose database. Real deployments set DATABASE_URL. */
export const LOCAL_DATABASE_URL = 'postgres://slacky@localhost:5432/slacky';

export interface DbOptions {
  connectionString?: string;
  /** Schemas to resolve unqualified names in, e.g. a per-test schema followed by `public`. */
  searchPath?: string[];
}

interface TxContext {
  tx: Transaction<Database>;
  beforeCommit: (() => Promise<void>)[];
  afterCommit: (() => void)[];
}

/**
 * The connection pool plus the current transaction. A transaction travels through
 * AsyncLocalStorage, so repositories pick it up without a `tx` argument at every call site.
 */
export class DB {
  private readonly tx = new AsyncLocalStorage<TxContext>();

  constructor(readonly kysely: Kysely<Database>) {}

  /** The transaction in progress, or the pool outside one. */
  get current(): Kysely<Database> {
    return this.tx.getStore()?.tx ?? this.kysely;
  }

  /** The transaction in progress, or undefined outside one. */
  get transactionInProgress(): Transaction<Database> | undefined {
    return this.tx.getStore()?.tx;
  }

  /** Runs `fn` in one transaction: every write inside commits or none does. Nested calls join the outer one. */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.tx.getStore()) return fn();
    let ctx!: TxContext;
    const result = await this.kysely.transaction().execute((tx) => {
      ctx = { tx, beforeCommit: [], afterCommit: [] };
      return this.tx.run(ctx, async () => {
        const out = await fn();
        // By index: a hook may add more.
        for (let i = 0; i < ctx.beforeCommit.length; i++) await ctx.beforeCommit[i]();
        return out;
      });
    });
    for (const hook of ctx.afterCommit) hook();
    return result;
  }

  /** Runs `hook` inside the current transaction, after its work and just before it commits. */
  beforeCommit(hook: () => Promise<void>) {
    this.requireContext().beforeCommit.push(hook);
  }

  /** Runs `hook` once the current transaction has committed; never if it rolls back. */
  afterCommit(hook: () => void) {
    this.requireContext().afterCommit.push(hook);
  }

  private requireContext() {
    const ctx = this.tx.getStore();
    if (!ctx) throw new Error('Not inside a transaction');
    return ctx;
  }

  close() {
    return this.kysely.destroy();
  }
}

export function openDb(opts: DbOptions = {}): DB {
  const pool = new pg.Pool({
    connectionString: opts.connectionString ?? process.env.DATABASE_URL ?? LOCAL_DATABASE_URL,
    options: opts.searchPath ? `-c search_path=${opts.searchPath.join(',')}` : undefined,
  });
  return new DB(new Kysely<Database>({ dialect: new PostgresDialect({ pool }) }));
}

export const newId = (prefix: string) => prefix + crypto.randomUUID().replaceAll('-', '').slice(0, 12);

/** timestamptz <-> the API's epoch ms. */
export const toDate = (ms: number) => new Date(ms);
export const toMs = <T extends Date | null>(d: T): T extends Date ? number : number | null => (d === null ? null : d.getTime()) as never;

/** Postgres error code for a unique constraint violation. */
export const isUniqueViolation = (err: unknown, constraint?: string) =>
  err instanceof Error && 'code' in err && err.code === '23505' && (!constraint || ('constraint' in err && err.constraint === constraint));
