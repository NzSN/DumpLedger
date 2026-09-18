import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Generate a CI symbol-ingest bearer token with 256 bits of entropy
 * (docs/security-model.md, "CI symbol-ingest tokens"). The token goes into
 * the CI secret store; only its sha256 — printed alongside — goes into
 * `DUMP_LEDGER_INGEST_TOKEN_HASH`.
 */
export function generateIngestToken(): string {
  return randomBytes(32).toString("base64url");
}

export function ingestTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function main(): void {
  const token = generateIngestToken();
  process.stdout.write(`Ingest token (store in the CI secret store, shown once): ${token}\n`);
  process.stdout.write(`DUMP_LEDGER_INGEST_TOKEN_HASH=${ingestTokenHash(token)}\n`);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main();
}
