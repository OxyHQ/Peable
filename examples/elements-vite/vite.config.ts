import { defineConfig } from 'vite';

// The page is served by Vite; `/api` is the example's own server (server.ts),
// which holds the Peable credential.
export default defineConfig({
  server: {
    port: 5173,
    proxy: { '/api': `http://localhost:${process.env.PORT ?? 4242}` },
  },
});
