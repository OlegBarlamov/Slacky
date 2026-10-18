-- Core store. Every user action is one transaction across these tables.

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('channel', 'dm')),
  name            TEXT NOT NULL UNIQUE,  -- channel name, or 'dm:<sorted member ids>' so a pair has one DM
  last_seq        INTEGER NOT NULL DEFAULT 0,  -- allocator for top-level messages.seq
  last_message_at INTEGER,                     -- newest top-level message: orders the DM list
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  user_id         TEXT NOT NULL REFERENCES users(id),
  read_seq        INTEGER NOT NULL DEFAULT 0,  -- read up to this top-level seq; unread = seq > read_seq
  PRIMARY KEY (conversation_id, user_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS members_by_user ON conversation_members(user_id);

CREATE TABLE IF NOT EXISTS messages (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id),
  thread_root_id   TEXT REFERENCES messages(id),  -- NULL = top-level
  seq              INTEGER NOT NULL,  -- position in its timeline: the channel, or the thread for replies
  author_id        TEXT NOT NULL REFERENCES users(id),
  client_msg_id    TEXT NOT NULL,     -- idempotency key chosen by the sender
  text             TEXT NOT NULL,     -- '' once deleted
  mentions_channel INTEGER NOT NULL DEFAULT 0,  -- @channel, top-level messages only
  reply_count      INTEGER NOT NULL DEFAULT 0,  -- roots only: live replies
  last_reply_seq   INTEGER NOT NULL DEFAULT 0,  -- roots only: allocator for replies' seq
  last_reply_at    INTEGER,                     -- roots only: newest live reply
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,  -- any change, incl. thread summary; exposed as Message.version
  edited_at        INTEGER,
  deleted_at       INTEGER,
  UNIQUE (author_id, client_msg_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS messages_channel ON messages(conversation_id, seq) WHERE thread_root_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS messages_thread ON messages(thread_root_id, seq) WHERE thread_root_id IS NOT NULL;

-- Live mentions only: one row per mentioned user, @channel expanded to members. Rows go away
-- when an edit drops the mention or the message is deleted.
CREATE TABLE IF NOT EXISTS mentions (
  message_id  TEXT NOT NULL REFERENCES messages(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  channel_wide INTEGER NOT NULL DEFAULT 0,  -- came from @channel, not @name
  created_at  INTEGER NOT NULL,
  read_at     INTEGER,
  PRIMARY KEY (message_id, user_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS mentions_by_user ON mentions(user_id, created_at DESC);

-- Who is in a thread, and how far they've read. Added when the thread starts (root author,
-- users @mentioned in the root), when replying, and when @mentioned in a reply. Reading
-- alone doesn't add you.
CREATE TABLE IF NOT EXISTS thread_participants (
  user_id  TEXT NOT NULL REFERENCES users(id),
  root_id  TEXT NOT NULL REFERENCES messages(id),
  read_seq INTEGER NOT NULL,  -- read up to this reply seq
  PRIMARY KEY (user_id, root_id)
) WITHOUT ROWID;
