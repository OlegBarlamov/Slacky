import type { Id, User } from '../../../shared/types';
import { newId, type DB } from './db';

const COLUMNS = 'id, name, created_at AS createdAt';

export class UserRepository {
  constructor(private readonly db: DB) {}

  /** Returns null if the name is taken. */
  create(name: string, at: number): User | null {
    const row = this.db
      .prepare(`INSERT INTO users (id, name, created_at) VALUES (?, ?, ?) ON CONFLICT(name) DO NOTHING RETURNING ${COLUMNS}`)
      .get(newId('u_'), name, at) as User | undefined;
    return row ?? null;
  }

  get(id: Id): User | undefined {
    return this.db.prepare(`SELECT ${COLUMNS} FROM users WHERE id = ?`).get(id) as User | undefined;
  }

  findByName(name: string): User | undefined {
    return this.db.prepare(`SELECT ${COLUMNS} FROM users WHERE name = ?`).get(name) as User | undefined;
  }

  idsByName(names: string[]): Id[] {
    return this.db.prepare('SELECT id FROM users WHERE name IN (SELECT value FROM json_each(?))').pluck().all(JSON.stringify(names)) as Id[];
  }

  list(): User[] {
    return this.db.prepare(`SELECT ${COLUMNS} FROM users ORDER BY name`).all() as User[];
  }
}
