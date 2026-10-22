import { type Selectable, sql } from 'kysely';
import { tokenize } from '../../../shared/search';
import type { Id, Mention, Message } from '../../../shared/types';
import { newId, toDate, toMs, type DB } from './db';
import type { MessagesTable } from './schema';

type Row = Omit<Selectable<MessagesTable>, 'search'>;

const COLUMNS = [
  'id',
  'conversation_id',
  'thread_root_id',
  'seq',
  'author_id',
  'client_msg_id',
  'text',
  'mentions_channel',
  'reply_count',
  'last_reply_seq',
  'last_reply_at',
  'version',
  'created_at',
  'updated_at',
  'edited_at',
  'deleted_at',
] as const;

const SEARCH_TIMEOUT_MS = 3000;

/** Postgres rejects longer lexemes; a word that long isn't something anyone searches for. */
const MAX_LEXEME_BYTES = 2047;

/**
 * The search vector, from the same tokenizer the client highlights with. The tokens are stored
 * as-is: `to_tsvector` would re-split them with Postgres's own parser (e.g. `foo_bar`).
 */
const searchVector = (text: string) =>
  sql`array_to_tsvector(${tokenize(text).filter((t) => Buffer.byteLength(t) <= MAX_LEXEME_BYTES)}::text[])`;

/** A tsquery literal: every term prefix-matched, except one letter, which matches the whole word. */
const toTsQuery = (terms: string[]) => terms.map((t) => `'${t.replace(/['\\]/g, '\\$&')}'${t.length > 1 ? ':*' : ''}`).join(' & ');

/** An ILIKE pattern that matches `phrase` literally anywhere in the text. */
const containsPattern = (phrase: string) => `%${phrase.replace(/[\\%_]/g, '\\$&')}%`;

export interface SearchQuery {
  convIds: Id[];
  authorId: Id | null;
  terms: string[]; // normalized words
  phrases: string[]; // lowercased, exact
  limit: number;
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

/** One timeline: a channel's top-level messages, or a thread's replies. */
export type Timeline = { convId: Id } | { rootId: Id };

/**
 * Where a page sits in its timeline, by seq: the newest, older than `before`, newer than
 * `after`, or around `around` (which falls in the newer half).
 */
export type PageCursor = { latest: true } | { before: number } | { after: number } | { around: number };

export interface Page {
  messages: Message[];
  hasBefore: boolean;
  hasAfter: boolean;
}

export interface FollowedThreadRow {
  root: Message;
  readSeq: number;
  unreadCount: number;
}

/** Keyset position in the Threads view: the last item's latest reply time and root id. */
export interface ThreadCursor {
  at: number;
  rootId: Id;
}

export interface MentionTarget {
  userId: Id;
  channelWide: boolean;
}

/** Messages and what is scoped to one: mentions and thread participants. */
export class MessageRepository {
  constructor(private readonly db: DB) {}

  /**
   * `forUpdate` locks the row until the transaction ends, for read-then-write paths that
   * must not interleave (e.g. deleting a root vs. its first reply).
   */
  async get(id: Id, { forUpdate = false } = {}): Promise<Message | undefined> {
    let query = this.db.current.selectFrom('messages').select(COLUMNS).where('id', '=', id);
    if (forUpdate) query = query.forUpdate();
    const row = await query.executeTakeFirst();
    return row && this.hydrate(row);
  }

  async findByClientMsgId(authorId: Id, clientMsgId: string): Promise<Message | undefined> {
    const row = await this.db.current.selectFrom('messages').select(COLUMNS).where('author_id', '=', authorId).where('client_msg_id', '=', clientMsgId).executeTakeFirst();
    return row && this.hydrate(row);
  }

  /**
   * A page of live messages, oldest first. Keyset over seq, so each side is one range scan
   * of the timeline's unique index; deleted messages leave gaps, which is fine.
   */
  async page(timeline: Timeline, cursor: PageCursor, limit: number): Promise<Page> {
    const live = () => {
      const query = this.db.current.selectFrom('messages').select(COLUMNS).where('deleted_at', 'is', null);
      return 'rootId' in timeline
        ? query.where('thread_root_id', '=', timeline.rootId)
        : query.where('conversation_id', '=', timeline.convId).where('thread_root_id', 'is', null);
    };
    // The page splits at seq `at`: older rows are below it, newer rows from it on. Each side
    // reads one row more than it may use, which tells whether there is more beyond.
    const at = 'latest' in cursor ? Number.MAX_SAFE_INTEGER : 'before' in cursor ? cursor.before : 'after' in cursor ? cursor.after + 1 : cursor.around;
    const olderWanted = 'after' in cursor ? 0 : limit;
    const newerWanted = 'after' in cursor || 'around' in cursor ? limit : 0;
    const [older, newer] = await Promise.all([
      live().where('seq', '<', at).orderBy('seq', 'desc').limit(olderWanted + 1).execute(),
      live().where('seq', '>=', at).orderBy('seq').limit(newerWanted + 1).execute(),
    ]);
    let olderCount = Math.min(older.length, olderWanted);
    let newerCount = Math.min(newer.length, newerWanted);
    if ('around' in cursor) {
      // Half each side; a short side leaves its share to the other.
      newerCount = Math.min(newer.length, limit - Math.min(older.length, Math.floor(limit / 2)));
      olderCount = Math.min(older.length, limit - newerCount);
    }
    return {
      messages: await this.hydrateAll([...older.slice(0, olderCount).reverse(), ...newer.slice(0, newerCount)]),
      hasBefore: older.length > olderCount,
      hasAfter: newer.length > newerCount,
    };
  }

  /** Live messages matching every term and phrase, newest first, plus how many match in all. */
  async search(q: SearchQuery): Promise<{ messages: Message[]; total: number }> {
    if (!q.convIds.length) return { messages: [], total: 0 };
    // A broad query must not tie up the database: cancel it (SQLSTATE 57014) past the timeout.
    return this.db.transaction(async () => {
      await sql`SET LOCAL statement_timeout = ${sql.lit(SEARCH_TIMEOUT_MS)}`.execute(this.db.current);
      return this.runSearch(q);
    });
  }

  private async runSearch(q: SearchQuery) {
    let query = this.db.current
      .selectFrom('messages')
      .select([...COLUMNS, sql<number>`count(*) OVER ()`.as('total')])
      .where('deleted_at', 'is', null) // also lets the planner use the partial GIN index
      .where(sql<boolean>`conversation_id = ANY(${q.convIds}::text[])`);
    if (q.authorId) query = query.where('author_id', '=', q.authorId);
    if (q.terms.length) query = query.where(sql<boolean>`search @@ ${toTsQuery(q.terms)}::tsquery`);
    for (const p of q.phrases) query = query.where(sql<boolean>`text ILIKE ${containsPattern(p)}`);
    const rows = await query.orderBy('created_at', 'desc').orderBy('id').limit(q.limit).execute();
    return { messages: await this.hydrateAll(rows), total: rows[0]?.total ?? 0 };
  }

  async insert(m: NewMessage): Promise<Id> {
    const id = newId('m_');
    await this.db.current
      .insertInto('messages')
      .values({
        id,
        conversation_id: m.convId,
        thread_root_id: m.threadRootId,
        seq: m.seq,
        author_id: m.authorId,
        client_msg_id: m.clientMsgId,
        text: m.text,
        mentions_channel: m.mentionsChannel,
        search: searchVector(m.text),
        created_at: toDate(m.createdAt),
        updated_at: toDate(m.createdAt),
      })
      .execute();
    return id;
  }

  async updateText(id: Id, text: string, mentionsChannel: boolean, at: number) {
    await this.db.current
      .updateTable('messages')
      .set((eb) => ({ text, mentions_channel: mentionsChannel, search: searchVector(text), edited_at: toDate(at), updated_at: toDate(at), version: eb('version', '+', 1) }))
      .where('id', '=', id)
      .execute();
  }

  async markDeleted(id: Id, at: number) {
    await this.db.current
      .updateTable('messages')
      .set((eb) => ({ text: '', mentions_channel: false, search: null, deleted_at: toDate(at), updated_at: toDate(at), version: eb('version', '+', 1) }))
      .where('id', '=', id)
      .execute();
  }

  async deleteMentions(id: Id) {
    await this.db.current.deleteFrom('mentions').where('message_id', '=', id).execute();
  }

  // ---------- threads ----------

  /** Allocates the next reply seq within the thread. */
  async nextReplySeq(rootId: Id): Promise<number> {
    const row = await this.db.current
      .updateTable('messages')
      .set((eb) => ({ last_reply_seq: eb('last_reply_seq', '+', 1) }))
      .where('id', '=', rootId)
      .returning('last_reply_seq')
      .executeTakeFirstOrThrow();
    return row.last_reply_seq;
  }

  /** Recomputes a root's thread summary from its live replies. Callers hold the root's row lock. */
  async refreshThreadSummary(rootId: Id, at: number) {
    await sql`
      UPDATE messages SET
        reply_count   = (SELECT count(*) FROM messages WHERE thread_root_id = ${rootId} AND deleted_at IS NULL),
        last_reply_at = (SELECT max(created_at) FROM messages WHERE thread_root_id = ${rootId} AND deleted_at IS NULL),
        updated_at = ${toDate(at)},
        version = version + 1
      WHERE id = ${rootId}`.execute(this.db.current);
  }

  /** Adds users to the thread with nothing read yet; existing participants are left alone. */
  async addThreadParticipants(rootId: Id, userIds: Id[]) {
    const unique = [...new Set(userIds)];
    if (!unique.length) return;
    await this.db.current
      .insertInto('thread_participants')
      .values(unique.map((userId) => ({ user_id: userId, root_id: rootId, read_seq: 0 })))
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  /** The replier is in the thread and has read it up to their reply. */
  async joinThread(rootId: Id, userId: Id, seq: number) {
    await this.db.current
      .insertInto('thread_participants')
      .values({ user_id: userId, root_id: rootId, read_seq: seq })
      .onConflict((oc) => oc.columns(['user_id', 'root_id']).doUpdateSet({ read_seq: sql`GREATEST(thread_participants.read_seq, excluded.read_seq)` }))
      .execute();
  }

  /** Moves a participant's read position forward only. Non-participants are not tracked. */
  async markThreadRead(rootId: Id, userId: Id, seq: number) {
    await this.db.current
      .updateTable('thread_participants')
      .set({ read_seq: sql`GREATEST(read_seq, ${seq}::bigint)` })
      .where('user_id', '=', userId)
      .where('root_id', '=', rootId)
      .execute();
  }

  async markThreadReadToEnd(rootId: Id, userId: Id) {
    await this.db.current
      .updateTable('thread_participants')
      .set((eb) => ({ read_seq: eb.selectFrom('messages').select('last_reply_seq').where('id', '=', rootId) }))
      .where('user_id', '=', userId)
      .where('root_id', '=', rootId)
      .execute();
  }

  /** The participant's read position, or null if they don't follow the thread. */
  async threadReadSeq(rootId: Id, userId: Id): Promise<number | null> {
    const row = await this.db.current.selectFrom('thread_participants').select('read_seq').where('root_id', '=', rootId).where('user_id', '=', userId).executeTakeFirst();
    return row ? row.read_seq : null;
  }

  /** Live replies by others the user hasn't read. */
  async unreadReplyCount(rootId: Id, userId: Id, afterSeq: number): Promise<number> {
    const row = await this.db.current
      .selectFrom('messages')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('thread_root_id', '=', rootId)
      .where('seq', '>', afterSeq)
      .where('author_id', '!=', userId)
      .where('deleted_at', 'is', null)
      .executeTakeFirstOrThrow();
    return row.n;
  }

  /**
   * Threads the user follows that have live replies, in conversations they're still in,
   * newest reply first, after `cursor`. Starts from the user's thread_participants rows.
   */
  async followedThreads(userId: Id, { cursor, unreadOnly, limit }: { cursor: ThreadCursor | null; unreadOnly: boolean; limit: number }): Promise<FollowedThreadRow[]> {
    const { rows } = await sql<Row & { tp_read_seq: number; unread: number }>`
      SELECT ${sql.join(COLUMNS.map((c) => sql.ref(`r.${c}`)))}, tp.read_seq AS tp_read_seq, u.unread
      FROM thread_participants tp
      JOIN messages r ON r.id = tp.root_id AND r.last_reply_at IS NOT NULL
      JOIN conversation_members cm ON cm.conversation_id = r.conversation_id AND cm.user_id = tp.user_id
      CROSS JOIN LATERAL (
        SELECT count(*) AS unread FROM messages x
        WHERE x.thread_root_id = r.id AND x.seq > tp.read_seq AND x.author_id <> tp.user_id AND x.deleted_at IS NULL
      ) u
      WHERE tp.user_id = ${userId}
        ${cursor ? sql`AND (r.last_reply_at, r.id) < (${toDate(cursor.at)}, ${cursor.rootId})` : sql``}
        ${unreadOnly ? sql`AND u.unread > 0` : sql``}
      ORDER BY r.last_reply_at DESC, r.id DESC
      LIMIT ${limit}`.execute(this.db.current);
    const roots = await this.hydrateAll(rows);
    return rows.map((r, i) => ({ root: roots[i], readSeq: r.tp_read_seq, unreadCount: r.unread }));
  }

  /** Followed threads with unread replies by others: the Threads badge. */
  async unreadThreadIds(userId: Id): Promise<Id[]> {
    const { rows } = await sql<{ id: Id }>`
      SELECT r.id FROM thread_participants tp
      JOIN messages r ON r.id = tp.root_id
      JOIN conversation_members cm ON cm.conversation_id = r.conversation_id AND cm.user_id = tp.user_id
      WHERE tp.user_id = ${userId} AND EXISTS (
        SELECT 1 FROM messages x
        WHERE x.thread_root_id = r.id AND x.seq > tp.read_seq AND x.author_id <> tp.user_id AND x.deleted_at IS NULL
      )
      ORDER BY r.id`.execute(this.db.current);
    return rows.map((r) => r.id);
  }

  /** The newest `perThread` live replies of each root, oldest first, grouped by root. */
  async latestReplies(rootIds: Id[], perThread: number): Promise<Map<Id, Message[]>> {
    const out = new Map<Id, Message[]>(rootIds.map((id) => [id, []]));
    if (!rootIds.length) return out;
    const { rows } = await sql<Row>`
      SELECT ${sql.join(COLUMNS.map((c) => sql.ref(c)))} FROM (
        SELECT *, row_number() OVER (PARTITION BY thread_root_id ORDER BY seq DESC) AS rn
        FROM messages WHERE thread_root_id = ANY(${rootIds}::text[]) AND deleted_at IS NULL
      ) x WHERE rn <= ${perThread}
      ORDER BY thread_root_id, seq`.execute(this.db.current);
    for (const m of await this.hydrateAll(rows)) out.get(m.threadRootId!)!.push(m);
    return out;
  }

  async threadParticipantIds(rootId: Id): Promise<Id[]> {
    const rows = await this.db.current.selectFrom('thread_participants').select('user_id').where('root_id', '=', rootId).orderBy('user_id').execute();
    return rows.map((r) => r.user_id);
  }

  // ---------- mentions ----------

  /** Makes `targets` the message's mentions; ones no longer targeted are removed. */
  async setMentions(id: Id, targets: MentionTarget[], at: number) {
    await this.db.current
      .deleteFrom('mentions')
      .where('message_id', '=', id)
      .where(sql<boolean>`NOT (user_id = ANY(${targets.map((t) => t.userId)}::text[]))`)
      .execute();
    if (!targets.length) return;
    await this.db.current
      .insertInto('mentions')
      .values(targets.map((t) => ({ message_id: id, user_id: t.userId, channel_wide: t.channelWide, created_at: toDate(at) })))
      .onConflict((oc) => oc.columns(['message_id', 'user_id']).doUpdateSet({ channel_wide: (eb) => eb.ref('excluded.channel_wide') }))
      .execute();
  }

  /** Marks the user's own mentions on these messages read; already-read ones keep their read_at. */
  async markMentionsRead(userId: Id, messageIds: Id[], at: number) {
    if (!messageIds.length) return;
    await this.db.current
      .updateTable('mentions')
      .set({ read_at: toDate(at) })
      .where('user_id', '=', userId)
      .where('read_at', 'is', null)
      .where(sql<boolean>`message_id = ANY(${messageIds}::text[])`)
      .execute();
  }

  private async hydrate(r: Row): Promise<Message> {
    return (await this.hydrateAll([r]))[0];
  }

  /**
   * Rows to messages in two batched queries, whatever the number of rows: their direct
   * mentions, and the reply authors of the roots among them. Extra columns are ignored.
   */
  private async hydrateAll(rows: Row[]): Promise<Message[]> {
    const live = rows.filter((r) => !r.deleted_at).map((r) => r.id);
    const roots = rows.filter((r) => r.reply_count).map((r) => r.id);
    const [mentions, authors] = await Promise.all([
      live.length
        ? this.db.current
            .selectFrom('mentions')
            .select(['message_id', 'user_id'])
            .where(sql<boolean>`message_id = ANY(${live}::text[])`)
            .where('channel_wide', '=', false)
            .orderBy('user_id')
            .execute()
        : [],
      roots.length
        ? this.db.current
            .selectFrom('messages')
            .select(['thread_root_id', 'author_id'])
            .distinct()
            .where(sql<boolean>`thread_root_id = ANY(${roots}::text[])`)
            .where('deleted_at', 'is', null)
            .orderBy('author_id')
            .execute()
        : [],
    ]);
    const group = <T,>(xs: T[], key: (x: T) => Id, value: (x: T) => Id) => {
      const out = new Map<Id, Id[]>();
      for (const x of xs) out.set(key(x), [...(out.get(key(x)) ?? []), value(x)]);
      return out;
    };
    const mentionsBy = group(mentions, (x) => x.message_id, (x) => x.user_id);
    const authorsBy = group(authors, (x) => x.thread_root_id!, (x) => x.author_id);
    return rows.map((r) => toMessage(r, mentionsBy.get(r.id) ?? [], authorsBy.get(r.id) ?? []));
  }
}

function toMessage(r: Row, userIds: Id[], participantIds: Id[]): Message {
  const mentions: Mention[] = [...(r.mentions_channel ? [{ kind: 'channel' as const }] : []), ...userIds.map((userId) => ({ kind: 'user' as const, userId }))];
  return {
    id: r.id,
    clientMsgId: r.client_msg_id,
    convId: r.conversation_id,
    seq: r.seq,
    authorId: r.author_id,
    text: r.text,
    mentions,
    threadRootId: r.thread_root_id,
    thread: r.reply_count ? { replyCount: r.reply_count, lastReplyAt: toMs(r.last_reply_at!), participantIds } : null,
    version: r.version,
    createdAt: toMs(r.created_at),
    editedAt: toMs(r.edited_at),
    deletedAt: toMs(r.deleted_at),
  };
}
