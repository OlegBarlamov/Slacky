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
  dms(userId: Id, limit: number): FeedPosition[] {
    return this.db
      .prepare(
        `SELECT c.id, cm.read_seq AS readSeq FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
         WHERE cm.user_id = ? AND c.kind = 'dm' AND c.last_message_at IS NOT NULL
         ORDER BY c.last_message_at DESC LIMIT ?`,
      )
      .all(userId, limit) as FeedPosition[];
  }

  /** Mentions of me in channels I'm still in, newest first. DMs are left to the DM items. */
  mentions(userId: Id, limit: number): FeedMention[] {
    const rows = this.db
      .prepare(
        `SELECT mn.message_id AS messageId, mn.channel_wide AS channelWide, mn.read_at AS readAt, mn.created_at AS createdAt
         FROM mentions mn
         JOIN messages m ON m.id = mn.message_id
         JOIN conversations c ON c.id = m.conversation_id AND c.kind = 'channel'
         JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = mn.user_id
         WHERE mn.user_id = ?
         ORDER BY mn.created_at DESC LIMIT ?`,
      )
      .all(userId, limit) as (Omit<FeedMention, 'channelWide'> & { channelWide: number })[];
    return rows.map((r) => ({ ...r, channelWide: !!r.channelWide }));
  }

  /** Threads I'm a participant of, in conversations I'm still in, by latest reply. */
  threads(userId: Id, limit: number): FeedPosition[] {
    return this.db
      .prepare(
        `SELECT r.id, tp.read_seq AS readSeq
         FROM thread_participants tp
         JOIN messages r ON r.id = tp.root_id AND r.last_reply_at IS NOT NULL
         JOIN conversation_members cm ON cm.conversation_id = r.conversation_id AND cm.user_id = tp.user_id
         WHERE tp.user_id = ?
         ORDER BY r.last_reply_at DESC LIMIT ?`,
      )
      .all(userId, limit) as FeedPosition[];
  }

  /** Ids of live top-level messages by others after `afterSeq`, newest first. */
  dmMessagesFromOthers(convId: Id, userId: Id, afterSeq: number, limit: number): Id[] {
    return this.db
      .prepare(
        `SELECT id FROM messages
         WHERE conversation_id = ? AND thread_root_id IS NULL AND seq > ? AND author_id != ? AND deleted_at IS NULL
         ORDER BY seq DESC LIMIT ?`,
      )
      .pluck()
      .all(convId, afterSeq, userId, limit) as Id[];
  }

  /** Ids of live replies after `afterSeq`, newest first; `excludeAuthorId` skips that user's own. */
  replies(rootId: Id, excludeAuthorId: Id | null, afterSeq: number, limit: number): Id[] {
    return this.db
      .prepare(
        `SELECT id FROM messages
         WHERE thread_root_id = ? AND seq > ? AND author_id != coalesce(?, '') AND deleted_at IS NULL
         ORDER BY seq DESC LIMIT ?`,
      )
      .pluck()
      .all(rootId, afterSeq, excludeAuthorId, limit) as Id[];
  }
}
