import type { FastifyInstance } from "fastify";

import {
  decodeFilenameBase64url,
  decodeUploadGrantSecret,
  encodeUploadCompleteResponse,
  encodeUploadQueuedResponse,
  UPLOAD_FALLBACK_FILENAME,
  X_DUMP_FILENAME_HEADER,
  X_UPLOAD_GRANT_HEADER,
} from "@dump-ledger/http-contracts";
import { IntakeError } from "../../intake/upload-session.js";
import { sendError } from "../contracts/json.js";
import type { RouteContext } from "./common.js";

/**
 * Public upload routes (design section 7.6).
 *
 * `POST /api/v1/uploads` accepts the raw byte stream with the grant secret and
 * the base64url-encoded filename in headers; bytes are streamed straight into
 * `UploadSession` and are never buffered or base64-encoded by the server. The
 * legacy path-secret page/form (`/upload/:secret`) was deleted in the Phase-5
 * cutover: no production deployment used it during the migration window, so no
 * legacy links exist in the wild. Header/fragment transport is the only upload
 * path.
 */
export function registerUploadRoutes(server: FastifyInstance, ctx: RouteContext): void {
  const { options, upload, uploadAdmission, uploadGrantRateLimiter } = ctx;

  server.post("/api/v1/uploads", async (request, reply) => {
    if (!uploadGrantRateLimiter.take(request.ip)) {
      reply.header("Retry-After", "60");
      return sendError(reply, "rate_limited");
    }
    const grantValue = request.headers[X_UPLOAD_GRANT_HEADER];
    let grantSecret: string;
    try {
      grantSecret = decodeUploadGrantSecret(grantValue);
    } catch {
      return sendError(reply, "grant_unavailable");
    }
    let originalName: string;
    try {
      originalName = decodeFilenameBase64url(request.headers[X_DUMP_FILENAME_HEADER]);
    } catch {
      originalName = UPLOAD_FALLBACK_FILENAME;
    }
    const contentLengthText = request.headers["content-length"];
    let contentLength: bigint | undefined;
    if (contentLengthText !== undefined) {
      try { contentLength = BigInt(contentLengthText); } catch { return sendError(reply, "invalid_request"); }
      if (contentLength < 0n) return sendError(reply, "invalid_request");
    }
    const admission = uploadAdmission.tryAcquire();
    if (admission === undefined) {
      reply.header("Retry-After", "5");
      return sendError(reply, "upload_busy");
    }
    try {
      const receipt = await upload.receive({
        grantSecret,
        originalName,
        ...(contentLength === undefined ? {} : { contentLength }),
        bytes: request.body as NodeJS.ReadableStream,
      });
      let phase: "sealed" | "available" | "rejected" = "sealed";
      if (options.uploadPostProcessor !== undefined) {
        try {
          phase = options.uploadPostProcessor.process(receipt.dumpId);
        } catch {
          const queued = options.postProcessingQueue?.enqueue(receipt.dumpId) ?? false;
          return reply
            .code(202)
            .type("application/json; charset=utf-8")
            .send(
              encodeUploadQueuedResponse({
                dumpId: receipt.dumpId,
                byteSize: receipt.byteSize,
                sha256: receipt.sha256,
                processing: queued ? "retry-queued" : "recovery-required",
              }),
            );
        }
      }
      return reply
        .code(201)
        .type("application/json; charset=utf-8")
        .send(
          encodeUploadCompleteResponse({
            dumpId: receipt.dumpId,
            phase,
            byteSize: receipt.byteSize,
            sha256: receipt.sha256,
          }),
        );
    } catch (error) {
      const code = error instanceof IntakeError ? error.code : "upload_incomplete";
      switch (code) {
        case "grant_invalid": return sendError(reply, "grant_unavailable");
        case "upload_too_large": return sendError(reply, "upload_too_large");
        case "storage_unavailable": return sendError(reply, "storage_unavailable");
        case "integrity_failure": return sendError(reply, "internal_error");
        default: return sendError(reply, "storage_unavailable");
      }
    } finally {
      admission.release();
    }
  });
}
