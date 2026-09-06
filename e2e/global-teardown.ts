import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FullConfig } from "@playwright/test";

const STATE_PATH = join(tmpdir(), "dump-ledger-e2e-state.json");

interface ServerState {
  readonly baseURL: string;
  readonly port: number;
  readonly dataDir: string;
  readonly pid: number;
  readonly password: string;
}

/** Stops the production server launched in global setup and removes its temp data dir. */
export default async function globalTeardown(_config: FullConfig): Promise<void> {
  if (!existsSync(STATE_PATH)) return;
  const state = JSON.parse(readFileSync(STATE_PATH, "utf8")) as ServerState;
  try {
    process.kill(state.pid, "SIGTERM");
  } catch {
    // already gone
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  try {
    process.kill(state.pid, "SIGKILL");
  } catch {
    // already gone
  }
  rmSync(state.dataDir, { recursive: true, force: true });
  rmSync(STATE_PATH, { force: true });
}
