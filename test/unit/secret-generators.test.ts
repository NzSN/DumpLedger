import assert from "node:assert/strict";
import test from "node:test";

import { generateGrantKey } from "../../tools/generate-grant-key.js";

test("grant key generator emits canonical 256-bit base64url", () => {
  const encoded = generateGrantKey();
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.equal(Buffer.from(encoded, "base64url").byteLength, 32);
  assert.equal(Buffer.from(encoded, "base64url").toString("base64url"), encoded);
});
