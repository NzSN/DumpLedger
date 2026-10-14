import type { FastifyInstance } from "fastify";

import {
  decodeRetentionRequest,
  encodeDumpDetailResponse,
  encodeRetentionResponse,
} from "@dump-ledger/http-contracts";
import { authorizeSessionOrAnalyzer, contractErrorFor, decodeJsonRequest, jsonRequireMutation, sendError } from "../contracts/json.js";
import type { RouteContext } from "./common.js";

const RETENTION_DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Dump detail, retention, and raw-content routes (design section 7.7).
 *
 * The JSON retention endpoint computes its canonical deadline from the server
 * clock (`ctx.now()`); the browser clock and timezone are never authoritative.
 * Dump detail and raw content admit the operator session or the analyzer
 * bearer token (`authorizeSessionOrAnalyzer`); the retention mutation stays
 * operator-only. Downloads remain streaming with Content-Disposition
 * protections.
 * The legacy HTML dump page, its retention form, and the `/dumps/:dumpId/
 * download` route were deleted in the Phase-5 cutover; `/dumps` and
 * `/dumps/:dumpId` now serve the React shell from static-web.
 */

/**
 * `If-None-Match` for the strong content validator: the condition matches
 * when any comma-separated list element is exactly the quoted digest. The
 * route only emits strong ETags, and the design pins exact-match semantics,
 * so weak (`W/…`) or wildcard (`*`) elements never short-circuit.
 */
function ifNoneMatchMatches(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  return header.split(",").some(element => element.trim() === etag);
}

export function registerDumpRoutes(server: FastifyInstance, ctx: RouteContext): void {
  const { options, now } = ctx;

  server.get<{ Params: { dumpId: string } }>("/api/v1/dumps/:dumpId", async (request, reply) => {
    if (authorizeSessionOrAnalyzer(request, reply, options) === undefined) return reply;
    const detail = options.application.dumpDetail(request.params.dumpId);
    if (detail === undefined) return sendError(reply, "not_found");
    return reply.type("application/json; charset=utf-8").send(encodeDumpDetailResponse(detail));
  });

  server.get<{ Params: { dumpId: string } }>("/api/v1/dumps/:dumpId/content", async (request, reply) => {
    if (authorizeSessionOrAnalyzer(request, reply, options) === undefined) return reply;
    // Conditional revalidation (analyzer-integration design, "Conditional
    // requests and dedup aids"): the check runs before the download is
    // authorized and the vault reader opens, so a 304 never leaves an
    // unconsumed reader behind. Only an available, downloadable dump can
    // answer 304 — the same rows `openDownload` would serve — and a dump
    // without a sealed digest simply has no validator to compare.
    const detail = options.application.dumpDetail(request.params.dumpId);
    const etag = detail !== undefined && detail.phase === "available" && detail.downloadable && detail.sha256 !== null
      ? `"${detail.sha256}"`
      : undefined;
    if (etag !== undefined && ifNoneMatchMatches(request.headers["if-none-match"], etag)) {
      return reply.code(304).header("ETag", etag).send();
    }
    const download = options.application.openDownload(request.params.dumpId);
    if (download === undefined || download.phase !== "available") return sendError(reply, "not_found");
    const safeName = /^[A-Za-z0-9_-]{1,100}$/.test(request.params.dumpId) ? request.params.dumpId : "dump";
    if (etag !== undefined) reply.header("ETag", etag);
    return reply
      .header("Content-Disposition", `attachment; filename="${safeName}.dmp"`)
      .header("Content-Length", download.byteSize.toString())
      .type("application/octet-stream")
      .send(download.bytes);
  });

  server.put<{ Params: { dumpId: string } }>("/api/v1/dumps/:dumpId/retention", async (request, reply) => {
    if (jsonRequireMutation(request, reply, options.sessions, options.allowedOrigins) === undefined) return reply;
    const decoded = decodeJsonRequest(request, decodeRetentionRequest);
    if (!decoded.ok) return sendError(reply, "invalid_request");
    const serverTime = now();
    if (!Number.isSafeInteger(serverTime) || serverTime < 0) return sendError(reply, "storage_unavailable");
    const purgeDate = new Date(serverTime + decoded.value.days * RETENTION_DAY_MS);
    if (!Number.isFinite(purgeDate.getTime())) return sendError(reply, "storage_unavailable");
    const purgeAt = purgeDate.toISOString();
    const result = options.application.setRetention(request.params.dumpId, purgeAt);
    if (!result.ok) return sendError(reply, contractErrorFor(result.code));
    return reply
      .type("application/json; charset=utf-8")
      .send(encodeRetentionResponse({ dump: { dumpId: request.params.dumpId, purgeAt } }));
  });
}
