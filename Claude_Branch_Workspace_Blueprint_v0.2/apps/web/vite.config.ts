import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev proxy: control plane is 127.0.0.1:15723. /api REST + /ws websocket
// (gate 12: no cross-origin in production — Fastify serves the SPA; the dev
// proxy keeps the browser same-origin against the Vite server, and the WS
// origin gate sees http://localhost:5173 from the dev allowlist).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:15723",
      "/ws": { target: "ws://127.0.0.1:15723", ws: true },
    },
  },
  build: {
    outDir: "dist",
  },
});
