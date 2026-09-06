import type { FastifyInstance } from "fastify";

import {
  decodeRetentionRequest,
  encodeDumpDetailResponse,
  encodeRetentionResponse,
} from "@dump-ledger/http-contracts";
import { contractErrorFor, decodeJsonRequest, jsonRequireMutation, jsonRequireSession, sendError } from "../contracts/json.js";
import type { RouteContext } from "./common.js";

const RETENTION_DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Dump detail, retention, and raw-content routes (design section 7.7).
 *
 * The JSON retention endpoint computes its canonical deadline from the server
 * clock (`ctx.now()`); the browser clock and timezone are never authoritative.
 * Downloads and raw content stay ordinary streaming navigations guarded by
 * the existing operator authorization and Content-Disposition protections.
 * The legacy HTML dump page, its retention form, and the `/dumps/:dumpId/
 * download` route were deleted in the Phase-5 cutover; `/dumps` and
 * `/dumps/:dumpId` now serve the React shell from static-web.
 */
export function registerDumpRoutes(server: FastifyInstance, ctx: RouteContext): void {
  const { options, now } = ctx;

  server.get<{ Params: { dumpId: string } }>("/api/v1/dumps/:dumpId", async (request, reply) => {
    if (jsonRequireSession(request, reply, options.sessions) === undefined) return reply;
    const detail = options.application.dumpDetail(request.params.dumpId);
    if (detail === undefined) return sendError(reply, "not_found");
    return reply.type("application/json; charset=utf-8").send(encodeDumpDetailResponse(detail));
  });

  server.get<{ Params: { dumpId: string } }>("/api/v1/dumps/:dumpId/content", async (request, reply) => {
    if (jsonRequireSession(request, reply, options.sessions) === undefined) return reply;
    const download = options.application.openDownload(request.params.dumpId);
    if (download === undefined || download.phase !== "available") return sendError(reply, "not_found");
    const safeName = /^[A-Za-z0-9_-]{1,100}$/.test(request.params.dumpId) ? request.params.dumpId : "dump";
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
