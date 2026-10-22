import { Migrator } from 'kysely/migration';
import type { DB } from './db';
import { migrations } from './migrations';

/**
 * Brings `schema` to the latest version. Throws, after rolling back, if a migration fails.
 * `db` must resolve unqualified names to `schema` first (its search_path).
 */
export async function migrateToLatest(db: DB, schema = 'public') {
  // Named explicitly: without it Kysely finds its bookkeeping tables in any schema, not just this one.
  const migrator = new Migrator({ db: db.kysely, provider: { getMigrations: async () => migrations }, migrationTableSchema: schema });
  const { error, results } = await migrator.migrateToLatest();
  if (error) throw error instanceof Error ? error : new Error(String(error));
  return results ?? [];
}
