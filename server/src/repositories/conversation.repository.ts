import { sql } from 'kysely';
import type { Conversation, Id } from '../../../shared/types';
import { newId, toDate, type DB } from './db';

export interface MemberState {
  convId: Id;
  readSeq: number;
  unreadCount: number;
  mentionCount: number;
}

export class ConversationRepository {
  constructor(private readonly db: DB) {}

  /** Returns null if the channel name is taken (the unique index decides, no lookup first). */
  async createChannel(name: string, at: number): Promise<Id | null> {
    const row = await this.db.current
      .insertInto('conversations')
      .values({ id: newId('c_'), kind: 'channel', name, created_at: toDate(at) })
      .onConflict((oc) => oc.column('name').where('kind', '=', 'channel').doNothing())
      .returning('id')
      .executeTakeFirst();
    return row?.id ?? null;
  }

  /** Returns null if the pair already has a DM. */
  async createDm(dmKey: string, at: number): Promise<Id | null> {
    const row = await this.db.current
      .insertInto('conversations')
      .values({ id: newId('d_'), kind: 'dm', dm_key: dmKey, created_at: toDate(at) })
      .onConflict((oc) => oc.column('dm_key').where('kind', '=', 'dm').doNothing())
      .returning('id')
      .executeTakeFirst();
    return row?.id ?? null;
  }

  /** Adds the users that exist and returns how many were added. */
  async addMembers(id: Id, userIds: Id[]): Promise<number> {
    if (!userIds.length) return 0;
    const result = await this.db.current
      .insertInto('conversation_members')
      .columns(['conversation_id', 'user_id'])
      .expression((eb) => eb.selectFrom('users').select([eb.val(id).as('conversation_id'), 'id']).where(sql<boolean>`id = ANY(${userIds}::text[])`))
      .executeTakeFirst();
    return Number(result.numInsertedOrUpdatedRows ?? 0);
  }

  /**
   * Joins with history read up to `readSeq` (default: everything so far, so nothing is unread).
   * Returns false if already a member.
   */
  async join(id: Id, userId: Id, readSeq: number | null = null): Promise<boolean> {
    const result = await sql`
      INSERT INTO conversation_members (conversation_id, user_id, read_seq)
      SELECT id, ${userId}, coalesce(${readSeq}::bigint, last_seq) FROM conversations WHERE id = ${id}
      ON CONFLICT DO NOTHING`.execute(this.db.current);
    return Number(result.numAffectedRows ?? 0) > 0;
  }

  /** Returns false if not a member. */
  async leave(id: Id, userId: Id): Promise<boolean> {
    const result = await this.db.current.deleteFrom('conversation_members').where('conversation_id', '=', id).where('user_id', '=', userId).executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  async get(id: Id): Promise<Conversation | undefined> {
    const c = await this.db.current.selectFrom('conversations').select(['id', 'kind', 'name', 'created_at']).where('id', '=', id).executeTakeFirst();
    if (!c) return undefined;
    const members = await this.db.current.selectFrom('conversation_members').select('user_id').where('conversation_id', '=', id).orderBy('user_id').execute();
    return { id: c.id, kind: c.kind, name: c.name, memberIds: members.map((m) => m.user_id), createdAt: c.created_at.getTime() };
  }

  async findChannelId(name: string): Promise<Id | undefined> {
    const row = await this.db.current.selectFrom('conversations').select('id').where('kind', '=', 'channel').where('name', '=', name).executeTakeFirst();
    return row?.id;
  }

  async findDmId(dmKey: string): Promise<Id | undefined> {
    const row = await this.db.current.selectFrom('conversations').select('id').where('kind', '=', 'dm').where('dm_key', '=', dmKey).executeTakeFirst();
    return row?.id;
  }

  /**
   * Allocates the next top-level seq and records the conversation's latest activity. The row
   * lock it takes serialises posts per conversation until the transaction ends.
   */
  async nextSeq(id: Id, at: number): Promise<number> {
    const row = await this.db.current
      .updateTable('conversations')
      .set((eb) => ({ last_seq: eb('last_seq', '+', 1), last_message_at: toDate(at) }))
      .where('id', '=', id)
      .returning('last_seq')
      .executeTakeFirstOrThrow();
    return row.last_seq;
  }

  /** Moves the member's read position forward only. */
  async markRead(id: Id, userId: Id, seq: number) {
    await this.db.current
      .updateTable('conversation_members')
      .set({ read_seq: sql`GREATEST(read_seq, ${seq}::bigint)` })
      .where('conversation_id', '=', id)
      .where('user_id', '=', userId)
      .execute();
  }

  async markAllRead(id: Id, userId: Id) {
    await this.db.current
      .updateTable('conversation_members')
      .set((eb) => ({ read_seq: eb.selectFrom('conversations').select('last_seq').where('id', '=', id) }))
      .where('conversation_id', '=', id)
      .where('user_id', '=', userId)
      .execute();
  }

  /** The member's read position, or undefined if not a member. */
  async readSeq(id: Id, userId: Id): Promise<number | undefined> {
    const row = await this.db.current.selectFrom('conversation_members').select('read_seq').where('conversation_id', '=', id).where('user_id', '=', userId).executeTakeFirst();
    return row?.read_seq;
  }

  /**
   * The user's conversations (or just `convId`) with read position and unread counts
   * (top-level, live, from others).
   */
  async memberStates(userId: Id, convId: Id | null = null): Promise<MemberState[]> {
    const { rows } = await sql<MemberState>`
      SELECT cm.conversation_id AS "convId", cm.read_seq AS "readSeq",
        (SELECT count(*) FROM messages m
          WHERE m.conversation_id = cm.conversation_id AND m.thread_root_id IS NULL AND m.seq > cm.read_seq
            AND m.author_id != cm.user_id AND m.deleted_at IS NULL) AS "unreadCount",
        (SELECT count(*) FROM mentions mn JOIN messages m ON m.id = mn.message_id
          WHERE mn.user_id = cm.user_id AND m.conversation_id = cm.conversation_id
            AND m.thread_root_id IS NULL AND m.seq > cm.read_seq) AS "mentionCount"
      FROM conversation_members cm WHERE cm.user_id = ${userId} AND (${convId}::text IS NULL OR cm.conversation_id = ${convId})
      ORDER BY cm.joined_at, cm.conversation_id`.execute(this.db.current);
    return rows;
  }

  async channelIdsNotJoined(userId: Id): Promise<Id[]> {
    const rows = await this.db.current
      .selectFrom('conversations as c')
      .select('c.id')
      .where('c.kind', '=', 'channel')
      .where(({ not, exists, selectFrom }) =>
        not(exists(selectFrom('conversation_members as cm').select(sql`1`.as('one')).whereRef('cm.conversation_id', '=', 'c.id').where('cm.user_id', '=', userId))),
      )
      .orderBy('c.name')
      .execute();
    return rows.map((r) => r.id);
  }
}
