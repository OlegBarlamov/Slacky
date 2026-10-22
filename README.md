# Slacky

Realtime messaging with an activity feed: a React client (`client/`), a Fastify + PostgreSQL
server (`server/`) and a CLI (`cli/`), sharing the API contract in `shared/`.

![Slacky: #general with a thread open](docs/demo.png)

```bash
npm install
docker compose up -d db   # Postgres 17 on localhost:5432 (dev db `slacky`, tests use `slacky_test`)
npm run dev:server        # migrates, then API on http://localhost:3001 (creates #general)
npm run dev               # client on http://localhost:5173, proxies /api to the server
npm test                  # needs the db container; each test gets its own schema
```

The server reads `DATABASE_URL` (default `postgres://slacky@localhost:5432/slacky`); tests read
`TEST_DATABASE_URL`. Migrations live in `server/src/repositories/migrations/` and run with
`npm run migrate -w server`.

Create a user to sign in; new users join #general and get a DM with themselves. To chat as
several people, use different browsers or profiles (one session cookie per profile).

Design, guarantees and trade-offs: [docs/DESIGN.md](docs/DESIGN.md). Sharing it over the internet: [docs/NGROK.md](docs/NGROK.md). Command line (for agents too): [docs/CLI.md](docs/CLI.md).
