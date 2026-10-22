// Tests run against real Postgres (`docker compose up -d db`). Each test gets its own freshly
// migrated schema in the test database, so test files run in parallel without seeing each other.
import { CompiledQuery, sql } from 'kysely';
import pg from 'pg';
import { openDb, type DB } from '../src/repositories/db';
import { migrateToLatest } from '../src/repositories/migrate';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://slacky@localhost:5432/slacky_test';

export interface TestDb {
  db: DB;
  /** A schema for pg-boss's tables, dropped with the test's own. */
  jobsSchema: string;
  /** Raw SQL with $1, $2… placeholders, for asserting on what was stored. */
  all: <T = Record<string, unknown>>(query: string, ...params: unknown[]) => Promise<T[]>;
  /** The first column of the first row, or undefined. */
  one: (query: string, ...params: unknown[]) => Promise<unknown>;
  exec: (query: string) => Promise<void>;
  /** Drops the schema and closes the pool. */
  drop: () => Promise<void>;
}

/**
 * Schema DDL one test at a time: the migrator introspects every schema's catalog, which fails
 * if another test drops its schema at that moment.
 */
async function exclusive(fn: () => Promise<void>) {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock(7310001)');
    await fn();
  } finally {
    await client.end(); // ending the session releases the lock
  }
}

export async function createTestDb(): Promise<TestDb> {
  const schema = `test_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const jobsSchema = `${schema}_jobs`;
  const db = openDb({ connectionString: TEST_DATABASE_URL, searchPath: [schema, 'public'] });
  await exclusive(async () => {
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(db.kysely);
    await migrateToLatest(db, schema);
  });
  const all = async <T>(query: string, ...params: unknown[]) => (await db.kysely.executeQuery<T>(CompiledQuery.raw(query, params))).rows;
  return {
    db,
    jobsSchema,
    all,
    one: async (query, ...params) => {
      const [row] = await all<Record<string, unknown>>(query, ...params);
      return row && Object.values(row)[0];
    },
    exec: async (query) => void (await db.kysely.executeQuery(CompiledQuery.raw(query))),
    drop: async () => {
      await exclusive(async () => {
        await sql`DROP SCHEMA ${sql.id(schema)} CASCADE`.execute(db.kysely);
        await sql`DROP SCHEMA IF EXISTS ${sql.id(jobsSchema)} CASCADE`.execute(db.kysely);
      });
      await db.close();
    },
  };
}
