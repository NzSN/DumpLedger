import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { OperatorSessions } from "./auth/sessions.js";
import { createDumpLedgerEngine } from "./engine/dump-ledger-engine.js";
import { EngineHttpApplication } from "./http/application.js";
import { PeriodicRuntimeJob } from "./http/runtime-jobs.js";
import { buildHttpServer } from "./http/server.js";
import { createVaultMinidumpInspectionPort } from "./inspection/index.js";
import { EngineUploadLifecycle, EngineUploadPostProcessor, VaultUploadSink } from "./intake/intake-facade.js";
import { PostProcessingQueue } from "./intake/post-processing-queue.js";
import { reconcile } from "./recovery/reconcile.js";
import { runRetention } from "./recovery/retention.js";
import { FilesystemVault } from "./vault/filesystem-vault.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function grantKey(): Buffer {
  const encoded = requiredEnvironment("DUMP_LEDGER_GRANT_KEY");
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("DUMP_LEDGER_GRANT_KEY must be unpadded base64url");
  const key = Buffer.from(encoded, "base64url");
  if (key.toString("base64url") !== encoded) throw new Error("DUMP_LEDGER_GRANT_KEY must use canonical base64url encoding");
  if (key.byteLength < 32) throw new Error("DUMP_LEDGER_GRANT_KEY must decode to at least 32 bytes");
  return key;
}

function positiveIntegerEnvironment(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? String(fallback));
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

export async function main(): Promise<void> {
  const dataRoot = resolve(process.env.DUMP_LEDGER_DATA_DIR ?? "data");
  const configuredGrantKey = grantKey();
  const operatorPasswordHash = requiredEnvironment("DUMP_LEDGER_OPERATOR_PASSWORD_HASH");
  const maxConcurrentUploads = positiveIntegerEnvironment("DUMP_LEDGER_MAX_CONCURRENT_UPLOADS", 2);
  const postProcessingCapacity = positiveIntegerEnvironment("DUMP_LEDGER_POST_PROCESSING_QUEUE", 128);
  const postProcessingAttempts = positiveIntegerEnvironment("DUMP_LEDGER_POST_PROCESSING_ATTEMPTS", 5);
  const retentionIntervalMs = positiveIntegerEnvironment("DUMP_LEDGER_RETENTION_INTERVAL_MS", 60_000);
  const retentionBatchSize = positiveIntegerEnvironment("DUMP_LEDGER_RETENTION_BATCH_SIZE", 32);
  const https = process.env.DUMP_LEDGER_HTTPS === "true";
  const host = process.env.DUMP_LEDGER_HOST ?? "127.0.0.1";
  if (!https && host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("non-loopback listening requires DUMP_LEDGER_HTTPS=true behind a trusted HTTPS endpoint");
  }
  const port = Number(process.env.DUMP_LEDGER_PORT ?? "4080");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("DUMP_LEDGER_PORT must be an integer from 1 through 65535");
  }
  const sessions = new OperatorSessions({
    passwordHash: operatorPasswordHash,
    secureCookies: https,
  });
  mkdirSync(dataRoot, { mode: 0o700, recursive: true });
  const vault = new FilesystemVault(dataRoot);
  const engine = createDumpLedgerEngine({
    databasePath: join(dataRoot, "ledger.sqlite"),
    vault,
    inspection: createVaultMinidumpInspectionPort(vault),
    grantSecretKey: configuredGrantKey,
  });
  try {
    reconcile(engine, vault);
  } catch (error) {
    engine.close();
    throw error;
  }
  const postProcessor = new EngineUploadPostProcessor(engine);
  const postProcessingQueue = new PostProcessingQueue({
    processor: postProcessor,
    maxPending: postProcessingCapacity,
    maxAttempts: postProcessingAttempts,
  });
  const retentionJob = new PeriodicRuntimeJob({
    name: "retention",
    intervalMs: retentionIntervalMs,
    run: () => { runRetention(engine, undefined, { limit: retentionBatchSize }); },
  });
  const server = buildHttpServer({
    application: new EngineHttpApplication(engine, vault),
    sessions,
    uploadLifecycle: new EngineUploadLifecycle(engine),
    uploadSink: new VaultUploadSink(vault),
    uploadPostProcessor: postProcessor,
    postProcessingQueue,
    maxConcurrentUploads,
    secureDeployment: https,
    runtimeJobs: [retentionJob],
  });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    retentionJob.close();
    await server.close();
    postProcessingQueue.close();
    engine.close();
  };
  process.once("SIGINT", () => { void close(); });
  process.once("SIGTERM", () => { void close(); });
  try {
    await server.listen({ host, port });
    retentionJob.start();
  } catch (error) {
    retentionJob.close();
    postProcessingQueue.close();
    engine.close();
    throw error;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main().catch(error => {
    process.stderr.write(`DumpLedger failed to start: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
