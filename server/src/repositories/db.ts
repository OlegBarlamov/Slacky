import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

export type DB = Database.Database;

export function openDb(file = ':memory:'): DB {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  return db;
}

export const newId = (prefix: string) => prefix + crypto.randomUUID().replaceAll('-', '').slice(0, 12);
