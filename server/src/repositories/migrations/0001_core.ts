// Core store. Every user action is one transaction across these tables.
import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>) {
  await sql`
    CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;

    CREATE TABLE users (
      id         text PRIMARY KEY,  -- app-generated opaque ids; the prefix helps debugging
      name       citext NOT NULL UNIQUE CHECK (name ~ '^[a-z0-9][a-z0-9._-]{1,19}$'),
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE conversations (
      id              text PRIMARY KEY,
      kind            text NOT NULL CHECK (kind IN ('channel', 'dm')),
      name            text,                        -- channels only
      dm_key          text,                        -- DMs only: sorted member ids, so a pair has one DM
      last_seq        bigint NOT NULL DEFAULT 0,   -- allocator for top-level messages.seq
      last_message_at timestamptz,                 -- newest top-level message: orders the DM list
      created_at      timestamptz NOT NULL DEFAULT now(),
      CHECK ((kind = 'channel') = (name IS NOT NULL) AND (kind = 'dm') = (dm_key IS NOT NULL))
    );
    CREATE UNIQUE INDEX conversations_channel_name ON conversations (name) WHERE kind = 'channel';
    CREATE UNIQUE INDEX conversations_dm_key ON conversations (dm_key) WHERE kind = 'dm';

    CREATE TABLE conversation_members (
      conversation_id text NOT NULL REFERENCES conversations(id),
      user_id         text NOT NULL REFERENCES users(id),
      read_seq        bigint NOT NULL DEFAULT 0,  -- read up to this top-level seq; unread = seq > read_seq
      joined_at       timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (conversation_id, user_id)
    );
    CREATE INDEX conversation_members_by_user ON conversation_members (user_id);

    CREATE TABLE messages (
      id               text PRIMARY KEY,
      conversation_id  text NOT NULL REFERENCES conversations(id),
      thread_root_id   text REFERENCES messages(id),  -- NULL = top-level
      seq              bigint NOT NULL,               -- position in its timeline: the channel, or the thread for replies
      author_id        text NOT NULL REFERENCES users(id),
      client_msg_id    text NOT NULL,                 -- idempotency key chosen by the sender
      text             text NOT NULL,                 -- '' once deleted
      mentions_channel boolean NOT NULL DEFAULT false,  -- @channel, top-level messages only
      reply_count      int NOT NULL DEFAULT 0,        -- roots only: live replies
      last_reply_seq   bigint NOT NULL DEFAULT 0,     -- roots only: allocator for replies' seq
      last_reply_at    timestamptz,                   -- roots only: newest live reply
      version          bigint NOT NULL DEFAULT 1,     -- bumped on every change, incl. thread summary; Message.version
      search           tsvector,                      -- written by the app from the shared/search tokenizer
      created_at       timestamptz NOT NULL,
      updated_at       timestamptz NOT NULL,
      edited_at        timestamptz,
      deleted_at       timestamptz,
      CONSTRAINT messages_author_client_msg_id UNIQUE (author_id, client_msg_id)
    );
    CREATE UNIQUE INDEX messages_channel_seq ON messages (conversation_id, seq) WHERE thread_root_id IS NULL;
    CREATE UNIQUE INDEX messages_thread_seq ON messages (thread_root_id, seq) WHERE thread_root_id IS NOT NULL;
    CREATE INDEX messages_search ON messages USING gin (search) WHERE deleted_at IS NULL;

    -- Live mentions only: one row per mentioned user, @channel expanded to members. Rows go away
    -- when an edit drops the mention or the message is deleted.
    CREATE TABLE mentions (
      message_id   text NOT NULL REFERENCES messages(id),
      user_id      text NOT NULL REFERENCES users(id),
      channel_wide boolean NOT NULL DEFAULT false,  -- came from @channel, not @name
      created_at   timestamptz NOT NULL,
      read_at      timestamptz,
      PRIMARY KEY (message_id, user_id)
    );
    CREATE INDEX mentions_by_user ON mentions (user_id, created_at DESC);
    CREATE INDEX mentions_unread_by_user ON mentions (user_id) WHERE read_at IS NULL;

    -- Who is in a thread, and how far they've read. Added when the thread starts (root author,
    -- users @mentioned in the root), when replying, and when @mentioned in a reply. Reading
    -- alone doesn't add you.
    CREATE TABLE thread_participants (
      user_id  text NOT NULL REFERENCES users(id),
      root_id  text NOT NULL REFERENCES messages(id),
      read_seq bigint NOT NULL,  -- read up to this reply seq
      PRIMARY KEY (user_id, root_id)  -- also serves lookups by user
    );
    CREATE INDEX thread_participants_by_root ON thread_participants (root_id);
  `.execute(db);
}

export async function down(db: Kysely<unknown>) {
  await sql`DROP TABLE thread_participants, mentions, messages, conversation_members, conversations, users`.execute(db);
}
