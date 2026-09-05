import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Generate a canonical base64url HMAC key with 256 bits of entropy. */
export function generateGrantKey(): string {
  return randomBytes(32).toString("base64url");
}

function main(): void {
  process.stdout.write(`${generateGrantKey()}\n`);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main();
}
