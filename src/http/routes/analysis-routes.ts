import type { FastifyInstance } from "fastify";

import {
  decodeRecordAnalysisRequest,
  encodeAnalysisListResponse,
  encodeAnalysisReport,
} from "@dump-ledger/http-contracts";
import {
  authorizeSessionOrAnalyzer,
  authorizeSessionOrAnalyzerMutation,
  contractErrorFor,
  decodeJsonRequest,
  sendError,
} from "../contracts/json.js";
import type { RouteContext } from "./common.js";

/**
 * Analysis write-back routes (docs/analyzer-integration-design.md, "Analysis
 * write-back"; milestone AI3).
 *
 * `POST /api/v1/dumps/:dumpId/analyses` records one analyzer verdict against
 * the dump's sealed bytes. The body decodes through the shared contract
 * decoder (unknown fields, duplicate keys, wrong types, and out-of-bounds
 * values are `400 invalid_request`), and the application layer enforces the
 * per-dump cap, the `inputSha256`-equals-sealed-hash rule, and the dump's
 * `available` phase before the `RecordAnalysis` engine command runs. A fresh
 * identity is `201`; a replay of the engine's identity tuple is `200` with
 * the stored report — the analyzer retry path, not an error.
 *
 * `GET /api/v1/dumps/:dumpId/analyses` lists every stored report for one
 * dump in `(createdAt, analysisId)` order; an unknown dump is `not_found`,
 * a dump with no reports is an empty list with `200`.
 *
 * The `POST` is the one mutation in the analyzer token's scope, so it uses
 * `authorizeSessionOrAnalyzerMutation`: any `Authorization` header selects
 * the analyzer bearer path only (wrong token, malformed header, or disabled
 * configuration is the generic 401), while session callers need cookie,
 * CSRF, and Origin evidence like every other mutation. The `GET` is a read
 * and uses `authorizeSessionOrAnalyzer` unchanged.
 */

export function registerAnalysisRoutes(server: FastifyInstance, ctx: RouteContext): void {
  const { options } = ctx;

  server.post<{ Params: { dumpId: string } }>("/api/v1/dumps/:dumpId/analyses", async (request, reply) => {
    if (authorizeSessionOrAnalyzerMutation(request, reply, options) === undefined) return reply;
    const decoded = decodeJsonRequest(request, decodeRecordAnalysisRequest);
    if (!decoded.ok) return sendError(reply, "invalid_request");
    const outcome = options.application.recordAnalysis(request.params.dumpId, decoded.value);
    if (!outcome.ok) return sendError(reply, contractErrorFor(outcome.code));
    return reply
      .code(outcome.replayed ? 200 : 201)
      .type("application/json; charset=utf-8")
      .send(encodeAnalysisReport(outcome.report));
  });

  server.get<{ Params: { dumpId: string } }>("/api/v1/dumps/:dumpId/analyses", async (request, reply) => {
    if (authorizeSessionOrAnalyzer(request, reply, options) === undefined) return reply;
    const response = options.application.listAnalyses(request.params.dumpId);
    if (response === undefined) return sendError(reply, "not_found");
    return reply.type("application/json; charset=utf-8").send(encodeAnalysisListResponse(response));
  });
}
