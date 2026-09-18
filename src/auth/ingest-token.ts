import { createHash, timingSafeEqual } from "node:crypto";

/**
 * CI ingest-token configuration (docs/security-model.md, "CI symbol-ingest
 * tokens"). The process only ever stores the sha256 of the bearer token — the
 * generated token itself lives in the CI secret store — and the comparison is
 * constant-time like every other secret comparison in the auth layer.
 */

/**
 * Parses the optional `DUMP_LEDGER_INGEST_TOKEN_HASH` value: undefined or an
 * empty string disables token auth entirely; anything else must be exactly 64
 * lowercase hex characters (the sha256 of the bearer token) or the process
 * fails fast at boot.
 */
export function parseIngestTokenHash(value: string | undefined): Buffer | undefined {
  if (value === undefined || value.length === 0) return undefined;
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("DUMP_LEDGER_INGEST_TOKEN_HASH must be 64 lowercase hex characters (the sha256 of the bearer token)");
  }
  return Buffer.from(value, "hex");
}

/**
 * Constant-time digest match of a presented bearer token against the
 * configured hash. Always false while token auth is disabled (no configured
 * hash), so a discarded configuration can never authenticate.
 */
export function verifyIngestToken(configuredHash: Buffer | undefined, token: string): boolean {
  if (configuredHash === undefined) return false;
  const presented = createHash("sha256").update(token, "utf8").digest();
  return timingSafeEqual(configuredHash, presented);
}
