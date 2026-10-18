# Slacky

Realtime messaging with an activity feed: a React client (`client/`), a Fastify + SQLite
server (`server/`) and a CLI (`cli/`), sharing the API contract in `shared/`.

![Slacky: #general with a thread open](docs/demo.png)

```bash
npm install
npm run dev:server   # API on http://localhost:3001 (creates server/chat.db with #general)
npm run dev          # client on http://localhost:5173, proxies /api to the server
npm test
```

Create a user to sign in; new users join #general and get a DM with themselves. To chat as
several people, use different browsers or profiles (one session cookie per profile).

Design, guarantees and trade-offs: [docs/DESIGN.md](docs/DESIGN.md). Sharing it over the internet: [docs/NGROK.md](docs/NGROK.md). Command line (for agents too): [docs/CLI.md](docs/CLI.md).
