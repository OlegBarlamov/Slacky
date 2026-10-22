// Release step: run before the new version starts. `npm run migrate -w server`
import { openDb } from './repositories/db';
import { migrateToLatest } from './repositories/migrate';

const db = openDb();
try {
  const results = await migrateToLatest(db);
  for (const r of results) console.log(`${r.status}: ${r.migrationName}`);
  if (!results.length) console.log('Already up to date');
} finally {
  await db.close();
}
