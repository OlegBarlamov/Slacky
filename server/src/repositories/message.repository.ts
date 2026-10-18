import type { Id, Mention, Message } from '../../../shared/types';
import { newId, type DB } from './db';

interface Row {
  id: Id;
  conversation_id: Id;
  thread_root_id: Id | null;
  seq: number;
  author_id: Id;
  client_msg_id: string;
  text: string;
  mentions_channel: number;
  reply_count: number;
  last_reply_at: number | null;
  created_at: number;
  updated_at: number;
  edited_at: number | null;
  deleted_at: number | null;
}

export interface NewMessage {
  convId: Id;
  threadRootId: Id | null;
  seq: number;
  authorId: Id;
  clientMsgId: string;
  text: string;
  mentionsChannel: boolean;
  createdAt: number;
}

export interface MentionTarget {
  userId: Id;
  channelWide: boolean;
}

/** Messages and what is scoped to one: mentions and thread participants. */
export class MessageRepository {
  constructor(private readonly db: DB) {}

  get(id: Id): Message | undefined {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row | undefined;
    return row && this.hydrate(row);
  }

  findByClientMsgId(authorId: Id, clientMsgId: string): Message | undefined {
    const row = this.db.prepare('SELECT * FROM messages WHERE author_id = ? AND client_msg_id = ?').get(authorId, clientMsgId) as Row | undefined;
    return row && this.hydrate(row);
  }

  /** Live top-level messages before `before` (or the newest), oldest first. */
  listChannel(convId: Id, before: number | null, limit: number): { messages: Message[]; hasMore: boolean } {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE conversation_id = ? AND thread_root_id IS NULL AND deleted_at IS NULL AND seq < ?
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(convId, before ?? Number.MAX_SAFE_INTEGER, limit + 1) as Row[];
    return { messages: rows.slice(0, limit).reverse().map((r) => this.hydrate(r)), hasMore: rows.length > limit };
  }

  /** Live replies, oldest first. */
  listReplies(rootId: Id): Message[] {
    const rows = this.db.prepare('SELECT * FROM messages WHERE thread_root_id = ? AND deleted_at IS NULL ORDER BY seq').all(rootId) as Row[];
    return rows.map((r) => this.hydrate(r));
  }

  /** Every live message, for rebuilding the search index from the source of truth. */
  allLive(): Message[] {
    return (this.db.prepare('SELECT * FROM messages WHERE deleted_at IS NULL').all() as Row[]).map((r) => this.hydrate(r));
  }

  insert(m: NewMessage): Id {
    const id = newId('m_');
    this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, thread_root_id, seq, author_id, client_msg_id, text, mentions_channel, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, m.convId, m.threadRootId, m.seq, m.authorId, m.clientMsgId, m.text, +m.mentionsChannel, m.createdAt, m.createdAt);
    return id;
  }

  updateText(id: Id, text: string, mentionsChannel: boolean, at: number) {
    this.db.prepare('UPDATE messages SET text = ?, mentions_channel = ?, edited_at = ?, updated_at = ? WHERE id = ?').run(text, +mentionsChannel, at, at, id);
  }

  markDeleted(id: Id, at: number) {
    this.db.prepare("UPDATE messages SET text = '', mentions_channel = 0, deleted_at = ?, updated_at = ? WHERE id = ?").run(at, at, id);
  }

  deleteMentions(id: Id) {
    this.db.prepare('DELETE FROM mentions WHERE message_id = ?').run(id);
  }

  // ---------- threads ----------

  /** Allocates the next reply seq within the thread. */
  nextReplySeq(rootId: Id): number {
    return this.db.prepare('UPDATE messages SET last_reply_seq = last_reply_seq + 1 WHERE id = ? RETURNING last_reply_seq').pluck().get(rootId) as number;
  }

  /** Recomputes a root's thread summary from its live replies. */
  refreshThreadSummary(rootId: Id, at: number) {
    this.db
      .prepare(
        `UPDATE messages SET
           reply_count   = (SELECT count(*) FROM messages WHERE thread_root_id = :id AND deleted_at IS NULL),
           last_reply_at = (SELECT max(created_at) FROM messages WHERE thread_root_id = :id AND deleted_at IS NULL),
           updated_at = :at
         WHERE id = :id`,
      )
      .run({ id: rootId, at });
  }

  /** Adds users to the thread with nothing read yet; existing participants are left alone. */
  addThreadParticipants(rootId: Id, userIds: Id[]) {
    const insert = this.db.prepare('INSERT INTO thread_participants (user_id, root_id, read_seq) VALUES (?, ?, 0) ON CONFLICT DO NOTHING');
    for (const userId of new Set(userIds)) insert.run(userId, rootId);
  }

  /** The replier is in the thread and has read it up to their reply. */
  joinThread(rootId: Id, userId: Id, seq: number) {
    this.db
      .prepare(
        `INSERT INTO thread_participants (user_id, root_id, read_seq) VALUES (?, ?, ?)
         ON CONFLICT DO UPDATE SET read_seq = max(read_seq, excluded.read_seq)`,
      )
      .run(userId, rootId, seq);
  }

  /** Moves a participant's read position forward only. Non-participants are not tracked. */
  markThreadRead(rootId: Id, userId: Id, seq: number) {
    this.db.prepare('UPDATE thread_participants SET read_seq = max(read_seq, ?) WHERE user_id = ? AND root_id = ?').run(seq, userId, rootId);
  }

  markThreadReadToEnd(rootId: Id, userId: Id) {
    this.db
      .prepare(
        `UPDATE thread_participants SET read_seq = (SELECT last_reply_seq FROM messages WHERE id = :root)
         WHERE user_id = :user AND root_id = :root`,
      )
      .run({ user: userId, root: rootId });
  }

  threadParticipantIds(rootId: Id): Id[] {
    return this.db.prepare('SELECT user_id FROM thread_participants WHERE root_id = ? ORDER BY user_id').pluck().all(rootId) as Id[];
  }

  // ---------- mentions ----------

  /** Makes `targets` the message's mentions; ones no longer targeted are removed. */
  setMentions(id: Id, targets: MentionTarget[], at: number) {
    this.db
      .prepare('DELETE FROM mentions WHERE message_id = ? AND user_id NOT IN (SELECT value FROM json_each(?))')
      .run(id, JSON.stringify(targets.map((t) => t.userId)));
    const upsert = this.db.prepare(
      'INSERT INTO mentions (message_id, user_id, channel_wide, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET channel_wide = excluded.channel_wide',
    );
    for (const t of targets) upsert.run(id, t.userId, +t.channelWide, at);
  }

  /** Marks the user's own mentions on these messages read; already-read ones keep their read_at. */
  markMentionsRead(userId: Id, messageIds: Id[], at: number) {
    this.db
      .prepare('UPDATE mentions SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND message_id IN (SELECT value FROM json_each(?))')
      .run(at, userId, JSON.stringify(messageIds));
  }

  private hydrate(r: Row): Message {
    const userIds = r.deleted_at
      ? []
      : (this.db.prepare('SELECT user_id FROM mentions WHERE message_id = ? AND channel_wide = 0').pluck().all(r.id) as Id[]);
    const mentions: Mention[] = [...(r.mentions_channel ? [{ kind: 'channel' as const }] : []), ...userIds.map((userId) => ({ kind: 'user' as const, userId }))];

    const participantIds = r.reply_count
      ? (this.db.prepare('SELECT DISTINCT author_id FROM messages WHERE thread_root_id = ? AND deleted_at IS NULL').pluck().all(r.id) as Id[])
      : [];

    return {
      id: r.id,
      clientMsgId: r.client_msg_id,
      convId: r.conversation_id,
      seq: r.seq,
      authorId: r.author_id,
      text: r.text,
      mentions,
      threadRootId: r.thread_root_id,
      thread: r.reply_count ? { replyCount: r.reply_count, lastReplyAt: r.last_reply_at!, participantIds } : null,
      version: r.updated_at,
      createdAt: r.created_at,
      editedAt: r.edited_at,
      deletedAt: r.deleted_at,
    };
  }
}
