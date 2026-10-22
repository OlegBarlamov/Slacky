# Slacky: design notes

A Slack-like app: channels, DMs (including one with yourself), threads, mentions, an activity
feed and search. React client, Fastify + PostgreSQL server, both speaking the contract in `shared/`.

## Layout

```
shared/        API types, channel naming, search query language
client/src/    transport (api, SSE reader) · state (Zustand store) · ui (React)
server/src/
  api/            HTTP routes: parse input, call a service, pick a status. No business logic.
  services/       all rules; every write is one transaction, and its events are published inside it
  repositories/   the only place with SQL
  events-system/  transactional publisher; pg-boss bus (durable) and in-memory bus (tests): a queue per listener
  listeners/      notifications, realtime
  externals/      fake external systems (notification sender) + simulated network
  realtime/       SSE hub with a replay buffer
cli/           `slacky` command-line client over the same HTTP API
docker/        local Postgres (`docker-compose.yml`) for dev and tests
```

## Data model (PostgreSQL, `server/src/repositories/migrations/`)

| Table | Purpose |
|---|---|
| `users` | unique, case-insensitive (`citext`) name, format checked by the DB (`channel` and `here` are reserved) |
| `conversations` | channels (`name`, unique among channels) and DMs (`dm_key` = sorted member ids, unique among DMs, so one DM per pair). `last_seq` numbers top-level messages; `last_message_at` orders DMs |
| `conversation_members` | membership + `read_seq`: unread = top-level messages with `seq > read_seq` |
| `messages` | top-level and replies. `seq` is the position in the channel, or in the thread for replies. Roots keep `reply_count`, `last_reply_seq`, `last_reply_at`. `version` is a counter bumped on every change (incl. thread summary). `search` is a `tsvector` of the shared tokenizer's tokens, written in the same transaction (partial GIN index on live messages) |
| `mentions` | one row per mentioned user (`@channel` expanded), with `read_at`. Live mentions only |
| `thread_participants` | who is in a thread + their `read_seq` in it |
| `notification_deliveries` | the notifications listener's ledger: one row per (message, recipient) |

Events are pg-boss jobs in the `pgboss` schema, created by pg-boss itself, not by our migrations.

Migrations run as a release step (`npm run migrate -w server`; `npm run dev` runs them first).
On start the server makes sure `#general` exists. Registering adds the user to `#general` and
creates their self-DM, in the same transaction.

## How a message travels

```
POST /api/conversations/:id/messages {clientMsgId, text}
  └─ one transaction: message, search vector, mentions, read position, thread summary/participants
       └─ publish message.created (snapshot: message, previous, root, participants)
          → before commit: one pg-boss job per listener, on the same transaction

pg-boss workers ── each listener has its own queue, retries with backoff and a dead-letter queue
  ├─▶ notifications  → ledger → notification sender (200 ms, 10%)
  └─▶ realtime       → SSE hub → members' streams: the message + their refreshed feed items
                       (one job at a time, oldest first)
```

The client sends optimistically and confirms with the response. The SSE echo of its own
message is dropped, because its version isn't newer.

## Guarantees

| Guaranteed | How |
|---|---|
| A write is all or nothing | one Postgres transaction per action (READ COMMITTED); per-conversation seq allocation and `FOR UPDATE` on thread roots serialise the read-then-write paths |
| A retried send doesn't duplicate | `UNIQUE(author_id, client_msg_id)` returns the original |
| Every committed write produces its events, and only committed writes do | events are pg-boss jobs inserted in the write's transaction; none for rollbacks, retries or no-op edits |
| Events survive crashes, deploys and a stopped worker | jobs are rows in Postgres; a job whose worker dies runs again (at least once) |
| One slow or failing system doesn't block the others | a queue per listener |
| Each listener gets every event | retries with exponential backoff; 10 s handler timeout; then the listener's dead-letter queue, kept 30 days, listed and retried with `npm run ops -w server -- dlq …` |
| Duplicates are harmless | notifications go through a ledger (`notification_deliveries`, key `message:recipient`, also the provider's idempotency key); realtime recomputes from the DB; clients drop older versions |
| A notification isn't sent for a message deleted (or a mention edited away) before it went out | the notifications listener re-checks the message before sending |
| Search matches the DB as soon as a write commits | the search vector is written in the message's transaction and queried with Postgres FTS |
| Search never shows deleted or inaccessible messages | only live messages, only in conversations you're a member of, filtered in the same query |
| One broad search can't tie up the database | 3 s `statement_timeout` on the search query, then 503 |
| Realtime resumes after a reconnect | SSE ids; `Last-Event-ID` replays from a 1,000-event buffer, otherwise `resync` |
| Committed data survives restarts | PostgreSQL (a Docker volume locally) |

**Not guaranteed:**
- **Strict order per listener.** Realtime handles one job at a time, oldest first, but a job
  that is waiting to retry doesn't hold back the ones behind it, and two transactions that
  commit close together can be handled in either order. Events from one transaction stay in
  order (they share a job). Version guards keep realtime clients correct.
- **Order after a dead letter.** Retrying a dead-lettered job delivers it late. Version
  guards keep realtime clients correct.
- **Exactly-once notifications at a real provider.** A crash between the provider accepting
  a send and the ledger recording it sends again on retry; the idempotency key covers
  providers that support one, push doesn't.
- **More than one server process.** Jobs are shared, but the SSE hub is in memory, so a
  client only gets events handled by the process it's connected to.
- **Sessions across restarts,** unless `SESSION_SECRET` is set.

**Retries:** notifications get 10 attempts over about an hour (a provider outage is absorbed
before anything dead-letters), realtime 5 attempts over about a minute. Tests use the
in-memory bus behind the same transactional publisher, plus `delivery.test.ts` against
pg-boss.

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
  - reading follows the scroll: a conversation or thread is read up to the newest message
    scrolled into view; that marks its mentions read, a DM item once caught up, and a thread
    item once its replies are.

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

- **Postgres full-text search** over `messages.search`. The app tokenizes and stores the
  tokens as-is (`array_to_tsvector`), so Postgres's own parser never re-splits them. Tokens
  over Postgres's 2047-byte limit are left out.
- **Query** (`MessageRepository.search`): terms become `'depl':* & …` (a one-letter term
  matches only that word), phrases an escaped `ILIKE`, plus `from:`/`in:` and your
  conversations, all in one statement. The text is always a bound parameter.
- **Tokenizer** (`shared/search.ts`): lowercases, strips accents, folds simple plurals, drops
  stopwords. Client highlighting uses the same code.
- **Query language:**
  - every word must match, as a word or a word prefix (`depl` finds `deploy`);
  - `"exact phrase"`;
  - `from:@name` and `in:#channel` filters.
- **Results:** newest first, up to 50 (100 max), with the total match count; no relevance ranking or paging.

## Client notes

- **Auth:** `POST /api/auth/register|login {name}` sets a signed, HttpOnly `sid` cookie. Name-only
  login means anyone can be anyone; that's on purpose for the exercise. Vite proxies `/api` to
  `localhost:3001`, so the cookie needs no CORS setup.
- **SSE:** read over `fetch` instead of `EventSource`, so the client sees 401s and sends
  `Last-Event-ID` itself; it reconnects with backoff.
- **Unknown users:** when the client meets a user id it doesn't know (someone who registered
  later), it fetches `GET /api/users/:id` once.
- **Timelines:** each channel or thread is a window of up to 300 messages around a position
  (first unread, a jump target, or the newest), rendered virtualized and paged at the edges.
  Live messages append only at the live edge. The 10 most recent windows stay cached.
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

- Search has no relevance ranking or typo tolerance;
  `pg_trgm` or a dedicated engine (Meilisearch) behind the same query shape would add them.
- The realtime listener recomputes a user's whole feed to find one changed item.
- No reactions, thread unfollow, private channels, group DMs, files, presence or typing
  indicators.
- Edits are last-writer-wins, which is safe because only the author can edit.
- Request validation is hand-rolled, not schema-based.
