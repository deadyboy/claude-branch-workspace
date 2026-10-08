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
const LIVE = process.env.CBW_E2E_LIVE === "1";

export default defineConfig({
  testDir: "./e2e",
  testMatch: LIVE ? "**/live-workspace.spec.ts" : "**/*.spec.ts",
  testIgnore: LIVE ? [] : ["**/live-workspace.spec.ts"],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  outputDir: process.env.CBW_E2E_OUTPUT_DIR ?? "test-results",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    channel: "chrome",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node dist/index.js",
    cwd: CONTROL,
    url: `http://127.0.0.1:${PORT}/api/runtime/capabilities`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      CBW_FAKE_RUNTIME: LIVE ? "0" : "1",
      CBW_FAKE_SCRIPT: LIVE ? "" : SCRIPT,
      CBW_MAX_CONCURRENT: "3",
      CBW_PER_PROJECT: "3",
      CBW_DB: DB,
      CBW_PORT: String(PORT),
    },
  },
});
