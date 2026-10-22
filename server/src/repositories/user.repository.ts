import { sql } from 'kysely';
import type { Id, User } from '../../../shared/types';
import { newId, toDate, type DB } from './db';

const toUser = (r: { id: Id; name: string; created_at: Date }): User => ({ id: r.id, name: r.name, createdAt: r.created_at.getTime() });

export class UserRepository {
  constructor(private readonly db: DB) {}

  /** Returns null if the name is taken. */
  async create(name: string, at: number): Promise<User | null> {
    const row = await this.db.current
      .insertInto('users')
      .values({ id: newId('u_'), name, created_at: toDate(at) })
      .onConflict((oc) => oc.column('name').doNothing())
      .returning(['id', 'name', 'created_at'])
      .executeTakeFirst();
    return row ? toUser(row) : null;
  }

  async get(id: Id): Promise<User | undefined> {
    const row = await this.db.current.selectFrom('users').select(['id', 'name', 'created_at']).where('id', '=', id).executeTakeFirst();
    return row && toUser(row);
  }

  async findByName(name: string): Promise<User | undefined> {
    const row = await this.db.current.selectFrom('users').select(['id', 'name', 'created_at']).where('name', '=', name).executeTakeFirst();
    return row && toUser(row);
  }

  async idsByName(names: string[]): Promise<Id[]> {
    if (!names.length) return [];
    const rows = await this.db.current
      .selectFrom('users')
      .select('id')
      .where(sql<boolean>`name = ANY(${names}::citext[])`)
      .execute();
    return rows.map((r) => r.id);
  }

  /** Everyone who shares a conversation with the user, the user included. */
  async listInConversationsOf(userId: Id): Promise<User[]> {
    const { rows } = await sql<{ id: Id; name: string; created_at: Date }>`
      SELECT DISTINCT u.id, u.name, u.created_at FROM users u
      JOIN conversation_members cm ON cm.user_id = u.id
      WHERE cm.conversation_id IN (SELECT conversation_id FROM conversation_members WHERE user_id = ${userId})
      ORDER BY u.name`.execute(this.db.current);
    return rows.map(toUser);
  }

  /** Names starting with `prefix` (case-insensitive), `preferIds` first, then by name. */
  async search(prefix: string, limit: number, preferIds: Id[] = []): Promise<User[]> {
    const pattern = `${prefix.replace(/[\\%_]/g, '\\$&')}%`;
    const rows = await this.db.current
      .selectFrom('users')
      .select(['id', 'name', 'created_at'])
      .where(sql<boolean>`name LIKE ${pattern}`)
      .orderBy(sql`id = ANY(${preferIds}::text[])`, 'desc')
      .orderBy('name')
      .limit(limit)
      .execute();
    return rows.map(toUser);
  }
}
