import type { FastifyInstance } from "fastify";

import { sendError } from "../contracts/json.js";

/**
 * SymSrv-protocol read surface (design section "Read serving (symsrv route)",
 * resolved decision D1).
 *
 * `GET /symbols/:name/:id/:file` mirrors the symbol store to debuggers:
 * CDB/WinDbg point `.sympath` at `<host>/symbols` and fetch artifacts by
 * debug-file name and debug id. The route is deliberately outside the
 * `/api/v1` surface — no session, no CSRF, no rate limiting, and no audit
 * event per fetch (debuggers issue many serial requests, and symsrv.dll
 * cannot authenticate); the exposure is bounded by decision D1 (LAN-open on
 * the private interface) and by serving nothing but immutable symbol bytes.
 *
 * Store-path grammar (mirrored locally from the store-path codec in
 * `src/symbols/identity.ts`, evaluated before the store is touched):
 *   - `name` and `file` are basename-shaped: 1..255 code points, no `/`, no
 *     `\`, no `..` anywhere, no leading or trailing dot (which also rules out
 *     `.` and `..` as whole segments), and no control characters;
 *   - `id` is 2..64 hex characters in either case — the SymSrv GUID+age or
 *     image-id encoding; symsrv spells a PDB id uppercase but an image id as
 *     `%08X` stamp plus lowercase `%x` size, so the segment is matched
 *     case-insensitively and canonicalized to uppercase before the lookup;
 *   - `file` must equal `name` byte-for-byte (the SymSrv schema repeats the
 *     debug file name in the last segment).
 * Every request this route cannot serve answers the same 404 `not_found` miss
 * — an unknown identity and a segment outside the grammar alike — because the
 * route is symsrv's wire contract, not an operator API: a 404 is what symsrv
 * reads as "try the next store", and it is the only status the design
 * documents as a miss. The grammar check still runs first, so nothing
 * malformed reaches the store or the vault. (Until 2026-09-20 the
 * uppercase-only grammar answered symsrv's mixed-case image ids -- `%08X`
 * stamp plus lowercase `%x` size -- with a 400, so the store could never
 * serve an image.)
 *
 * Hits carry `Cache-Control: public, max-age=31536000, immutable` (artifacts
 * are immutable per identity); every error response goes through the shared
 * `sendError` envelope, whose `no-store` wins over any public caching.
 *
 * Registration order matters: the caller registers this three-segment route
 * BEFORE the static-web fallback so symbol fetches reach the store; the SPA
 * `/symbols` page is a distinct one-segment path this route never matches.
 */

/** Minimal read port over the symbol store; implemented by the SQLite/vault store. */
export interface SymbolArtifactStorePort {
  openArtifact(debugFile: string, debugId: string, file: string):
    | { readonly byteSize: bigint; readonly stream: NodeJS.ReadableStream }
    | undefined;
}

const MAX_SEGMENT_LENGTH = 255;
const DEBUG_ID_PATTERN = /^[0-9A-Fa-f]{2,64}$/;
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Basename-shaped store-path segment: no separators, no `..` anywhere, no
 * leading/trailing dot, no control characters, at most 255 code points.
 */
function isBasenameSegment(value: string): boolean {
  if (value === "") return false;
  if ([...value].length > MAX_SEGMENT_LENGTH) return false;
  if (value.includes("/") || value.includes("\\")) return false;
  if (value.includes("..")) return false;
  if (value.startsWith(".") || value.endsWith(".")) return false;
  if (hasControlCharacter(value)) return false;
  return true;
}

export function registerSymbolRoutes(server: FastifyInstance, store: SymbolArtifactStorePort): void {
  server.get<{ Params: { name: string; id: string; file: string } }>(
    "/symbols/:name/:id/:file",
    (request, reply) => {
      const { name, id, file } = request.params;
      if (!isBasenameSegment(name) || !isBasenameSegment(file) || !DEBUG_ID_PATTERN.test(id)) {
        return sendError(reply, "not_found");
      }
      // SymSrv schema: the final segment repeats the debug file name.
      if (file !== name) return sendError(reply, "not_found");
      // SymSrv id casing differs per identity kind (uppercase PDB GUID+age;
      // `%08X` + lowercase `%x` for an image). The store's canonical key is
      // uppercase, so normalize the segment before the lookup.
      const canonicalId = id.toUpperCase();
      let artifact: ReturnType<SymbolArtifactStorePort["openArtifact"]>;
      try {
        artifact = store.openArtifact(name, canonicalId, file);
      } catch {
        return sendError(reply, "internal_error");
      }
      if (artifact === undefined) return sendError(reply, "not_found");
      const contentLength = Number(artifact.byteSize);
      if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
        return sendError(reply, "internal_error");
      }
      return reply
        .header("Cache-Control", IMMUTABLE_CACHE_CONTROL)
        .header("Content-Length", contentLength)
        .type("application/octet-stream")
        .send(artifact.stream);
    },
  );
}
