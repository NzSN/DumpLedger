import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Generate a webhook-admin bearer token with 256 bits of entropy
 * (docs/webhook-admin-token-design.md, "The credential"). The token goes into
 * the caller's secret store; only its sha256 — printed alongside — goes into
 * `DUMP_LEDGER_WEBHOOK_ADMIN_TOKEN_HASH`.
 */
export function generateWebhookAdminToken(): string {
  return randomBytes(32).toString("base64url");
}

export function webhookAdminTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function main(): void {
  const token = generateWebhookAdminToken();
  process.stdout.write(`Webhook admin token (store in the caller's secret store, shown once): ${token}\n`);
  process.stdout.write(`DUMP_LEDGER_WEBHOOK_ADMIN_TOKEN_HASH=${webhookAdminTokenHash(token)}\n`);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main();
}
