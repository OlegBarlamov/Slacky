# Sharing Slacky over ngrok

Tunnel only the client. Vite proxies `/api` to the server, so one URL serves both and the
session cookie stays same-origin.

**Warning:** login is name-only and the tunnel is public, so anyone with the URL can sign in
as any user. Share the link only with people you trust, and close the tunnel when you're done.

## Setup (once)

1. Install ngrok: `brew install ngrok`.
2. Connect it to your free ngrok account: `ngrok config add-authtoken <token>`. Copy the token from
   https://dashboard.ngrok.com/get-started/your-authtoken.

`client/vite.config.ts` already allows `*.ngrok-free.app` hosts alongside localhost.

## Run

```bash
npm run dev:server   # terminal 1
npm run dev          # terminal 2
ngrok http 5173      # terminal 3, then share the https://….ngrok-free.app URL it prints
```

Visitors see ngrok's free-plan warning page once and click **Visit Site**.
