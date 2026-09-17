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
} from "@dump-ledger/http-contracts";
import { parsePdbIdentity } from "../../symbols/identity.js";
import { jsonRequireMutation, jsonRequireSession, sendError } from "../contracts/json.js";
import type { RouteContext } from "./common.js";

/** Bytes buffered from the start of the stream for MSF/RSDS identity parsing. */
const IDENTITY_WINDOW_BYTES = 1024 * 1024;

class SymbolLimitExceeded extends Error {}

/**
 * Operator symbol-store routes (docs/symbols-design.md, "Ingest"). The read
 * symsrv surface lives in symbol-routes.ts; everything here requires the
 * operator session like every other mutation. Bytes stream straight into
 * symbol staging and identity is parsed from the received prefix — never
 * from uploader input.
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
    // Decision D2: PDB-only v1. Kind is decided from the filename suffix;
    // anything else is rejected before a byte is staged.
    if (!originalName.toLowerCase().endsWith(".pdb")) return sendError(reply, "symbol_kind_unsupported");

    const contentLengthText = request.headers["content-length"];
    if (contentLengthText !== undefined) {
      let contentLength: bigint;
      try { contentLength = BigInt(contentLengthText); } catch { return sendError(reply, "invalid_request"); }
      if (contentLength > MAX_SYMBOL_BYTES) return sendError(reply, "symbol_too_large");
    }

    const begun = options.application.beginSymbolIngest();
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

    const identity = parsePdbIdentity(Buffer.concat(identityWindow));
    if (identity === undefined) {
      options.application.failSymbolIngest(artifactId);
      return sendError(reply, "symbol_identity_unreadable");
    }

    const sha256 = hash.digest("hex");
    const sealed = options.application.sealSymbolIngest({
      artifactId,
      debugFile: identity.debugFile,
      debugId: identity.debugId,
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
          debugFile: identity.debugFile,
          debugId: identity.debugId,
          kind: "pdb",
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
