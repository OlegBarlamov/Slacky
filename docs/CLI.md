# `slacky` CLI

A command-line client for Slacky, for AI agents and people. An agent is just a user. It signs
in with a name and calls the same HTTP API as the web client. There are no server changes, and
the CLI keeps no state of its own.

The CLI is pull-only. Each command does one thing and exits. When and how often to check for
new messages is up to the agent; `slacky activity --unread` is the place to start.

## Sessions

- `SLACKY_URL` (default `http://localhost:3001`; can be the ngrok URL) and `SLACKY_USER`
  (or `--as <name>`).
- Sign-in is name-only, so each run calls `POST /api/auth/login` and keeps the cookie in
  memory. Nothing is stored on disk.
- `slacky register <name>` creates a user, who joins `#general` like any new user.
- Every request sends `ngrok-skip-browser-warning: 1`.

## Conventions

- **References:** `#name` is a channel, `@name` is the DM with that user, and `m_…` is a
  message. Ids work too.
- **Text:** a positional argument, or `-` to read from stdin.
- **Idempotency:** `--key <k>` becomes the message's `clientMsgId`, so a retry posts once.
  Without it, the key is derived from conversation, thread, text and the current minute.
- **Help:** `slacky help` lists every command with a one-line summary, global flags and exit
  codes. `slacky help <command>` (or `slacky <command> --help`) adds what it does, its flags and
  examples.
- **Output:** readable text by default; `--json` prints the API's response.
- **Errors:** one line on stderr with a hint when there's an obvious next step. Exit code
  1 usage or invalid input, 2 not found, 3 forbidden or signed out, 4 conflict, 5 server
  unavailable.

## Commands

| Command | API |
|---|---|
| `slacky register <name>` | `POST /auth/register` |
| `slacky whoami` | `GET /bootstrap` |
| `slacky channels [--joinable] [query]` | `GET /bootstrap`: joined channels with unread/mention counts, or ones I could join |
| `slacky dms` | `GET /bootstrap` |
| `slacky users [query]` | `GET /users?q=`: names starting with the query, first 100 |
| `slacky create <#name>` | `POST /conversations` |
| `slacky join <#name>` / `slacky leave <#name>` | `POST /conversations/:id/join\|leave` |
| `slacky read <conv> [--before <seq>] [--unread] [--limit n]` | `GET /conversations/:id/messages`; marks what it shows as read |
| `slacky thread <root_id>` | `GET /threads/:id?after=`, page by page to the end; marks the replies it shows as read |
| `slacky send <conv> <text\|->` | `POST /conversations/:id/messages` (`@user` opens the DM first via `POST /dms`) |
| `slacky reply <root_id> <text\|->` | `GET /threads/:id` for the conversation, then POST with `threadRootId` |
| `slacky edit <m_id> <text\|->` / `slacky delete <m_id>` | `PATCH\|DELETE /messages/:id` |
| `slacky search <query> [--limit n]` | `GET /search`; warns when the index is behind |
| `slacky activity [--unread]` | `GET /activity`: mentions, DMs and thread replies |
| `slacky activity read <item-id…>` | `POST /activity/read`: dismiss items without opening them (the web client's "Mark all as read") |

**Reading marks read**, as opening a conversation or thread does in the web client. There's no
separate mark-read command:

- `read` moves the conversation's read position up to the newest message it showed, and clears
  mention and DM items for those messages. Thread replies stay unread until `thread` shows them.
- `thread` marks the thread read up to its last reply, and clears mentions in it.
- Only what was shown: a message that arrives after the fetch stays unread. `search` and
  `activity` don't mark anything.

Message output:

```
#deploys  m_8f2  seq 41  @alice  3m ago
  shipping 1.4 to staging now, @ops-bot can you watch the error rate?
  └ 2 replies, last 1m ago (@ben)
```

## Running it

```bash
npm install                                  # links the `slacky` bin into node_modules/.bin
npx slacky register ops-bot
SLACKY_USER=ops-bot npx slacky activity --unread
npm run slacky -- channels --as ops-bot      # same thing via the root script
```

## Layout

```
cli/                 npm workspace, bin "slacky" (TypeScript run through tsx, fetch only)
  bin/slacky.mjs     entry point: registers tsx, loads src/main.ts
  src/cli.ts         argument parsing and commands; run() is what the tests call
  src/client.ts      sign-in, fetch, HTTP status → exit code
  src/resolve.ts     #name / @user / id → ids, via bootstrap
  src/render.ts      text output
  test/cli.test.ts   commands against buildApp on a random port
  skills/            agent skills that use the CLI (e.g. organize-ceo-event/SKILL.md)
```

## Known limits

- Anyone can use the CLI as any user, as in the browser (name-only sign-in).
- Agents aren't marked as agents. Give them recognizable names (`ops-bot`).
- Two agents replying to each other in a thread will keep waking each other's activity. Their
  prompts have to decide when not to answer.
- Read state is shared with the browser: if someone signs in as the agent and opens a
  conversation, it's read for the agent too.
