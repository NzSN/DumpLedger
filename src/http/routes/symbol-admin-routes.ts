import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { FastifyInstance } from "fastify";

import {
  decodeSymbolFilenameBase64url,
  encodeSymbolIngestResponse,
  encodeSymbolListResponse,
  MAX_SYMBOL_BYTES,
  X_SYMBOL_FILENAME_HEADER,
  type SymbolKind,
} from "@dump-ledger/http-contracts";
import { DumpLedgerError } from "../../domain/errors.js";
import { parsePdbIdentity, parsePeIdentity } from "../../symbols/identity.js";
import { jsonRequireMutation, jsonRequireSession, sendError } from "../contracts/json.js";
import type { SymbolIngestIdentity } from "../server.js";
import type { RouteContext } from "./common.js";

/**
 * Bytes buffered from the start of the stream for identity parsing. MSF/RSDS
 * needs only the PDB Info stream, and PE needs the DOS stub, the `e_lfanew`
 * target, the COFF header, and `SizeOfImage`: real PE headers sit within a few
 * KiB of the start (1 MiB is a generous bound), and a header beyond the window
 * degrades to `symbol_identity_unreadable` exactly like a malformed one — the
 * route never scans the whole artifact for identity offsets.
 */
const IDENTITY_WINDOW_BYTES = 1024 * 1024;

/**
 * Symbol artifact kind by upload filename suffix (D2 lifted: `.exe`/`.dll`
 * images ride the same entity as PDBs); anything else is unsupported. The
 * filename is display-only input that has already passed the shared filename
 * rules (no separators, no control characters, bounded length).
 */
function symbolKindForFilename(filename: string): SymbolKind | undefined {
  const lowered = filename.toLowerCase();
  if (lowered.endsWith(".pdb")) return "pdb";
  if (lowered.endsWith(".exe") || lowered.endsWith(".dll")) return "exe";
  return undefined;
}

/** PE identity parse; a filename the store-path grammar cannot carry (e.g. a
 * leading dot) degrades to the same unreadable-identity outcome as a non-PE
 * file, mirroring the PDB path where a broken artifact is a 422, not a 400.
 * Anything but the parser's own rejected-input error is a real defect and
 * keeps propagating. */
function parsePeIdentityOrUndefined(bytes: Buffer, codeFile: string): ReturnType<typeof parsePeIdentity> {
  try {
    return parsePeIdentity(bytes, codeFile);
  } catch (error) {
    if (error instanceof DumpLedgerError) return undefined;
    throw error;
  }
}

class SymbolLimitExceeded extends Error {}

/**
 * Operator symbol-store routes (docs/symbols-design.md, "Ingest"). The read
 * symsrv surface lives in symbol-routes.ts; everything here requires the
 * operator session like every other mutation. Bytes stream straight into
 * symbol staging and identity is parsed from the received prefix — never
 * from uploader input. Since milestone 3 the route accepts PDB, EXE, and DLL
 * artifacts (decision D2 lifted): the suffix picks the kind, the bytes pick
 * the identity.
 */
export function registerSymbolAdminRoutes(server: FastifyInstance, ctx: RouteContext): void {
  const { options } = ctx;

  server.get("/api/v1/symbols", async (request, reply) => {
    if (jsonRequireSession(request, reply, options.sessions) === undefined) return reply;
    const list = options.application.listSymbols();
    return reply.type("application/json; charset=utf-8").send(encodeSymbolListResponse(list));
  });

  server.post("/api/v1/symbols", async (request, reply) => {
    if (jsonRequireMutation(request, reply, options.sessions, options.allowedOrigins) === undefined) return reply;

    let originalName: string;
    try {
      originalName = decodeSymbolFilenameBase64url(request.headers[X_SYMBOL_FILENAME_HEADER]);
    } catch {
      return sendError(reply, "invalid_request");
    }
    // Kind is decided from the filename suffix before a byte is staged.
    const kind = symbolKindForFilename(originalName);
    if (kind === undefined) return sendError(reply, "symbol_kind_unsupported");

    const contentLengthText = request.headers["content-length"];
    if (contentLengthText !== undefined) {
      let contentLength: bigint;
      try { contentLength = BigInt(contentLengthText); } catch { return sendError(reply, "invalid_request"); }
      if (contentLength > MAX_SYMBOL_BYTES) return sendError(reply, "symbol_too_large");
    }

    const begun = options.application.beginSymbolIngest(kind);
    if (!begun.ok || begun.id === undefined) return sendError(reply, begun.ok ? "internal_error" : "storage_unavailable");
    const artifactId = begun.id;

    const hash = createHash("sha256");
    const identityWindow: Buffer[] = [];
    let identityWindowBytes = 0;
    let byteSize = 0n;
    let failed: "symbol_too_large" | "storage_unavailable" | undefined;
    const destination = new Writable({
      write: (chunk: Buffer, _encoding, done) => {
        try {
          byteSize += BigInt(chunk.byteLength);
          if (byteSize > MAX_SYMBOL_BYTES) throw new SymbolLimitExceeded();
          if (identityWindowBytes < IDENTITY_WINDOW_BYTES) {
            const keep = Math.min(chunk.byteLength, IDENTITY_WINDOW_BYTES - identityWindowBytes);
            identityWindow.push(chunk.subarray(0, keep));
            identityWindowBytes += keep;
          }
          hash.update(chunk);
          ctx.options.application.appendSymbolBytes(artifactId, chunk);
          done();
        } catch (error) {
          failed = error instanceof SymbolLimitExceeded ? "symbol_too_large" : "storage_unavailable";
          done(error as Error);
        }
      },
    });

    try {
      await pipeline(request.body as NodeJS.ReadableStream, destination);
    } catch {
      options.application.failSymbolIngest(artifactId);
      return sendError(reply, failed ?? "storage_unavailable");
    }
    options.application.syncSymbolStaging(artifactId);

    // Identity is parsed from the received prefix -- never from uploader input.
    // A PDB resolves by its RSDS GUID+age; an EXE/DLL image by PE
    // `TimeDateStamp` + `SizeOfImage`, with the upload filename's basename as
    // `codeFile` (the COFF header stores no name).
    const window = Buffer.concat(identityWindow);
    let identity: SymbolIngestIdentity;
    if (kind === "pdb") {
      const parsed = parsePdbIdentity(window);
      if (parsed === undefined) {
        options.application.failSymbolIngest(artifactId);
        return sendError(reply, "symbol_identity_unreadable");
      }
      identity = { kind, debugFile: parsed.debugFile, debugId: parsed.debugId };
    } else {
      const parsed = parsePeIdentityOrUndefined(window, originalName);
      if (parsed === undefined) {
        options.application.failSymbolIngest(artifactId);
        return sendError(reply, "symbol_identity_unreadable");
      }
      identity = { kind, codeFile: parsed.codeFile, codeId: parsed.codeId };
    }

    const sha256 = hash.digest("hex");
    const sealed = options.application.sealSymbolIngest({
      artifactId,
      ...identity,
      byteSize,
      sha256,
      ...(typeof request.headers["x-symbol-product"] === "string" ? { product: request.headers["x-symbol-product"] } : {}),
      ...(typeof request.headers["x-symbol-version"] === "string" ? { version: request.headers["x-symbol-version"] } : {}),
      ...(typeof request.headers["x-symbol-arch"] === "string" ? { arch: request.headers["x-symbol-arch"] } : {}),
    });
    if (!sealed.ok || sealed.id === undefined) {
      return sendError(reply, sealed.ok ? "internal_error" : "storage_unavailable");
    }
    return reply
      .code(201)
      .type("application/json; charset=utf-8")
      .send(
        encodeSymbolIngestResponse({
          artifactId: sealed.id,
          kind: identity.kind,
          debugFile: identity.kind === "pdb" ? identity.debugFile : null,
          debugId: identity.kind === "pdb" ? identity.debugId : null,
          codeFile: identity.kind === "exe" ? identity.codeFile : null,
          codeId: identity.kind === "exe" ? identity.codeId : null,
          byteSize,
          sha256,
          deduplicated: sealed.deduplicated === true,
        }),
      );
  });

  server.delete<{ Params: { artifactId: string } }>("/api/v1/symbols/:artifactId", async (request, reply) => {
    if (jsonRequireMutation(request, reply, options.sessions, options.allowedOrigins) === undefined) return reply;
    const result = options.application.purgeSymbol(request.params.artifactId);
    if (!result.ok) return sendError(reply, result.code === "not_found" ? "not_found" : "internal_error");
    return reply.code(204).send();
  });
}
