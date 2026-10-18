import type { Conversation, Id } from '../../../shared/types';
import { newId, type DB } from './db';

export interface MemberState {
  convId: Id;
  readSeq: number;
  unreadCount: number;
  mentionCount: number;
}

export class ConversationRepository {
  constructor(private readonly db: DB) {}

  /** Returns null if the name is taken (UNIQUE(name) decides, no lookup first). */
  create(kind: Conversation['kind'], name: string, at: number): Id | null {
    const id = this.db
      .prepare('INSERT INTO conversations (id, kind, name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO NOTHING RETURNING id')
      .pluck()
      .get(newId(kind === 'channel' ? 'c_' : 'd_'), kind, name, at) as Id | undefined;
    return id ?? null;
  }

  /** Adds the users that exist and returns how many were added. */
  addMembers(id: Id, userIds: Id[]): number {
    return this.db
      .prepare('INSERT INTO conversation_members (conversation_id, user_id) SELECT ?, id FROM users WHERE id IN (SELECT value FROM json_each(?))')
      .run(id, JSON.stringify(userIds)).changes;
  }

  /**
   * Joins with history read up to `readSeq` (default: everything so far, so nothing is unread).
   * Returns false if already a member.
   */
  join(id: Id, userId: Id, readSeq: number | null = null): boolean {
    return (
      this.db
        .prepare(
          `INSERT INTO conversation_members (conversation_id, user_id, read_seq)
           SELECT id, ?, coalesce(?, last_seq) FROM conversations WHERE id = ? ON CONFLICT DO NOTHING`,
        )
        .run(userId, readSeq, id).changes > 0
    );
  }

  /** Returns false if not a member. */
  leave(id: Id, userId: Id): boolean {
    return this.db.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?').run(id, userId).changes > 0;
  }

  get(id: Id): Conversation | undefined {
    const c = this.db.prepare('SELECT id, kind, name, created_at FROM conversations WHERE id = ?').get(id) as
      | { id: Id; kind: Conversation['kind']; name: string; created_at: number }
      | undefined;
    if (!c) return undefined;
    const memberIds = this.db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ? ORDER BY user_id').pluck().all(id) as Id[];
    return { id: c.id, kind: c.kind, name: c.kind === 'dm' ? null : c.name, memberIds, createdAt: c.created_at };
  }

  findIdByName(name: string): Id | undefined {
    return this.db.prepare('SELECT id FROM conversations WHERE name = ?').pluck().get(name) as Id | undefined;
  }

  /** Allocates the next top-level seq and records the conversation's latest activity. */
  nextSeq(id: Id, at: number): number {
    return this.db
      .prepare('UPDATE conversations SET last_seq = last_seq + 1, last_message_at = ? WHERE id = ? RETURNING last_seq')
      .pluck()
      .get(at, id) as number;
  }

  /** Moves the member's read position forward only. */
  markRead(id: Id, userId: Id, seq: number) {
    this.db.prepare('UPDATE conversation_members SET read_seq = max(read_seq, ?) WHERE conversation_id = ? AND user_id = ?').run(seq, id, userId);
  }

  markAllRead(id: Id, userId: Id) {
    this.db
      .prepare('UPDATE conversation_members SET read_seq = (SELECT last_seq FROM conversations WHERE id = ?) WHERE conversation_id = ? AND user_id = ?')
      .run(id, id, userId);
  }

  /** The user's conversations with read position and unread counts (top-level, live, from others). */
  memberStates(userId: Id): MemberState[] {
    return this.db
      .prepare(
        `SELECT cm.conversation_id AS convId, cm.read_seq AS readSeq,
           (SELECT count(*) FROM messages m
             WHERE m.conversation_id = cm.conversation_id AND m.thread_root_id IS NULL AND m.seq > cm.read_seq
               AND m.author_id != cm.user_id AND m.deleted_at IS NULL) AS unreadCount,
           (SELECT count(*) FROM mentions mn JOIN messages m ON m.id = mn.message_id
             WHERE mn.user_id = cm.user_id AND m.conversation_id = cm.conversation_id
               AND m.thread_root_id IS NULL AND m.seq > cm.read_seq) AS mentionCount
         FROM conversation_members cm WHERE cm.user_id = ?`,
      )
      .all(userId) as MemberState[];
  }

  channelIdsNotJoined(userId: Id): Id[] {
    return this.db
      .prepare(
        `SELECT id FROM conversations c WHERE kind = 'channel'
           AND NOT EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id = c.id AND cm.user_id = ?)
         ORDER BY name`,
      )
      .pluck()
      .all(userId) as Id[];
  }
}
