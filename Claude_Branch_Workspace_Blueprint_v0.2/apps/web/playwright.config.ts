// Phase 4 S7 — end-to-end Playwright config.
//
// Boots the REAL control plane (fake runtime) which serves the built SPA from
// apps/web/dist at 127.0.0.1:15723 (gate 12 loopback). REST + WS are
// same-origin — no Vite proxy masking. Runs on system Chrome (channel:chrome)
// so no browser download is required.
//
// Env:
//   CBW_E2E_PORT   override the control-plane port (default 15723)
//   CBW_E2E_DB     override the temp SQLite db path
//   CBW_E2E_SCRIPT override the fake-turn script path

import { defineConfig } from "@playwright/test";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CBW_E2E_PORT ?? 15723);
const DB = process.env.CBW_E2E_DB ?? join(process.env.TEMP ?? "/tmp", `cbw-e2e-${Date.now()}.db`);
const SCRIPT = process.env.CBW_E2E_SCRIPT ?? resolve(here, "e2e/fake-script.json");
const CONTROL = resolve(here, "../control-plane");

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    channel: "chrome",
    headless: true,
  },
  webServer: {
    command: "node dist/index.js",
    cwd: CONTROL,
    url: `http://127.0.0.1:${PORT}/api/runtime/capabilities`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      CBW_FAKE_RUNTIME: "1",
      CBW_FAKE_SCRIPT: SCRIPT,
      CBW_DB: DB,
      CBW_PORT: String(PORT),
    },
  },
});
