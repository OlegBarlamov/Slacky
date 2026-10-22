import { sql } from 'kysely';
import type { Id } from '../../../shared/types';
import type { DB } from './db';

export interface FeedMention {
  messageId: Id;
  channelWide: boolean;
  readAt: number | null;
  createdAt: number;
}

export interface FeedPosition {
  id: Id; // conversation id for DMs, root id for threads
  readSeq: number;
}

/** Read-side queries behind the activity feed. Every query only returns what the user can still see. */
export class FeedRepository {
  constructor(private readonly db: DB) {}

  /** My DMs that have messages, newest activity first. */
  async dms(userId: Id, limit: number): Promise<FeedPosition[]> {
    const { rows } = await sql<FeedPosition>`
      SELECT c.id, cm.read_seq AS "readSeq" FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
      WHERE cm.user_id = ${userId} AND c.kind = 'dm' AND c.last_message_at IS NOT NULL
      ORDER BY c.last_message_at DESC LIMIT ${limit}`.execute(this.db.current);
    return rows;
  }

  /** Mentions of me in channels I'm still in, newest first. DMs are left to the DM items. */
  async mentions(userId: Id, limit: number): Promise<FeedMention[]> {
    const { rows } = await sql<{ messageId: Id; channelWide: boolean; readAt: Date | null; createdAt: Date }>`
      SELECT mn.message_id AS "messageId", mn.channel_wide AS "channelWide", mn.read_at AS "readAt", mn.created_at AS "createdAt"
      FROM mentions mn
      JOIN messages m ON m.id = mn.message_id
      JOIN conversations c ON c.id = m.conversation_id AND c.kind = 'channel'
      JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = mn.user_id
      WHERE mn.user_id = ${userId}
      ORDER BY mn.created_at DESC LIMIT ${limit}`.execute(this.db.current);
    return rows.map((r) => ({ ...r, readAt: r.readAt && r.readAt.getTime(), createdAt: r.createdAt.getTime() }));
  }

  /** Threads I'm a participant of, in conversations I'm still in, by latest reply. */
  async threads(userId: Id, limit: number): Promise<FeedPosition[]> {
    const { rows } = await sql<FeedPosition>`
      SELECT r.id, tp.read_seq AS "readSeq"
      FROM thread_participants tp
      JOIN messages r ON r.id = tp.root_id AND r.last_reply_at IS NOT NULL
      JOIN conversation_members cm ON cm.conversation_id = r.conversation_id AND cm.user_id = tp.user_id
      WHERE tp.user_id = ${userId}
      ORDER BY r.last_reply_at DESC LIMIT ${limit}`.execute(this.db.current);
    return rows;
  }

  /** Ids of live top-level messages by others after `afterSeq`, newest first. */
  async dmMessagesFromOthers(convId: Id, userId: Id, afterSeq: number, limit: number): Promise<Id[]> {
    const rows = await this.db.current
      .selectFrom('messages')
      .select('id')
      .where('conversation_id', '=', convId)
      .where('thread_root_id', 'is', null)
      .where('seq', '>', afterSeq)
      .where('author_id', '!=', userId)
      .where('deleted_at', 'is', null)
      .orderBy('seq', 'desc')
      .limit(limit)
      .execute();
    return rows.map((r) => r.id);
  }

  /** Ids of live replies after `afterSeq`, newest first; `excludeAuthorId` skips that user's own. */
  async replies(rootId: Id, excludeAuthorId: Id | null, afterSeq: number, limit: number): Promise<Id[]> {
    let query = this.db.current.selectFrom('messages').select('id').where('thread_root_id', '=', rootId).where('seq', '>', afterSeq).where('deleted_at', 'is', null);
    if (excludeAuthorId) query = query.where('author_id', '!=', excludeAuthorId);
    const rows = await query.orderBy('seq', 'desc').limit(limit).execute();
    return rows.map((r) => r.id);
  }
}
