# Slacky: design notes

A Slack-like app: channels, DMs (including one with yourself), threads, mentions, an activity
feed and search. React client, Fastify + SQLite server, both speaking the contract in `shared/`.

## Layout

```
shared/        API types, channel naming, search query language
client/src/    transport (api, SSE reader) · state (Zustand store) · ui (React)
server/src/
  api/            HTTP routes: parse input, call a service, pick a status. No business logic.
  services/       all rules; every write is one transaction; events published after commit
  repositories/   the only place with SQL
  events-system/  in-memory event bus: one queue per listener
  listeners/      search, notifications, realtime
  externals/      fake external systems (search index, notification sender) + simulated network
  realtime/       SSE hub with a replay buffer
```

## Data model (SQLite, `server/chat.db`)

| Table | Purpose |
|---|---|
| `users` | unique name (`channel` and `here` are reserved) |
| `conversations` | channels and DMs. A DM's name is `dm:<sorted member ids>`, so `UNIQUE(name)` allows one DM per pair. `last_seq` numbers top-level messages; `last_message_at` orders DMs |
| `conversation_members` | membership + `read_seq`: unread = top-level messages with `seq > read_seq` |
| `messages` | top-level and replies. `seq` is the position in the channel, or in the thread for replies. Roots keep `reply_count`, `last_reply_seq`, `last_reply_at`. `updated_at` is sent as `version` |
| `mentions` | one row per mentioned user (`@channel` expanded), with `read_at`. Live mentions only |
| `thread_participants` | who is in a thread + their `read_seq` in it |

On start the server creates any missing tables (no migrations: delete `chat.db*` after a schema
change) and makes sure `#general` exists. Registering adds the user to `#general` and creates
their self-DM, in the same transaction.

## How a message travels

```
POST /api/conversations/:id/messages {clientMsgId, text}
  └─ one transaction: message, mentions, read position, thread summary/participants
  └─ after commit: publish message.created (snapshot: message, previous, root, participants)

InMemoryEventBus ── each listener has its own FIFO queue, retries and dead-letter queue
  ├─▶ search         → search index (400 ms latency, 10% failures by default)
  ├─▶ notifications  → notification sender (200 ms, 10%)
  └─▶ realtime       → SSE hub → members' streams: the message + their refreshed feed items
```

The client sends optimistically and confirms with the response. The SSE echo of its own
message is dropped, because its version isn't newer.

## Guarantees

| Guaranteed | How |
|---|---|
| A write is all or nothing | one `BEGIN IMMEDIATE` transaction per action |
| A retried send doesn't duplicate | `UNIQUE(author_id, client_msg_id)` returns the original |
| No event for a write that didn't happen | publish after commit; none for rollbacks, retries or no-op edits |
| One slow or failing system doesn't block the others | a queue per listener |
| Each listener gets every event, in order, while the process runs | FIFO queue; retries with backoff and jitter; 10 s timeout; 5 attempts, then the dead-letter queue |
| Duplicates are harmless | search ignores older versions and keeps deletes final; notifications dedupe on `message:recipient`; realtime recomputes from the DB; clients drop older versions |
| Search never shows deleted or inaccessible messages | the index is queried only over your conversations, and every hit is re-checked against the DB |
| Search says when it's down, rather than returning nothing | one retry, then 503 |
| The search index matches the DB after a restart | rebuilt from the DB on startup |
| Realtime resumes after a reconnect | SSE ids; `Last-Event-ID` replays from a 1,000-event buffer, otherwise `resync` |
| Committed data survives restarts | SQLite file in WAL mode |

**Not guaranteed:**
- **Events across a crash.** There's no outbox. If the process dies between commit and
  publish, or with events still queued, they're lost: missed notifications and live updates,
  and search stays behind until the next restart. Fix: write events to an outbox table in
  the same transaction.
- **Search seeing your write right away.** The index lags. The API reports `pendingChanges`
  and the UI shows "catching up".
- **Order after a dead letter.** Replaying a dead-lettered event delivers it late. Version
  guards keep search correct.
- **Exactly-once notifications at a real provider.** Our fake dedupes by key; a real
  provider could double-send after a timeout. A notification can also go out for a message
  deleted a moment later.
- **More than one server process.** The bus and the SSE hub are in memory.
- **Sessions across restarts,** unless `SESSION_SECRET` is set.
- **Distinct versions for two changes in the same millisecond** (`version` is `updated_at`).

**Strict FIFO** means a failing event holds up only its own listener, for at most about
50 s (5 attempts with 10 s timeouts) before it's dead-lettered.

## Activity feed: what deserves attention

The feed is read from the core tables, so it always matches the DB. The realtime listener
pushes changed items live.

| Item | When | Grouping |
|---|---|---|
| `mention:<message>` | someone @mentions you, or uses `@channel`, in a channel you're in | one per message; `channelWide` marks `@channel` |
| `dm:<conversation>` | someone else writes in a DM with you | unread messages, or the last one once read |
| `thread:<root>` | a thread you're in | unread replies from others, or the latest reply once read |

- **Thread participants:**
  - in a channel: the root author and users the root @mentions directly (added when the first
    reply arrives), every replier, and anyone @mentioned in a reply;
  - in a DM: both members, from the first reply on.
- **A thread shows as soon as you reply,** marked read. Reading alone doesn't make you a
  participant.
- **Not attention-worthy:** ordinary channel messages (unread badges cover those) and your own
  messages (self-mentions don't count).
- **One message can produce two items:** a mention inside a thread reply shows as a mention
  and in the thread item. Mentions in DMs don't create separate items.
- **Edits don't move an item up;** only new messages do.
- **Read state:**
  - mentions have a read flag;
  - DMs and threads move their read position to the end;
  - opening a conversation or thread marks its items read.

### Mention rules

- **@name in a channel reaches anyone.** Channels are open, so a mentioned non-member joins it
  in the same transaction. For a top-level message, their unread history starts at that
  message. For a reply, they also join the thread. Their client hears about the channel
  before the message.
- **@name in a DM** only reaches its members; you can't pull a third person in.
- `@channel` works in top-level messages only. In a reply it's plain text: a thread shouldn't
  ping the whole channel.
- `@here` isn't supported. It's plain text everywhere.

### Edited and deleted

- **Edited:** items show the current text, marked "(edited)", and keep their position.
- **Mention edited away:** the mention row is deleted, so the item disappears.
- **Deleted:**
  - the text is wiped and the row kept as a tombstone, so ids never dangle;
  - its mentions are deleted, so its mention items disappear;
  - it drops out of DM and thread groups;
  - deleted messages are left out of channel history.
- **A message with replies can't be deleted** (409), so a thread never loses its root.

## Search

- **Separate system** (`externals/search-index.ts`), in memory:
  - indexing is fed by the search listener;
  - queries go through the simulated network, so they can be slow or fail.
- **Tokenizer** (`shared/search.ts`): lowercases, strips accents, folds simple plurals, drops
  stopwords. Client highlighting uses the same code.
- **Query language:**
  - every word must match, as a word or a word prefix (`depl` finds `deploy`);
  - `"exact phrase"`;
  - `from:@name` and `in:#channel` filters.
- **Results:** newest first, up to 50 (100 max), with no relevance ranking or paging. Each query scans the whole index.

## Client notes

- **Auth:** `POST /api/auth/register|login {name}` sets a signed, HttpOnly `sid` cookie. Name-only
  login means anyone can be anyone; that's on purpose for the exercise. Vite proxies `/api` to
  `localhost:3001`, so the cookie needs no CORS setup.
- **SSE:** read over `fetch` instead of `EventSource`, so the client sees 401s and sends
  `Last-Event-ID` itself; it reconnects with backoff.
- **Unknown users:** when the client meets a user id it doesn't know (someone who registered
  later), it fetches `GET /api/users/:id` once.
- **Hiding a conversation** is a client-only preference, kept in a per-user cookie on that
  device. It comes back when it's open, or when it has an unread DM or mention for you.
- **Several people:** use different browsers or profiles; all tabs of one profile share a
  session.

## Borrowed vs. changed

- **Borrowed from Slack:** layout, thread pane, Up-arrow to edit, the "New" divider,
  `@channel` (top-level only), and joining a thread by replying or being mentioned.
- **Changed:**
  - DM and thread activity is grouped, not one row per event;
  - `@channel` is styled lower priority;
  - mentions that are edited away or deleted vanish instead of leaving a trace;
  - messages with replies can't be deleted.

## Corners cut knowingly

- No outbox (see "Not guaranteed"), no migrations, and an in-memory search index that scans
  every document.
- The realtime listener recomputes a user's whole feed to find one changed item.
- A page of messages takes about two small queries per message.
- No reactions, thread unfollow, private channels, group DMs, files, presence or typing
  indicators.
- Edits are last-writer-wins, which is safe because only the author can edit.
- Request validation is hand-rolled, not schema-based.
