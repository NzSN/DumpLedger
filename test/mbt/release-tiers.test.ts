import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  ModelInterfaceRegistrationError,
  connectTlsMirror,
  runClientNegotiated,
  runClientWithTracesNegotiated,
  spawnMirror,
  type Transport,
} from "mirrorecma";

import { createMbtProbe } from "../../src/mbt/harness.js";
import {
  createDumpLedgerMbtSelection,
  dumpLedgerMbtConfig,
} from "../../src/mbt/registry.js";
import {
  createMbtPki,
  removeMbtPki,
  tlsOptions,
  type MbtPki,
} from "./support/mtls.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const MIRROR_BIN = process.env.MIRROR_BIN
  ?? "/home/nzsn/Repos/Mirrors/.lake/build/bin/mirror";
const PARTIAL_TRACE = resolve(
  REPO_ROOT,
  "test/fixtures/mbt/traces/01-accepted-partial-delete.itf.json",
);

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out`)),
        180_000,
      );
    }),
  ]);
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((error) => error === undefined
      ? resolvePromise()
      : rejectPromise(error));
  });
  return address.port;
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolvePromise) => {
      child.once("close", () => resolvePromise());
    }),
    new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

async function startServer(
  pki: MbtPki,
  allowClient: boolean,
): Promise<{ readonly port: number; readonly child: ChildProcess }> {
  const port = await freePort();
  const args = [
    "--server", String(port), "--tls",
    "--cert", pki.serverCertificate,
    "--key", pki.serverKey,
    "--ca", pki.caCertificate,
  ];
  if (allowClient) {
    args.push("--model-interface-allow-client", pki.clientFingerprint);
  }
  const child = spawn(MIRROR_BIN, args, {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`mTLS server exited ${child.exitCode}: ${stderr}`);
    }
    try {
      const probe = await connectTlsMirror(
        "127.0.0.1",
        port,
        tlsOptions(pki),
      );
      await probe.close();
      return { port, child };
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }
  await stopServer(child);
  throw new Error(`mTLS server did not become ready: ${stderr}`);
}

test(
  "live Apalache trace runs from source through negotiated generated binding",
  { timeout: 190_000 },
  async () => {
    const probe = createMbtProbe();
    await withTimeout(runClientNegotiated(
      spawnMirror(MIRROR_BIN),
      dumpLedgerMbtConfig(REPO_ROOT),
      { numTraces: 1 },
      createDumpLedgerMbtSelection(probe),
    ), "live Apalache DumpLedger replay");
    assert.equal(probe.factoryCalls, 1);
    assert.ok(probe.portCalls > 0);
    assert.ok(probe.engineCalls > 0);
    assert.equal(probe.bindingDisposeCalls, 1);
    assert.equal(probe.harnessDisposeCalls, 1);
  },
);

test(
  "allowlisted TLS 1.3 mTLS replays and missing allowlist makes zero SUT calls",
  { timeout: 190_000 },
  async () => {
    const pki = await createMbtPki();
    try {
      const allowed = await startServer(pki, true);
      try {
        const probe = createMbtProbe();
        const transport = await connectTlsMirror(
          "127.0.0.1",
          allowed.port,
          tlsOptions(pki),
        );
        await withTimeout(runClientWithTracesNegotiated(
          transport,
          dumpLedgerMbtConfig(REPO_ROOT),
          [PARTIAL_TRACE],
          createDumpLedgerMbtSelection(probe),
        ), "allowlisted mTLS DumpLedger replay");
        assert.equal(probe.factoryCalls, 1);
        assert.ok(probe.engineCalls > 0);
        assert.equal(probe.bindingDisposeCalls, 1);
        assert.equal(probe.harnessDisposeCalls, 1);
      } finally {
        await stopServer(allowed.child);
      }

      const denied = await startServer(pki, false);
      try {
        const probe = createMbtProbe();
        const transport: Transport = await connectTlsMirror(
          "127.0.0.1",
          denied.port,
          tlsOptions(pki),
        );
        await assert.rejects(
          withTimeout(runClientWithTracesNegotiated(
            transport,
            dumpLedgerMbtConfig(REPO_ROOT),
            [PARTIAL_TRACE],
            createDumpLedgerMbtSelection(probe),
          ), "non-allowlisted mTLS DumpLedger replay"),
          (error: unknown) => error instanceof ModelInterfaceRegistrationError
            && error.code === "interface_unavailable",
        );
        assert.equal(probe.factoryCalls, 0);
        assert.equal(probe.portCalls, 0);
        assert.equal(probe.engineCalls, 0);
        assert.equal(probe.observationCalls, 0);
        assert.equal(probe.bindingDisposeCalls, 0);
        assert.equal(probe.harnessDisposeCalls, 0);
      } finally {
        await stopServer(denied.child);
      }
    } finally {
      await removeMbtPki(pki);
    }
  },
);
