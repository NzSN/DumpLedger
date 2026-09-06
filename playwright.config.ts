import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig } from "@playwright/test";

/**
 * Real-browser e2e (design section 12): journeys run against the PRODUCTION
 * build. A global setup compiles-free server launch is not used here —
 * `test:e2e` runs after `pnpm run build`, and `e2e/global-setup.ts` spawns
 * `node dist/src/main.js` on an ephemeral port with a temp data dir and
 * generated operator credentials, then records the base URL in a temp state
 * file that the spec reads.
 *
 * Chromium only; exactly pinned @playwright/test. The whole suite runs in one
 * worker because the journeys share one live server and one operator session.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  outputDir: join(tmpdir(), "dump-ledger-playwright-results"),
  use: {
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
