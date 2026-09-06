import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hashOperatorPassword } from "../dist/src/auth/sessions.js";

/**
 * Starts the compiled production server (`node dist/src/main.js`) on an
 * ephemeral localhost port with a throwaway DUMP_LEDGER_DATA_DIR and a
 * freshly generated operator credential, and waits until /health answers.
 * The base URL is written to a temp state file that the spec reads; the
 * teardown stops the process and removes the data dir.
 */

export const STATE_PATH = join(tmpdir(), "dump-ledger-e2e-state.json");

export const OPERATOR_PASSWORD = "e2e-operator-password-local";

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => reject(new Error("could not allocate an ephemeral port")));
        return;
      }
      const port = address.port;
      probe.close(() => resolvePort(port));
    });
  });
}

export default async function globalSetup(): Promise<void> {
  rmSync(STATE_PATH, { force: true });
  const dataDir = mkdtempSync(join(tmpdir(), "dump-ledger-e2e-data-"));
  const port = await freePort();
  const passwordHash = await hashOperatorPassword(OPERATOR_PASSWORD);
  const grantKey = Buffer.alloc(32, 0x5a).toString("base64url");
  const serverEntry = join(process.cwd(), "dist", "src", "main.js");

  const child = spawn(process.execPath, [serverEntry], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DUMP_LEDGER_DATA_DIR: dataDir,
      DUMP_LEDGER_GRANT_KEY: grantKey,
      DUMP_LEDGER_OPERATOR_PASSWORD_HASH: passwordHash,
      DUMP_LEDGER_HOST: "127.0.0.1",
      DUMP_LEDGER_PORT: String(port),
      DUMP_LEDGER_HTTPS: "false",
      DUMP_LEDGER_RETENTION_INTERVAL_MS: "600000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const logs: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => logs.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => logs.push(chunk));

  const baseURL = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  let up = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${baseURL}/health`);
      if (response.ok) {
        up = true;
        break;
      }
    } catch {
      // not listening yet
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }

  if (!up) {
    child.kill("SIGKILL");
    rmSync(dataDir, { recursive: true, force: true });
    const logTail = Buffer.concat(logs).toString("utf8").slice(-4000);
    throw new Error(`production server failed to start on port ${port}:\n${logTail}`);
  }

  writeFileSync(
    STATE_PATH,
    JSON.stringify({ baseURL, port, dataDir, pid: child.pid, password: OPERATOR_PASSWORD }),
  );
}
