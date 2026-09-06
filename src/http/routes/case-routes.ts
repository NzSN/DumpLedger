import type { FastifyInstance } from "fastify";

import {
  decodeCaseSearchParams,
  decodeTransitionRequest,
  encodeCaseDetailResponse,
  encodeCaseSearchResponse,
  encodeTransitionResponse,
  type CaseAction,
} from "@dump-ledger/http-contracts";
import {
  contractErrorFor,
  decodeJsonRequest,
  jsonRequireMutation,
  jsonRequireSession,
  sendError,
} from "../contracts/json.js";
import type { RouteContext } from "./common.js";

/**
 * Case search, detail, manifest, and lifecycle-transition routes
 * (design section 7.4).
 *
 * `allowedActions` on the JSON detail is presentation guidance only; every
 * transition is delegated to the lifecycle engine command and re-checked in
 * its ledger transaction (illegal transitions return the stable
 * `invalid_transition` error). The legacy HTML case page and
 * `/cases/:caseId/manifest.json` route were deleted in the Phase-5 cutover;
 * `/cases` and `/cases/:caseId` now serve the React shell from static-web.
 */
export function registerCaseRoutes(server: FastifyInstance, ctx: RouteContext): void {
  const { options } = ctx;

  server.get("/api/v1/cases", async (request, reply) => {
    if (jsonRequireSession(request, reply, options.sessions) === undefined) return reply;
    let params;
    try {
      params = decodeCaseSearchParams((request.query ?? {}) as Record<string, string | readonly string[] | undefined>);
    } catch {
      return sendError(reply, "invalid_request");
    }
    const found = options.application.searchCases(params);
    return reply.type("application/json; charset=utf-8").send(encodeCaseSearchResponse(found));
  });

  server.get<{ Params: { caseId: string } }>("/api/v1/cases/:caseId", async (request, reply) => {
    if (jsonRequireSession(request, reply, options.sessions) === undefined) return reply;
    const detail = options.application.caseDetail(request.params.caseId);
    if (detail === undefined) return sendError(reply, "not_found");
    return reply.type("application/json; charset=utf-8").send(encodeCaseDetailResponse(detail));
  });

  server.get<{ Params: { caseId: string } }>("/api/v1/cases/:caseId/manifest", async (request, reply) => {
    if (jsonRequireSession(request, reply, options.sessions) === undefined) return reply;
    const manifest = options.application.caseManifest(request.params.caseId);
    if (typeof manifest === "object" && manifest !== null && "error" in manifest) {
      return sendError(reply, "not_found");
    }
    return reply.type("application/json; charset=utf-8").send(manifest);
  });

  server.post<{ Params: { caseId: string } }>("/api/v1/cases/:caseId/transitions", async (request, reply) => {
    if (jsonRequireMutation(request, reply, options.sessions, options.allowedOrigins) === undefined) return reply;
    const decoded = decodeJsonRequest(request, decodeTransitionRequest);
    if (!decoded.ok) return sendError(reply, "invalid_request");
    const action: CaseAction = decoded.value.action;
    const outcome = options.application.transitionCase(request.params.caseId, action);
    if (outcome === undefined) return sendError(reply, "internal_error");
    if (!outcome.ok) return sendError(reply, contractErrorFor(outcome.code));
    return reply.type("application/json; charset=utf-8").send(encodeTransitionResponse(outcome.response));
  });
}
