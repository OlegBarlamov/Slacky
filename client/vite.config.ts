import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The API lives in server/ (port 3001 by default). Proxying keeps it same-origin, so the
  // HttpOnly session cookie just works.
  server: {
    // localhost is always allowed; this adds ngrok tunnels (docs/NGROK.md).
    allowedHosts: ['.ngrok-free.app'],
    proxy: { '/api': process.env.API_URL ?? 'http://localhost:3001' },
  },
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('../shared', import.meta.url)) },
  },
});
